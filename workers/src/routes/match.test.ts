import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword } from "../lib/auth";
import { createFakeD1Database } from "../test-utils/fake-d1";

// vitestはプレーンなVite環境で`.wasm`の直接importをロードできないため、
// `../simulate`をモック化してWasmシミュレータへの依存を切り離す
// (DB書き込み配線・スコア判定ロジック自体は本物のsimulate_json入出力形式で検証済みではなく、
// ここではエンドポイントの配線・状態遷移を検証する)。
vi.mock("../simulate", () => ({
  callSimulateJson: vi.fn(async () => {
    const stones: [number, number][] = [];
    // team0: 1つだけハウス中心(スコアが乗る位置)、残りは遠方
    stones.push([0, 38.405]);
    for (let i = 1; i < 8; i++) stones.push([100, 100]);
    // team1: 全て遠方
    for (let i = 0; i < 8; i++) stones.push([200, 200]);
    return {
      result: JSON.stringify({ stones, trajectory_steps: 10 }),
      elapsedMs: 1,
    };
  }),
}));

const { matchRoutes } = await import("./match");
const { Hono } = await import("hono");
const { drizzle } = await import("drizzle-orm/d1");

const schemaSql = readFileSync(
  join(__dirname, "../../drizzle/0000_furry_toro.sql"),
  "utf-8",
);

const PEPPER = "test-pepper";

function buildApp() {
  const fakeD1 = createFakeD1Database(schemaSql);
  const db = fakeD1;
  const notifyTeamConfigUpdated = vi.fn(async () => {});
  const pushStateUpdate = vi.fn(async () => {});
  const sseFetch = vi.fn(
    async (req: Request) =>
      new Response("sse-ok", { status: 200, headers: req.headers }),
  );
  const app = new Hono();
  app.route("/", matchRoutes);
  const env = {
    // fake D1 shim is structurally compatible with what drizzle-orm/d1 uses
    DB: db as never,
    PEPPER_DATA: PEPPER,
    MATCH_ROOM: {
      getByName: () => ({
        notifyTeamConfigUpdated,
        pushStateUpdate,
        fetch: sseFetch,
      }),
    },
  };
  return {
    app,
    env,
    db: drizzle(db as never),
    notifyTeamConfigUpdated,
    pushStateUpdate,
    sseFetch,
  };
}

/**
 * 複数試合の同時進行を検証するためのヘルパー。`buildApp()`と異なり、
 * `MATCH_ROOM.getByName(matchId)`をmatchId別に独立したstubへ振り分ける
 * (実際のDurable Objectsが`matchId`単位でインスタンス分離される挙動を模す)。
 * 既存テスト(`buildApp()`)は影響を受けないよう、別ヘルパーとして追加する。
 */
