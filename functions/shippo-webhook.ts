import { applyRefundedLabel, applyTrackingUpdate, getTrack, syncPendingOrders } from './lib/labels';
import { ShippoSettings, getShippoSettings, getTransaction, hasToken } from './lib/shippo';

export const config: SwellConfig = {
  description: 'Receive Shippo webhooks',
  route: {
    methods: ['post'],
    public: true,
  },
};

// Shippo doesn't sign webhooks, so the payload is never trusted: every transaction
// or track is loaded again from the Shippo API with your token before it is used.
export async function post(req: SwellRequest) {
  const { swell } = req;
  const settings = await getShippoSettings(swell);

  if (settings.enabled === false || !hasToken(settings)) {
    return { received: true, processed: false };
  }

  const payload = (typeof req.body === 'string' ? safeParse(req.body) : req.body) as {
    event?: string;
    test?: boolean;
    data?: any;
  };

  const event = payload?.event;
  if (!event || !payload.data) {
    return { received: true, processed: false };
  }

  // Shippo expects an answer within 3 seconds; do the work after responding
  req.context.waitUntil(
    handleEvent(req, settings, event, payload.data).catch((err) => {
      console.error(`Shippo: webhook ${event} failed - ${err?.message || err}`);
    }),
  );

  return { received: true, event };
}

export async function handleEvent(req: SwellRequest, settings: ShippoSettings, event: string, data: any) {
  if (event === 'transaction_created' || event === 'transaction_updated') {
    if (data.object_id) {
      const tx = await getTransaction(settings, data.object_id);
      if (await applyRefundedLabel(req, tx)) {
        console.log(`Shippo: label ${tx.object_id} was refunded`);
        return;
      }
    }

    // transactions don't say which order they belong to, so check the orders still waiting for a label
    if (settings.send_orders !== false) {
      const summary = await syncPendingOrders(req, settings);
      console.log(`Shippo: label check after ${event}`, summary);
    }
    return;
  }

  if (event === 'track_updated') {
    if (!data.carrier || !data.tracking_number) {
      return;
    }
    const track = await getTrack(settings, data.carrier, data.tracking_number);
    // the transaction id is only in the webhook payload, for the label owner
    const updated = await applyTrackingUpdate(req, { ...track, transaction: track?.transaction || data.transaction });
    if (updated) {
      console.log(`Shippo: tracking ${data.tracking_number} is ${track?.tracking_status?.status}`);
    }
  }
}

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
