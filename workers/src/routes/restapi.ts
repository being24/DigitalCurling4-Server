import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Context } from "hono";
import type { Bindings } from "../env";
import {
  collectStateIds,
  readAllTournaments,
  readLastShotInfoByPostStateId,
  readLatestShotInfoByMatchId,
  readLatestStateData,
  readMatchData,
  readMatchesByTournamentName,
  readScoreData,
  readShotInEndByTotalShotNumber,
  readShotInfoData,
  readShotsInEnd,
  readStateData,
  readStateDataInEnd,
  readStoneData,
  resolveLatestMatchIdByName,
} from "../repositories/restapi_repository";

/**
 * `src/routers/restapi.py`相当。認証不要・読み取り専用の19エンドポイント。
 * レスポンスボディは`src/models/schema_models.py`のPydanticモデルと同じsnake_caseフィールド構造。
 */

export const restapiRoutes = new Hono<{ Bindings: Bindings }>();

// `src/routers/http_exceptions.py`相当。FastAPIの既定エラーボディ({"detail": ...})を踏襲する。
function notFound(c: Context, detail: string) {
  return c.json({ detail }, 404);
}

function badRequest(c: Context, detail: string) {
  return c.json({ detail }, 400);
}

function requiredQuery(c: Context, key: string): string | null {
  const value = c.req.query(key);
  return value && value.length > 0 ? value : null;
}

export function parseIntParam(value: string): number | null {
  if (!/^-?\d+$/.test(value)) return null;
  return Number.parseInt(value, 10);
}

async function resolveMatchIdByNameOrError(c: Context, db: DrizzleD1Database): Promise<string | Response> {
  const matchName = requiredQuery(c, "match_name");
  if (matchName === null) {
    return badRequest(c, "match_name is required.");
  }
  const matchId = await resolveLatestMatchIdByName(db, matchName);
  if (matchId === null) {
    return notFound(c, "Match not found.");
  }
  return matchId;
}

// ---- MatchAPI ----

restapiRoutes.get("/matches/by-name/latest", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  const matchData = await readMatchData(db, matchId);
  if (matchData === null) return notFound(c, "Match not found.");
  return c.json(matchData);
});

restapiRoutes.get("/matches/by-name/score", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  const matchData = await readMatchData(db, matchId);
  if (matchData === null || matchData.score === null) return notFound(c, "Match not found.");
  return c.json(matchData.score);
});

restapiRoutes.get("/matches/by-name/stone-coordinate/latest", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  const latestState = await readLatestStateData(db, matchId);
  if (latestState === null || latestState.stone_coordinate === null) {
    return notFound(c, "Stone coordinate not found.");
  }
  return c.json(latestState.stone_coordinate);
});

restapiRoutes.get("/matches/by-name/ends", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  const latestState = await readLatestStateData(db, matchId);
  if (latestState === null) return notFound(c, "Match not found.");
  return c.json(Array.from({ length: (latestState.end_number ?? 0) + 1 }, (_, i) => i));
});

restapiRoutes.get("/matches/by-name/latest-state", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  const stateData = await readLatestStateData(db, matchId);
  if (stateData === null) return notFound(c, "State not found.");
  return c.json(stateData);
});

restapiRoutes.get("/matches/by-name/ends/:endNumber/states", async (c) => {
  const db = drizzle(c.env.DB);
  const endNumber = parseIntParam(c.req.param("endNumber"));
  if (endNumber === null) return badRequest(c, "endNumber must be an integer.");
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  return c.json(await readStateDataInEnd(db, matchId, endNumber));
});

restapiRoutes.get("/matches/by-name/ends/:endNumber/shots", async (c) => {
  const db = drizzle(c.env.DB);
  const endNumber = parseIntParam(c.req.param("endNumber"));
  if (endNumber === null) return badRequest(c, "endNumber must be an integer.");
  const matchId = await resolveMatchIdByNameOrError(c, db);
  if (matchId instanceof Response) return matchId;
  return c.json(await readShotsInEnd(db, matchId, endNumber));
});

restapiRoutes.get("/matches/:matchId", async (c) => {
  const db = drizzle(c.env.DB);
  const matchData = await readMatchData(db, c.req.param("matchId"));
  if (matchData === null) return notFound(c, "Match not found.");
  return c.json(matchData);
});

restapiRoutes.get("/matches/:matchId/score", async (c) => {
  const db = drizzle(c.env.DB);
  const matchData = await readMatchData(db, c.req.param("matchId"));
  if (matchData === null || matchData.score === null) return notFound(c, "Match not found.");
  return c.json(matchData.score);
});

restapiRoutes.get("/matches/:matchId/stone-coordinate/latest", async (c) => {
  const db = drizzle(c.env.DB);
  const latestState = await readLatestStateData(db, c.req.param("matchId"));
  if (latestState === null || latestState.stone_coordinate === null) {
    return notFound(c, "Stone coordinate not found.");
  }
  return c.json(latestState.stone_coordinate);
});

