import {
  ShippoError,
  ShippoSettings,
  buildShippoOrder,
  createOrder,
  getAppData,
  getWeightUnit,
  shippableItems,
} from './shippo';

export const STATUS_AWAITING_LABEL = 'awaiting_label';
export const STATUS_LABEL_CREATED = 'label_created';
// a label was bought, but another shipment (another app, or by hand) had already shipped the order's items in Swell
export const STATUS_SHIPPED_ELSEWHERE = 'shipped_elsewhere';
export const STATUS_ERROR = 'error';

export interface SendResult {
  sent: boolean;
  shippo_order_id?: string;
  reason?: string;
  // true when an order in the Error status was sent again as a new Shippo order
  resent?: boolean;
}

// Sends one Swell order to Shippo's Orders page. Errors are saved on the order;
// Shippo 5xx and network errors are rethrown so model events retry them.
export async function sendOrder(req: SwellRequest, orderId: string, settings: ShippoSettings): Promise<SendResult> {
  const { swell, appId } = req;

  const order = await swell.get(`/orders/${orderId}`, {
    expand: ['account', 'items.product', 'items.variant'],
  });

  if (!order) {
    return { sent: false, reason: 'Order not found' };
  }

  const appData = getAppData(order, appId);

  // an order in the Error status can be sent again: its Shippo order is gone or unusable
  // (for example sent with another token), so a new Shippo order replaces it
  const resend = Boolean(appData.shippo_order_id) && appData.shippo_status === STATUS_ERROR;
  if (appData.shippo_order_id && !resend) {
    return { sent: false, shippo_order_id: appData.shippo_order_id, reason: 'Already sent to Shippo' };
  }

  if (order.canceled) {
    return { sent: false, reason: 'Order is canceled' };
  }

  if (!shippableItems(order).length) {
    return { sent: false, reason: 'Order has no items to ship' };
  }

  if (!order.shipping?.country) {
    await swell.put(
      `/orders/${orderId}`,
      req.appValues({ shippo_status: STATUS_ERROR, shippo_error: 'Missing shipping address' }),
    );
    return { sent: false, reason: 'Missing shipping address' };
  }

  let created: any;
  try {
    const weightUnit = await getWeightUnit(swell);
    created = await createOrder(settings, buildShippoOrder(order, settings, weightUnit));
  } catch (err: any) {
    const message = err?.message || String(err);
    console.error(`Shippo: failed to send order ${order.number} - ${message}`);
    await swell.put(`/orders/${orderId}`, req.appValues({ shippo_status: STATUS_ERROR, shippo_error: message }));

    // 4xx means the order data or the token is wrong; retrying won't help
    if (err instanceof ShippoError && err.status < 500) {
      return { sent: false, reason: message };
    }
    throw err;
  }

  // A failed save is only logged: rethrowing would run the event again and create a second Shippo order
  try {
    await swell.put(
      `/orders/${orderId}`,
      req.appValues({
        shippo_order_id: created?.object_id,
        shippo_status: STATUS_AWAITING_LABEL,
        shippo_error: null,
      }),
    );
  } catch (err: any) {
    console.error(
      `Shippo: order ${order.number} was sent as Shippo order ${created?.object_id}, but saving it on the order failed - ${err?.message || err}`,
    );
  }

  console.log(
    resend
      ? `Shippo: sent order ${order.number} again as Shippo order ${created?.object_id} (was ${appData.shippo_order_id})`
      : `Shippo: sent order ${order.number} as Shippo order ${created?.object_id}`,
  );
  return { sent: true, shippo_order_id: created?.object_id, ...(resend && { resent: true }) };
}
