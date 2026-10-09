import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ShippoError,
  applyMarkup,
  buildParcel,
  buildShipment,
  buildShippoOrder,
  carrierId,
  createOrder,
  createShipment,
  deliveryDescription,
  formatShippoError,
  fromAddress,
  getAccountEmail,
  getAppData,
  getOrder,
  getRate,
  getShippoSettings,
  getTransaction,
  getWeightUnit,
  hasToken,
  isTestToken,
  listCarrierAccounts,
  money,
  ratePrice,
  ratesToServices,
  serviceId,
  shippableItems,
  shippoRequest,
  splitList,
  toAddress,
  totalWeight,
} from "../../functions/lib/shippo";
import { SETTINGS, SHIPPING, jsonResponse, makeOrder, makeRate, mockShippo } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("settings helpers", () => {
  it("getShippoSettings reads the shippo settings group", async () => {
    const swell = { settings: vi.fn().mockResolvedValue({ shippo: { api_token: "t" } }) };
    expect(await getShippoSettings(swell as any)).toEqual({ api_token: "t" });
  });

  it("getShippoSettings returns {} when nothing is saved", async () => {
    const swell = { settings: vi.fn().mockResolvedValue(null) };
    expect(await getShippoSettings(swell as any)).toEqual({});
  });

  it("hasToken ignores blank tokens", () => {
    expect(hasToken({ api_token: " shippo_test_x " })).toBe(true);
    expect(hasToken({ api_token: "  " })).toBe(false);
    expect(hasToken({})).toBe(false);
  });

  it("isTestToken detects Shippo test tokens", () => {
    expect(isTestToken("shippo_test_abc")).toBe(true);
    expect(isTestToken("shippo_live_abc")).toBe(false);
    expect(isTestToken(undefined)).toBe(false);
  });

  it("splitList splits on commas and whitespace", () => {
    expect(splitList(" usps_priority, ups_ground\nfedex_2_day ,,")).toEqual([
      "usps_priority",
      "ups_ground",
      "fedex_2_day",
    ]);
    expect(splitList(undefined)).toEqual([]);
  });
});

describe("formatShippoError", () => {
  it("uses detail", () => {
    expect(formatShippoError({ detail: "Invalid token." }, "x")).toBe("Invalid token.");
  });

  it("joins field errors", () => {
    expect(formatShippoError({ to_address: { zip: ["This field is required."] } }, "x")).toBe(
      "to_address: zip: This field is required.",
    );
  });

  it("drops __all__ prefixes and joins lists", () => {
    expect(formatShippoError({ __all__: ["A", "B"] }, "x")).toBe("A; B");
  });

  it("falls back for empty bodies", () => {
    expect(formatShippoError(null, "Bad Request")).toBe("Bad Request");
    expect(formatShippoError({}, "Bad Request")).toBe("Bad Request");
  });

  it("returns plain strings as is", () => {
    expect(formatShippoError("nope", "x")).toBe("nope");
  });
});

describe("shippoRequest", () => {
  it("sends the ShippoToken header, API version and JSON body", async () => {
    const { calls } = mockShippo({ "POST /orders/": { object_id: "o1" } });
    const result = await shippoRequest({ api_token: " shippo_test_abc " }, "POST", "/orders/", { a: 1 });

    expect(result).toEqual({ object_id: "o1" });
    expect(calls[0].headers.get("authorization")).toBe("ShippoToken shippo_test_abc");
    expect(calls[0].headers.get("shippo-api-version")).toBe("2018-02-08");
    expect(calls[0].body).toEqual({ a: 1 });
  });

  it("throws ShippoError with status and message", async () => {
    mockShippo({ "GET /orders/x": jsonResponse({ detail: "Not found." }, 404) });
    const err = await shippoRequest(SETTINGS, "GET", "/orders/x").catch((e) => e);

    expect(err).toBeInstanceOf(ShippoError);
    expect(err.status).toBe(404);
    expect(err.message).toBe("Shippo 404: Not found.");
  });

  it("uses the response text when the error isn't JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("Bad gateway", { status: 502 })));
    const err = await shippoRequest(SETTINGS, "GET", "/x").catch((e) => e);
    expect(err.message).toBe("Shippo 502: Bad gateway");
  });

  it("returns null for empty bodies", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 200 })));
    expect(await shippoRequest(SETTINGS, "GET", "/x")).toBeNull();
  });

  it("turns a timeout into a 504 ShippoError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        });
      }),
    );
    const err = await shippoRequest(SETTINGS, "GET", "/x", undefined, 20).catch((e) => e);
    expect(err).toBeInstanceOf(ShippoError);
    expect(err.status).toBe(504);
  });

  it("rethrows network errors", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("network down")));
    await expect(shippoRequest(SETTINGS, "GET", "/x")).rejects.toThrow("network down");
  });
});