restapiRoutes.get("/matches/:matchId/ends", async (c) => {
  const db = drizzle(c.env.DB);
  const latestState = await readLatestStateData(db, c.req.param("matchId"));
  if (latestState === null) return notFound(c, "Match not found.");
  return c.json(Array.from({ length: (latestState.end_number ?? 0) + 1 }, (_, i) => i));
});

restapiRoutes.get("/matches/:matchId/latest-state", async (c) => {
  const db = drizzle(c.env.DB);
  const stateData = await readLatestStateData(db, c.req.param("matchId"));
  if (stateData === null) return notFound(c, "State not found.");
  return c.json(stateData);
});

restapiRoutes.get("/matches/:matchId/ends/:endNumber/states", async (c) => {
  const db = drizzle(c.env.DB);
  const endNumber = parseIntParam(c.req.param("endNumber"));
  if (endNumber === null) return badRequest(c, "endNumber must be an integer.");
  return c.json(await readStateDataInEnd(db, c.req.param("matchId"), endNumber));
});

// ---- MatchShotsAPI ----

restapiRoutes.get("/matches/:matchId/ends/:endNumber/shots", async (c) => {
  const db = drizzle(c.env.DB);
  const endNumber = parseIntParam(c.req.param("endNumber"));
  if (endNumber === null) return badRequest(c, "endNumber must be an integer.");
  const matchId = c.req.param("matchId");
  const matchData = await readMatchData(db, matchId);
  if (matchData === null) return notFound(c, "Match not found.");
  return c.json(await readShotsInEnd(db, matchId, endNumber));
});

restapiRoutes.get("/matches/:matchId/ends/:endNumber/shots/:totalShotNumber", async (c) => {
  const db = drizzle(c.env.DB);
  const endNumber = parseIntParam(c.req.param("endNumber"));
  const totalShotNumber = parseIntParam(c.req.param("totalShotNumber"));
  if (endNumber === null || totalShotNumber === null) {
    return badRequest(c, "endNumber and totalShotNumber must be integers.");
  }
  const shotInfo = await readShotInEndByTotalShotNumber(db, c.req.param("matchId"), endNumber, totalShotNumber);
  if (shotInfo === null) return notFound(c, "Shot info not found.");
  return c.json(shotInfo);
});

restapiRoutes.get("/matches/:matchId/shots/latest", async (c) => {
  const db = drizzle(c.env.DB);
  const matchId = c.req.param("matchId");
  const matchData = await readMatchData(db, matchId);
  if (matchData === null) return notFound(c, "Match not found.");
  const shotInfo = await readLatestShotInfoByMatchId(db, matchId);
  if (shotInfo === null) return notFound(c, "No shots have been thrown yet.");
  return c.json(shotInfo);
});

// ---- StateAPI ----

restapiRoutes.get("/states/:stateId", async (c) => {
  const db = drizzle(c.env.DB);
  const stateData = await readStateData(db, c.req.param("stateId"));
  if (stateData === null) return notFound(c, "State not found.");
  return c.json(stateData);
});

restapiRoutes.get("/states", async (c) => {
  const db = drizzle(c.env.DB);
  return c.json(await collectStateIds(db));
});

// ---- StonePositionAPI ----

restapiRoutes.get("/stone_coordinate/:stoneCoordinateId", async (c) => {
  const db = drizzle(c.env.DB);
  const stoneData = await readStoneData(db, c.req.param("stoneCoordinateId"));
  if (stoneData === null) return notFound(c, "Stone coordinate not found.");
  return c.json(stoneData);
});

// ---- ScoreAPI ----

restapiRoutes.get("/scores/:scoreId", async (c) => {
  const db = drizzle(c.env.DB);
  const scoreData = await readScoreData(db, c.req.param("scoreId"));
  if (scoreData === null) return notFound(c, "Score not found.");
  return c.json(scoreData);
});

// ---- ShotInfoAPI ----

restapiRoutes.get("/shots/by-post-state/:postStateId", async (c) => {
  const db = drizzle(c.env.DB);
  const shotInfo = await readLastShotInfoByPostStateId(db, c.req.param("postStateId"));
  if (shotInfo === null) return notFound(c, "Shot info not found.");
  return c.json(shotInfo);
});

restapiRoutes.get("/shots/:shotId", async (c) => {
  const db = drizzle(c.env.DB);
  const shotInfo = await readShotInfoData(db, c.req.param("shotId"));
  if (shotInfo === null) return notFound(c, "Shot info not found.");
  return c.json(shotInfo);
});

// ---- TournamentAPI ----

restapiRoutes.get("/tournaments", async (c) => {
  const db = drizzle(c.env.DB);
  return c.json(await readAllTournaments(db));
});

// ---- MatchListAPI ----

restapiRoutes.get("/matches", async (c) => {
  const db = drizzle(c.env.DB);
  const tournamentName = requiredQuery(c, "tournament_name");
  if (tournamentName === null) return badRequest(c, "tournament_name is required.");
  const matches = await readMatchesByTournamentName(db, tournamentName);
  if (matches.length === 0) return notFound(c, "Tournament not found or has no matches.");
  return c.json(matches);
});
