import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/shipping-rates";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, SHIPPING, jsonResponse, makeRate, mockShippo, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const NATIVE = { id: "standard", name: "Standard Shipping", price: 5 };

function cart(overrides: Record<string, any> = {}) {
  return {
    id: "cart_1",
    currency: "USD",
    shipping: SHIPPING,
    items: [{ id: "i1", delivery: "shipment", quantity: 1, shipment_weight: 500 }],
    shipment_rating: {
      fingerprint: "fp",
      services: [NATIVE, { id: "shippo_old", name: "Old", price: 1 }],
    },
    $event: { type: "order.shipping", hook: "after" },
    ...overrides,
  };
}

function request(settings: Record<string, any>, data: Record<string, any> = cart()) {
  return createMockRequest({
    appId: "shippo",
    data,
    swell: {
      settings: vi.fn().mockResolvedValue({ shippo: settings }),
      get: routeGet({ "/settings/shipments": { weight_unit: "g" }, "/accounts/acc_1": { email: "jane@example.com" } }),
    },
  });
}

describe("shipping-rates", () => {
  it("is bound to the shippo extension's rating hook", () => {
    expect(config).toMatchObject({
      extension: "shippo",
      model: { events: ["after:order.shipping"], fields: ["shipment_rating"] },
    });
  });

  it("adds Shippo services and keeps the other services", async () => {
    const { calls } = mockShippo({
      "POST /shipments/": { rates: [makeRate(), makeRate({ amount: "4.10", provider: "UPS", servicelevel: { name: "Ground", token: "ups_ground" } })] },
    });

    const result: any = await handler(request(SETTINGS));

    expect(calls[0].body.parcels[0]).toMatchObject({ weight: "500", mass_unit: "g" });
    expect(calls[0].body.address_to.zip).toBe("94103");
    expect(result.shipment_rating.fingerprint).toBe("fp");
    expect(result.shipment_rating.services.map((s: any) => [s.id, s.price])).toEqual([
      ["standard", 5],
      ["shippo_ups_ground", 4.1],
      ["shippo_usps_priority", 7.5],
    ]);
  });

  it("sends the customer email, loading the account when the cart has only account_id", async () => {
    const { calls } = mockShippo({ "POST /shipments/": { rates: [makeRate()] } });
    vi.spyOn(console, "log").mockImplementation(() => {});

    await handler(request(SETTINGS, cart({ account_id: "acc_1" })));

    expect(calls[0].body.address_to.email).toBe("jane@example.com");
  });

  it("reads items and account_id from $record when the hook data has only the changed fields", async () => {
    const { calls } = mockShippo({ "POST /shipments/": { rates: [makeRate()] } });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const { items, ...changed } = cart();

    const result: any = await handler(
      request(SETTINGS, { ...changed, account: {}, $record: { items, account_id: "acc_1", currency: "USD" } }),
    );

    expect(calls[0].body.parcels[0]).toMatchObject({ weight: "500", mass_unit: "g" });
    expect(calls[0].body.address_to.email).toBe("jane@example.com");
    expect(result.shipment_rating.services.map((s: any) => s.id)).toEqual(["standard", "shippo_usps_priority"]);
  });

  it("works when there were no services yet", async () => {
    mockShippo({ "POST /shipments/": { rates: [makeRate()] } });
    const result: any = await handler(request(SETTINGS, cart({ shipment_rating: undefined })));
    expect(result.shipment_rating.services.map((s: any) => s.id)).toEqual(["shippo_usps_priority"]);
  });

  it("logs Shippo messages when no rates come back", async () => {
    mockShippo({ "POST /shipments/": { rates: [], messages: [{ source: "UPS", text: "Invalid zip" }] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const result: any = await handler(request(SETTINGS));

    expect(warn).toHaveBeenCalledWith("Shippo: no rates", ["UPS: Invalid zip"]);
    expect(result.shipment_rating.services).toEqual([NATIVE]);
  });

  it("warns when no rate is in the cart currency", async () => {
    mockShippo({ "POST /shipments/": { rates: [makeRate()] } });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await handler(request(SETTINGS, cart({ currency: "EUR" })));

    expect(warn).toHaveBeenCalledWith(expect.stringContaining("none in EUR"));
  });

  it("leaves rating untouched when Shippo fails", async () => {
    mockShippo({ "POST /shipments/": jsonResponse({ detail: "Invalid token." }, 401) });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await handler(request(SETTINGS))).toBeUndefined();
    expect(error).toHaveBeenCalledWith("Shippo: rate request failed - Shippo 401: Invalid token.");
  });

  it("does nothing when disabled, rates are off, or the token is missing", async () => {
    const { fetchMock } = mockShippo({});
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(await handler(request({ ...SETTINGS, enabled: false }))).toBeUndefined();
    expect(await handler(request({ ...SETTINGS, rates_enabled: false }))).toBeUndefined();
    expect(await handler(request({ ...SETTINGS, api_token: "" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing until there is an address and something to ship", async () => {
    const { fetchMock } = mockShippo({});

    expect(await handler(request(SETTINGS, cart({ shipping: {} })))).toBeUndefined();
    expect(await handler(request(SETTINGS, cart({ items: [] })))).toBeUndefined();
    expect(await handler(request({ ...SETTINGS, from_zip: "" }))).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
