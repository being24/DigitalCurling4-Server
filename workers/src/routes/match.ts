import { drizzle } from "drizzle-orm/d1";
import type { Context } from "hono";
import { Hono } from "hono";
import { auth as parseBasicAuth } from "hono/utils/basic-auth";
import type { GameMode } from "../domain/match_rules";
import {
  calculateTotalScore,
  generateResetStoneCoordinateData,
  getScoreFromDistanceList,
  totalShotsPerEnd as getTotalShotsPerEnd,
  stoneCountPerTeam,
  stoneDistanceFromTee,
} from "../domain/match_rules";
import type { Bindings } from "../env";
import { distortShot } from "../lib/random";
import { generateUuid7 } from "../lib/uuid7";
import { requireBasicAuth } from "../middleware/basic_auth";
import {
  createMatchAuth,
  createMatchData,
  createPlayerData,
  createStateData,
  EndSetupValueError,
  type MatchDataRow,
  performMixedDoublesEndSetup,
  readMatchAuthTeamName,
  readMatchData,
  readPlayerData,
  readPlayerId,
  readSimulatorId,
  readTeamId,
  readUserHashPassword,
  recordLastShotOfEnd,
  recordShotResult,
  type StateInsertRow,
  setEndSetupTeamForEnd,
  updateFirstTeam,
  updateMatchDataWithTeamName,
  updateNextShotTeam,
  updateSecondTeam,
} from "../repositories/match";
import { readLatestStateData } from "../services/match_room_queries";
import { callSimulateJson } from "../simulate";

/**
 * `src/routers/match.py`相当。試合作成・team-config登録・投球処理・mixed doubles end-setupの
 * 認証必須4エンドポイント。
 */

export const matchRoutes = new Hono<{ Bindings: Bindings }>();
matchRoutes.use(requireBasicAuth);

// match作成時に使うデフォルトのteam/player id(`src/routers/match.py::start_match`の定数をそのまま踏襲)
const DEFAULT_FIRST_TEAM_ID = "5050f20f-cf97-4fb1-bbc1-f2c9052e0d17";
const DEFAULT_SECOND_TEAM_ID = "60e1e056-3613-4846-afc9-514ea7b6adde";
const DEFAULT_FIRST_TEAM_PLAYER_ID = "006951d4-37b2-48eb-85a2-af9463a1e7aa";
const DEFAULT_SECOND_TEAM_PLAYER_ID = "0eb2f8a5-bc94-40f2-9e0c-6d1300f2e7b0";

// `src/routers/http_exceptions.py`相当。FastAPIの既定エラーボディ({"detail": ...})を踏襲する。
function notFound(c: Context, detail: string) {
  return c.json({ detail }, 404);
}
function badRequest(c: Context, detail: string) {
  return c.json({ detail }, 400);
}
function conflict(c: Context, detail: string) {
  return c.json({ detail }, 409);
}
function unauthorized(c: Context, detail: string) {
  return c.json({ detail }, 401);
}

function requireAuthUser(
  c: Context,
): { username: string; password: string } | null {
  return parseBasicAuth(c.req.raw) ?? null;
}

// ---- POST /matches ----

interface ClientDataBody {
  game_mode: GameMode;
  tournament: { tournament_name: string };
  simulator: { simulator_name: string };
  applied_rule: "fgz_rule" | "no_tick_rule" | "modified_fgz_rule";
  time_limit: number;
  extra_end_time_limit: number;
  standard_end_count: number;
  match_name: string;
  positioned_stones_pattern?: number | null;
}