describe("API wrappers", () => {
  it("call the right endpoints", async () => {
    const { calls } = mockShippo({
      "POST /shipments/": { rates: [] },
      "POST /orders/": { object_id: "o1" },
      "GET /orders/o%2F1": { object_id: "o/1" },
      "GET /transactions/t1": { object_id: "t1" },
      "GET /rates/r1": { object_id: "r1" },
      "GET /carrier_accounts/": { results: [{ carrier: "usps" }] },
    });

    await createShipment(SETTINGS, { a: 1 });
    await createOrder(SETTINGS, { b: 2 });
    await getOrder(SETTINGS, "o/1");
    await getTransaction(SETTINGS, "t1");
    await getRate(SETTINGS, "r1");
    expect(await listCarrierAccounts(SETTINGS)).toEqual([{ carrier: "usps" }]);

    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      "POST /shipments/",
      "POST /orders/",
      "GET /orders/o%2F1",
      "GET /transactions/t1",
      "GET /rates/r1",
      "GET /carrier_accounts/?results=100",
    ]);
  });

  it("listCarrierAccounts returns [] without results", async () => {
    mockShippo({ "GET /carrier_accounts/": {} });
    expect(await listCarrierAccounts(SETTINGS)).toEqual([]);
  });
});

describe("addresses", () => {
  it("fromAddress builds the ship-from address and uppercases the country", () => {
    expect(fromAddress(SETTINGS)).toEqual({
      name: "Alder & Co.",
      company: undefined,
      street1: "215 Clayton St",
      street2: undefined,
      city: "San Francisco",
      state: "CA",
      zip: "94117",
      country: "US",
      phone: undefined,
      email: undefined,
    });
  });

  it("fromAddress falls back to the company as name", () => {
    expect(fromAddress({ ...SETTINGS, from_name: "", from_company: "Alder" })?.name).toBe("Alder");
  });

  it("fromAddress is null while required fields are missing", () => {
    expect(fromAddress({ ...SETTINGS, from_zip: " " })).toBeNull();
    expect(fromAddress({})).toBeNull();
  });

  it("toAddress maps a Swell address", () => {
    expect(toAddress({ ...SHIPPING, country: "us", phone: "555" }, "jane@example.com")).toEqual({
      name: "Jane Doe",
      company: undefined,
      street1: "965 Mission St",
      street2: undefined,
      city: "San Francisco",
      state: "CA",
      zip: "94103",
      country: "US",
      phone: "555",
      email: "jane@example.com",
    });
  });

  it("toAddress prefers the full name and needs a country", () => {
    expect(toAddress({ name: "J D", country: "CA" })?.name).toBe("J D");
    expect(toAddress({ address1: "x" })).toBeNull();
    expect(toAddress(undefined)).toBeNull();
  });
});

describe("weights and parcels", () => {
  it("getWeightUnit reads the store weight unit", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ weight_unit: "g" }) };
    expect(await getWeightUnit(swell as any)).toBe("g");
    expect(swell.get).toHaveBeenCalledWith("/settings/shipments");
  });

  it("getWeightUnit defaults to lb for unknown units", async () => {
    const swell = { get: vi.fn().mockResolvedValue({ weight_unit: "stone" }) };
    expect(await getWeightUnit(swell as any)).toBe("lb");
  });

  it("shippableItems keeps shipment items only", () => {
    const items = [{ delivery: "shipment" }, { delivery: "giftcard" }, { delivery: null }];
    expect(shippableItems({ items })).toEqual([{ delivery: "shipment" }]);
    expect(shippableItems(null)).toEqual([]);
  });

  it("totalWeight sums line weights", () => {
    expect(totalWeight([{ shipment_weight: 1.5 }, { shipment_weight: "2" }, {}])).toBe(3.5);
  });

  it("money formats to 2 decimals", () => {
    expect(money(4.005)).toBe("4.01");
    expect(money(undefined)).toBe("0.00");
  });

  it("buildParcel uses item weights in the store unit", () => {
    expect(buildParcel([{ shipment_weight: 250 }, { shipment_weight: 500 }], SETTINGS, "g")).toEqual({
      length: "10",
      width: "8",
      height: "4",
      distance_unit: "in",
      weight: "750",
      mass_unit: "g",
    });
  });

  it("buildParcel falls back to the default weight and dimensions", () => {
    expect(buildParcel([{ shipment_weight: 0 }], { default_weight: 2.5, mass_unit: "kg" }, "g")).toEqual({
      length: "10",
      width: "8",
      height: "4",
      distance_unit: "in",
      weight: "2.5",
      mass_unit: "kg",
    });
  });
});

