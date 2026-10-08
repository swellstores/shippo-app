import { afterEach, describe, expect, it, vi } from "vitest";
import handler, { config } from "../../functions/sync-labels";
import { createMockRequest } from "../helpers/mock-request";
import { SETTINGS, makeOrder, mockShippo } from "../helpers/fixtures";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function request(settings: Record<string, any>, orders: any[] = []) {
  const get = vi.fn().mockResolvedValue({ results: orders, count: orders.length });
  const put = vi.fn().mockResolvedValue({});
  const req = createMockRequest({
    appId: "shippo",
    swell: { settings: vi.fn().mockResolvedValue({ shippo: settings }), get, put },
  });
  return { req, get, put };
}

describe("sync-labels", () => {
  it("runs every 15 minutes", () => {
    expect(config.cron?.schedule).toBe("*/15 * * * *");
  });

  it("checks orders awaiting a label and logs the summary", async () => {
    mockShippo({ "GET /orders/so_1": { transactions: [] } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const order = makeOrder({ $app: { shippo: { shippo_order_id: "so_1", shippo_status: "awaiting_label" } } });
    const { req, put } = request(SETTINGS, [order]);

    await handler(req);

    expect(put).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledWith("Shippo: label check", { checked: 1, labeled: 0, errors: 0, remaining: false });
  });

  it("stays quiet when nothing is pending", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const { req, get } = request(SETTINGS, []);

    await handler(req);

    expect(get).toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });

  it("does nothing when disabled, order sending is off or the token is missing", async () => {
    for (const settings of [
      { ...SETTINGS, enabled: false },
      { ...SETTINGS, send_orders: false },
      { ...SETTINGS, api_token: "" },
    ]) {
      const { req, get } = request(settings);
      await handler(req);
      expect(get).not.toHaveBeenCalled();
    }
  });
});
