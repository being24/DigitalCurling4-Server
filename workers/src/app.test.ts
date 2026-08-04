import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "./lib/auth";
import { createFakeD1Database } from "./test-utils/fake-d1";

// app.tsは`./routes/match`経由で`../simulate`(Wasm依存)をトップレベルimportするため、
// match.test.tsと同じ理由でモック化する。
vi.mock("./simulate", () => ({
  callSimulateJson: vi.fn(async () => {
    const stones: [number, number][] = [];
    stones.push([0, 38.405]);
    for (let i = 1; i < 8; i++) stones.push([100, 100]);
    for (let i = 0; i < 8; i++) stones.push([200, 200]);
    return {
      result: JSON.stringify({ stones, trajectory_steps: 10 }),
      elapsedMs: 1,
    };
  }),
  handleSimulate: vi.fn(async () => new Response("sim")),
}));

const { app } = await import("./app");
const { drizzle } = await import("drizzle-orm/d1");

const schemaSql = readFileSync(
  join(__dirname, "../drizzle/0000_furry_toro.sql"),
  "utf-8",
);

const PEPPER = "test-pepper";
const fakeRateLimiter = { limit: async () => ({ success: true }) };

/**
 * `app.ts`をそのまま使う統合テスト用ヘルパー。match_room.test.ts/routes/*.test.ts同様、
 * `MATCH_ROOM.getByName(matchId)`をmatchId別に独立したstubへ振り分け、
 * viewer(restapiRoutes経由の`fetch`)とplayer(matchRoutes経由のRPCメソッド)が
 * 同一matchIdのDOスタブに集約されることも検証できるようにする。
 */
function buildApp() {
  const fakeD1 = createFakeD1Database(schemaSql);
  type DoStub = {
    notifyTeamConfigUpdated: ReturnType<typeof vi.fn>;
    pushStateUpdate: ReturnType<typeof vi.fn>;
    fetch: ReturnType<typeof vi.fn>;
  };
  const doStubs = new Map<string, DoStub>();
  const getByName = vi.fn((matchId: string): DoStub => {
    let stub = doStubs.get(matchId);
    if (!stub) {
      stub = {
        notifyTeamConfigUpdated: vi.fn(async () => {}),
        pushStateUpdate: vi.fn(async () => {}),
        fetch: vi.fn(
          async (req: Request) =>
            new Response("sse-ok", { status: 200, headers: req.headers }),
        ),
      };
      doStubs.set(matchId, stub);
    }
    return stub;
  });
  const env = {
    DB: fakeD1 as never,
    PEPPER_DATA: PEPPER,
    MATCH_ROOM: { getByName },
    SHOT_RATE_LIMITER: fakeRateLimiter,
  };
  return { app, env, db: drizzle(fakeD1 as never), getByName, doStubs };
}

async function seedUser(
  rawDb: ReturnType<typeof createFakeD1Database>,
  username: string,
  password: string,
) {
  const salt = `salt-${username}`;
  const hash = await hashPassword(password, salt, PEPPER);
  await rawDb
    .prepare(
      "INSERT INTO users (username, hash_password, salt) VALUES (?, ?, ?)",
    )
    .bind(username, hash, salt)
    .run();
}

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

const teamConfigBody = (teamName: string) => ({
  use_default_config: false,
  team_name: teamName,
  player1: {
    max_velocity: 4.0,
    shot_std_dev: 0.0076,
    angle_std_dev: 0.0018,
    player_name: "p1",
  },
  player2: {
    max_velocity: 4.0,
    shot_std_dev: 0.0076,
    angle_std_dev: 0.0018,
    player_name: "p2",
  },
  player3: {
    max_velocity: 4.0,
    shot_std_dev: 0.0076,
    angle_std_dev: 0.0018,
    player_name: "p3",
  },
  player4: {
    max_velocity: 4.0,
    shot_std_dev: 0.0076,
    angle_std_dev: 0.0018,
    player_name: "p4",
  },
});

