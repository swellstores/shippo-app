import { afterEach, describe, expect, it, vi } from "vitest";
import { config, handleEvent, post } from "../../functions/shippo-webhook";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, makeOrder, mockShippo } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(body: unknown, { settings = SETTINGS as Record<string, any>, swell = {} } = {}) {
  const pending: Promise<unknown>[] = [];
  const req = createMockRequest({
    appId: "shippo",
    data: body as any,
    swell: { settings: vi.fn().mockResolvedValue({ shippo: settings }), ...swell },
  });
  (req as any).context = { waitUntil: (promise: Promise<unknown>) => pending.push(promise) };
  return { req, pending };
}

describe("shippo-webhook", () => {
  it("is a public POST route", () => {
    expect(config.route).toEqual({ methods: ["post"], public: true });
  });

  it("accepts webhooks without a token and ignores one in the URL", async () => {
    mockShippo({ "GET /tracks/usps/1": { tracking_number: "1", tracking_status: null } });
    const plain = request({ event: "track_updated", data: { carrier: "usps", tracking_number: "1" } });
    expect(await post(plain.req)).toEqual({ received: true, event: "track_updated" });
    await Promise.all(plain.pending);

    const withToken = request({ event: "track_updated", data: { carrier: "usps", tracking_number: "1" } });
    (withToken.req as any).query = { token: "anything" };
    expect(await post(withToken.req)).toEqual({ received: true, event: "track_updated" });
    await Promise.all(withToken.pending);
  });

  it("acknowledges without work when disabled or the payload is empty", async () => {
    const off = request({ event: "track_updated", data: {} }, { settings: { ...SETTINGS, enabled: false } });
    expect(await post(off.req)).toEqual({ received: true, processed: false });
    expect(off.pending).toHaveLength(0);

    const empty = request({});
    expect(await post(empty.req)).toEqual({ received: true, processed: false });

    const text = request("not json");
    (text.req as any).body = "not json";
    expect(await post(text.req)).toEqual({ received: true, processed: false });
  });

  it("answers right away and processes in the background", async () => {
    mockShippo({ "GET /tracks/usps/9400111": { tracking_number: "9400111", tracking_status: null } });
    const get = vi.fn();
    const { req, pending } = request(
      { event: "track_updated", data: { carrier: "usps", tracking_number: "9400111" } },
      { swell: { get } },
    );

    expect(await post(req)).toEqual({ received: true, event: "track_updated" });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });

  it("logs background failures instead of throwing", async () => {
    mockShippo({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const { req, pending } = request({ event: "track_updated", data: { carrier: "usps", tracking_number: "1" } });

    await post(req);
    await Promise.all(pending);

    expect(error).toHaveBeenCalledWith(expect.stringContaining("Shippo: webhook track_updated failed"));
  });
});

describe("handleEvent", () => {
  it("track_updated reloads the track from Shippo and saves it", async () => {
    const { calls } = mockShippo({
      "GET /tracks/usps/9400111": {
        tracking_number: "9400111",
        tracking_status: { status: "DELIVERED", status_details: "Delivered", status_date: "2026-10-09T10:00:00Z" },
      },
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order = makeOrder({ $app: { shippo: { shippo_transaction_id: "tx_1", shippo_tracking_number: "9400111" } } });
    const put = vi.fn().mockResolvedValue({});
    const { req } = request({}, { swell: { get: vi.fn().mockResolvedValue({ results: [order] }), put } });

    // payload status is ignored: the reloaded track is used
    await handleEvent(req, SETTINGS, "track_updated", {
      carrier: "usps",
      tracking_number: "9400111",
      transaction: "tx_1",
      tracking_status: { status: "TRANSIT" },
    });

    expect(calls[0].path).toBe("/tracks/usps/9400111");
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: { shippo: expect.objectContaining({ shippo_tracking_status: "DELIVERED" }) },
    });
  });

  it("track_updated without carrier or number does nothing", async () => {
    const { fetchMock } = mockShippo({});
    const { req } = request({});
    await handleEvent(req, SETTINGS, "track_updated", { tracking_number: "1" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("transaction_updated with a refunded label resets the order", async () => {
    mockShippo({ "GET /transactions/tx_1": { object_id: "tx_1", status: "REFUNDED" } });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const order = makeOrder({ $app: { shippo: { shippo_transaction_id: "tx_1", shippo_shipment_id: "ship_1" } } });
    const get = vi.fn().mockResolvedValue({ results: [order] });
    const put = vi.fn().mockResolvedValue({});
    const { req } = request({}, { swell: { get, put } });

    await handleEvent(req, SETTINGS, "transaction_updated", { object_id: "tx_1", status: "SUCCESS" });

    expect(put).toHaveBeenCalledWith("/shipments/ship_1", { canceled: true });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("transaction_created runs a label check", async () => {
    mockShippo({ "GET /transactions/tx_2": { object_id: "tx_2", status: "SUCCESS" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const get = vi.fn().mockResolvedValue({ results: [], count: 0 });
    const { req } = request({}, { swell: { get } });

    await handleEvent(req, SETTINGS, "transaction_created", { object_id: "tx_2" });

    expect(get).toHaveBeenCalledWith("/orders", expect.objectContaining({ limit: 10 }));
    expect(log).toHaveBeenCalledWith("Shippo: label check after transaction_created", {
      checked: 0,
      labeled: 0,
      errors: 0,
      remaining: false,
    });
  });

  it("transaction events skip the label check when order sending is off", async () => {
    mockShippo({});
    const get = vi.fn();
    const { req } = request({}, { swell: { get } });

    await handleEvent(req, { ...SETTINGS, send_orders: false }, "transaction_created", {});

    expect(get).not.toHaveBeenCalled();
  });

  it("ignores other events", async () => {
    const { fetchMock } = mockShippo({});
    await handleEvent(request({}).req, SETTINGS, "batch_created", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
