import { describe, expect, it } from "vitest";
import { parseIntParam } from "./restapi";

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
