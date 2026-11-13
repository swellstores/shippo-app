import { STATUS_AWAITING_LABEL, STATUS_ERROR, STATUS_LABEL_CREATED, STATUS_SHIPPED_ELSEWHERE } from './orders';
import {
  ShippoError,
  ShippoSettings,
  ShippoTransaction,
  carrierId,
  getAppData,
  getOrder,
  getRate,
  getTransaction,
  shippoRequest,
} from './shippo';

// orders older than this are no longer checked for labels
export const MAX_ORDER_AGE_DAYS = 60;
// orders checked per pass; each takes 2-3 Shippo requests
export const DEFAULT_BATCH_SIZE = 10;
// stop starting new orders after this, to stay inside the 10s function limit
export const DEFAULT_BUDGET_MS = 6000;
// transactions fetched per Shippo order
const MAX_TRANSACTIONS = 5;

export interface SyncSummary {
  checked: number;
  labeled: number;
  errors: number;
  remaining: boolean;
  // set when Shippo refused the token (401 or 403) and the pass stopped
  stopped?: string;
}

// 401 and 403 are about the token, not the order: the pass stops and the orders keep waiting
export function isTokenRefused(err: unknown): err is ShippoError {
  return err instanceof ShippoError && (err.status === 401 || err.status === 403);
}

export interface LabelDetails {
  transaction_id: string;
  tracking_number?: string;
  tracking_url?: string;
  label_url?: string;
  provider?: string;
  servicelevel_name?: string;
  servicelevel_token?: string;
}

function transactionIds(shippoOrder: any): string[] {
  return (shippoOrder?.transactions || [])
    .map((tx: any) => (typeof tx === 'string' ? tx : tx?.object_id))
    .filter(Boolean)
    .slice(0, MAX_TRANSACTIONS);
}

// carrier and service of the label; a missing rate never blocks fulfillment
export async function labelDetails(settings: ShippoSettings, tx: ShippoTransaction): Promise<LabelDetails> {
  const details: LabelDetails = {
    transaction_id: tx.object_id,
    tracking_number: tx.tracking_number || undefined,
    tracking_url: tx.tracking_url_provider || undefined,
    label_url: tx.label_url || undefined,
  };

  if (tx.rate && typeof tx.rate === 'object') {
    details.provider = tx.rate.provider;
    details.servicelevel_name = tx.rate.servicelevel_name;
    details.servicelevel_token = tx.rate.servicelevel_token;
  } else if (typeof tx.rate === 'string' && tx.rate) {
    try {
      const rate = await getRate(settings, tx.rate);
      details.provider = rate?.provider;
      details.servicelevel_name = rate?.servicelevel?.name;
      details.servicelevel_token = rate?.servicelevel?.token;
    } catch (err: any) {
      console.warn(`Shippo: could not load rate ${tx.rate} - ${err?.message || err}`);
    }
  }

  return details;
}

// first purchased label among the Shippo order's transactions
export async function findPurchasedLabel(
  settings: ShippoSettings,
  shippoOrder: any,
): Promise<ShippoTransaction | null> {
  for (const id of transactionIds(shippoOrder)) {
    const tx = await getTransaction(settings, id);
    if (tx?.status === 'SUCCESS') {
      return tx;
    }
  }
  return null;
}

// Active Swell shipments of the order with this tracking number, oldest first
export async function findShipmentsByTracking(swell: SwellAPI, orderId: string, trackingNumber?: string): Promise<any[]> {
  if (!trackingNumber) {
    return [];
  }
  const result: any = await swell.get('/shipments', {
    where: { order_id: orderId, tracking_code: trackingNumber, canceled: { $ne: true } },
    limit: 25,
  });
  return (result?.results || []).sort(
    (a: any, b: any) => String(a.date_created).localeCompare(String(b.date_created)) || String(a.id).localeCompare(String(b.id)),
  );
}

