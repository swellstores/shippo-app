import { STATUS_AWAITING_LABEL, STATUS_ERROR, STATUS_LABEL_CREATED } from './orders';
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
export async function createSwellShipment(swell: SwellAPI, order: any, label: LabelDetails): Promise<string | null> {
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

  if (!items.length) {
    console.log(`Shippo: order ${order.number} has nothing left to ship`);
    return null;
  }

  const shipping = order.shipping || {};
  const shipment = await swell.post('/shipments', {
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
  });

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
    // the Shippo order is gone or belongs to another account; stop checking it
    if (err instanceof ShippoError && [400, 403, 404].includes(err.status)) {
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
  };

  if (settings.create_fulfillment !== false && !appData.shippo_shipment_id) {
    const shipmentId = await createSwellShipment(swell, order, label);
    if (shipmentId) {
      values.shippo_shipment_id = shipmentId;
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
