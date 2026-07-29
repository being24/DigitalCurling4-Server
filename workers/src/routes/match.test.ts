import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createFakeD1Database } from "../test-utils/fake-d1";
import { hashPassword } from "../lib/auth";

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
    return { result: JSON.stringify({ stones, trajectory_steps: 10 }), elapsedMs: 1 };
  }),
}));

const { matchRoutes } = await import("./match");
const { Hono } = await import("hono");
const { drizzle } = await import("drizzle-orm/d1");

const schemaSql = readFileSync(join(__dirname, "../../drizzle/0000_furry_toro.sql"), "utf-8");

const PEPPER = "test-pepper";

function buildApp() {
  const fakeD1 = createFakeD1Database(schemaSql);
  const db = fakeD1;
  const notifyTeamConfigUpdated = vi.fn(async () => {});
  const pushStateUpdate = vi.fn(async () => {});
  const app = new Hono();
  app.route("/", matchRoutes);
  const env = {
    // biome-ignore lint: fake D1 shim is structurally compatible with what drizzle-orm/d1 uses
    DB: db as never,
    PEPPER_DATA: PEPPER,
    MATCH_ROOM: {
      getByName: () => ({ notifyTeamConfigUpdated, pushStateUpdate }),
    },
  };
  return { app, env, db: drizzle(db as never), notifyTeamConfigUpdated, pushStateUpdate };
}

async function seedUser(rawDb: ReturnType<typeof createFakeD1Database>, username: string, password: string) {
  const salt = "salt-" + username;
  const hash = await hashPassword(password, salt, PEPPER);
  await rawDb
    .prepare("INSERT INTO users (username, hash_password, salt) VALUES (?, ?, ?)")
    .bind(username, hash, salt)
    .run();
}

function basicAuthHeader(username: string, password: string): string {
  return "Basic " + Buffer.from(`${username}:${password}`).toString("base64");
}

describe("matchRoutes", () => {
  let ctx: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    ctx = buildApp();
    const rawDb = ctx.env.DB as unknown as ReturnType<typeof createFakeD1Database>;
    await rawDb
      .prepare("INSERT INTO physical_simulator (physical_simulator_id, simulator_name) VALUES (?, ?)")
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
        headers: { "content-type": "application/json", authorization: basicAuthHeader("alice", "alice-pw") },
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
      player1: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p1" },
      player2: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p2" },
      player3: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p3" },
      player4: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p4" },
    });

    const team0Res = await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team0`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuthHeader("alice", "alice-pw") },
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
        headers: { "content-type": "application/json", authorization: basicAuthHeader("bob", "bob-pw") },
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
        headers: { "content-type": "application/json", authorization: basicAuthHeader("alice", "alice-pw") },
        body: JSON.stringify({ translational_velocity: 2.5, angular_velocity: 1.5707, shot_angle: 1.5707 }),
      },
      ctx.env,
    );
    const shotBody = await shotRes.text();
    expect(shotRes.status, `expected 200, got ${shotRes.status}: ${shotBody}`).toBe(200);
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
        headers: { "content-type": "application/json", authorization: basicAuthHeader("alice", "alice-pw") },
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
      player1: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p1" },
      player2: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p2" },
      player3: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p3" },
      player4: { max_velocity: 4.0, shot_std_dev: 0.0076, angle_std_dev: 0.0018, player_name: "p4" },
    });

    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team0`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuthHeader("alice", "alice-pw") },
        body: JSON.stringify(teamConfigBody("Team Alice")),
      },
      ctx.env,
    );
    await ctx.app.request(
      `/store-team-config?match_id=${matchId}&expected_match_team_name=team1`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuthHeader("bob", "bob-pw") },
        body: JSON.stringify(teamConfigBody("Team Bob")),
      },
      ctx.env,
    );

    const shotRes = await ctx.app.request(
      `/shots?match_id=${matchId}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", authorization: basicAuthHeader("bob", "bob-pw") },
        body: JSON.stringify({ translational_velocity: 2.5, angular_velocity: 1.5707, shot_angle: 1.5707 }),
      },
      ctx.env,
    );
    expect(shotRes.status).toBe(409);
  });
});
