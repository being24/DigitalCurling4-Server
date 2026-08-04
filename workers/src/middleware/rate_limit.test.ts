import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { Bindings } from "../env";
import { rateLimitByUser } from "./rate_limit";

function buildApp(
  limit: (options: { key: string }) => Promise<{ success: boolean }>,
) {
  const app = new Hono<{ Bindings: Bindings }>();
  app.use("/shots", rateLimitByUser);
  app.post("/shots", (c) => c.json({ ok: true }));
  const env = { SHOT_RATE_LIMITER: { limit: vi.fn(limit) } };
  return { app, env };
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

describe("rateLimitByUser", () => {
  it("limit()がsuccess:trueを返すとき、後続のハンドラが実行される", async () => {
    const { app, env } = buildApp(async () => ({ success: true }));
    const res = await app.request(
      "/shots",
      {
        method: "POST",
        headers: { authorization: basicAuthHeader("alice", "pw") },
      },
      env as never,
    );
    expect(res.status).toBe(200);
  });

  it("limit()がsuccess:falseを返すとき、429を返しハンドラは実行されない", async () => {
    const { app, env } = buildApp(async () => ({ success: false }));
    const res = await app.request(
      "/shots",
      {
        method: "POST",
        headers: { authorization: basicAuthHeader("alice", "pw") },
      },
      env as never,
    );
    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ detail: "Too many requests." });
  });

  it("limit()にはusernameとリクエストパスを組み合わせたkeyが渡される", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const { app, env } = buildApp(limit);
    await app.request(
      "/shots",
      {
        method: "POST",
        headers: { authorization: basicAuthHeader("alice", "pw") },
      },
      env as never,
    );
    expect(limit).toHaveBeenCalledWith({ key: "alice:/shots" });
  });

  it("認証ヘッダが無い場合はanonymousをkeyに使う", async () => {
    const limit = vi.fn(async () => ({ success: true }));
    const { app, env } = buildApp(limit);
    await app.request("/shots", { method: "POST" }, env as never);
    expect(limit).toHaveBeenCalledWith({ key: "anonymous:/shots" });
  });
});
