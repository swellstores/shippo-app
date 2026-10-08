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
export const STATUS_ERROR = 'error';

export interface SendResult {
  sent: boolean;
  shippo_order_id?: string;
  reason?: string;
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

  if (appData.shippo_order_id) {
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

  try {
    const weightUnit = await getWeightUnit(swell);
    const created = await createOrder(settings, buildShippoOrder(order, settings, weightUnit));

    await swell.put(
      `/orders/${orderId}`,
      req.appValues({
        shippo_order_id: created?.object_id,
        shippo_status: STATUS_AWAITING_LABEL,
        shippo_error: null,
      }),
    );

    console.log(`Shippo: sent order ${order.number} as Shippo order ${created?.object_id}`);
    return { sent: true, shippo_order_id: created?.object_id };
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
}