function buildAppWithPerMatchDo() {
  const fakeD1 = createFakeD1Database(schemaSql);
  const db = fakeD1;
  type DoStub = {
    notifyTeamConfigUpdated: ReturnType<typeof vi.fn>;
    pushStateUpdate: ReturnType<typeof vi.fn>;
    sseFetch: ReturnType<typeof vi.fn>;
  };
  const doStubs = new Map<string, DoStub>();
  const getByName = vi.fn((matchId: string): DoStub => {
    let stub = doStubs.get(matchId);
    if (!stub) {
      stub = {
        notifyTeamConfigUpdated: vi.fn(async () => {}),
        pushStateUpdate: vi.fn(async () => {}),
        sseFetch: vi.fn(
          async (req: Request) =>
            new Response("sse-ok", { status: 200, headers: req.headers }),
        ),
      };
      doStubs.set(matchId, stub);
    }
    return stub;
  });
  const app = new Hono();
  app.route("/", matchRoutes);
  const env = {
    DB: db as never,
    PEPPER_DATA: PEPPER,
    MATCH_ROOM: { getByName },
  };
  return { app, env, db: drizzle(db as never), getByName, doStubs };
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

describe("matchRoutes", () => {
  let ctx: ReturnType<typeof buildApp>;

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
  });

  it("rejects requests without basic auth", async () => {
    const res = await ctx.app.request(
      "/matches",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it("full flow: create match -> both teams configure -> single mid-end shot (five-rock / standard)", async () => {
    const createRes = await ctx.app.request(
      "/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({
          game_mode: "standard",
          tournament: { tournament_name: "test-cup" },
          simulator: { simulator_name: "fcv1" },
          applied_rule: "fgz_rule",
          time_limit: 600,
          extra_end_time_limit: 60,
          standard_end_count: 8,
          match_name: "alice vs bob",
        }),
      },
      ctx.env,
    );
    expect(createRes.status).toBe(200);
    const matchId = (await createRes.json()) as string;
    expect(typeof matchId).toBe("string");

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

    const team0Res = await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team0`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify(teamConfigBody("Team Alice")),
      },
      ctx.env,
    );
    expect(team0Res.status).toBe(200);
    expect(await team0Res.json()).toBe("team0");

    const team1Res = await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("bob", "bob-pw"),
        },
        body: JSON.stringify(teamConfigBody("Team Bob")),
      },
      ctx.env,
    );
    expect(team1Res.status).toBe(200);
    expect(await team1Res.json()).toBe("team1");
    expect(ctx.notifyTeamConfigUpdated).toHaveBeenCalledTimes(2);

    // team0 (Alice) throws the first shot of the match.
    const shotRes = await ctx.app.request(
      `/shots?match_id=${matchId}`,
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
    const shotBody = await shotRes.text();
    expect(
      shotRes.status,
      `expected 200, got ${shotRes.status}: ${shotBody}`,
    ).toBe(200);
    expect(ctx.pushStateUpdate).toHaveBeenCalledTimes(1);

    const { state, shotInfo } = await import("../db/schema");
    const stateRows = await ctx.db.select().from(state).all();
    // initial state (totalShotNumber=0) + post-shot state (totalShotNumber=1)
    expect(stateRows).toHaveLength(2);
    const postShot = stateRows.find((r) => r.totalShotNumber === 1);
    expect(postShot).toBeTruthy();
    expect(postShot?.nextShotTeamId).not.toBeNull();

    const shotRows = await ctx.db.select().from(shotInfo).all();
    expect(shotRows).toHaveLength(1);
    expect(shotRows[0].playerId).toBeTruthy();
  });

  it("bob cannot throw when it is team0's (Alice's) turn", async () => {
    const createRes = await ctx.app.request(
      "/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({
          game_mode: "standard",
          tournament: { tournament_name: "test-cup" },
          simulator: { simulator_name: "fcv1" },
          applied_rule: "fgz_rule",
          time_limit: 600,
          extra_end_time_limit: 60,
          standard_end_count: 8,
          match_name: "alice vs bob",
        }),
      },
      ctx.env,
    );
    const matchId = (await createRes.json()) as string;

    const teamConfigBody = (teamName: string) => ({
      use_default_config: true,
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

    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team0`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify(teamConfigBody("Team Alice")),
      },
      ctx.env,
    );
    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team1`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("bob", "bob-pw"),
        },
        body: JSON.stringify(teamConfigBody("Team Bob")),
      },
      ctx.env,
    );

    const shotRes = await ctx.app.request(
      `/shots?match_id=${matchId}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("bob", "bob-pw"),
        },
        body: JSON.stringify({
          translational_velocity: 2.5,
          angular_velocity: 1.5707,
          shot_angle: 1.5707,
        }),
      },
      ctx.env,
    );
    expect(shotRes.status).toBe(409);
  });

  it("POST /matches with an invalid body returns 422", async () => {
    const res = await ctx.app.request(
      "/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({ game_mode: "not-a-real-mode" }),
      },
      ctx.env,
    );
    expect(res.status).toBe(422);
  });

  it("store-team-config with a non-UUID match_id returns 422", async () => {
    const res = await ctx.app.request(
      "/store-team-config?match_id=not-a-uuid&expected_match_team_name=team0",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(res.status).toBe(422);
  });

  it("store-team-config with an invalid expected_match_team_name returns 422", async () => {
    const matchId = "019facfe-4805-71de-8582-11deeb598a43";
    const res = await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team9`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({}),
      },
      ctx.env,
    );
    expect(res.status).toBe(422);
  });

  it("POST /shots with a non-UUID match_id returns 422", async () => {
    const res = await ctx.app.request(
      "/shots?match_id=not-a-uuid",
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
    expect(res.status).toBe(422);
  });

  it("end-setup with a non-UUID matchId path param returns 422", async () => {
    const res = await ctx.app.request(
      "/matches/not-a-uuid/end-setup?request=center_house",
      {
        method: "POST",
        headers: { authorization: basicAuthHeader("alice", "alice-pw") },
      },
      ctx.env,
    );
    expect(res.status).toBe(422);
  });

  it("GET /matches/:matchId/stream rejects requests without basic auth", async () => {
    const res = await ctx.app.request(
      "/matches/019facfe-4805-71de-8582-11deeb598a43/stream",
      { method: "GET" },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it("GET /matches/:matchId/stream with a non-UUID matchId returns 422", async () => {
    const res = await ctx.app.request(
      "/matches/not-a-uuid/stream",
      { headers: { authorization: basicAuthHeader("alice", "alice-pw") } },
      ctx.env,
    );
    expect(res.status).toBe(422);
  });

  it("GET /matches/:matchId/stream returns 401 when the user has no team binding for the match", async () => {
    const res = await ctx.app.request(
      "/matches/019facfe-4805-71de-8582-11deeb598a43/stream",
      { headers: { authorization: basicAuthHeader("alice", "alice-pw") } },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it("GET /matches/:matchId/stream resolves the team from auth and delegates to MatchRoom via pathname=/sse", async () => {
    const createRes = await ctx.app.request(
      "/matches",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify({
          game_mode: "standard",
          tournament: { tournament_name: "test-cup" },
          simulator: { simulator_name: "fcv1" },
          applied_rule: "fgz_rule",
          time_limit: 600,
          extra_end_time_limit: 60,
          standard_end_count: 8,
          match_name: "alice vs bob",
        }),
      },
      ctx.env,
    );
    const matchId = (await createRes.json()) as string;

    const teamConfigBody = {
      use_default_config: true,
      team_name: "Team Alice",
      player1: {
        max_velocity: 4,
        shot_std_dev: 0.01,
        angle_std_dev: 0.01,
        player_name: "p1",
      },
      player2: {
        max_velocity: 4,
        shot_std_dev: 0.01,
        angle_std_dev: 0.01,
        player_name: "p2",
      },
      player3: {
        max_velocity: 4,
        shot_std_dev: 0.01,
        angle_std_dev: 0.01,
        player_name: "p3",
      },
      player4: {
        max_velocity: 4,
        shot_std_dev: 0.01,
        angle_std_dev: 0.01,
        player_name: "p4",
      },
    };
    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team0`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("alice", "alice-pw"),
        },
        body: JSON.stringify(teamConfigBody),
      },
      ctx.env,
    );

    const streamRes = await ctx.app.request(
      `/matches/${matchId}/stream`,
      { headers: { authorization: basicAuthHeader("alice", "alice-pw") } },
      ctx.env,
    );
    expect(streamRes.status).toBe(200);
    expect(ctx.sseFetch).toHaveBeenCalledTimes(1);
    const forwardedRequest = ctx.sseFetch.mock.calls[0][0] as Request;
    const forwardedUrl = new URL(forwardedRequest.url);
    expect(forwardedUrl.pathname).toBe("/sse");
    expect(forwardedUrl.searchParams.get("match")).toBe(matchId);
    expect(forwardedUrl.searchParams.get("team")).toBe("team0");
  });
});

