import {
  SERVICE_PREFIX,
  ShippoRate,
  buildShipment,
  createShipment,
  getAccountEmail,
  getShippoSettings,
  getWeightUnit,
  hasToken,
  ratesToServices,
} from './lib/shippo';

export const config: SwellConfig = {
  extension: 'shippo',
  description: 'Live Shippo rates at checkout',
  timeout: 10000,
  model: {
    events: ['after:order.shipping'],
    fields: ['shipment_rating'],
  },
};

export default async function (req: SwellRequest) {
  const { swell, data } = req;
  const settings = await getShippoSettings(swell);

  if (settings.enabled === false || settings.rates_enabled === false) {
    return;
  }

  if (!hasToken(settings)) {
    console.error('Shippo: missing API token, no rates returned');
    return;
  }

  // other services (native or from other carriers) stay; earlier Shippo services are replaced
  const existing = (data.shipment_rating?.services || []).filter(
    (service: any) => !String(service?.id || '').startsWith(SERVICE_PREFIX),
  );

  // hook data holds only the changed fields; items and account_id come from the stored cart in $record
  const cart = { ...data.$record, ...data };

  const [weightUnit, email] = await Promise.all([getWeightUnit(swell), getAccountEmail(swell, cart)]);
  const shipment = buildShipment({ ...cart, account: { ...cart.account, email } }, settings, weightUnit);

  if (!shipment) {
    // no ship-from address, no shipping country or nothing to ship yet
    return;
  }

  let rates: ShippoRate[] = [];
  try {
    const result = await createShipment(settings, shipment);
    rates = result?.rates || [];

    if (!rates.length && result?.messages?.length) {
      console.warn(
        'Shippo: no rates',
        result.messages.slice(0, 5).map((m: any) => [m.source, m.text].filter(Boolean).join(': ')),
      );
    }
  } catch (err: any) {
    // never break checkout: fall back to the other services
    console.error(`Shippo: rate request failed - ${err?.message || err}`);
    return;
  }

  const services = ratesToServices(rates, settings, cart.currency);

  if (rates.length && !services.length) {
    console.warn(`Shippo: ${rates.length} rates returned, none in ${cart.currency} or matching the service filter`);
  }

  return {
    shipment_rating: {
      ...data.shipment_rating,
      services: [...existing, ...services],
    },
  };
}