describe("buildShipment", () => {
  const record = { shipping: SHIPPING, account: { email: "a@b.c" }, items: [{ delivery: "shipment", shipment_weight: 2 }] };

  it("builds a synchronous rate request", () => {
    const shipment: any = buildShipment(record, { ...SETTINGS, carrier_accounts: "ca1, ca2" }, "lb");
    expect(shipment.async).toBe(false);
    expect(shipment.address_from.street1).toBe("215 Clayton St");
    expect(shipment.address_to.zip).toBe("94103");
    expect(shipment.parcels[0].weight).toBe("2");
    expect(shipment.carrier_accounts).toEqual(["ca1", "ca2"]);
  });

  it("omits carrier_accounts when not set", () => {
    expect(buildShipment(record, SETTINGS, "lb")).not.toHaveProperty("carrier_accounts");
  });

  it("is null without a ship-from address, a destination or items", () => {
    expect(buildShipment(record, { ...SETTINGS, from_street1: "" }, "lb")).toBeNull();
    expect(buildShipment({ ...record, shipping: {} }, SETTINGS, "lb")).toBeNull();
    expect(buildShipment({ ...record, items: [] }, SETTINGS, "lb")).toBeNull();
  });
});

describe("rates", () => {
  it("serviceId is stable and prefixed", () => {
    expect(serviceId(makeRate())).toBe("shippo_usps_priority");
    expect(serviceId(makeRate({ servicelevel: { name: "Express 2-Day" }, provider: "DHL" }))).toBe(
      "shippo_dhl_express_2_day",
    );
  });

  it("ratePrice uses the matching currency", () => {
    expect(ratePrice(makeRate(), "usd")).toBe(7.5);
    expect(ratePrice(makeRate({ currency: "USD", amount_local: "10.20", currency_local: "CAD" }), "CAD")).toBe(10.2);
    expect(ratePrice(makeRate(), "EUR")).toBeNull();
    expect(ratePrice(makeRate(), undefined)).toBe(7.5);
  });

  it("applyMarkup adds percent and fee", () => {
    expect(applyMarkup(10, { markup_percent: 10, handling_fee: 1.5 })).toBe(12.5);
    expect(applyMarkup(10, {})).toBe(10);
    expect(applyMarkup(1, { handling_fee: -5 })).toBe(0);
  });

  it("deliveryDescription uses estimated days, then duration terms", () => {
    expect(deliveryDescription(makeRate({ estimated_days: 1 }))).toBe("Estimated delivery in 1 day");
    expect(deliveryDescription(makeRate({ estimated_days: 3 }))).toBe("Estimated delivery in 3 days");
    expect(deliveryDescription(makeRate({ estimated_days: null }))).toBe("Delivery in 1 to 3 business days.");
    expect(deliveryDescription(makeRate({ estimated_days: null, duration_terms: "" }))).toBeUndefined();
  });

  it("ratesToServices maps, filters, dedupes and sorts", () => {
    const rates = [
      makeRate({ amount: "12.00", provider: "UPS", servicelevel: { name: "Ground", token: "ups_ground" } }),
      makeRate({ amount: "7.50" }),
      makeRate({ amount: "6.90", object_id: "rate_dup" }),
      makeRate({ amount: "5", currency: "EUR", currency_local: "EUR", servicelevel: { token: "dhl_x", name: "X" } }),
    ];

    const services = ratesToServices(rates as any, { ...SETTINGS, markup_percent: 10 }, "USD");

    expect(services).toEqual([
      {
        id: "shippo_usps_priority",
        name: "USPS Priority Mail",
        price: 7.59,
        carrier: "shippo",
        shippo_provider: "USPS",
        shippo_servicelevel: "usps_priority",
        description: "Estimated delivery in 2 days",
      },
      {
        id: "shippo_ups_ground",
        name: "UPS Ground",
        price: 13.2,
        carrier: "shippo",
        shippo_provider: "UPS",
        shippo_servicelevel: "ups_ground",
        description: "Estimated delivery in 2 days",
      },
    ]);
  });

  it("ratesToServices honors the service level filter and hides delivery days", () => {
    const rates = [makeRate(), makeRate({ servicelevel: { name: "Ground", token: "ups_ground" } })];
    const services = ratesToServices(rates as any, { service_levels: "UPS_GROUND", show_delivery_days: false }, "USD");

    expect(services.map((s) => s.id)).toEqual(["shippo_ups_ground"]);
    expect(services[0]).not.toHaveProperty("description");
  });

  it("ratesToServices skips unparseable prices", () => {
    expect(ratesToServices([makeRate({ amount: "abc" })] as any, {}, "USD")).toEqual([]);
    expect(ratesToServices(undefined as any, {}, "USD")).toEqual([]);
  });
});

