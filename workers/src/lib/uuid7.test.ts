import { describe, expect, it } from "vitest";
import { generateUuid7 } from "./uuid7";

const UUID_V7_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("generateUuid7", () => {
  it("returns a string matching the UUIDv7 format (RFC 9562)", () => {
    const uuid = generateUuid7();
    expect(uuid).toMatch(UUID_V7_PATTERN);
  });

  it("generates unique values across repeated calls", () => {
    const uuids = new Set(Array.from({ length: 1000 }, () => generateUuid7()));
    expect(uuids.size).toBe(1000);
  });

  it("is time-sortable: lexicographic order matches generation order", async () => {
    const first = generateUuid7();
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = generateUuid7();

    expect(first < second).toBe(true);
  });
});