describe("複数試合の同時進行", () => {
  let ctx: ReturnType<typeof buildAppWithPerMatchDo>;

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
          tournament: { tournament_name: "concurrent-test-cup" },
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
    ctx = buildAppWithPerMatchDo();
    const rawDb = ctx.env.DB as unknown as ReturnType<
      typeof createFakeD1Database
    >;
    await rawDb
      .prepare(
        "INSERT INTO physical_simulator (physical_simulator_id, simulator_name) VALUES (?, ?)",
      )
      .bind("sim-fcv1", "fcv1")
      .run();
    // match A/B/Cで別ユーザーを使い、認証レコードの取り違えが起きないことも同時に検証する。
    await seedUser(rawDb, "alice", "alice-pw");
    await seedUser(rawDb, "bob", "bob-pw");
    await seedUser(rawDb, "carol", "carol-pw");
    await seedUser(rawDb, "dave", "dave-pw");
    await seedUser(rawDb, "eve", "eve-pw");
    await seedUser(rawDb, "frank", "frank-pw");
  });

  it("2つの試合を並行して作成・team-configすると、それぞれ別のmatch_idが発行される", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    expect(matchIdA).not.toBe(matchIdB);

    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);

    // 各試合ごとにMATCH_ROOM.getByNameが正しいmatchIdで呼ばれている(DOインスタンスの宛先が
    // 試合ごとに分離されていることのルーティングレベルでの検証)。
    const calledMatchIds = ctx.getByName.mock.calls.map((call) => call[0]);
    expect(calledMatchIds).toContain(matchIdA);
    expect(calledMatchIds).toContain(matchIdB);
    expect(
      ctx.doStubs.get(matchIdA)?.notifyTeamConfigUpdated,
    ).toHaveBeenCalledTimes(2);
    expect(
      ctx.doStubs.get(matchIdB)?.notifyTeamConfigUpdated,
    ).toHaveBeenCalledTimes(2);
  });

  it("match Aへの投球は、match B向けのDOスタブを一切呼ばない(push配信のクロストーク防止)", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);

    const shotRes = await ctx.app.request(
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
    expect(shotRes.status).toBe(200);

    expect(ctx.doStubs.get(matchIdA)?.pushStateUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.doStubs.get(matchIdB)?.pushStateUpdate).not.toHaveBeenCalled();
  });

  it("match A/Bそれぞれで投球すると、各試合のD1状態(total_shot_number)が独立して進行する", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);

    // match Aのみ投球を1回進める。match Bは未投球のまま。
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

    const { state } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const statesA = await ctx.db
      .select()
      .from(state)
      .where(eq(state.matchId, matchIdA))
      .all();
    const statesB = await ctx.db
      .select()
      .from(state)
      .where(eq(state.matchId, matchIdB))
      .all();

    // match A: 初期state(totalShotNumber=0) + 投球後state(totalShotNumber=1)
    expect(statesA.map((s) => s.totalShotNumber).sort()).toEqual([0, 1]);
    // match B: 未投球のため初期stateのみ
    expect(statesB.map((s) => s.totalShotNumber)).toEqual([0]);
  });

  it("match Aでteam0(Alice)の番のときにmatch Bのteam1(Dave)が誤って投球できない", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);

    // daveはmatch Bのteam1であり、match Aには一切登録されていないため、
    // match A宛の投球はmatch_team_name解決に失敗し401になるはず(readMatchAuthTeamNameは
    // (username, matchId)の複合条件で引くため、他試合の認証情報を誤って使うことはない)。
    const res = await ctx.app.request(
      `/shots?match_id=${matchIdA}`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: basicAuthHeader("dave", "dave-pw"),
        },
        body: JSON.stringify({
          translational_velocity: 2.5,
          angular_velocity: 1.5707,
          shot_angle: 1.5707,
        }),
      },
      ctx.env,
    );
    expect(res.status).toBe(401);
  });

  it("3試合を同時進行させても、matchIdごとにDOスタブが正しく分離される", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    const matchIdC = await createMatch("match-C", "eve", "eve-pw");
    expect(new Set([matchIdA, matchIdB, matchIdC]).size).toBe(3);

    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);
    await configureTeams(matchIdC, ["eve", "eve-pw"], ["frank", "frank-pw"]);

    expect(
      ctx.doStubs.get(matchIdA)?.notifyTeamConfigUpdated,
    ).toHaveBeenCalledTimes(2);
    expect(
      ctx.doStubs.get(matchIdB)?.notifyTeamConfigUpdated,
    ).toHaveBeenCalledTimes(2);
    expect(
      ctx.doStubs.get(matchIdC)?.notifyTeamConfigUpdated,
    ).toHaveBeenCalledTimes(2);
  });

  it("3試合が同時進行中、1試合のみに投球しても他の2試合には一切pushが届かない", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    const matchIdC = await createMatch("match-C", "eve", "eve-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);
    await configureTeams(matchIdC, ["eve", "eve-pw"], ["frank", "frank-pw"]);

    // match Bのみに投球する。match A・Cは無関係のはず。
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

    expect(ctx.doStubs.get(matchIdB)?.pushStateUpdate).toHaveBeenCalledTimes(1);
    expect(ctx.doStubs.get(matchIdA)?.pushStateUpdate).not.toHaveBeenCalled();
    expect(ctx.doStubs.get(matchIdC)?.pushStateUpdate).not.toHaveBeenCalled();
  });

  it("3試合それぞれで投球すると、各試合のD1状態(total_shot_number)が互いに影響しあわず独立して進行する", async () => {
    const matchIdA = await createMatch("match-A", "alice", "alice-pw");
    const matchIdB = await createMatch("match-B", "carol", "carol-pw");
    const matchIdC = await createMatch("match-C", "eve", "eve-pw");
    await configureTeams(matchIdA, ["alice", "alice-pw"], ["bob", "bob-pw"]);
    await configureTeams(matchIdB, ["carol", "carol-pw"], ["dave", "dave-pw"]);
    await configureTeams(matchIdC, ["eve", "eve-pw"], ["frank", "frank-pw"]);

    const shoot = (matchId: string, user: string, pass: string) =>
      ctx.app.request(
        `/shots?match_id=${matchId}`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: basicAuthHeader(user, pass),
          },
          body: JSON.stringify({
            translational_velocity: 2.5,
            angular_velocity: 1.5707,
            shot_angle: 1.5707,
          }),
        },
        ctx.env,
      );

    // match Aは2投、match Bは1投、match Cは無投球のまま進める。
    await shoot(matchIdA, "alice", "alice-pw");
    await shoot(matchIdA, "bob", "bob-pw");
    await shoot(matchIdB, "carol", "carol-pw");

    const { state } = await import("../db/schema");
    const { eq } = await import("drizzle-orm");

    const latestTotalShots = async (matchId: string) => {
      const rows = await ctx.db
        .select()
        .from(state)
        .where(eq(state.matchId, matchId))
        .all();
      return Math.max(...rows.map((r) => r.totalShotNumber ?? -1));
    };

    expect(await latestTotalShots(matchIdA)).toBe(2);
    expect(await latestTotalShots(matchIdB)).toBe(1);
    expect(await latestTotalShots(matchIdC)).toBe(0);
  });
});
