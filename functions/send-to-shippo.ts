import { sendOrder } from './lib/orders';
import { fail, getShippoSettings, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Send this order to Shippo',
  action: true,
};

export default async function (req: SwellRequest) {
  const orderId = req.data.$action?.record_id;

  if (typeof orderId !== 'string' || !/^[0-9a-f]{24}$/i.test(orderId)) {
    fail('Open an order to send it to Shippo.');
  }

  // every failure, including a failed Swell read, is a red error popup with a message
  let result;
  try {
    const settings = await getShippoSettings(req.swell);
    if (settings.enabled === false) {
      fail('The Shippo app is turned off. Turn on Enabled in the app settings first.');
    }
    if (!hasToken(settings)) {
      fail('Add your Shippo API token in the app settings first.');
    }
    result = await sendOrder(req, orderId, settings);
  } catch (err: any) {
    if (err instanceof SwellError) throw err;
    fail(`Not sent: ${err?.message || err}`);
  }

  if (!result.sent) {
    fail(`Not sent: ${result.reason}.`);
  }
  return {
    message: result.resent
      ? `Sent to Shippo again as order ${result.shippo_order_id}.`
      : `Sent to Shippo as order ${result.shippo_order_id}.`,
  };
}