function parseClientDataBody(raw: unknown): ClientDataBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (o.game_mode !== "standard" && o.game_mode !== "mixed_doubles")
    return null;
  const t = o.tournament as Record<string, unknown> | undefined;
  const s = o.simulator as Record<string, unknown> | undefined;
  if (typeof t?.tournament_name !== "string") return null;
  if (typeof s?.simulator_name !== "string") return null;
  if (
    o.applied_rule !== "fgz_rule" &&
    o.applied_rule !== "no_tick_rule" &&
    o.applied_rule !== "modified_fgz_rule"
  ) {
    return null;
  }
  if (typeof o.time_limit !== "number") return null;
  if (typeof o.extra_end_time_limit !== "number") return null;
  if (typeof o.standard_end_count !== "number") return null;
  if (typeof o.match_name !== "string") return null;
  const positionedStonesPattern =
    typeof o.positioned_stones_pattern === "number"
      ? o.positioned_stones_pattern
      : null;
  return {
    game_mode: o.game_mode,
    tournament: { tournament_name: t.tournament_name },
    simulator: { simulator_name: s.simulator_name },
    applied_rule: o.applied_rule,
    time_limit: o.time_limit,
    extra_end_time_limit: o.extra_end_time_limit,
    standard_end_count: o.standard_end_count,
    match_name: o.match_name,
    positioned_stones_pattern: positionedStonesPattern,
  };
}

matchRoutes.post("/matches", async (c) => {
  const db = drizzle(c.env.DB);
  const raw = await c.req.json().catch(() => null);
  const body = parseClientDataBody(raw);
  if (!body) return badRequest(c, "Invalid request body.");

  const isMixedDoubles = body.game_mode === "mixed_doubles";

  let positionedStonesPattern = body.positioned_stones_pattern;
  if (isMixedDoubles) {
    if (
      positionedStonesPattern === null ||
      positionedStonesPattern === undefined
    ) {
      positionedStonesPattern = 0;
    }
    if (positionedStonesPattern < 0 || positionedStonesPattern > 5) {
      return badRequest(
        c,
        "positioned_stones_pattern must be between 0 and 5.",
      );
    }
  }

  const simulatorId = await readSimulatorId(db, body.simulator.simulator_name);
  if (simulatorId === null) return notFound(c, "Simulator not found.");

  const appliedRuleName = body.applied_rule;
  if (isMixedDoubles && appliedRuleName !== "modified_fgz_rule") {
    return badRequest(c, 'Mixed doubles only supports "modified_fgz_rule".');
  }
  if (!isMixedDoubles && appliedRuleName === "modified_fgz_rule") {
    return badRequest(
      c,
      'Standard game mode does not support "modified_fgz_rule".',
    );
  }

  let appliedRule: number;
  if (appliedRuleName === "fgz_rule") appliedRule = 0;
  else if (appliedRuleName === "no_tick_rule") appliedRule = 1;
  else appliedRule = 2; // modified_fgz_rule

  const matchId = generateUuid7();
  const scoreId = generateUuid7();
  const tournamentId = generateUuid7();
  const teamScore = new Array<number>(body.standard_end_count + 1).fill(0);
  const now = new Date();

  await createMatchData(db, {
    matchId,
    scoreId,
    tournamentId,
    tournamentName: body.tournament.tournament_name,
    teamScore,
    firstTeamId: DEFAULT_FIRST_TEAM_ID,
    firstTeamPlayer1Id: DEFAULT_FIRST_TEAM_PLAYER_ID,
    firstTeamPlayer2Id: DEFAULT_FIRST_TEAM_PLAYER_ID,
    firstTeamPlayer3Id: isMixedDoubles ? null : DEFAULT_FIRST_TEAM_PLAYER_ID,
    firstTeamPlayer4Id: isMixedDoubles ? null : DEFAULT_FIRST_TEAM_PLAYER_ID,
    secondTeamId: DEFAULT_SECOND_TEAM_ID,
    secondTeamPlayer1Id: DEFAULT_SECOND_TEAM_PLAYER_ID,
    secondTeamPlayer2Id: DEFAULT_SECOND_TEAM_PLAYER_ID,
    secondTeamPlayer3Id: isMixedDoubles ? null : DEFAULT_SECOND_TEAM_PLAYER_ID,
    secondTeamPlayer4Id: isMixedDoubles ? null : DEFAULT_SECOND_TEAM_PLAYER_ID,
    timeLimit: body.time_limit,
    extraEndTimeLimit: body.extra_end_time_limit,
    standardEndCount: body.standard_end_count,
    appliedRule,
    physicalSimulatorId: simulatorId,
    matchName: body.match_name,
    gameMode: body.game_mode,
    createdAt: now,
    startedAt: now,
    mixedDoublesSettings: isMixedDoubles
      ? {
          positionedStonesPattern: positionedStonesPattern as number,
          endSetupTeamIds: [DEFAULT_SECOND_TEAM_ID],
        }
      : null,
  });

  await createStateData(db, {
    stateId: generateUuid7(),
    winnerTeamId: null,
    matchId,
    endNumber: 0,
    teamShotNumber: isMixedDoubles ? null : 0,
    totalShotNumber: isMixedDoubles ? null : 0,
    firstTeamRemainingTime: body.time_limit,
    secondTeamRemainingTime: body.time_limit,
    firstTeamExtraEndRemainingTime: body.extra_end_time_limit,
    secondTeamExtraEndRemainingTime: body.extra_end_time_limit,
    scoreId,
    shotId: null,
    nextShotTeamId: isMixedDoubles ? null : DEFAULT_FIRST_TEAM_ID,
    createdAt: now,
    stoneCoordinate: {
      stoneCoordinateId: generateUuid7(),
      data: generateResetStoneCoordinateData(body.game_mode),
    },
  });

  return c.json(matchId);
});

