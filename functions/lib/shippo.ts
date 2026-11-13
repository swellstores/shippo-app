const API_BASE = 'https://api.goshippo.com';
const API_VERSION = '2018-02-08';

// Shippo answers rate requests synchronously; leave room for the 10s function limit
export const DEFAULT_TIMEOUT_MS = 8000;

export const SERVICE_PREFIX = 'shippo_';

export interface ShippoSettings {
  api_token?: string;
  enabled?: boolean;
  from_name?: string;
  from_company?: string;
  from_street1?: string;
  from_street2?: string;
  from_city?: string;
  from_state?: string;
  from_zip?: string;
  from_country?: string;
  from_phone?: string;
  from_email?: string;
  rates_enabled?: boolean;
  carrier_accounts?: string;
  service_levels?: string;
  markup_percent?: number;
  handling_fee?: number;
  show_delivery_days?: boolean;
  parcel_length?: number;
  parcel_width?: number;
  parcel_height?: number;
  distance_unit?: string;
  default_weight?: number;
  mass_unit?: string;
  send_orders?: boolean;
  sync_on?: 'paid' | 'submitted';
  create_fulfillment?: boolean;
}

export interface ShippoAddress {
  name?: string;
  company?: string;
  street1?: string;
  street2?: string;
  city?: string;
  state?: string;
  zip?: string;
  country: string;
  phone?: string;
  email?: string;
}

export interface ShippoRate {
  object_id: string;
  amount: string;
  currency: string;
  amount_local?: string;
  currency_local?: string;
  provider: string;
  servicelevel?: { name?: string; token?: string };
  estimated_days?: number | null;
  duration_terms?: string;
}

export interface ShippoTransaction {
  object_id: string;
  status?: string;
  object_state?: string;
  tracking_number?: string;
  tracking_url_provider?: string;
  label_url?: string;
  rate?: string | { object_id?: string; provider?: string; servicelevel_name?: string; servicelevel_token?: string };
  tracking_status?: string;
  eta?: string;
}

export interface SwellService {
  id: string;
  name: string;
  price: number;
  description?: string;
  carrier?: string;
  [key: string]: unknown;
}

export class ShippoError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

// a thrown 400 shows in the admin as a red error popup, a returned { message } as a regular one
export function fail(message: string): never {
  throw new SwellError(message, { status: 400 });
}

export async function getShippoSettings(swell: SwellAPI): Promise<ShippoSettings> {
  const all = await swell.settings();
  return all?.shippo || {};
}

export function hasToken(settings: ShippoSettings): boolean {
  return Boolean(settings.api_token?.trim());
}

export function isTestToken(token?: string): boolean {
  return Boolean(token?.trim().startsWith('shippo_test_'));
}

// Shippo errors come as { detail }, { field: [messages] } or a list of messages
export function formatShippoError(json: any, fallback: string): string {
  if (!json) {
    return fallback;
  }
  if (typeof json === 'string') {
    return json;
  }
  if (Array.isArray(json)) {
    return json.map((item) => formatShippoError(item, '')).filter(Boolean).join('; ') || fallback;
  }
  if (typeof json.detail === 'string') {
    return json.detail;
  }
  if (typeof json.text === 'string') {
    return json.text;
  }
  const parts = Object.entries(json).map(([key, value]) => {
    const text = formatShippoError(value, '');
    return key === '__all__' || key === 'non_field_errors' ? text : `${key}: ${text}`;
  });
  return parts.filter(Boolean).join('; ') || fallback;
}

export async function shippoRequest(
  settings: ShippoSettings,
  method: string,
  path: string,
  body?: object,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<any> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method,
      headers: {
        Authorization: `ShippoToken ${settings.api_token?.trim()}`,
        'Shippo-API-Version': API_VERSION,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw new ShippoError(`Shippo did not respond within ${timeoutMs / 1000}s`, 504);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // not JSON
  }

  if (!res.ok) {
    throw new ShippoError(`Shippo ${res.status}: ${formatShippoError(json, text || res.statusText)}`, res.status);
  }

  return json;
}

// --- addresses, weights, parcels ---