// Swell shipment for everything still to be shipped on the order. Webhooks can arrive twice at
// the same moment, so an existing shipment for the label is reused, and if two runs still create
// one each, the later copy is canceled and both runs return the oldest.
export async function createSwellShipment(swell: SwellAPI, order: any, label: LabelDetails): Promise<string> {
  const existing = await findShipmentsByTracking(swell, order.id, label.tracking_number);
  if (existing.length) {
    console.log(`Shippo: order ${order.number} already has shipment ${existing[0].id} for ${label.tracking_number}`);
    return existing[0].id;
  }

  const items = (order.items || [])
    .filter((item: any) => item.delivery === 'shipment' && item.quantity_shipment_deliverable > 0)
    .map((item: any) => ({
      order_item_id: item.id,
      product_id: item.product_id,
      variant_id: item.variant_id,
      quantity: item.quantity_shipment_deliverable,
    }));

  // the same case as Swell refusing the items below, found before creating the shipment
  if (!items.length) {
    console.log(`Shippo: order ${order.number} has nothing left to ship`);
    throw new ItemsAlreadyShipped('nothing left to ship');
  }

  const shipping = order.shipping || {};
  let shipment: any;
  try {
    shipment = await swell.post('/shipments', {
      order_id: order.id,
      items,
      destination: {
        name: shipping.name,
        first_name: shipping.first_name,
        last_name: shipping.last_name,
        address1: shipping.address1,
        address2: shipping.address2,
        city: shipping.city,
        state: shipping.state,
        zip: shipping.zip,
        country: shipping.country,
        phone: shipping.phone,
      },
      carrier: carrierId(label.provider),
      carrier_name: label.provider,
      // the dashboard shows `service` in the shipment dialog, so use the readable name
      service: label.servicelevel_name || label.servicelevel_token,
      service_name: label.servicelevel_name,
      tracking_code: label.tracking_number,
      notes: `Shippo label ${label.transaction_id}${label.tracking_url ? `: ${label.tracking_url}` : ''}`,
      // Swell refuses items the order has no longer left to ship, so they can't be shipped twice
      $validate_items: true,
    });
  } catch (err) {
    // The Swell client throws a refused write as a SwellError with the errors in `body`
    const errors = validationErrors(err);
    // the order's shipments are locked by another write: thrown, so the order is checked again
    if (errors?.order_id) {
      throw new Error(`Swell couldn't create the shipment for order ${order.number}: ${errorText(errors)}`);
    }
    const refused = errors && itemsRefusal(errors);
    if (!refused) throw err;
    // The items were shipped meanwhile, e.g. by a parallel run for this label: use its shipment. Swell reserves the
    // items before it writes that shipment, so it's looked for again after a moment if it isn't there yet.
    const copy = await findParallelShipment(swell, order.id, label.tracking_number);
    if (copy) {
      console.log(`Shippo: order ${order.number} was shipped meanwhile; keeps shipment ${copy.id}`);
      return copy.id;
    }
    // shipped, fully or partly, by another shipment: only full shipments are made, so the label is saved without one
    console.warn(`Shippo: Swell refused the shipment for order ${order.number}: ${refused}`);
    throw new ItemsAlreadyShipped(refused);
  }

  console.log(`Shippo: created shipment ${shipment.id} for order ${order.number}`);

  const copies = await findShipmentsByTracking(swell, order.id, label.tracking_number);
  const oldest = copies[0];
  if (oldest && oldest.id !== shipment.id) {
    await swell.put(`/shipments/${shipment.id}`, { canceled: true });
    console.log(`Shippo: canceled duplicate shipment ${shipment.id}; order ${order.number} keeps ${oldest.id}`);
    return oldest.id;
  }
  return shipment.id;
}

// how long to wait before looking again for a parallel run's shipment that Swell hasn't written yet
export const PARALLEL_SHIPMENT_WAIT_MS = 1000;

async function findParallelShipment(swell: SwellAPI, orderId: string, trackingNumber?: string): Promise<any | null> {
  if (!trackingNumber) return null;
  const found = await findShipmentsByTracking(swell, orderId, trackingNumber);
  if (found.length) return found[0];
  await new Promise((resolve) => setTimeout(resolve, PARALLEL_SHIPMENT_WAIT_MS));
  return (await findShipmentsByTracking(swell, orderId, trackingNumber))[0] || null;
}

