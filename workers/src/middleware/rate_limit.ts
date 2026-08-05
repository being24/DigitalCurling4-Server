import type { Context, Next } from "hono";
import { auth as parseBasicAuth } from "hono/utils/basic-auth";
import type { Bindings } from "../env";

/**
 * Cloudflare Workers Rate Limiting API(https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
 * を使い、Basic認証のusername単位・エンドポイント単位でリクエスト頻度を制限する。
 * `requireBasicAuth`の後段で使うことを前提とし、認証情報はリクエストヘッダから再取得する
 * (Hono `basicAuth`ミドルウェアはコンテキストにusernameを保存しないため)。
 */
export async function rateLimitByUser(
  c: Context<{ Bindings: Bindings }>,
  next: Next,
): Promise<Response | undefined> {
  const authUser = parseBasicAuth(c.req.raw);
  const key = `${authUser?.username ?? "anonymous"}:${c.req.path}`;
  const { success } = await c.env.SHOT_RATE_LIMITER.limit({ key });
  if (!success) {
    return c.json({ detail: "Too many requests." }, 429);
  }
  await next();
}
