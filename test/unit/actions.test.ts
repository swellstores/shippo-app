import { afterEach, describe, expect, it, vi } from "vitest";
import checkLabels, { config as checkLabelsConfig } from "../../functions/check-labels";
import sendToShippo, { config as sendToShippoConfig } from "../../functions/send-to-shippo";
import testConnection, { config as testConnectionConfig } from "../../functions/test-connection";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeOrder, mockShippo, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(settings: Record<string, any>, swell: Record<string, any> = {}, data: Record<string, any> = {}) {
  return createMockRequest({
    appId: "shippo",
    data,
    swell: { settings: vi.fn().mockResolvedValue({ shippo: settings }), ...swell },
  });
}

describe("action configs", () => {
  it("are dashboard actions", () => {
    expect(testConnectionConfig.action).toBe(true);
    expect(checkLabelsConfig.action).toBe(true);
    expect(sendToShippoConfig.action).toBe(true);
  });
});

describe("test-connection", () => {
  it("reports the mode and active carriers", async () => {
    mockShippo({
      "GET /carrier_accounts/": {
        results: [
          { carrier: "usps", carrier_name: "USPS", active: true },
          { carrier: "ups", active: true },
          { carrier: "fedex", carrier_name: "FedEx", active: false },
        ],
      },
    });

    expect(await testConnection(request(SETTINGS))).toEqual({
      message: "Connected to Shippo (test token). Active carriers: USPS, ups.",
    });
  });

  it("points out missing carriers and address", async () => {
    mockShippo({ "GET /carrier_accounts/": { results: [] } });
    const { message } = await testConnection(
      request({ api_token: "shippo_live_x", from_street1: "" }),
    );

    expect(message).toContain("Connected to Shippo (live token). Active carriers: none.");
    expect(message).toContain("No active carrier accounts");
    expect(message).toContain("Fill in the ship-from address");
  });

  it("reports a rejected token", async () => {
    mockShippo({ "GET /carrier_accounts/": jsonResponse({ detail: "Invalid token." }, 401) });
    expect(await testConnection(request(SETTINGS))).toEqual({
      message: "Shippo rejected the request: Shippo 401: Invalid token.",
    });
  });

  it("asks for a token first", async () => {
    expect((await testConnection(request({}))).message).toMatch(/Add your Shippo API token/);
  });
});

describe("check-labels", () => {
  it("summarizes the check", async () => {
    mockShippo({ "GET /orders/so_1": jsonResponse({ detail: "Not found." }, 404), "GET /orders/so_2": { transactions: [] } });
    const orders = ["so_1", "so_2"].map((id, i) => makeOrder({ id: `o${i}`, $app: { shippo: { shippo_order_id: id } } }));
    const req = request(SETTINGS, {
      get: vi.fn().mockResolvedValue({ results: orders, count: 12 }),
      put: vi.fn().mockResolvedValue({}),
    });

    expect(await checkLabels(req)).toEqual({
      message:
        "Checked 2 orders, 0 with a new label, 1 with errors (see the Shippo tab on the order). More orders are waiting; run it again or wait for the next automatic check.",
    });
  });

  it("uses the singular for one order", async () => {
    mockShippo({ "GET /orders/so_1": { transactions: [] } });
    const req = request(SETTINGS, {
      get: vi.fn().mockResolvedValue({ results: [makeOrder({ $app: { shippo: { shippo_order_id: "so_1" } } })], count: 1 }),
      put: vi.fn().mockResolvedValue({}),
    });
    expect(await checkLabels(req)).toEqual({ message: "Checked 1 order, 0 with a new label." });
  });

  it("says when nothing is waiting", async () => {
    const req = request(SETTINGS, { get: vi.fn().mockResolvedValue({ results: [], count: 0 }) });
    expect(await checkLabels(req)).toEqual({ message: "No orders are waiting for a Shippo label." });
  });

  it("asks for a token first", async () => {
    expect((await checkLabels(request({}))).message).toMatch(/Add your Shippo API token/);
  });
});

describe("send-to-shippo", () => {
  function sendRequest(settings: Record<string, any>, order: unknown, recordId: unknown = ORDER_ID) {
    return request(
      settings,
      {
        get: routeGet({ [`/orders/${ORDER_ID}`]: order, "/settings/shipments": { weight_unit: "lb" } }),
        put: vi.fn().mockResolvedValue({}),
      },
      { $action: { id: "send_to_shippo", source: "record", collection: "orders", record_id: recordId } },
    );
  }

  it("sends the order", async () => {
    mockShippo({ "POST /orders/": { object_id: "so_1" } });
    expect(await sendToShippo(sendRequest(SETTINGS, makeOrder()))).toEqual({ message: "Sent to Shippo as order so_1." });
  });

  it("explains why an order wasn't sent", async () => {
    mockShippo({});
    const order = makeOrder({ $app: { shippo: { shippo_order_id: "so_0" } } });
    expect(await sendToShippo(sendRequest(SETTINGS, order))).toEqual({ message: "Not sent: Already sent to Shippo." });
  });

  it("reports Shippo outages", async () => {
    mockShippo({ "POST /orders/": jsonResponse({ detail: "down" }, 503) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await sendToShippo(sendRequest(SETTINGS, makeOrder()))).toEqual({ message: "Not sent: Shippo 503: down" });
  });

  it("validates the record id and the token", async () => {
    expect((await sendToShippo(sendRequest(SETTINGS, null, "../settings"))).message).toBe(
      "Open an order to send it to Shippo.",
    );
    expect((await sendToShippo(sendRequest(SETTINGS, null, null))).message).toBe(
      "Open an order to send it to Shippo.",
    );
    expect((await sendToShippo(sendRequest({}, null))).message).toMatch(/Add your Shippo API token/);
  });
});
