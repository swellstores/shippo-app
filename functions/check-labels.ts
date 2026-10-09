import { syncPendingOrders } from './lib/labels';
import { getShippoSettings, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Check Shippo for new labels now',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = await getShippoSettings(req.swell);

  if (settings.enabled === false) {
    return { message: 'The Shippo app is turned off. Turn on Enabled in the app settings first.' };
  }

  if (!hasToken(settings)) {
    return { message: 'Add your Shippo API token and save the settings first.' };
  }

  const summary = await syncPendingOrders(req, settings);

  if (!summary.checked) {
    return { message: 'No orders are waiting for a Shippo label.' };
  }

  const parts = [`Checked ${summary.checked} order${summary.checked === 1 ? '' : 's'}`, `${summary.labeled} with a new label`];
  if (summary.errors) {
    parts.push(`${summary.errors} with errors (see the Shippo tab on the order)`);
  }

  return {
    message: `${parts.join(', ')}.${summary.remaining ? ' More orders are waiting; run it again or wait for the next automatic check.' : ''}`,
  };
}
