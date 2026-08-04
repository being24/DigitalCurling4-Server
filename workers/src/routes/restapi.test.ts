import { describe, expect, it } from "vitest";
import { isValidUuidString, parseIntParam } from "./restapi";

describe("parseIntParam", () => {
  it("数字文字列を整数に変換する", () => {
    expect(parseIntParam("0")).toBe(0);
    expect(parseIntParam("42")).toBe(42);
  });

  it("負の整数を受け付ける(end_number等は0始まりだが将来の入力ミス耐性として許容)", () => {
    expect(parseIntParam("-1")).toBe(-1);
  });

  it("非整数文字列はnullを返す", () => {
    expect(parseIntParam("abc")).toBeNull();
    expect(parseIntParam("1.5")).toBeNull();
    expect(parseIntParam("")).toBeNull();
    expect(parseIntParam("1a")).toBeNull();
  });
});

describe("isValidUuidString", () => {
  it("UUIDv7形式を受け付ける", () => {
    expect(isValidUuidString("019facfe-4805-71de-8582-11deeb598a43")).toBe(
      true,
    );
  });

  it("既定のteam id(UUIDv4形式)を受け付ける", () => {
    expect(isValidUuidString("5050f20f-cf97-4fb1-bbc1-f2c9052e0d17")).toBe(
      true,
    );
  });

  it("不正な形式・欠落は拒否する", () => {
    expect(isValidUuidString("not-a-uuid")).toBe(false);
    expect(isValidUuidString("")).toBe(false);
    expect(isValidUuidString(undefined)).toBe(false);
    expect(isValidUuidString("019facfe-4805-71de-8582")).toBe(false);
  });
});
