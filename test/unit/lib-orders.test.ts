import { afterEach, describe, expect, it, vi } from "vitest";
import { sendOrder } from "../../functions/lib/orders";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, jsonResponse, makeOrder, mockShippo, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup(order: unknown) {
  const put = vi.fn().mockResolvedValue({});
  const get = routeGet({
    [`/orders/64f0c0ffee0000000000aaaa`]: order,
    "/settings/shipments": { weight_unit: "lb" },
  });
  const req = createMockRequest({ appId: "shippo", swell: { get, put } });
  return { req, put, get };
}

describe("sendOrder", () => {
  it("creates the Shippo order and saves its id", async () => {
    const { calls } = mockShippo({ "POST /orders/": { object_id: "so_1" } });
    const { req, put, get } = setup(makeOrder());

    const result = await sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS);

    expect(result).toEqual({ sent: true, shippo_order_id: "so_1" });
    expect(get).toHaveBeenCalledWith("/orders/64f0c0ffee0000000000aaaa", {
      expand: ["account", "items.product", "items.variant"],
    });
    expect(calls[0].body.order_number).toBe("100123");
    expect(put).toHaveBeenCalledWith("/orders/64f0c0ffee0000000000aaaa", {
      $app: { shippo: { shippo_order_id: "so_1", shippo_status: "awaiting_label", shippo_error: null } },
    });
  });

  it("skips orders already in Shippo", async () => {
    const { fetchMock } = mockShippo({});
    const { req, put } = setup(makeOrder({ $app: { shippo: { shippo_order_id: "so_0" } } }));

    expect(await sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS)).toEqual({
      sent: false,
      shippo_order_id: "so_0",
      reason: "Already sent to Shippo",
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  it("never resends orders waiting for or holding a label", async () => {
    const { fetchMock } = mockShippo({});
    for (const shippo_status of ["awaiting_label", "label_created"]) {
      const { req } = setup(makeOrder({ $app: { shippo: { shippo_order_id: "so_0", shippo_status } } }));
      expect((await sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS)).reason).toBe("Already sent to Shippo");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends an order in the Error status again as a new Shippo order", async () => {
    const { calls } = mockShippo({ "POST /orders/": { object_id: "so_2" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, put } = setup(
      makeOrder({ $app: { shippo: { shippo_order_id: "so_1", shippo_status: "error", shippo_error: "Shippo 404: Not found." } } }),
    );

    expect(await sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS)).toEqual({ sent: true, shippo_order_id: "so_2", resent: true });
    expect(calls).toHaveLength(1);
    expect(put).toHaveBeenCalledWith("/orders/64f0c0ffee0000000000aaaa", {
      $app: { shippo: { shippo_order_id: "so_2", shippo_status: "awaiting_label", shippo_error: null } },
    });
    expect(log).toHaveBeenCalledWith("Shippo: sent order 100123 again as Shippo order so_2 (was so_1)");
    log.mockRestore();
  });

  it("skips missing, canceled and non-shippable orders", async () => {
    mockShippo({});
    expect((await sendOrder(setup(null).req, "64f0c0ffee0000000000aaaa", SETTINGS)).reason).toBe("Order not found");
    expect((await sendOrder(setup(makeOrder({ canceled: true })).req, "64f0c0ffee0000000000aaaa", SETTINGS)).reason).toBe(
      "Order is canceled",
    );
    expect(
      (await sendOrder(setup(makeOrder({ items: [{ delivery: "giftcard" }] })).req, "64f0c0ffee0000000000aaaa", SETTINGS))
        .reason,
    ).toBe("Order has no items to ship");
  });

  it("saves an error when the shipping address is missing", async () => {
    mockShippo({});
    const { req, put } = setup(makeOrder({ shipping: {} }));

    expect((await sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS)).reason).toBe("Missing shipping address");
    expect(put).toHaveBeenCalledWith("/orders/64f0c0ffee0000000000aaaa", {
      $app: { shippo: { shippo_status: "error", shippo_error: "Missing shipping address" } },
    });
  });

  it("saves 4xx errors without throwing", async () => {
    mockShippo({ "POST /orders/": jsonResponse({ to_address: ["Invalid"] }, 400) });
    const { req, put } = setup(makeOrder());

    const result = await sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS);

    expect(result).toEqual({ sent: false, reason: "Shippo 400: to_address: Invalid" });
    expect(put).toHaveBeenCalledWith("/orders/64f0c0ffee0000000000aaaa", {
      $app: { shippo: { shippo_status: "error", shippo_error: "Shippo 400: to_address: Invalid" } },
    });
  });

  it("saves and rethrows 5xx errors so the event is retried", async () => {
    mockShippo({ "POST /orders/": jsonResponse({ detail: "Oops" }, 503) });
    const { req, put } = setup(makeOrder());

    await expect(sendOrder(req, "64f0c0ffee0000000000aaaa", SETTINGS)).rejects.toThrow("Shippo 503: Oops");
    expect(put).toHaveBeenCalledTimes(1);
  });
});