describe("app.ts: viewer接続とplayer投球が混在する複数試合", () => {
  let ctx: ReturnType<typeof buildApp>;

  async function createMatch(
    matchName: string,
    authUser: string,
    authPass: string,
  ) {
    const res = await ctx.app.request(
      "/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader(authUser, authPass),
        },
        body: JSON.stringify({
          game_mode: "standard",
          tournament: { tournament_name: "mixed-scenario-cup" },
          simulator: { simulator_name: "fcv1" },
          applied_rule: "fgz_rule",
          time_limit: 600,
          extra_end_time_limit: 60,
          standard_end_count: 8,
          match_name: matchName,
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(200);
    return (await res.json()) as string;
  }

  async function configureTeams(
    matchId: string,
    team0User: [string, string],
    team1User: [string, string],
  ) {
    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team0`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader(...team0User),
        },
        body: JSON.stringify(teamConfigBody(`${team0User[0]}-team`)),
      },
      ctx.env,
    );
    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader(...team1User),
        },
        body: JSON.stringify(teamConfigBody(`${team1User[0]}-team`)),
      },
      ctx.env,
    );
  }

  beforeEach(async () => {
    ctx = buildApp();
    const rawDb = ctx.env.DB as unknown as ReturnType<
      typeof createFakeD1Database
    >;
    await rawDb
      .prepare(
        "INSERT INTO physical_simulator (physical_simulator_id, simulator_name) VALUES (?, ?)",
      )
      .bind("sim-fcv1", "fcv1")
      .run();
    await seedUser(rawDb, "alice", "alice-pw");
    await seedUser(rawDb, "bob", "bob-pw");
    await seedUser(rawDb, "carol", "carol-pw");
    await seedUser(rawDb, "dave", "dave-pw");
  });

  it("match Aのviewer接続(restapiRoutes)とmatch Bの投球push(matchRoutes)は、同一DOスタブ集合の別エントリとして正しく分離される", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);

    // match Aはviewerとして観戦。restapiRoutes経由でDOのfetch(SSE)が呼ばれる。
    const viewerRes = await ctx.app.request(
      `/matches/${matchIdA}/viewer`,
      {},
      ctx.env,
    );
    expect(viewerRes.status).toBe(200);

    // match Bはteam0(carol)が投球。matchRoutes経由でDOのpushStateUpdate(RPC)が呼ばれる。
    const shotRes = await ctx.app.request(
      `/shots?match_id=${matchIdB}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("carol", "carol-pw"),
        },
        body: JSON.stringify({
          translational_velocity: 2.5,
          angular_velocity: 1.5707,
          shot_angle: 1.5707,
        }),
      },
      ctx.env,
    );
    expect(shotRes.status).toBe(200);

    // match Aのviewer接続(fetch)はmatch Aのスタブにのみ発生し、match Bのpushには影響しない。
    expect(ctx.doStubs.get(matchIdA)?.fetch).toHaveBeenCalledTimes(1);
    expect(ctx.doStubs.get(matchIdA)?.pushStateUpdate).not.toHaveBeenCalled();

    // match Bの投球push(pushStateUpdate)はmatch Bのスタブにのみ発生し、match Aのviewerには影響しない。
    expect(ctx.doStubs.get(matchIdB)?.pushStateUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.doStubs.get(matchIdB)?.fetch).not.toHaveBeenCalled();
  });

  it("match Aのviewerが観戦中に、match Aのteam0が投球しても、match Bのviewerには一切通知が飛ばない", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);

    // 両試合ともviewer接続する。
    await ctx.app.request(`/matches/${matchIdA}/viewer`, {}, ctx.env);
    await ctx.app.request(`/matches/${matchIdB}/viewer`, {}, ctx.env);
    expect(ctx.doStubs.get(matchIdA)?.fetch).toHaveBeenCalledTimes(1);
    expect(ctx.doStubs.get(matchIdB)?.fetch).toHaveBeenCalledTimes(1);

    // match Aのteam0(alice)が投球する。
    await ctx.app.request(
      `/shots?match_id=${matchIdA}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({
          translational_velocity: 2.5,
          angular_velocity: 1.5707,
          shot_angle: 1.5707,
        }),
      },
      ctx.env,
    );

    // 投球pushはmatch Aのスタブにのみ発生し、match Bのスタブ(viewerが張っている方)には
    // 一切追加のfetch/pushStateUpdateが発生しない。
    expect(ctx.doStubs.get(matchIdA)?.pushStateUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.doStubs.get(matchIdB)?.pushStateUpdate).not.toHaveBeenCalled();
    // match Bのviewer接続(fetch)は最初の1回のままで増えていない(match Aの投球で誤って
    // match Bのビューアーへ新規fetchが飛んでいないこと)。
    expect(ctx.doStubs.get(matchIdB)?.fetch).toHaveBeenCalledTimes(1);
  });
});
