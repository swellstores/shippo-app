import { vi } from "vitest";
import type { ShippoSettings } from "../../functions/lib/shippo";

export const SETTINGS: ShippoSettings = {
  api_token: "shippo_test_abc",
  enabled: true,
  from_name: "Alder & Co.",
  from_street1: "215 Clayton St",
  from_city: "San Francisco",
  from_state: "CA",
  from_zip: "94117",
  from_country: "us",
  rates_enabled: true,
  markup_percent: 0,
  handling_fee: 0,
  show_delivery_days: true,
  parcel_length: 10,
  parcel_width: 8,
  parcel_height: 4,
  distance_unit: "in",
  default_weight: 1,
  mass_unit: "lb",
  send_orders: true,
  sync_on: "paid",
  create_fulfillment: true,
  webhook_secret: "s3cret-token",
};

export const SHIPPING = {
  first_name: "Jane",
  last_name: "Doe",
  address1: "965 Mission St",
  city: "San Francisco",
  state: "CA",
  zip: "94103",
  country: "US",
  service_name: "USPS Priority Mail",
};

export function makeOrder(overrides: Record<string, any> = {}) {
  return {
    id: "64f0c0ffee0000000000aaaa",
    number: "100123",
    paid: true,
    currency: "USD",
    grand_total: 44.9,
    sub_total: 39.9,
    shipment_total: 5,
    tax_total: 0,
    date_created: "2026-10-01T10:00:00.000Z",
    account: { email: "jane@example.com" },
    shipping: { ...SHIPPING },
    items: [
      {
        id: "item_1",
        delivery: "shipment",
        quantity: 2,
        quantity_shipment_deliverable: 2,
        shipment_weight: 3,
        price: 19.95,
        price_total: 39.9,
        product_id: "prod_1",
        variant_id: "var_1",
        product: { name: "Mug", sku: "MUG" },
      },
    ],
    ...overrides,
  };
}

export function makeRate(overrides: Record<string, any> = {}) {
  return {
    object_id: "rate_1",
    amount: "7.50",
    currency: "USD",
    amount_local: "7.50",
    currency_local: "USD",
    provider: "USPS",
    servicelevel: { name: "Priority Mail", token: "usps_priority" },
    estimated_days: 2,
    duration_terms: "Delivery in 1 to 3 business days.",
    ...overrides,
  };
}

// swell.get mock that answers by path
export function routeGet(routes: Record<string, unknown>) {
  return vi.fn(async (url: string, ...args: unknown[]) => {
    for (const [prefix, value] of Object.entries(routes)) {
      if (url === prefix || url.startsWith(`${prefix}?`)) {
        return typeof value === "function" ? (value as (...a: unknown[]) => unknown)(...args) : value;
      }
    }
    return null;
  });
}

export function jsonResponse(body: unknown, status = 200) {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// fetch mock that answers Shippo requests by "METHOD /path" prefix
export function mockShippo(routes: Record<string, unknown | ((body: any) => unknown)>) {
  const calls: { method: string; path: string; body: any; headers: Headers }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = (init.method || "GET").toUpperCase();
    const path = url.pathname + url.search;
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body, headers: new Headers(init.headers) });

    for (const [key, value] of Object.entries(routes)) {
      const [routeMethod, routePath] = key.split(" ");
      if (routeMethod === method && path.startsWith(routePath)) {
        const result = typeof value === "function" ? (value as (b: any) => unknown)(body) : value;
        return result instanceof Response ? result : jsonResponse(result);
      }
    }
    return jsonResponse({ detail: `Not mocked: ${method} ${path}` }, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}
