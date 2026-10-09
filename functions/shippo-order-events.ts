import { sendOrder } from './lib/orders';
import { getShippoSettings, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Send orders to Shippo',
  model: {
    events: ['order.submitted', 'order.paid'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const eventType = data.$event?.type;

  const settings = await getShippoSettings(swell);

  if (settings.enabled === false || settings.send_orders === false) {
    return;
  }

  const syncEvent = settings.sync_on === 'submitted' ? 'order.submitted' : 'order.paid';
  if (eventType !== syncEvent) {
    return;
  }

  if (!hasToken(settings)) {
    console.error('Shippo: missing API token, order not sent');
    return;
  }

  const result = await sendOrder(req, data.id, settings);
  if (!result.sent) {
    console.log(`Shippo: order ${data.number || data.id} not sent - ${result.reason}`);
  }
}