describe("buildShippoOrder", () => {
  it("maps a paid Swell order", () => {
    const order: any = buildShippoOrder(makeOrder({ comments: "Leave at door" }), SETTINGS, "lb");

    expect(order).toMatchObject({
      order_number: "100123",
      order_status: "PAID",
      placed_at: "2026-10-01T10:00:00.000Z",
      currency: "USD",
      subtotal_price: "39.90",
      total_price: "44.90",
      total_tax: "0.00",
      shipping_cost: "5.00",
      shipping_cost_currency: "USD",
      shipping_method: "USPS Priority Mail",
      weight: "3",
      weight_unit: "lb",
      notes: "Leave at door",
    });
    expect(order.to_address).toMatchObject({ name: "Jane Doe", email: "jane@example.com", country: "US" });
    expect(order.from_address.street1).toBe("215 Clayton St");
    expect(order.line_items).toEqual([
      {
        title: "Mug",
        variant_title: undefined,
        sku: "MUG",
        quantity: 2,
        total_price: "39.90",
        currency: "USD",
        weight: "3",
        weight_unit: "lb",
        manufacture_country: undefined,
      },
    ]);
  });

  it("marks unpaid orders, uses the default weight and omits ship-from", () => {
    const order: any = buildShippoOrder(
      makeOrder({
        paid: false,
        items: [{ delivery: "shipment", quantity: 1, product_name: "Tee", variant: { name: "M", sku: "TEE-M" } }],
      }),
      { ...SETTINGS, from_street1: "" },
      "kg",
    );

    expect(order.order_status).toBe("AWAITPAY");
    expect(order).not.toHaveProperty("from_address");
    // Shippo requires an order weight: falls back to the default parcel weight
    expect(order).toMatchObject({ weight: "1", weight_unit: "lb" });
    expect(order.line_items[0]).toMatchObject({ title: "Tee", variant_title: "M", sku: "TEE-M" });
    expect(order.line_items[0]).not.toHaveProperty("weight");
  });
});

describe("getAccountEmail", () => {
  it("uses the expanded account email", async () => {
    const get = vi.fn();
    expect(await getAccountEmail({ get } as any, { account: { email: "a@b.co" }, account_id: "acc_1" })).toBe("a@b.co");
    expect(get).not.toHaveBeenCalled();
  });

  it("loads the account by account_id", async () => {
    const get = vi.fn().mockResolvedValue({ email: "jane@example.com" });
    expect(await getAccountEmail({ get } as any, { account_id: "acc_1" })).toBe("jane@example.com");
    expect(get).toHaveBeenCalledWith("/accounts/acc_1", { fields: "email" });
  });

  it("returns undefined without an account or when the lookup fails", async () => {
    const get = vi.fn().mockRejectedValue(new Error("boom"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await getAccountEmail({ get } as any, {})).toBeUndefined();
    expect(await getAccountEmail({ get } as any, { account_id: "acc_1" })).toBeUndefined();
    expect(await getAccountEmail({ get: vi.fn().mockResolvedValue(null) } as any, { account_id: "acc_1" })).toBeUndefined();
  });
});

describe("misc", () => {
  it("getAppData reads the app namespace", () => {
    expect(getAppData({ $app: { shippo: { a: 1 } } }, "shippo")).toEqual({ a: 1 });
    expect(getAppData({ $app: { shippo: { a: 1 } } }, "6ac74385b432150012c194f6")).toEqual({ a: 1 });
    expect(getAppData({}, "shippo")).toEqual({});
  });

  it("carrierId matches Swell carrier ids", () => {
    expect(carrierId("USPS")).toBe("usps");
    expect(carrierId("DHL Express")).toBe("dhl_express");
    expect(carrierId("FedEx")).toBe("fedex");
    expect(carrierId(undefined)).toBeUndefined();
  });
});