// ---- POST /store-team-config ----

interface PlayerBody {
  max_velocity: number;
  shot_std_dev: number;
  angle_std_dev: number;
  player_name: string;
}

interface TeamConfigBody {
  use_default_config: boolean;
  team_name: string;
  player1: PlayerBody;
  player2: PlayerBody;
  player3: PlayerBody | null;
  player4: PlayerBody | null;
}

function isPlayerBody(v: unknown): v is PlayerBody {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.max_velocity === "number" &&
    typeof o.shot_std_dev === "number" &&
    typeof o.angle_std_dev === "number" &&
    typeof o.player_name === "string"
  );
}

function parseTeamConfigBody(raw: unknown): TeamConfigBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.use_default_config !== "boolean") return null;
  if (typeof o.team_name !== "string") return null;
  if (!isPlayerBody(o.player1) || !isPlayerBody(o.player2)) return null;
  const player3 =
    o.player3 == null ? null : isPlayerBody(o.player3) ? o.player3 : undefined;
  const player4 =
    o.player4 == null ? null : isPlayerBody(o.player4) ? o.player4 : undefined;
  if (player3 === undefined || player4 === undefined) return null;
  return {
    use_default_config: o.use_default_config,
    team_name: o.team_name,
    player1: o.player1,
    player2: o.player2,
    player3,
    player4,
  };
}

