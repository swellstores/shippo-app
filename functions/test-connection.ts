import { ShippoError, fromAddress, getShippoSettings, hasToken, isTestToken, listCarrierAccounts } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Check the Shippo API token',
  action: true,
};

export default async function (req: SwellRequest) {
  const settings = await getShippoSettings(req.swell);

  if (!hasToken(settings)) {
    return { message: 'Add your Shippo API token and save the settings first.' };
  }

  let accounts: any[];
  try {
    accounts = await listCarrierAccounts(settings);
  } catch (err) {
    if (err instanceof ShippoError && (err.status === 401 || err.status === 403)) {
      throw new SwellError(
        "Shippo didn't accept the API token. Copy it again from Shippo → Settings → Advanced → API, save it, then test again.",
        { status: 400 },
      );
    }
    if (err instanceof ShippoError) {
      throw new SwellError(`${err.message.replace(/\.$/, '')}. Try again in a minute.`, { status: 400 });
    }
    throw new SwellError("Couldn't reach Shippo. Try again in a minute.", { status: 400 });
  }

  const active = accounts.filter((account) => account.active !== false);
  const carriers = [...new Set(active.map((account) => account.carrier_name || account.carrier).filter(Boolean))];
  const mode = isTestToken(settings.api_token) ? 'test' : 'live';

  const notes: string[] = [];
  if (!carriers.length) {
    notes.push('No active carrier accounts, so checkout will show no Shippo rates.');
  }
  if (!fromAddress(settings)) {
    notes.push('Fill in the ship-from address (street, city, postal code and country) to get rates.');
  }

  return {
    message: [
      `Connected to Shippo (${mode} token). Active carriers: ${carriers.join(', ') || 'none'}.`,
      ...notes,
    ].join(' '),
  };
}
