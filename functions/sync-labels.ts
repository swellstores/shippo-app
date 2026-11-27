import { syncPendingOrders } from './lib/labels';
import { getShippoSettings, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Fulfill orders from Shippo labels',
  cron: {
    schedule: '*/30 * * * *',
    // Skipped while the app or order sending is off, or there's no API token
    conditions: {
      $settings: { shippo: { enabled: { $ne: false }, send_orders: { $ne: false }, api_token: { $empty: false } } },
    },
  },
};

export default async function (req: SwellRequest) {
  const settings = await getShippoSettings(req.swell);

  if (settings.enabled === false || settings.send_orders === false || !hasToken(settings)) {
    return;
  }

  const summary = await syncPendingOrders(req, settings);

  if (summary.checked) {
    console.log('Shippo: label check', summary);
  }
}