// Swell refused the shipment's items as already shipped by another shipment (another app, or by hand); the message is
// Swell's reason, e.g. "Cannot ship 2 of item <id>, only 1 left to deliver"
export class ItemsAlreadyShipped extends Error {}

export function itemsShippedNote(reason: string): string {
  return `Label saved, but no shipment was created: the order's items were already shipped by another shipment (${reason}).`;
}

// the { field: { message } } errors of a write Swell refused (the SwellError's body)
function validationErrors(err: any): Record<string, any> | undefined {
  const errors = err?.status === 400 ? err.body : undefined;
  return errors && typeof errors === 'object' ? errors : undefined;
}

// Swell's reason when it refused the items as no longer left to ship (validateShipmentItems with $validate_items)
function itemsRefusal(errors: Record<string, any>): string | undefined {
  const message = errors.items?.message;
  return typeof message === 'string' && /^Cannot ship /.test(message) ? message : undefined;
}

// Swell's { field: { message } } errors as one line
function errorText(errors: Record<string, any>): string {
  return Object.entries(errors)
    .map(([field, error]) => `${field}: ${error?.message || error}`)
    .join('; ');
}

// Checks one order's Shippo order for a purchased label and fulfills the order
export async function syncOrderLabel(
  req: SwellRequest,
  settings: ShippoSettings,
  order: any,
): Promise<'labeled' | 'waiting' | 'error'> {
  const { swell, appId } = req;
  const appData = getAppData(order, appId);
  const now = new Date().toISOString();

  let shippoOrder: any;
  try {
    shippoOrder = await getOrder(settings, appData.shippo_order_id);
  } catch (err: any) {
    // the Shippo order is gone or was made with another token: stop checking it (401 and 403 are rethrown)
    if (err instanceof ShippoError && [400, 404].includes(err.status)) {
      await swell.put(
        `/orders/${order.id}`,
        req.appValues({ shippo_status: STATUS_ERROR, shippo_error: err.message, shippo_checked_at: now }),
      );
      return 'error';
    }
    throw err;
  }

  const tx = await findPurchasedLabel(settings, shippoOrder);
  if (!tx) {
    await swell.put(`/orders/${order.id}`, req.appValues({ shippo_checked_at: now }));
    return 'waiting';
  }

  const label = await labelDetails(settings, tx);
  const values: Record<string, any> = {
    shippo_status: STATUS_LABEL_CREATED,
    shippo_transaction_id: label.transaction_id,
    shippo_tracking_number: label.tracking_number || null,
    shippo_tracking_url: label.tracking_url || null,
    shippo_label_url: label.label_url || null,
    shippo_carrier: label.provider || null,
    shippo_service: label.servicelevel_name || null,
    shippo_checked_at: now,
    shippo_error: null,
    shippo_note: null,
  };

  if (settings.create_fulfillment !== false && !appData.shippo_shipment_id) {
    try {
      const shipmentId = await createSwellShipment(swell, order, label);
      if (shipmentId) {
        values.shippo_shipment_id = shipmentId;
      }
    } catch (err) {
      if (!(err instanceof ItemsAlreadyShipped)) throw err;
      values.shippo_status = STATUS_SHIPPED_ELSEWHERE;
      values.shippo_note = itemsShippedNote(err.message);
    }
  }

  await swell.put(`/orders/${order.id}`, req.appValues(values));
  return 'labeled';
}