matchRoutes.post("/store-team-config", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = c.req.query("match_id");
  const expectedMatchTeamName = c.req.query("expected_match_team_name");
  if (!matchId) return badRequest(c, "match_id is required.");
  if (expectedMatchTeamName !== "team0" && expectedMatchTeamName !== "team1") {
    return badRequest(c, "expected_match_team_name must be team0 or team1.");
  }
  const raw = await c.req.json().catch(() => null);
  const body = parseTeamConfigBody(raw);
  if (!body) return badRequest(c, "Invalid request body.");

  const authUser = requireAuthUser(c);
  if (!authUser) return unauthorized(c, "Invalid credentials");

  const matchData = await readMatchData(db, matchId);

  let matchTeamName = await updateMatchDataWithTeamName(
    db,
    matchId,
    body.team_name,
    expectedMatchTeamName,
  );

  if (matchTeamName === null) {
    // To reconnect this match, check if the client is the same as the one who started the match.
    const reconnectTeamName = await readMatchAuthTeamName(
      db,
      authUser.username,
      matchId,
    );
    if (reconnectTeamName === null)
      return conflict(c, "This match has already started.");
    matchTeamName = reconnectTeamName;
  } else {
    const hashPassword = await readUserHashPassword(db, authUser.username);
    if (hashPassword) {
      await createMatchAuth(
        db,
        authUser.username,
        hashPassword,
        matchTeamName,
        matchId,
      );
    }
  }

  const isMixedDoubles =
    matchData !== null && matchData.gameMode === "mixed_doubles";

  if (isMixedDoubles && (body.player3 !== null || body.player4 !== null)) {
    return badRequest(
      c,
      "Mixed doubles uses only player1/player2; player3/player4 must be omitted.",
    );
  }

  if (body.use_default_config) {
    const stub = c.env.MATCH_ROOM.getByName(matchId);
    await stub.notifyTeamConfigUpdated(matchId);
    return c.json(matchTeamName);
  }

  if (!isMixedDoubles && (body.player3 === null || body.player4 === null)) {
    return badRequest(c, "player3 and player4 are required for standard mode.");
  }

  const playerModels: PlayerBody[] = isMixedDoubles
    ? [body.player1, body.player2]
    : [
        body.player1,
        body.player2,
        body.player3 as PlayerBody,
        body.player4 as PlayerBody,
      ];

  let teamId = await readTeamId(db, body.team_name);
  if (teamId === null) teamId = crypto.randomUUID();

  const playerIds: string[] = [];
  for (const playerModel of playerModels) {
    let playerId = await readPlayerId(db, playerModel.player_name, teamId);
    if (playerId === null) {
      playerId = crypto.randomUUID();
      await createPlayerData(db, {
        playerId,
        teamId,
        maxVelocity: playerModel.max_velocity,
        shotStdDev: playerModel.shot_std_dev,
        angleStdDev: playerModel.angle_std_dev,
        playerName: playerModel.player_name,
      });
    }
    playerIds.push(playerId);
  }

  if (matchTeamName === "team0") {
    await updateFirstTeam(db, matchId, teamId, playerIds, body.team_name);
    if (matchData === null || matchData.gameMode === "standard") {
      await updateNextShotTeam(db, matchId, teamId);
    }
  } else {
    await updateSecondTeam(db, matchId, teamId, playerIds, body.team_name);
    if (isMixedDoubles) {
      const latestState = await readLatestStateData(db, matchId);
      if (
        latestState &&
        latestState.stateRow.endNumber === 0 &&
        latestState.stateRow.nextShotTeamId === null &&
        latestState.stateRow.totalShotNumber === null
      ) {
        await setEndSetupTeamForEnd(db, matchId, 0, teamId);
      }
    }
  }

  const stub = c.env.MATCH_ROOM.getByName(matchId);
  await stub.notifyTeamConfigUpdated(matchId);

  return c.json(matchTeamName);
});

// ---- POST /shots ----

interface ShotInfoBody {
  translational_velocity: number;
  angular_velocity: number;
  shot_angle: number;
}

function parseShotInfoBody(raw: unknown): ShotInfoBody | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (
    typeof o.translational_velocity !== "number" ||
    typeof o.angular_velocity !== "number" ||
    typeof o.shot_angle !== "number"
  ) {
    return null;
  }
  return {
    translational_velocity: o.translational_velocity,
    angular_velocity: o.angular_velocity,
    shot_angle: o.shot_angle,
  };
}

interface StoneCoord {
  x: number;
  y: number;
}
interface TeamStoneCoordinateData {
  team0: StoneCoord[];
  team1: StoneCoord[];
}

function buildPositionArray(data: TeamStoneCoordinateData): number[] {
  const flat = (stones: StoneCoord[]) => stones.flatMap((s) => [s.x, s.y]);
  return [...flat(data.team0), ...flat(data.team1)];
}

/** `workers/wasm-src/fcv1_simulator_wasm.cpp::simulate_json`を直接呼び出す */
async function simulateShot(params: {
  position: number[];
  totalShotNumber: number;
  shotPerTeam: number;
  teamNumber: number;
  appliedRule: number;
  velocityX: number;
  velocityY: number;
  angularVelocity: number;
}): Promise<{ team0: [number, number][]; team1: [number, number][] }> {
  const inputJson = JSON.stringify({
    position: params.position,
    shot: params.totalShotNumber,
    shot_per_team: params.shotPerTeam,
    team_id: params.teamNumber,
    applied_rule: params.appliedRule,
    x_velocities: params.velocityX,
    y_velocities: params.velocityY,
    angular_velocities: params.angularVelocity,
  });
  const { result } = await callSimulateJson(inputJson);
  const parsed = JSON.parse(result) as {
    stones?: [number, number][];
    error?: string;
  };
  if (!parsed.stones) {
    throw new Error(`simulate_json failed: ${parsed.error ?? "unknown error"}`);
  }
  const stonesPerTeam = parsed.stones.length / 2;
  return {
    team0: parsed.stones.slice(0, stonesPerTeam),
    team1: parsed.stones.slice(stonesPerTeam),
  };
}

