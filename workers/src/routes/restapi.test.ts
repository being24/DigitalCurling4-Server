import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { createFakeD1Database } from "../test-utils/fake-d1";
import { isValidUuidString, parseIntParam, restapiRoutes } from "./restapi";

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

describe("GET /matches/:matchId/viewer", () => {
  const schemaSql = readFileSync(
    join(__dirname, "../../drizzle/0000_furry_toro.sql"),
    "utf-8",
  );

  function buildApp() {
    const fakeD1 = createFakeD1Database(schemaSql);
    const sseFetch = vi.fn(
      async (req: Request) =>
        new Response("sse-ok", { status: 200, headers: req.headers }),
    );
    const app = new Hono();
    app.route("/", restapiRoutes);
    const env = {
      DB: fakeD1 as never,
      MATCH_ROOM: { getByName: () => ({ fetch: sseFetch }) },
    };
    return { app, env, fakeD1, sseFetch };
  }

  it("非UUID形式のmatchIdは422を返す", async () => {
    const { app, env } = buildApp();
    const res = await app.request("/matches/not-a-uuid/viewer", {}, env);
    expect(res.status).toBe(422);
  });

  it("存在しないmatchIdは404を返す", async () => {
    const { app, env } = buildApp();
    const res = await app.request(
      "/matches/019facfe-4805-71de-8582-11deeb598a43/viewer",
      {},
      env,
    );
    expect(res.status).toBe(404);
  });

  it("認証不要でMatchRoom(DO)へ pathname=/sse・team=viewer として委譲する", async () => {
    const { app, env, fakeD1, sseFetch } = buildApp();
    const matchId = "019facfe-4805-71de-8582-11deeb598a43";
    await fakeD1
      .prepare("INSERT INTO match_data (match_id) VALUES (?)")
      .bind(matchId)
      .run();

    const res = await app.request(`/matches/${matchId}/viewer`, {}, env);
    expect(res.status).toBe(200);
    expect(sseFetch).toHaveBeenCalledTimes(1);
    const forwardedRequest = sseFetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.pathname).toBe("/sse");
    expect(forwardedUrl.searchParams.get("match")).toBe(matchId);
    expect(forwardedUrl.searchParams.get("team")).toBe("viewer");
  });

  describe("複数試合の同時進行", () => {
    /** matchId別に独立したDOスタブを返す(実際のDurable Objectsのインスタンス分離を模す)。 */
    function buildAppWithPerMatchDo() {
      const fakeD1 = createFakeD1Database(schemaSql);
      const sseFetchByMatch = new Map<string, ReturnType<typeof vi.fn>>();
      const getByName = vi.fn((matchId: string) => {
        let sseFetch = sseFetchByMatch.get(matchId);
        if (!sseFetch) {
          sseFetch = vi.fn(
            async (req: Request) =>
              new Response("sse-ok", { status: 200, headers: req.headers }),
          );
          sseFetchByMatch.set(matchId, sseFetch);
        }
        return { fetch: sseFetch };
      });
      const app = new Hono();
      app.route("/", restapiRoutes);
      const env = { DB: fakeD1 as never, MATCH_ROOM: { getByName } };
      return { app, env, fakeD1, getByName, sseFetchByMatch };
    }

    it("match Aのviewer接続は、match B向けのDOスタブを一切呼ばない", async () => {
      const { app, env, fakeD1, sseFetchByMatch } = buildAppWithPerMatchDo();
      const matchIdA = "019facfe-4805-71de-8582-11deeb598a43";
      const matchIdB = "019facfe-4805-71de-8582-22deeb598b54";
      await fakeD1
        .prepare("INSERT INTO match_data (match_id) VALUES (?), (?)")
        .bind(matchIdA, matchIdB)
        .run();

      const res = await app.request(`/matches/${matchIdA}/viewer`, {}, env);
      expect(res.status).toBe(200);

      const sseFetchA = sseFetchByMatch.get(matchIdA);
      expect(sseFetchA).toHaveBeenCalledTimes(1);
      expect(sseFetchByMatch.get(matchIdB)).toBeUndefined();
      if (!sseFetchA) throw new Error("sseFetchA must be defined here");

      const forwardedUrl = new URL((sseFetchA.mock.calls[0][0] as Request).url);
      expect(forwardedUrl.searchParams.get("match")).toBe(matchIdA);
    });

    it("2つの試合それぞれのviewerへ同時接続すると、各々が正しいmatchIdでDOへ委譲される", async () => {
      const { app, env, fakeD1, sseFetchByMatch } = buildAppWithPerMatchDo();
      const matchIdA = "019facfe-4805-71de-8582-11deeb598a43";
      const matchIdB = "019facfe-4805-71de-8582-22deeb598b54";
      await fakeD1
        .prepare("INSERT INTO match_data (match_id) VALUES (?), (?)")
        .bind(matchIdA, matchIdB)
        .run();

      const [resA, resB] = await Promise.all([
        app.request(`/matches/${matchIdA}/viewer`, {}, env),
        app.request(`/matches/${matchIdB}/viewer`, {}, env),
      ]);
      expect(resA.status).toBe(200);
      expect(resB.status).toBe(200);
      expect(sseFetchByMatch.get(matchIdA)).toHaveBeenCalledTimes(1);
      expect(sseFetchByMatch.get(matchIdB)).toHaveBeenCalledTimes(1);
    });
  });
});