// Orders sent to Shippo that have no label yet, least recently checked first
export async function getPendingOrders(req: SwellRequest, limit: number): Promise<{ results: any[]; count: number }> {
  const prefix = `$app.${req.appId}`;
  const cutoff = new Date(Date.now() - MAX_ORDER_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();

  const result = await req.swell.get('/orders', {
    where: {
      [`${prefix}.shippo_status`]: STATUS_AWAITING_LABEL,
      canceled: { $ne: true },
      date_created: { $gte: cutoff },
    },
    sort: `${prefix}.shippo_checked_at asc`,
    limit,
  });

  return { results: result?.results || [], count: result?.count || 0 };
}

export async function syncPendingOrders(
  req: SwellRequest,
  settings: ShippoSettings,
  { limit = DEFAULT_BATCH_SIZE, budgetMs = DEFAULT_BUDGET_MS } = {},
): Promise<SyncSummary> {
  const started = Date.now();
  const { results, count } = await getPendingOrders(req, limit);
  const summary: SyncSummary = { checked: 0, labeled: 0, errors: 0, remaining: count > results.length };

  for (const order of results) {
    if (Date.now() - started > budgetMs) {
      summary.remaining = true;
      break;
    }

    try {
      const outcome = await syncOrderLabel(req, settings, order);
      summary.checked++;
      if (outcome === 'labeled') summary.labeled++;
      if (outcome === 'error') summary.errors++;
    } catch (err: any) {
      if (isTokenRefused(err)) {
        summary.stopped = err.message;
        summary.remaining = true;
        console.error(`Shippo: label check stopped at order ${order.number} - ${err.message}`);
        break;
      }
      summary.checked++;
      summary.errors++;
      console.error(`Shippo: failed to check order ${order.number} - ${err?.message || err}`);
    }
  }

  return summary;
}

async function findOrderByAppField(req: SwellRequest, field: string, value: string): Promise<any | null> {
  const result = await req.swell.get('/orders', {
    where: { [`$app.${req.appId}.${field}`]: value },
    limit: 1,
  });
  return result?.results?.[0] || null;
}

// A refunded (voided) label cancels its Swell shipment; the order waits for a new label
export async function applyRefundedLabel(req: SwellRequest, tx: ShippoTransaction): Promise<boolean> {
  if (tx.status !== 'REFUNDED') {
    return false;
  }

  const order = await findOrderByAppField(req, 'shippo_transaction_id', tx.object_id);
  if (!order) {
    return false;
  }

  const appData = getAppData(order, req.appId);
  if (appData.shippo_shipment_id) {
    await req.swell.put(`/shipments/${appData.shippo_shipment_id}`, { canceled: true });
    console.log(`Shippo: canceled shipment ${appData.shippo_shipment_id} for order ${order.number}`);
  }

  await req.swell.put(
    `/orders/${order.id}`,
    req.appValues({
      shippo_status: STATUS_AWAITING_LABEL,
      shippo_transaction_id: null,
      shippo_tracking_number: null,
      shippo_tracking_url: null,
      shippo_label_url: null,
      shippo_carrier: null,
      shippo_service: null,
      shippo_shipment_id: null,
      shippo_tracking_status: null,
      shippo_tracking_details: null,
      shippo_tracking_date: null,
      shippo_eta: null,
      shippo_note: null,
    }),
  );
  return true;
}

export async function getTrack(settings: ShippoSettings, carrier: string, trackingNumber: string): Promise<any> {
  return shippoRequest(
    settings,
    'GET',
    `/tracks/${encodeURIComponent(carrier)}/${encodeURIComponent(trackingNumber)}`,
  );
}

// Saves the latest carrier tracking status on the order that has this tracking number
export async function applyTrackingUpdate(req: SwellRequest, track: any): Promise<boolean> {
  const trackingNumber = track?.tracking_number;
  const status = track?.tracking_status;
  if (!trackingNumber || !status?.status) {
    return false;
  }

  const order = await findOrderByAppField(req, 'shippo_tracking_number', trackingNumber);
  if (!order) {
    return false;
  }

  const appData = getAppData(order, req.appId);

  // a tracking number reused by another label is not this order's parcel
  if (track.transaction && appData.shippo_transaction_id && track.transaction !== appData.shippo_transaction_id) {
    return false;
  }

  // updates can arrive out of order; keep the newest carrier scan
  const statusDate = status.status_date || status.object_updated;
  if (statusDate && appData.shippo_tracking_date && Date.parse(statusDate) < Date.parse(appData.shippo_tracking_date)) {
    return false;
  }

  await req.swell.put(
    `/orders/${order.id}`,
    req.appValues({
      shippo_tracking_status: status.status,
      shippo_tracking_details: status.status_details || null,
      shippo_tracking_date: statusDate || null,
      shippo_eta: track.eta || null,
    }),
  );
  return true;
}