export function splitList(value?: string): string[] {
  return (value || '')
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

// ship-from address from settings; null until the required fields are filled in
export function fromAddress(settings: ShippoSettings): ShippoAddress | null {
  const required = [settings.from_street1, settings.from_city, settings.from_zip, settings.from_country];
  if (required.some((value) => !value?.trim())) {
    return null;
  }

  return {
    name: settings.from_name?.trim() || settings.from_company?.trim() || undefined,
    company: settings.from_company?.trim() || undefined,
    street1: settings.from_street1!.trim(),
    street2: settings.from_street2?.trim() || undefined,
    city: settings.from_city!.trim(),
    state: settings.from_state?.trim() || undefined,
    zip: settings.from_zip!.trim(),
    country: settings.from_country!.trim().toUpperCase(),
    phone: settings.from_phone?.trim() || undefined,
    email: settings.from_email?.trim() || undefined,
  };
}

// Swell address (order/cart `shipping`) to a Shippo address
export function toAddress(address: any, email?: string): ShippoAddress | null {
  if (!address?.country) {
    return null;
  }

  return {
    name: address.name || `${address.first_name || ''} ${address.last_name || ''}`.trim() || undefined,
    company: address.company || undefined,
    street1: address.address1 || undefined,
    street2: address.address2 || undefined,
    city: address.city || undefined,
    state: address.state || undefined,
    zip: address.zip || undefined,
    country: String(address.country).toUpperCase(),
    phone: address.phone || undefined,
    email: email || undefined,
  };
}

// hook data carries account_id but usually not the expanded account
export async function getAccountEmail(swell: SwellAPI, record: any): Promise<string | undefined> {
  if (record?.account?.email) {
    return record.account.email;
  }
  if (!record?.account_id) {
    return undefined;
  }
  try {
    const account = await swell.get(`/accounts/${record.account_id}`, { fields: 'email' });
    return account?.email || undefined;
  } catch (err: any) {
    console.warn(`Shippo: could not load account ${record.account_id} - ${err?.message || err}`);
    return undefined;
  }
}

const WEIGHT_UNITS = ['g', 'kg', 'lb', 'oz'];

export async function getWeightUnit(swell: SwellAPI): Promise<string> {
  const shipments = await swell.get('/settings/shipments');
  const unit = shipments?.weight_unit;
  return WEIGHT_UNITS.includes(unit) ? unit : 'lb';
}

export function shippableItems(record: any): any[] {
  return (record?.items || []).filter((item: any) => item.delivery === 'shipment');
}

// Swell item weights are line totals in the store's weight unit
export function totalWeight(items: any[]): number {
  return items.reduce((sum, item) => sum + (Number(item.shipment_weight) || 0), 0);
}

function decimal(value: number, digits = 4): string {
  return String(Math.round(value * 10 ** digits) / 10 ** digits);
}

export function money(value: number | undefined | null): string {
  return (Math.round((Number(value) || 0) * 100) / 100).toFixed(2);
}

// one parcel per order: default box dimensions and the items' total weight
export function buildParcel(items: any[], settings: ShippoSettings, weightUnit: string) {
  const weight = totalWeight(items);
  const useDefault = weight <= 0;
  const massUnit = useDefault ? settings.mass_unit || 'lb' : weightUnit;

  return {
    length: decimal(Number(settings.parcel_length) || 10),
    width: decimal(Number(settings.parcel_width) || 8),
    height: decimal(Number(settings.parcel_height) || 4),
    distance_unit: settings.distance_unit || 'in',
    weight: decimal(useDefault ? Number(settings.default_weight) || 1 : weight),
    mass_unit: WEIGHT_UNITS.includes(massUnit) ? massUnit : 'lb',
  };
}

// --- checkout rates ---

export async function createShipment(settings: ShippoSettings, shipment: object): Promise<any> {
  return shippoRequest(settings, 'POST', '/shipments/', shipment);
}

export function buildShipment(record: any, settings: ShippoSettings, weightUnit: string) {
  const from = fromAddress(settings);
  const to = toAddress(record?.shipping, record?.account?.email);
  const items = shippableItems(record);

  if (!from || !to || !items.length) {
    return null;
  }

  const carrierAccounts = splitList(settings.carrier_accounts);

  return {
    address_from: from,
    address_to: to,
    parcels: [buildParcel(items, settings, weightUnit)],
    async: false,
    ...(carrierAccounts.length && { carrier_accounts: carrierAccounts }),
  };
}

export function serviceId(rate: ShippoRate): string {
  const token = rate.servicelevel?.token || `${rate.provider}_${rate.servicelevel?.name || ''}`;
  return `${SERVICE_PREFIX}${token.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

// rate price in the cart currency, or null when Shippo did not quote that currency
export function ratePrice(rate: ShippoRate, currency?: string): number | null {
  const wanted = currency?.toUpperCase();
  if (!wanted || rate.currency?.toUpperCase() === wanted) {
    return Number(rate.amount);
  }
  if (rate.currency_local?.toUpperCase() === wanted && rate.amount_local !== undefined) {
    return Number(rate.amount_local);
  }
  return null;
}

export function applyMarkup(price: number, settings: ShippoSettings): number {
  const markup = Number(settings.markup_percent) || 0;
  const fee = Number(settings.handling_fee) || 0;
  return Math.max(Math.round((price * (1 + markup / 100) + fee) * 100) / 100, 0);
}

export function deliveryDescription(rate: ShippoRate): string | undefined {
  const days = rate.estimated_days;
  if (typeof days === 'number' && days > 0) {
    return days === 1 ? 'Estimated delivery in 1 day' : `Estimated delivery in ${days} days`;
  }
  return rate.duration_terms || undefined;
}

// Shippo rates to Swell shipment services, cheapest first, one per service level
export function ratesToServices(rates: ShippoRate[], settings: ShippoSettings, currency?: string): SwellService[] {
  const allowed = splitList(settings.service_levels).map((token) => token.toLowerCase());
  const byId = new Map<string, SwellService>();

  for (const rate of rates || []) {
    const token = rate.servicelevel?.token?.toLowerCase();
    if (allowed.length && (!token || !allowed.includes(token))) {
      continue;
    }

    const price = ratePrice(rate, currency);
    if (price === null || !Number.isFinite(price)) {
      continue;
    }

    const service: SwellService = {
      id: serviceId(rate),
      name: [rate.provider, rate.servicelevel?.name].filter(Boolean).join(' '),
      price: applyMarkup(price, settings),
      carrier: 'shippo',
      shippo_provider: rate.provider,
      shippo_servicelevel: rate.servicelevel?.token,
    };

    const description = settings.show_delivery_days === false ? undefined : deliveryDescription(rate);
    if (description) {
      service.description = description;
    }

    const existing = byId.get(service.id);
    if (!existing || service.price < existing.price) {
      byId.set(service.id, service);
    }
  }

  return [...byId.values()].sort((a, b) => a.price - b.price);
}

// --- orders ---

export async function createOrder(settings: ShippoSettings, order: object): Promise<any> {
  return shippoRequest(settings, 'POST', '/orders/', order);
}

export async function getOrder(settings: ShippoSettings, orderId: string): Promise<any> {
  return shippoRequest(settings, 'GET', `/orders/${encodeURIComponent(orderId)}`);
}

export async function getTransaction(settings: ShippoSettings, transactionId: string): Promise<ShippoTransaction> {
  return shippoRequest(settings, 'GET', `/transactions/${encodeURIComponent(transactionId)}`);
}

export async function getRate(settings: ShippoSettings, rateId: string): Promise<any> {
  return shippoRequest(settings, 'GET', `/rates/${encodeURIComponent(rateId)}`);
}

export async function listCarrierAccounts(settings: ShippoSettings): Promise<any[]> {
  const result = await shippoRequest(settings, 'GET', '/carrier_accounts/?results=100');
  return result?.results || [];
}

// POST /orders payload for one Swell order
export function buildShippoOrder(order: any, settings: ShippoSettings, weightUnit: string): object {
  const currency = order.currency;
  const email = order.account?.email;
  const items = shippableItems(order);
  // Shippo requires an order weight; items without weights fall back to the default parcel weight
  const parcel = buildParcel(items, settings, weightUnit);
  const from = fromAddress(settings);

  return {
    order_number: String(order.number),
    order_status: order.paid ? 'PAID' : 'AWAITPAY',
    placed_at: order.date_created,
    to_address: toAddress(order.shipping, email),
    ...(from && { from_address: from }),
    line_items: items.map((item: any) => ({
      title: (item.product?.name || item.product_name || 'Item').slice(0, 255),
      variant_title: item.variant?.name || item.variant_name || undefined,
      sku: item.variant?.sku || item.product?.sku || undefined,
      quantity: item.quantity || 1,
      total_price: money(item.price_total),
      currency,
      ...(Number(item.shipment_weight) > 0 && {
        weight: decimal(Number(item.shipment_weight)),
        weight_unit: weightUnit,
      }),
      manufacture_country: item.product?.origin_country || undefined,
    })),
    currency,
    subtotal_price: money(order.sub_total),
    total_price: money(order.grand_total),
    total_tax: money(order.tax_total),
    shipping_cost: money(order.shipment_total),
    shipping_cost_currency: currency,
    shipping_method: order.shipping?.service_name || undefined,
    weight: parcel.weight,
    weight_unit: parcel.mass_unit,
    notes: order.comments || undefined,
  };
}

// app values on a standard record are keyed by app slug in responses
export function getAppData(record: any, appId: string): Record<string, any> {
  return record?.$app?.[appId] || record?.$app?.shippo || {};
}

// Swell carrier ids match Shippo provider names: "DHL Express" -> dhl_express
export function carrierId(provider?: string): string | undefined {
  return provider ? provider.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') : undefined;
}
