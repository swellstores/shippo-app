# Shippo for Swell

Connects a Swell store to [Shippo](https://goshippo.com). Customers see live Shippo carrier rates at checkout. Orders are sent to Shippo's **Orders** page, where you buy labels. When a label is bought, the app fulfills the order in Swell with the carrier and tracking number, and it keeps the tracking status on the order.

## Features

- **Live rates at checkout:** a Swell shipping extension. When a cart's shipping address or items change, the app asks Shippo for rates (`POST /shipments`, synchronous) from your ship-from address to the customer's, for one parcel. Every Shippo service level becomes a checkout option, named like `USPS Priority Mail`, with estimated delivery days. You can limit carrier accounts and service levels, and add a markup and a handling fee. Other shipping services (Swell's own, or other apps') stay as they are.
- **Orders to Shippo:** when an order is paid (or submitted, see settings) and has items to ship, it's created in Shippo (`POST /orders`). The Shippo order has the shipping address, ship-from address, line items with SKU, prices and weights, totals, and the service the customer chose at checkout. An order is sent only once.
- **Send to Shippo button:** an order's page has a **Send to Shippo** action. Use it for orders placed before the app was installed, or to retry an order whose Shippo status is **Error**: it's sent again as a new Shippo order, for example when its old Shippo order belongs to another token. Orders waiting for a label or already labeled are never sent twice.
- **Fulfillment from labels:** every 15 minutes the app checks the Shippo orders that don't have a label yet. When it finds a purchased label, it creates a Swell shipment for everything still to ship, with the carrier, service and tracking number. The **Check for labels now** action in the app settings runs the check right away.
- **Webhook (optional):** with the Shippo webhook set up, a new label triggers the check right away. Carrier tracking updates (in transit, delivered and so on) are saved on the order. A refunded (voided) label cancels its Swell shipment, and the order waits for a new label.
- **Order tab:** a **Shippo** tab on the order page shows the status, Shippo order ID, carrier, service, tracking number, tracking page, label link, tracking status and details, estimated delivery, the last check and the last error. The orders list gets a **Shippo** status column.
- **Test connection:** the action in the app settings checks the API token and lists your active Shippo carriers. It also flags a missing ship-from address.

## Settings

All credentials and options are app settings (`settings/shippo.json`). Nothing is hard-coded.

| Setting | Required | Default | Description |
|---|---|---|---|
| API token | yes | | Shippo → Settings → Advanced → API. Use a `shippo_test_` token in Swell's test environment and a `shippo_live_` token in live. |
| Enabled | no | on | Turns off rates, order sending, label checks and webhooks without uninstalling the app. |
| **Ship-from address** | | | |
| Name, Company | no | | Sender name. The company is used as the name when the name is empty. |
| Street, Street line 2 | Street: for rates | | |
| City | for rates | | |
| State / province code | for some countries | | e.g. `CA`. Needed for US, Canada and other countries where carriers require it. |
| Postal code | for rates | | |
| Country code | for rates | | 2-letter ISO code, e.g. `US`. |
| Phone, Email | no | | Some carriers need a phone number to buy a label. |
| **Checkout rates** | | | |
| Show Shippo rates at checkout | no | on | Turns checkout rates off while keeping order sending. |
| Carrier accounts | no | all active | Comma-separated Shippo carrier account object IDs to quote. |
| Service levels | no | all | Comma-separated Shippo service level tokens to offer, e.g. `usps_priority, ups_ground`. Case doesn't matter. |
| Markup (%) | no | 0 | Added to each Shippo rate. |
| Handling fee | no | 0 | Flat amount added to each rate after the markup, in the checkout currency. |
| Show estimated delivery days | no | on | Shows "Estimated delivery in N days" (or Shippo's duration terms) under each option. |
| **Default parcel** | | | |
| Length, Width, Height, Unit | no | 10 × 8 × 4 in | Box size used for every rate. Unit is `in` or `cm`. |
| Default weight, Weight unit | no | 1 lb | Used when the items have no shipping weight. Unit is `lb`, `oz`, `kg` or `g`. |
| **Orders and labels** | | | |
| Send orders to Shippo | no | on | Creates Shippo orders and checks them for labels. |
| Send orders when | no | Order is paid | `Order is paid` (`order.paid`) or `Order is submitted` (`order.submitted`). |
| Create Swell shipment when a label is bought | no | on | Fulfills the Swell order. When off, the label and tracking are still saved on the Shippo tab. |
| **Webhook** | | | |
| Webhook URL | read-only | `https://{store-id}:{public-key}@{store-id}.swell.store/functions/shippo/shippo-webhook` | The URL pattern to paste into Shippo, with the placeholders replaced. |

**Actions** (Actions menu on the app's settings page): **Test connection** and **Check for labels now**. **Send to Shippo** is on each order's page. While **Enabled** is off, Check for labels now and Send to Shippo do nothing and say so.

## Setup

1. In Shippo, connect your carrier accounts (or use Shippo's built-in ones). Copy an API token from **Settings → Advanced → API**: the test token for Swell's test environment, the live token for live.
2. Install the app in Swell and open its settings. Enter the **API token** and the **Ship-from address**, adjust the **Default parcel**, and save.
3. Run **Test connection** from the Actions menu. It should say "Connected to Shippo" and list your carriers.
4. Go to **Settings → Shipping**. Turn on **Shippo** in the list and click **Save changes**. Checkout rates appear only after this step.
5. *(Optional, recommended)* Set up the Shippo webhook as described in [Webhook setup](#webhook-setup).
6. Add an item to a cart and enter a shipping address. Shippo rates should show at checkout.
7. Place and pay a test order. It should appear on Shippo's **Orders** page, and its Shippo tab in Swell should say **Awaiting label**.
8. Buy a label for it in Shippo. Within 15 minutes (right away with the webhook, or after **Check for labels now**), the order gets a shipment with the tracking number.

## Webhook setup

The webhook is optional. Without it, the app finds new labels with its check every 15 minutes, but voided labels and carrier tracking updates never reach Swell. With it, Shippo tells the app about each of these as it happens.

**What it handles**

| Shippo event | What the app does |
|---|---|
| `transaction_created` | Runs the label check right away, so the order is fulfilled without waiting for the 15-minute check. |
| `transaction_updated` | If the label was voided or refunded, cancels its Swell shipment and puts the order back to **Awaiting label**. Otherwise runs the label check. |
| `track_updated` | Saves the carrier's tracking status, details, date and estimated delivery on the order. |

Other events are acknowledged and ignored.

**Steps**

1. **Build the URL.** Take the pattern from the read-only **Webhook URL** setting:

   ```
   https://{store-id}:{public-key}@{store-id}.swell.store/functions/shippo/shippo-webhook
   ```

   - `{store-id}`: your Swell store ID, the subdomain of your `*.swell.store` address.
   - `{public-key}`: a Swell **public** key from **Developer → API keys**. Use the test key to reach the test environment and the live key for live. Never use a secret key here.

   Example: `https://alder:pk_test_123…@alder.swell.store/functions/shippo/shippo-webhook`
2. **Add it in Shippo.** In Shippo, open **Settings → Advanced → Webhooks** and add the URL once for each of `transaction_created`, `transaction_updated` and `track_updated`. Shippo webhooks are either test or live: register test webhooks with the Swell test key URL while you use a `shippo_test_` token, and live webhooks with the live key URL once you switch to a live token. Webhooks can also be created with Shippo's API (`POST https://api.goshippo.com/webhooks/` with `url`, `event` and `is_test`).
3. **Test it.** Use Shippo's test button next to the webhook, or send a request yourself:

   ```bash
   curl -X POST 'https://{store-id}:{public-key}@{store-id}.swell.store/functions/shippo/shippo-webhook' \
     -H 'Content-Type: application/json' \
     -d '{"event":"track_updated","test":true,"data":{}}'
   ```

   A working webhook answers `200` with a JSON body starting with `{"received":true`. Then check the app's function logs (`swell logs --type function -s Shippo`) for the `shippo-webhook` call.

**Troubleshooting**

| Response | Cause |
|---|---|
| `404` `Function app.shippo.shippo-webhook not found` | The public key is missing from the URL, belongs to another store, or the app isn't installed in that environment. |
| `200` but nothing changes | **Enabled** is off in the app settings, the order was sent with a different Shippo token (test vs live), or the event isn't one of the three above. |

Shippo doesn't sign webhooks, and the app doesn't need a secret: it never trusts what a webhook says. How the handler checks requests is described under [How it works](#how-it-works).

## How it works

| Function | Trigger | What it does |
|---|---|---|
| `functions/shipping-rates.ts` | `after:order.shipping`, extension `shippo` | Gets Shippo rates and adds them to `shipment_rating.services`. |
| `functions/order-events.ts` | `order.submitted`, `order.paid` | Sends the order to Shippo on the event chosen in settings. |
| `functions/sync-labels.ts` | Cron, every 15 minutes | Checks orders awaiting a label and fulfills those with one. |
| `functions/shippo-webhook.ts` | Public route, `POST` | Receives Shippo webhooks: runs the label check, handles refunded labels and saves tracking. |
| `functions/test-connection.ts` | Settings action | Checks the token and lists carriers. |
| `functions/check-labels.ts` | Settings action | Runs the label check now. |
| `functions/send-to-shippo.ts` | Order page action | Sends one order to Shippo. |
| `functions/lib/shippo.ts` | Shared | Shippo API client, addresses, parcels, rate mapping, order mapping. |
| `functions/lib/orders.ts` | Shared | Sends one Swell order to Shippo and saves the result. |
| `functions/lib/labels.ts` | Shared | Label check, Swell shipment creation, refunds, tracking. |

Data stored on each order under `$app.shippo` (`models/orders.json`): `shippo_order_id`, `shippo_status` (`awaiting_label`, `label_created` or `error`), `shippo_transaction_id`, `shippo_tracking_number`, `shippo_tracking_url`, `shippo_label_url`, `shippo_carrier`, `shippo_service`, `shippo_shipment_id`, `shippo_tracking_status`, `shippo_tracking_details`, `shippo_tracking_date`, `shippo_eta`, `shippo_checked_at`, `shippo_error`.

**Rates:** each option's ID is `shippo_` plus the Shippo service level token, e.g. `shippo_usps_priority`, so it stays stable between rate requests. The price is in the cart currency: Shippo quotes each rate in the sender's and in the recipient's currency, and the app uses whichever matches. Options also carry `shippo_provider` and `shippo_servicelevel`. The rate request includes the customer's email as part of the ship-to address. The rating hook's data holds only the cart fields that changed (shipping address, rating, currency). The rest of the cart, including items and `account_id`, comes from the stored record in `$record`, and the app merges the two. The cart has only `account_id`, so the app looks up the account's email, and leaves it out if there's no account yet.

**Weights:** Swell item weights are line totals in the store's weight unit (`/settings/shipments` → `weight_unit`). They're summed and sent to Shippo in that unit, for checkout rates and for the order weight Shippo requires on every order. If the items have no weight, the default weight and unit are used.

**Label matching:** Shippo labels (transactions) don't say which order they belong to, but a Shippo order lists its labels. So the app reads each pending Shippo order (`GET /orders/{id}`), then its transactions (`GET /transactions/{id}`), and takes the first with status `SUCCESS`. The carrier and service come from the label's rate (`GET /rates/{id}`). Each pass checks up to 10 orders, least recently checked first, and stops starting new ones after about 6 seconds.

**Swell shipments:** `carrier` is the Shippo provider name in lowercase with underscores (`USPS` → `usps`, `DHL Express` → `dhl_express`), which matches Swell's own carrier IDs. `service` is the readable service name, and `notes` has the Shippo label ID and tracking link. Shippo can deliver the same webhook twice at the same moment, so before creating a shipment the app reuses an active one with the label's tracking number, and if two runs still each create one, the later copy cancels itself.

**Webhook security:** Shippo doesn't sign webhooks, and the URL carries no secret. The handler never trusts the payload instead: transactions are loaded again with `GET /transactions/{id}` and tracking with `GET /tracks/{carrier}/{number}` using your API token, so a forged call can at most make the app re-check real labels or tracking numbers. The handler answers right away and does the work after responding, because Shippo waits only 3 seconds.

## Limits

- **Labels are bought in Shippo:** the app doesn't buy labels. The rate the customer picked at checkout isn't reserved; buy the label on Shippo's Orders page.
- **Shippo orders can't be changed or canceled through the API:** a canceled Swell order stays on Shippo's Orders page, and edits made in Swell after sending aren't synced. The app stops checking canceled orders for labels.
- **One parcel, one label per order:** rates use one box with the default dimensions. Only the first purchased label of a Shippo order is used to fulfill the Swell order; later labels are ignored.
- **Label check window:** orders older than 60 days aren't checked anymore. Without the webhook, a label can take up to 15 minutes to reach Swell, and with many pending orders a pass checks only 10.
- **Refunded labels and tracking status need the webhook:** without it, voided labels don't cancel the Swell shipment, and the tracking status isn't updated.
- **Currencies:** a rate is shown only if Shippo quoted it in the cart currency (the sender's or the recipient's currency). Otherwise it's skipped, and a warning is logged.
- **Checkout speed:** Shippo has 8 seconds to return rates. If it fails or takes longer, checkout shows only the other services, and the error is logged.
- **International shipments:** no customs declaration is sent with rate requests, so some international rates may be missing. Customs forms are filled in Shippo when buying the label.
- **Weights:** items without a shipping weight add nothing to the parcel weight. The default weight is used only when no item has a weight.
- **Webhook URL credentials:** the Swell public key goes in the URL (`https://{store-id}:{public-key}@…`), the way Swell routes public functions to the right environment. If Shippo refuses URLs with credentials, the webhook can't be used; the 15-minute check still works.
- **Retries:** errors from Shippo are saved to the order's `shippo_error`. Only Shippo 5xx and network errors are retried for order sending. Model-event functions that keep failing are turned off by the platform after about 4 days.

## Development

Source: [swellstores/shippo-app](https://github.com/swellstores/shippo-app) (MIT, see `LICENSE`). Needs the [Swell CLI](https://developers.swell.is/cli) (`swell login`) and Node 20+.

```bash
git clone https://github.com/swellstores/shippo-app && cd shippo-app
npm install
swell app dev          # run functions locally against the test environment
npm test               # vitest: unit tests + read-only integration tests
npm run typecheck
swell app push         # deploy to the store's test environment
swell inspect functions --app=.
swell inspect extensions app.shippo.shippo   # checkout rates activation
swell logs --type function -s Shippo
```

- **Unit tests** (`test/unit/`) mock Swell and the Shippo API (`fetch`) and cover every function and the shared libraries.
- **Integration tests** (`test/integration/`) are read-only and use your `swell login` session against the test store. They check the store weight unit, the app settings and the pending-orders query.
- **Extension activation:** `swell app push` doesn't turn on checkout rates. `swell inspect extensions app.shippo.shippo` shows `not activated` until a merchant turns on Shippo in Settings → Shipping and saves.
- **Actions:** `test-connection`, `check-labels` and `send-to-shippo` are action functions (`action: true`). They can only be run from the dashboard, not with `swell api`.
- **Schema validation:** in Swell CLI 2.9.19, `swell schema <type> <file>` fails on every file with `no schema with key or ref "https://json-schema.org/draft/2020-12/schema"`, and the function validator doesn't know `action: true` yet. The manifests were checked against the CLI's own bundled schemas (`swell schema <type> --format=json-schema-bundle`) with Ajv's 2020-12 validator, and the platform validates everything again on `swell app push`.
- **Webhook URL:** the webhook only responds after `swell app push`; under `swell app dev` it isn't reachable publicly. Without a public key in the URL, the store host answers 404 (`Function app.shippo.shippo-webhook not found`).

Listing assets: `assets/icon.png` is the Shippo hippo mark (512×512, Shippo ink `#0e242d` on white), taken from the vector logo on goshippo.com. `images` in `swell.json` points at four 3200×1800 App Store images in `assets/screenshots/`: `1-settings.png` (API token and ship-from address), `2-shipping.png` (turning on Shippo in Settings → Shipping), `3-orders.png` (the Shippo status column in the order list) and `4-order.png` (the Shippo tab of a labeled order).