/** `src/routers/match.py::_build_next_end_initial_state`相当 */
function buildNextEndInitialState(
  postState: StateInsertRow,
  gameMode: GameMode,
  nextEndFirstShotTeamId: string | null,
): StateInsertRow {
  const isMixedDoubles = gameMode === "mixed_doubles";
  return {
    stateId: generateUuid7(),
    winnerTeamId: null,
    matchId: postState.matchId,
    endNumber: postState.endNumber + 1,
    teamShotNumber: isMixedDoubles ? null : 0,
    totalShotNumber: isMixedDoubles ? null : 0,
    firstTeamRemainingTime: postState.firstTeamRemainingTime,
    secondTeamRemainingTime: postState.secondTeamRemainingTime,
    firstTeamExtraEndRemainingTime: postState.firstTeamExtraEndRemainingTime,
    secondTeamExtraEndRemainingTime: postState.secondTeamExtraEndRemainingTime,
    scoreId: postState.scoreId,
    shotId: null,
    nextShotTeamId: isMixedDoubles ? null : nextEndFirstShotTeamId,
    createdAt: new Date(),
    stoneCoordinate: {
      stoneCoordinateId: generateUuid7(),
      data: generateResetStoneCoordinateData(gameMode),
    },
  };
}

matchRoutes.post("/shots", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = c.req.query("match_id");
  if (!matchId) return badRequest(c, "match_id is required.");
  const raw = await c.req.json().catch(() => null);
  const shotInfoBody = parseShotInfoBody(raw);
  if (!shotInfoBody) return badRequest(c, "Invalid request body.");

  const endTime = new Date();

  const matchData = await readMatchData(db, matchId);
  const preState = await readLatestStateData(db, matchId);
  if (matchData === null || preState === null)
    return notFound(c, "Match or state not found.");

  if (preState.stateRow.winnerTeamId !== null)
    return conflict(c, "Match already finished.");
  if (preState.stateRow.nextShotTeamId === null)
    return conflict(c, "End setup required.");
  if (preState.stateRow.totalShotNumber === null)
    return conflict(c, "End setup required.");

  const authUser = requireAuthUser(c);
  if (!authUser) return unauthorized(c, "Invalid credentials");
  const matchTeamName = await readMatchAuthTeamName(
    db,
    authUser.username,
    matchId,
  );
  if (matchTeamName === null) return unauthorized(c, "Invalid match data");

  const shotTeamName =
    preState.stateRow.nextShotTeamId === matchData.firstTeamId
      ? "team0"
      : "team1";
  if (shotTeamName !== matchTeamName) return conflict(c, "Not your turn.");

  const shotTeamId = preState.stateRow.nextShotTeamId as string;
  const endNumber = preState.stateRow.endNumber;
  let totalShotNumber = preState.stateRow.totalShotNumber;
  let shotPerTeam = Math.floor(totalShotNumber / 2);
  const playerNumber = Math.floor(totalShotNumber / 4) + 1;
  const teamNumber = matchTeamName === "team0" ? 0 : 1;

  let playerId: string | null;
  if (matchData.gameMode === "mixed_doubles") {
    const shotIndexForTeam = shotPerTeam;
    const playerSlot = shotIndexForTeam === 0 || shotIndexForTeam === 4 ? 1 : 2;
    playerId =
      matchTeamName === "team0"
        ? playerSlot === 1
          ? matchData.firstTeamPlayer1Id
          : matchData.firstTeamPlayer2Id
        : playerSlot === 1
          ? matchData.secondTeamPlayer1Id
          : matchData.secondTeamPlayer2Id;
  } else {
    const firstTeamPlayerIds = [
      matchData.firstTeamPlayer1Id,
      matchData.firstTeamPlayer2Id,
      matchData.firstTeamPlayer3Id,
      matchData.firstTeamPlayer4Id,
    ];
    const secondTeamPlayerIds = [
      matchData.secondTeamPlayer1Id,
      matchData.secondTeamPlayer2Id,
      matchData.secondTeamPlayer3Id,
      matchData.secondTeamPlayer4Id,
    ];
    playerId =
      matchTeamName === "team0"
        ? firstTeamPlayerIds[playerNumber - 1]
        : secondTeamPlayerIds[playerNumber - 1];
  }
  if (!playerId) return notFound(c, "Player not found.");

  const playerData = await readPlayerData(db, playerId);
  if (playerData === null) return notFound(c, "Player not found.");

  const distorted = distortShot(
    {
      translationalVelocity: shotInfoBody.translational_velocity,
      shotAngle: shotInfoBody.shot_angle,
      angularVelocity: shotInfoBody.angular_velocity,
    },
    {
      maxVelocity: playerData.maxVelocity,
      shotStdDev: playerData.shotStdDev,
      angleStdDev: playerData.angleStdDev,
    },
  );

  const preEndTime = preState.stateRow.createdAt as Date;
  const timeDiffSeconds = (endTime.getTime() - preEndTime.getTime()) / 1000;

  let team0RemainingTime = preState.stateRow.firstTeamRemainingTime;
  let team1RemainingTime = preState.stateRow.secondTeamRemainingTime;
  let team0ExtraEndRemainingTime =
    preState.stateRow.firstTeamExtraEndRemainingTime;
  let team1ExtraEndRemainingTime =
    preState.stateRow.secondTeamExtraEndRemainingTime;
  let winnerTeamId: string | null = null;

  if (preState.stateRow.endNumber < matchData.standardEndCount) {
    if (matchTeamName === "team0") {
      team0RemainingTime -= timeDiffSeconds;
      if (team0RemainingTime < 0) {
        winnerTeamId = matchData.secondTeamId;
        team0RemainingTime = 0;
      }
    } else {
      team1RemainingTime -= timeDiffSeconds;
      if (team1RemainingTime < 0) {
        winnerTeamId = matchData.firstTeamId;
        team1RemainingTime = 0;
      }
    }
  } else {
    if (matchTeamName === "team0") {
      team0ExtraEndRemainingTime -= timeDiffSeconds;
      if (team0ExtraEndRemainingTime < 0) {
        winnerTeamId = matchData.secondTeamId;
        team0ExtraEndRemainingTime = 0;
      }
    } else {
      team1ExtraEndRemainingTime -= timeDiffSeconds;
      if (team1ExtraEndRemainingTime < 0) {
        winnerTeamId = matchData.firstTeamId;
        team1ExtraEndRemainingTime = 0;
      }
    }
  }

  const position = buildPositionArray(
    preState.stoneCoordinateData as TeamStoneCoordinateData,
  );
  const velocityX =
    distorted.translationalVelocity * Math.cos(distorted.shotAngle);
  const velocityY =
    distorted.translationalVelocity * Math.sin(distorted.shotAngle);

  const simulated = await simulateShot({
    position,
    totalShotNumber,
    shotPerTeam,
    teamNumber,
    appliedRule: matchData.appliedRule,
    velocityX,
    velocityY,
    angularVelocity: distorted.angularVelocity,
  });

  totalShotNumber += 1;
  shotPerTeam = Math.floor(totalShotNumber / 2);

  let nextShotTeamId: string | null =
    shotTeamId === matchData.secondTeamId
      ? matchData.firstTeamId
      : matchData.secondTeamId;

  const shotInfoData = {
    shotId: generateUuid7(),
    playerId,
    teamId: shotTeamId,
    trajectoryId: generateUuid7(),
    preShotStateId: preState.stateRow.stateId,
    postShotStateId: generateUuid7(),
    actualTranslationalVelocity: shotInfoBody.translational_velocity,
    actualShotAngle: shotInfoBody.shot_angle,
    actualAngularVelocity: distorted.actualAngularVelocity,
    translationalVelocity: distorted.translationalVelocity,
    shotAngle: distorted.shotAngle,
    angularVelocity: distorted.angularVelocity,
  };

  const stoneCount = stoneCountPerTeam(matchData.gameMode as GameMode);
  const stoneCoordinateData: TeamStoneCoordinateData = {
    team0: simulated.team0.slice(0, stoneCount).map(([x, y]) => ({ x, y })),
    team1: simulated.team1.slice(0, stoneCount).map(([x, y]) => ({ x, y })),
  };

  const totalShotsPerEnd = getTotalShotsPerEnd(matchData.gameMode as GameMode);
  let nextEndFirstShotTeamId: string | null = null;
  let nextEndSelectorTeamId: string | null = null;
  let scoreData: { scoreId: string; team0: number[]; team1: number[] } | null =
    null;

  if (totalShotNumber === totalShotsPerEnd) {
    nextShotTeamId = null;
    const team0Score = [...preState.scoreData.team0];
    const team1Score = [...preState.scoreData.team1];

    const distanceList: [number, number][] = [];
    for (let i = 0; i < stoneCount; i++) {
      distanceList.push([
        0,
        stoneDistanceFromTee(
          stoneCoordinateData.team0[i].x,
          stoneCoordinateData.team0[i].y,
        ),
      ]);
      distanceList.push([
        1,
        stoneDistanceFromTee(
          stoneCoordinateData.team1[i].x,
          stoneCoordinateData.team1[i].y,
        ),
      ]);
    }
    const [scoredTeam, points] = getScoreFromDistanceList(distanceList);

    if (scoredTeam === null) {
      nextEndFirstShotTeamId =
        matchTeamName === "team1"
          ? matchData.firstTeamId
          : matchData.secondTeamId;
    }

    if (matchData.gameMode === "mixed_doubles") {
      let currentSelector: string | null = null;
      const ids = matchData.mixedDoublesSettings?.endSetupTeamIds;
      if (ids && endNumber >= 0 && endNumber < ids.length) {
        currentSelector = ids[endNumber];
      }
      if (currentSelector === null) currentSelector = matchData.secondTeamId;

      if (scoredTeam === 0) {
        nextEndSelectorTeamId = matchData.secondTeamId;
      } else if (scoredTeam === 1) {
        nextEndSelectorTeamId = matchData.firstTeamId;
      } else {
        nextEndSelectorTeamId =
          currentSelector === matchData.firstTeamId
            ? matchData.secondTeamId
            : matchData.firstTeamId;
      }
    }

    if (endNumber < matchData.standardEndCount) {
      if (scoredTeam === 0) {
        team0Score[endNumber] = points;
        team1Score[endNumber] = 0;
        nextEndFirstShotTeamId = matchData.firstTeamId;
      } else if (scoredTeam === 1) {
        team0Score[endNumber] = 0;
        team1Score[endNumber] = points;
        nextEndFirstShotTeamId = matchData.secondTeamId;
      }
    } else {
      if (scoredTeam === 0) {
        team0Score[matchData.standardEndCount] = points;
        team1Score[matchData.standardEndCount] = 0;
        nextEndFirstShotTeamId = null;
        winnerTeamId = matchData.firstTeamId;
      } else if (scoredTeam === 1) {
        team0Score[matchData.standardEndCount] = 0;
        team1Score[matchData.standardEndCount] = points;
        winnerTeamId = matchData.secondTeamId;
        nextEndFirstShotTeamId = null;
      }
    }

    scoreData = {
      scoreId: preState.stateRow.scoreId,
      team0: team0Score,
      team1: team1Score,
    };

    if (endNumber >= matchData.standardEndCount - 1) {
      const team0Total = calculateTotalScore(team0Score);
      const team1Total = calculateTotalScore(team1Score);
      if (team0Total > team1Total) {
        nextEndFirstShotTeamId = null;
        winnerTeamId = matchData.firstTeamId;
      } else if (team0Total < team1Total) {
        nextEndFirstShotTeamId = null;
        winnerTeamId = matchData.secondTeamId;
      } else {
        winnerTeamId = null;
      }
    }
  }

  const postState: StateInsertRow = {
    stateId: shotInfoData.postShotStateId,
    winnerTeamId,
    matchId,
    endNumber: preState.stateRow.endNumber,
    teamShotNumber: shotPerTeam,
    totalShotNumber,
    firstTeamRemainingTime: team0RemainingTime,
    secondTeamRemainingTime: team1RemainingTime,
    firstTeamExtraEndRemainingTime: team0ExtraEndRemainingTime,
    secondTeamExtraEndRemainingTime: team1ExtraEndRemainingTime,
    scoreId: preState.stateRow.scoreId,
    shotId: null,
    nextShotTeamId,
    createdAt: new Date(),
    stoneCoordinate: {
      stoneCoordinateId: generateUuid7(),
      data: stoneCoordinateData,
    },
  };

  if (totalShotNumber === totalShotsPerEnd) {
    const nextEndInitialState =
      winnerTeamId === null
        ? buildNextEndInitialState(
            postState,
            matchData.gameMode as GameMode,
            nextEndFirstShotTeamId,
          )
        : null;
    await recordLastShotOfEnd(db, {
      shotInfo: shotInfoData,
      postState,
      preStateId: preState.stateRow.stateId,
      scoreData: scoreData as {
        scoreId: string;
        team0: number[];
        team1: number[];
      },
      nextEndInitialState,
      nextEndSelectorTeamId:
        winnerTeamId === null ? nextEndSelectorTeamId : null,
      matchId,
    });
  } else {
    await recordShotResult(db, {
      shotInfo: shotInfoData,
      postState,
      preStateId: preState.stateRow.stateId,
    });
  }

  const stub = c.env.MATCH_ROOM.getByName(matchId);
  await stub.pushStateUpdate(matchId);

  return c.json(null);
});

