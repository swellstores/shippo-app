import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ItemsAlreadyShipped,
  itemsShippedNote,
  applyRefundedLabel,
  applyTrackingUpdate,
  createSwellShipment,
  findPurchasedLabel,
  getPendingOrders,
  getTrack,
  labelDetails,
  syncOrderLabel,
  syncPendingOrders,
} from "../../functions/lib/labels";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeOrder, mockShippo } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

// a write Swell refuses, as the Swell client in functions throws it: a SwellError with status 400 and the errors in body
function refused(errors: Record<string, any>) {
  return Object.assign(new Error(`POST /shipments\n${JSON.stringify(errors)}`), { name: "SwellError", status: 400, body: errors });
}
const NOT_LEFT = "Cannot ship 2 of item item_1, only 0 left to deliver";

// GET for a refused shipment: no shipment with the label's tracking number, and the order read again with `left` of
// item_1 still to ship by its saved shipments
function afterRefusal(left: number, copy?: any) {
  return vi.fn(async (path: string) =>
    path === "/shipments"
      ? { results: copy ? [copy] : [] }
      : makeOrder({ items: [{ id: "item_1", delivery: "shipment", quantity_shipment_deliverable: left }] }),
  );
}

function pendingOrder(overrides: Record<string, any> = {}) {
  return makeOrder({ $app: { shippo: { shippo_order_id: "so_1", shippo_status: "awaiting_label" } }, ...overrides });
}

const SUCCESS_TX = {
  object_id: "tx_1",
  status: "SUCCESS",
  tracking_number: "9400111",
  tracking_url_provider: "https://tools.usps.com/?t=9400111",
  label_url: "https://shippo/label.pdf",
  rate: "rate_1",
};

const RATE = { object_id: "rate_1", provider: "USPS", servicelevel: { name: "Priority Mail", token: "usps_priority" } };

