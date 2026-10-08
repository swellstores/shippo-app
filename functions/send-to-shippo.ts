import { sendOrder } from './lib/orders';
import { getShippoSettings, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Send this order to Shippo',
  action: true,
};

export default async function (req: SwellRequest) {
  const orderId = req.data.$action?.record_id;

  if (typeof orderId !== 'string' || !/^[0-9a-f]{24}$/i.test(orderId)) {
    return { message: 'Open an order to send it to Shippo.' };
  }

  const settings = await getShippoSettings(req.swell);

  if (!hasToken(settings)) {
    return { message: 'Add your Shippo API token in the app settings first.' };
  }

  try {
    const result = await sendOrder(req, orderId, settings);
    if (result.sent) {
      return { message: `Sent to Shippo as order ${result.shippo_order_id}.` };
    }
    return { message: `Not sent: ${result.reason}.` };
  } catch (err: any) {
    return { message: `Not sent: ${err?.message || err}` };
  }
}