// ---- POST /matches/:matchId/end-setup ----

matchRoutes.post("/matches/:matchId/end-setup", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = c.req.param("matchId");
  const request = c.req.query("request");
  if (
    request !== "pp_left" &&
    request !== "pp_right" &&
    request !== "center_house" &&
    request !== "center_guard"
  ) {
    return badRequest(c, "Invalid positioned_stones option.");
  }

  const authUser = requireAuthUser(c);
  if (!authUser) return unauthorized(c, "Invalid credentials");
  const matchTeamName = await readMatchAuthTeamName(
    db,
    authUser.username,
    matchId,
  );
  if (matchTeamName === null) return unauthorized(c, "Invalid match data");

  const matchData: MatchDataRow | null = await readMatchData(db, matchId);
  const latestState = await readLatestStateData(db, matchId);
  if (matchData === null || latestState === null)
    return notFound(c, "Match not found.");

  if (matchData.gameMode !== "mixed_doubles")
    return badRequest(c, "end-setup is only for mixed_doubles.");
  if (matchData.mixedDoublesSettings === null)
    return conflict(c, "Mixed doubles settings missing.");
  if (latestState.stateRow.winnerTeamId !== null)
    return conflict(c, "Match already finished.");
  if (
    latestState.stateRow.nextShotTeamId !== null ||
    latestState.stateRow.totalShotNumber !== null
  ) {
    return conflict(c, "End already started.");
  }

  try {
    const { stateId } = await performMixedDoublesEndSetup(db, {
      matchData,
      latestState: {
        endNumber: latestState.stateRow.endNumber,
        firstTeamRemainingTime: latestState.stateRow.firstTeamRemainingTime,
        secondTeamRemainingTime: latestState.stateRow.secondTeamRemainingTime,
        firstTeamExtraEndRemainingTime:
          latestState.stateRow.firstTeamExtraEndRemainingTime,
        secondTeamExtraEndRemainingTime:
          latestState.stateRow.secondTeamExtraEndRemainingTime,
        scoreId: latestState.stateRow.scoreId,
      },
      matchTeamName,
      request,
    });

    const stub = c.env.MATCH_ROOM.getByName(matchId);
    await stub.pushStateUpdate(matchId);
    void stateId;
  } catch (e) {
    if (e instanceof EndSetupValueError) {
      const message = e.message;
      if (message.includes("only be used")) return badRequest(c, message);
      return conflict(c, message);
    }
    throw e;
  }

  return c.json(null);
});