describe("labelDetails", () => {
  it("loads carrier and service from the rate id", async () => {
    mockShippo({ "GET /rates/rate_1": RATE });
    expect(await labelDetails(SETTINGS, SUCCESS_TX)).toEqual({
      transaction_id: "tx_1",
      tracking_number: "9400111",
      tracking_url: "https://tools.usps.com/?t=9400111",
      label_url: "https://shippo/label.pdf",
      provider: "USPS",
      servicelevel_name: "Priority Mail",
      servicelevel_token: "usps_priority",
    });
  });

  it("uses an expanded rate without a request", async () => {
    const { fetchMock } = mockShippo({});
    const details = await labelDetails(SETTINGS, {
      object_id: "tx_1",
      rate: { provider: "UPS", servicelevel_name: "Ground", servicelevel_token: "ups_ground" },
    });
    expect(details).toMatchObject({ provider: "UPS", servicelevel_name: "Ground", servicelevel_token: "ups_ground" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps going when the rate can't be loaded", async () => {
    mockShippo({ "GET /rates/rate_1": jsonResponse({ detail: "gone" }, 404) });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const details = await labelDetails(SETTINGS, SUCCESS_TX);
    expect(details.tracking_number).toBe("9400111");
    expect(details.provider).toBeUndefined();
  });
});

describe("findPurchasedLabel", () => {
  it("returns the first successful transaction", async () => {
    mockShippo({
      "GET /transactions/tx_0": { object_id: "tx_0", status: "REFUNDED" },
      "GET /transactions/tx_1": SUCCESS_TX,
    });
    const tx = await findPurchasedLabel(SETTINGS, { transactions: [{ object_id: "tx_0" }, "tx_1"] });
    expect(tx?.object_id).toBe("tx_1");
  });

  it("returns null without a purchased label", async () => {
    mockShippo({ "GET /transactions/tx_0": { object_id: "tx_0", status: "ERROR" } });
    expect(await findPurchasedLabel(SETTINGS, { transactions: [{ object_id: "tx_0" }] })).toBeNull();
    expect(await findPurchasedLabel(SETTINGS, {})).toBeNull();
  });
});

describe("createSwellShipment", () => {
  it("ships the deliverable items with carrier and tracking", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn().mockResolvedValue({ id: "ship_1" });
    const get = vi.fn().mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ results: [{ id: "ship_1" }] });
    const id = await createSwellShipment({ post, get } as any, makeOrder(), {
      transaction_id: "tx_1",
      tracking_number: "9400111",
      tracking_url: "https://track",
      provider: "USPS",
      servicelevel_name: "Priority Mail",
    });

    expect(id).toBe("ship_1");
    expect(post).toHaveBeenCalledWith(
      "/shipments",
      expect.objectContaining({
        order_id: ORDER_ID,
        items: [{ order_item_id: "item_1", product_id: "prod_1", variant_id: "var_1", quantity: 2 }],
        carrier: "usps",
        carrier_name: "USPS",
        service: "Priority Mail",
        service_name: "Priority Mail",
        tracking_code: "9400111",
        notes: "Shippo label tx_1: https://track",
        $validate_items: true,
      }),
    );
    expect(get).toHaveBeenCalledWith("/shipments", {
      where: { order_id: ORDER_ID, tracking_code: "9400111", canceled: { $ne: true } },
      limit: 25,
    });
  });

  it("uses the parallel run's shipment when Swell refuses the items as already shipped", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn().mockRejectedValue(refused({ items: { message: NOT_LEFT } }));
    const get = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({ results: [{ id: "ship_a", date_created: "2026-10-09T12:49:52.739Z" }] });
    const put = vi.fn();
    expect(await createSwellShipment({ post, get, put } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" })).toBe(
      "ship_a",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("throws ItemsAlreadyShipped when the items were shipped by another shipment", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = vi.fn().mockRejectedValue(refused({ items: { message: NOT_LEFT } }));
    const get = afterRefusal(0);
    await expect(
      createSwellShipment({ post, get } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" }),
    ).rejects.toBeInstanceOf(ItemsAlreadyShipped);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(NOT_LEFT));
    expect(get).toHaveBeenCalledWith(`/orders/${ORDER_ID}`);
  });

  it("treats a partial shipment elsewhere as shipped elsewhere: only full shipments are made", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const post = vi.fn().mockRejectedValue(refused({ items: { message: "Cannot ship 2 of item item_1, only 1 left to deliver" } }));
    await expect(
      createSwellShipment({ post, get: afterRefusal(1) } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" }),
    ).rejects.toBeInstanceOf(ItemsAlreadyShipped);
  });

  it("throws a retryable error when the items are only reserved by a shipment write in progress", async () => {
    const post = vi.fn().mockRejectedValue(refused({ items: { message: NOT_LEFT } }));
    // the saved shipments still leave both items to ship: Swell counted a reservation
    const result = createSwellShipment({ post, get: afterRefusal(2) } as any, makeOrder(), {
      transaction_id: "tx_1",
      tracking_number: "9400111",
    });
    await expect(result).rejects.toThrow("its items are reserved by another shipment write in progress");
    await expect(result).rejects.not.toBeInstanceOf(ItemsAlreadyShipped);
  });

  it("throws when the order's shipments are locked by another write, so the order is checked again", async () => {
    const post = vi.fn().mockRejectedValue(refused({ order_id: { message: "Order shipments are being updated, please try again" } }));
    const get = vi.fn().mockResolvedValue({ results: [] });
    await expect(
      createSwellShipment({ post, get } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" }),
    ).rejects.toThrow("order_id: Order shipments are being updated, please try again");
  });

  it("rethrows other validation errors instead of taking them for items shipped elsewhere", async () => {
    const error = refused({ "items.product_id": { message: "Required" } });
    const post = vi.fn().mockRejectedValue(error);
    const get = vi.fn().mockResolvedValue({ results: [] });
    await expect(
      createSwellShipment({ post, get } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" }),
    ).rejects.toBe(error);
  });

  it("reuses the shipment a parallel run already created for the label", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn();
    const get = vi.fn().mockResolvedValue({ results: [{ id: "ship_0", date_created: "2026-10-09T12:49:52.739Z" }] });

    expect(await createSwellShipment({ post, get } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" })).toBe(
      "ship_0",
    );
    expect(post).not.toHaveBeenCalled();
  });

  it("cancels its own copy when a parallel run created one at the same time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn().mockResolvedValue({ id: "ship_b" });
    const put = vi.fn().mockResolvedValue({});
    const get = vi
      .fn()
      .mockResolvedValueOnce({ results: [] })
      .mockResolvedValueOnce({
        results: [
          { id: "ship_b", date_created: "2026-10-09T12:49:52.756Z" },
          { id: "ship_a", date_created: "2026-10-09T12:49:52.739Z" },
        ],
      });

    const id = await createSwellShipment({ post, get, put } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" });

    expect(id).toBe("ship_a");
    expect(put).toHaveBeenCalledWith("/shipments/ship_b", { canceled: true });
  });

  it("keeps the oldest copy, by id when created at the same time", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn().mockResolvedValue({ id: "ship_a" });
    const put = vi.fn();
    const same = "2026-10-09T12:49:52.739Z";
    const get = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ results: [{ id: "ship_b", date_created: same }, { id: "ship_a", date_created: same }] });

    expect(await createSwellShipment({ post, get, put } as any, makeOrder(), { transaction_id: "tx_1", tracking_number: "9400111" })).toBe(
      "ship_a",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("skips the duplicate lookup when the label has no tracking number", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn().mockResolvedValue({ id: "ship_1" });
    const get = vi.fn();
    expect(await createSwellShipment({ post, get } as any, makeOrder(), { transaction_id: "tx_1" })).toBe("ship_1");
    expect(get).not.toHaveBeenCalled();
  });

  it("treats nothing left to ship like Swell refusing the items", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const post = vi.fn();
    const order = makeOrder({ items: [{ delivery: "shipment", quantity_shipment_deliverable: 0 }] });
    await expect(createSwellShipment({ post } as any, order, { transaction_id: "tx_1" })).rejects.toMatchObject({
      constructor: ItemsAlreadyShipped,
      message: "nothing left to ship",
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("syncOrderLabel", () => {
  it("saves the label with a note when another shipment already shipped the items", async () => {
    mockShippo({
      "GET /orders/so_1": { object_id: "so_1", transactions: [{ object_id: "tx_1" }] },
      "GET /transactions/tx_1": SUCCESS_TX,
      "GET /rates/rate_1": RATE,
    });
    vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn();
    const get = vi.fn().mockResolvedValue({ results: [] });
    const req = createMockRequest({ appId: "shippo", swell: { put, post, get } });
    // everything was shipped by another shipment before the order was loaded
    const order = pendingOrder({ items: [{ delivery: "shipment", quantity_shipment_deliverable: 0 }] });

    expect(await syncOrderLabel(req, SETTINGS, order)).toBe("labeled");
    expect(post).not.toHaveBeenCalled();
    const saved = put.mock.calls.at(-1)![1].$app.shippo;
    expect(saved).toMatchObject({
      shippo_status: "shipped_elsewhere",
      shippo_transaction_id: "tx_1",
      shippo_note: itemsShippedNote("nothing left to ship"),
    });
    expect(saved).not.toHaveProperty("shippo_shipment_id");
  });

  it("fulfills the order when a label was bought", async () => {
    mockShippo({
      "GET /orders/so_1": { object_id: "so_1", transactions: [{ object_id: "tx_1" }] },
      "GET /transactions/tx_1": SUCCESS_TX,
      "GET /rates/rate_1": RATE,
    });
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn().mockResolvedValue({ id: "ship_1" });
    const get = vi.fn().mockResolvedValueOnce({ results: [] }).mockResolvedValueOnce({ results: [{ id: "ship_1" }] });
    const req = createMockRequest({ appId: "shippo", swell: { put, post, get } });

    expect(await syncOrderLabel(req, SETTINGS, pendingOrder())).toBe("labeled");

    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: {
        shippo: expect.objectContaining({
          shippo_status: "label_created",
          shippo_transaction_id: "tx_1",
          shippo_tracking_number: "9400111",
          shippo_carrier: "USPS",
          shippo_service: "Priority Mail",
          shippo_shipment_id: "ship_1",
          shippo_error: null,
        }),
      },
    });
  });

  it("doesn't create a shipment when fulfillment is off", async () => {
    mockShippo({
      "GET /orders/so_1": { transactions: ["tx_1"] },
      "GET /transactions/tx_1": SUCCESS_TX,
      "GET /rates/rate_1": RATE,
    });
    const put = vi.fn().mockResolvedValue({});
    const post = vi.fn();
    const req = createMockRequest({ appId: "shippo", swell: { put, post } });

    expect(await syncOrderLabel(req, { ...SETTINGS, create_fulfillment: false }, pendingOrder())).toBe("labeled");
    expect(post).not.toHaveBeenCalled();
    expect(put.mock.calls[0][1].$app.shippo).not.toHaveProperty("shippo_shipment_id");
  });

  it("only records the check while no label exists", async () => {
    mockShippo({ "GET /orders/so_1": { transactions: [] } });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({ appId: "shippo", swell: { put } });

    expect(await syncOrderLabel(req, SETTINGS, pendingOrder())).toBe("waiting");
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: { shippo: { shippo_checked_at: expect.any(String) } },
    });
  });

  it("stops checking orders Shippo no longer has", async () => {
    mockShippo({ "GET /orders/so_1": jsonResponse({ detail: "Not found." }, 404) });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({ appId: "shippo", swell: { put } });

    expect(await syncOrderLabel(req, SETTINGS, pendingOrder())).toBe("error");
    expect(put.mock.calls[0][1].$app.shippo).toMatchObject({
      shippo_status: "error",
      shippo_error: "Shippo 404: Not found.",
    });
  });

  it("marks an order Error on 400 too (an invalid Shippo order id)", async () => {
    mockShippo({ "GET /orders/so_1": jsonResponse({ detail: "Invalid id." }, 400) });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({ appId: "shippo", swell: { put } });
    expect(await syncOrderLabel(req, SETTINGS, pendingOrder())).toBe("error");
  });

  it("rethrows 401 and 403 without touching the order: they're about the token", async () => {
    for (const status of [401, 403]) {
      mockShippo({ "GET /orders/so_1": jsonResponse({ detail: "Token refused." }, status) });
      const put = vi.fn();
      const req = createMockRequest({ appId: "shippo", swell: { put } });
      await expect(syncOrderLabel(req, SETTINGS, pendingOrder())).rejects.toMatchObject({ status });
      expect(put).not.toHaveBeenCalled();
    }
  });

  it("rethrows other Shippo errors", async () => {
    mockShippo({ "GET /orders/so_1": jsonResponse({ detail: "down" }, 500) });
    const req = createMockRequest({ appId: "shippo", swell: { put: vi.fn() } });
    await expect(syncOrderLabel(req, SETTINGS, pendingOrder())).rejects.toThrow("Shippo 500: down");
  });
});

describe("getPendingOrders / syncPendingOrders", () => {
  it("queries orders awaiting a label, least recently checked first", async () => {
    const get = vi.fn().mockResolvedValue({ results: [{ id: "a" }], count: 3 });
    const req = createMockRequest({ appId: "shippo", swell: { get } });

    expect(await getPendingOrders(req, 5)).toEqual({ results: [{ id: "a" }], count: 3 });
    expect(get).toHaveBeenCalledWith("/orders", {
      where: {
        "$app.shippo.shippo_status": "awaiting_label",
        canceled: { $ne: true },
        date_created: { $gte: expect.any(String) },
      },
      sort: "$app.shippo.shippo_checked_at asc",
      limit: 5,
    });
  });

  it("summarizes a pass and keeps going after errors", async () => {
    mockShippo({
      "GET /orders/so_1": { transactions: ["tx_1"] },
      "GET /orders/so_2": { transactions: [] },
      "GET /orders/so_3": jsonResponse({ detail: "down" }, 500),
      "GET /transactions/tx_1": SUCCESS_TX,
      "GET /rates/rate_1": RATE,
    });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orders = ["so_1", "so_2", "so_3"].map((id, i) =>
      pendingOrder({ id: `order_${i}`, number: `10${i}`, $app: { shippo: { shippo_order_id: id } } }),
    );
    const req = createMockRequest({
      appId: "shippo",
      swell: {
        get: vi.fn().mockResolvedValue({ results: orders, count: 3 }),
        put: vi.fn().mockResolvedValue({}),
        post: vi.fn().mockResolvedValue({ id: "ship_1" }),
      },
    });

    expect(await syncPendingOrders(req, SETTINGS)).toEqual({ checked: 3, labeled: 1, errors: 1, remaining: false });
  });

  it("stops the pass at a refused token and leaves the orders waiting", async () => {
    const { calls } = mockShippo({ "GET /orders/so_1": jsonResponse({ detail: "Token does not exist." }, 401) });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const orders = ["so_1", "so_2"].map((id, i) => pendingOrder({ id: `order_${i}`, number: `10${i}`, $app: { shippo: { shippo_order_id: id } } }));
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({ appId: "shippo", swell: { get: vi.fn().mockResolvedValue({ results: orders, count: 2 }), put } });

    expect(await syncPendingOrders(req, SETTINGS)).toEqual({
      checked: 0, labeled: 0, errors: 0, remaining: true, stopped: "Shippo 401: Token does not exist.",
    });
    // the second order isn't requested, and no order is written
    expect(calls).toHaveLength(1);
    expect(put).not.toHaveBeenCalled();
  });

  it("stops when the time budget is used up", async () => {
    mockShippo({ "GET /orders/": { transactions: [] } });
    const orders = [pendingOrder({ id: "a" }), pendingOrder({ id: "b" })];
    const req = createMockRequest({
      appId: "shippo",
      swell: { get: vi.fn().mockResolvedValue({ results: orders, count: 2 }), put: vi.fn().mockResolvedValue({}) },
    });

    expect(await syncPendingOrders(req, SETTINGS, { budgetMs: -1 })).toEqual({
      checked: 0,
      labeled: 0,
      errors: 0,
      remaining: true,
    });
  });
});

describe("applyRefundedLabel", () => {
  it("cancels the shipment and waits for a new label", async () => {
    const order = makeOrder({ $app: { shippo: { shippo_transaction_id: "tx_1", shippo_shipment_id: "ship_1" } } });
    const get = vi.fn().mockResolvedValue({ results: [order] });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({ appId: "shippo", swell: { get, put } });

    expect(await applyRefundedLabel(req, { object_id: "tx_1", status: "REFUNDED" })).toBe(true);

    expect(get).toHaveBeenCalledWith("/orders", { where: { "$app.shippo.shippo_transaction_id": "tx_1" }, limit: 1 });
    expect(put).toHaveBeenCalledWith("/shipments/ship_1", { canceled: true });
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: { shippo: expect.objectContaining({ shippo_status: "awaiting_label", shippo_shipment_id: null }) },
    });
  });

  it("ignores labels that aren't refunded or aren't ours", async () => {
    const get = vi.fn().mockResolvedValue({ results: [] });
    const req = createMockRequest({ appId: "shippo", swell: { get, put: vi.fn() } });

    expect(await applyRefundedLabel(req, { object_id: "tx_1", status: "SUCCESS" })).toBe(false);
    expect(get).not.toHaveBeenCalled();
    expect(await applyRefundedLabel(req, { object_id: "tx_9", status: "REFUNDED" })).toBe(false);
  });

  it("works without a Swell shipment", async () => {
    const order = makeOrder({ $app: { shippo: { shippo_transaction_id: "tx_1" } } });
    const put = vi.fn().mockResolvedValue({});
    const req = createMockRequest({
      appId: "shippo",
      swell: { get: vi.fn().mockResolvedValue({ results: [order] }), put },
    });

    expect(await applyRefundedLabel(req, { object_id: "tx_1", status: "REFUNDED" })).toBe(true);
    expect(put).toHaveBeenCalledTimes(1);
  });
});

describe("tracking", () => {
  const track = {
    tracking_number: "9400111",
    eta: "2026-10-10T00:00:00Z",
    transaction: "tx_1",
    tracking_status: { status: "TRANSIT", status_details: "Arrived at facility", status_date: "2026-10-08T12:00:00Z" },
  };

  it("getTrack calls the tracking endpoint", async () => {
    const { calls } = mockShippo({ "GET /tracks/usps/9400111": track });
    expect(await getTrack(SETTINGS, "usps", "9400111")).toEqual(track);
    expect(calls[0].path).toBe("/tracks/usps/9400111");
  });

  function trackingReq(appData: Record<string, any> | null) {
    const get = vi.fn().mockResolvedValue({ results: appData ? [makeOrder({ $app: { shippo: appData } })] : [] });
    const put = vi.fn().mockResolvedValue({});
    return { req: createMockRequest({ appId: "shippo", swell: { get, put } }), get, put };
  }

  it("saves the latest status on the order", async () => {
    const { req, get, put } = trackingReq({ shippo_transaction_id: "tx_1" });

    expect(await applyTrackingUpdate(req, track)).toBe(true);
    expect(get).toHaveBeenCalledWith("/orders", { where: { "$app.shippo.shippo_tracking_number": "9400111" }, limit: 1 });
    expect(put).toHaveBeenCalledWith(`/orders/${ORDER_ID}`, {
      $app: {
        shippo: {
          shippo_tracking_status: "TRANSIT",
          shippo_tracking_details: "Arrived at facility",
          shippo_tracking_date: "2026-10-08T12:00:00Z",
          shippo_eta: "2026-10-10T00:00:00Z",
        },
      },
    });
  });

  it("skips older scans, other labels and unknown tracking numbers", async () => {
    expect(
      await applyTrackingUpdate(trackingReq({ shippo_tracking_date: "2026-10-09T00:00:00Z" }).req, track),
    ).toBe(false);
    expect(await applyTrackingUpdate(trackingReq({ shippo_transaction_id: "tx_other" }).req, track)).toBe(false);
    expect(await applyTrackingUpdate(trackingReq(null).req, track)).toBe(false);
  });

  it("ignores payloads without a status", async () => {
    const { req, get } = trackingReq({});
    expect(await applyTrackingUpdate(req, { tracking_number: "1" })).toBe(false);
    expect(await applyTrackingUpdate(req, null)).toBe(false);
    expect(get).not.toHaveBeenCalled();
  });
});
