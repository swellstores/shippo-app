import { describe, expect, it } from "vitest";
import { getPendingOrders } from "../../functions/lib/labels";
import { getShippoSettings, getWeightUnit } from "../../functions/lib/shippo";
import { createMockRequest } from "../helpers/mock-request";
import { createSwellClient } from "../helpers/swell-client";

// Read-only checks against the logged-in test store (uses swell-cli auth).
describe("store data the app depends on", () => {
  const swell = createSwellClient();

  it("reads the store weight unit used for parcel weights", async () => {
    expect(["g", "kg", "oz", "lb"]).toContain(await getWeightUnit(swell as SwellAPI));
  });

  it("reads the app settings", async () => {
    const settings = await getShippoSettings({ settings: () => swell.settings("shippo") } as unknown as SwellAPI);
    expect(settings).toBeTypeOf("object");
  });

  it("runs the pending-orders query the label check uses", async () => {
    const req = createMockRequest({ appId: "shippo", useRealSwell: true });
    const { results, count } = await getPendingOrders(req, 1);

    expect(Array.isArray(results)).toBe(true);
    expect(count).toBeGreaterThanOrEqual(results.length);
  });
});
