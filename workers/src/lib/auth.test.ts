import { describe, expect, it } from "vitest";
import { hashPassword, timingSafeEqual } from "./auth";

describe("hashPassword", () => {
  it("matches Python's hashlib.sha256((password+salt+pepper).encode()).hexdigest()", async () => {
    // 期待値はPython側で実際に計算して確認済み:
    // hashlib.sha256(("password123"+"saltvalue"+"peppervalue").encode()).hexdigest()
    const hash = await hashPassword("password123", "saltvalue", "peppervalue");
    expect(hash).toBe(
      "c65ec8f9394fa5b8dfb93ed6fe84195be9edd1f09a4e6e64549b74f6c3734ed3",
    );
  });

  it("is deterministic for the same input", async () => {
    const h1 = await hashPassword("pw", "salt", "pepper");
    const h2 = await hashPassword("pw", "salt", "pepper");
    expect(h1).toBe(h2);
  });

  it("produces different hashes for different passwords", async () => {
    const h1 = await hashPassword("pw1", "salt", "pepper");
    const h2 = await hashPassword("pw2", "salt", "pepper");
    expect(h1).not.toBe(h2);
  });

  it("produces different hashes for different salts", async () => {
    const h1 = await hashPassword("pw", "salt1", "pepper");
    const h2 = await hashPassword("pw", "salt2", "pepper");
    expect(h1).not.toBe(h2);
  });
});

describe("timingSafeEqual", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqual("abc123", "abc123")).toBe(true);
  });

  it("returns false for different strings of the same length", () => {
    expect(timingSafeEqual("abc123", "abc124")).toBe(false);
  });

  it("returns false for different length strings", () => {
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });

  it("returns true for empty strings", () => {
    expect(timingSafeEqual("", "")).toBe(true);
  });
});
