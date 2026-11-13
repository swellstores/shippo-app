import { syncPendingOrders } from './lib/labels';
import { fail, getShippoSettings, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Check Shippo for new labels now',
  action: true,
};

export default async function (req: SwellRequest) {
  // every failure, a failed Swell read too, is a red error popup
  let summary;
  try {
    const settings = await getShippoSettings(req.swell);
    if (settings.enabled === false) {
      fail('The Shippo app is turned off. Turn on Enabled in the app settings first.');
    }
    if (!hasToken(settings)) {
      fail('Add your Shippo API token and save the settings first.');
    }
    summary = await syncPendingOrders(req, settings);
  } catch (err: any) {
    if (err instanceof SwellError) throw err;
    fail(`Check for labels failed: ${err?.message || err}`);
  }

  if (summary.stopped) {
    fail(
      `Check for labels stopped: ${summary.stopped.replace(/\.$/, '')}. Check the API token in the app settings; the orders still waiting for a label weren't changed.`,
    );
  }

  if (!summary.checked) {
    return { message: 'No orders are waiting for a Shippo label.' };
  }

  const parts = [`Checked ${summary.checked} order${summary.checked === 1 ? '' : 's'}`, `${summary.labeled} with a new label`];
  if (summary.errors) {
    parts.push(`${summary.errors} with errors (see the Shippo tab on the order)`);
  }

  const message = `${parts.join(', ')}.${summary.remaining ? ' More orders are waiting; run it again or wait for the next automatic check.' : ''}`;
  // any failed order makes the result an error
  if (summary.errors) {
    fail(message);
  }
  return { message };
}
