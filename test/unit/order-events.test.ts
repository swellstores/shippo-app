import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/order-events";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, makeOrder, mockShippo, routeGet } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ORDER_ID = "64f0c0ffee0000000000aaaa";

function request(settings: Record<string, any>, eventType: string) {
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    appId: "shippo",
    data: { id: ORDER_ID, number: "100123", $event: { type: eventType } },
    swell: {
      settings: vi.fn().mockResolvedValue({ shippo: settings }),
      get: routeGet({ [`/orders/${ORDER_ID}`]: makeOrder(), "/settings/shipments": { weight_unit: "lb" } }),
      put,
    },
  });
  return { req, put };
}

describe("order-events", () => {
  it("listens to submitted and paid orders", () => {
    expect(config.model?.events).toEqual(["order.submitted", "order.paid"]);
  });

  it("sends paid orders by default", async () => {
    const { calls } = mockShippo({ "POST /orders/": { object_id: "so_1" } });
    const { req, put } = request(SETTINGS, "order.paid");

    await handler(req);

    expect(calls).toHaveLength(1);
    expect(put.mock.calls[0][1].$app.shippo.shippo_order_id).toBe("so_1");
  });

  it("sends on submit when configured", async () => {
    const { calls } = mockShippo({ "POST /orders/": { object_id: "so_1" } });

    await handler(request({ ...SETTINGS, sync_on: "submitted" }, "order.paid").req);
    expect(calls).toHaveLength(0);

    await handler(request({ ...SETTINGS, sync_on: "submitted" }, "order.submitted").req);
    expect(calls).toHaveLength(1);
  });

  it("ignores the other event", async () => {
    const { fetchMock } = mockShippo({});
    await handler(request(SETTINGS, "order.submitted").req);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, sending is off or the token is missing", async () => {
    const { fetchMock } = mockShippo({});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await handler(request({ ...SETTINGS, enabled: false }, "order.paid").req);
    await handler(request({ ...SETTINGS, send_orders: false }, "order.paid").req);
    await handler(request({ ...SETTINGS, api_token: "" }, "order.paid").req);

    expect(fetchMock).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Shippo: missing API token, order not sent");
  });

  it("logs why an order wasn't sent", async () => {
    mockShippo({});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const put = vi.fn();
    const req = createMockRequest({
      appId: "shippo",
      data: { id: ORDER_ID, number: "100123", $event: { type: "order.paid" } },
      swell: {
        settings: vi.fn().mockResolvedValue({ shippo: SETTINGS }),
        get: routeGet({ [`/orders/${ORDER_ID}`]: makeOrder({ $app: { shippo: { shippo_order_id: "so_0" } } }) }),
        put,
      },
    });

    await handler(req);

    expect(log).toHaveBeenCalledWith("Shippo: order 100123 not sent - Already sent to Shippo");
    expect(put).not.toHaveBeenCalled();
  });
});
