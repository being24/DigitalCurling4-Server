import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  matchData as matchDataTable,
  matchMixedDoublesSettings,
  score,
  shotInfo,
  state,
  stoneCoordinate,
} from "../db/schema";
import type { MatchDataRow, ShotInfoRow, StateRow } from "./state_replay";

export interface StateWithRelations {
  stateRow: StateRow;
  stoneCoordinateData: unknown;
  scoreData: { team0: number[]; team1: number[] };
}

/**
 * `src/crud.py::ReadData.read_match_data`相当。matchDataとmixed_doubles_settingsを結合して返す。
 */
export async function readMatchDataRow(
  db: DrizzleD1Database,
  matchId: string,
): Promise<MatchDataRow | null> {
  const rows = await db.select().from(matchDataTable).where(eq(matchDataTable.matchId, matchId)).limit(1);
  const row = rows[0];
  if (!row) return null;

  const mdsRows = await db
    .select()
    .from(matchMixedDoublesSettings)
    .where(eq(matchMixedDoublesSettings.matchId, matchId))
    .limit(1);
  const mds = mdsRows[0];

  return {
    matchId: row.matchId,
    firstTeamName: row.firstTeamName,
    secondTeamName: row.secondTeamName,
    firstTeamId: row.firstTeamId,
    secondTeamId: row.secondTeamId,
    gameMode: row.gameMode,
    mixedDoublesSettings: mds
      ? {
          positionedStonesPattern: mds.positionedStonesPattern,
          team0PowerPlayEnd: mds.team0PowerPlayEnd,
          team1PowerPlayEnd: mds.team1PowerPlayEnd,
          endSetupTeamIds: mds.endSetupTeamIds,
        }
      : null,
  };
}

function selectStateWithRelations(db: DrizzleD1Database) {
  return db
    .select({
      stateId: state.stateId,
      winnerTeamId: state.winnerTeamId,
      matchId: state.matchId,
      endNumber: state.endNumber,
      teamShotNumber: state.teamShotNumber,
      totalShotNumber: state.totalShotNumber,
      firstTeamRemainingTime: state.firstTeamRemainingTime,
      secondTeamRemainingTime: state.secondTeamRemainingTime,
      firstTeamExtraEndRemainingTime: state.firstTeamExtraEndRemainingTime,
      secondTeamExtraEndRemainingTime: state.secondTeamExtraEndRemainingTime,
      stoneCoordinateId: state.stoneCoordinateId,
      scoreId: state.scoreId,
      shotId: state.shotId,
      nextShotTeamId: state.nextShotTeamId,
      createdAt: state.createdAt,
      stoneCoordinateData: stoneCoordinate.data,
      scoreTeam0: score.team0,
      scoreTeam1: score.team1,
    })
    .from(state)
    .leftJoin(stoneCoordinate, eq(state.stoneCoordinateId, stoneCoordinate.stoneCoordinateId))
    .leftJoin(score, eq(state.scoreId, score.scoreId));
}

type RawStateRow = Awaited<ReturnType<ReturnType<typeof selectStateWithRelations>["where"]>>[number];

function toStateWithRelations(row: RawStateRow): StateWithRelations {
  return {
    stateRow: {
      stateId: row.stateId,
      winnerTeamId: row.winnerTeamId,
      matchId: row.matchId ?? "",
      endNumber: row.endNumber ?? 0,
      teamShotNumber: row.teamShotNumber,
      totalShotNumber: row.totalShotNumber,
      firstTeamRemainingTime: row.firstTeamRemainingTime ?? 0,
      secondTeamRemainingTime: row.secondTeamRemainingTime ?? 0,
      firstTeamExtraEndRemainingTime: row.firstTeamExtraEndRemainingTime ?? 0,
      secondTeamExtraEndRemainingTime: row.secondTeamExtraEndRemainingTime ?? 0,
      stoneCoordinateId: row.stoneCoordinateId ?? "",
      scoreId: row.scoreId ?? "",
      shotId: row.shotId,
      nextShotTeamId: row.nextShotTeamId,
      createdAt: row.createdAt,
    },
    stoneCoordinateData: row.stoneCoordinateData ?? {},
    scoreData: { team0: row.scoreTeam0 ?? [], team1: row.scoreTeam1 ?? [] },
  };
}

/**
 * `src/crud.py::ReadData.read_latest_state_data`相当。
 * SQLiteのORDER BY DESCはNULLを末尾に置くため、Postgres版の`.nullslast()`は不要。
 */
export async function readLatestStateData(
  db: DrizzleD1Database,
  matchId: string,
): Promise<StateWithRelations | null> {
  const rows = await selectStateWithRelations(db)
    .where(eq(state.matchId, matchId))
    .orderBy(desc(state.endNumber), desc(state.totalShotNumber), desc(state.stateId))
    .limit(1);
  return rows[0] ? toStateWithRelations(rows[0]) : null;
}

/** `src/crud.py::ReadData.read_state_data_in_end`相当 */
export async function readStateDataInEnd(
  db: DrizzleD1Database,
  matchId: string,
  endNumber: number,
): Promise<StateWithRelations[]> {
  const rows = await selectStateWithRelations(db)
    .where(and(eq(state.matchId, matchId), eq(state.endNumber, endNumber)))
    .orderBy(state.totalShotNumber);
  return rows.map(toStateWithRelations);
}

/** `src/crud.py::ReadData.read_last_shot_info_by_post_state_id`相当 */
export async function readShotInfoByPostShotStateId(
  db: DrizzleD1Database,
  stateId: string,
): Promise<ShotInfoRow | null> {
  const rows = await db.select().from(shotInfo).where(eq(shotInfo.postShotStateId, stateId)).limit(1);
  const row = rows[0];
  if (!row || row.translationalVelocity == null || row.angularVelocity == null || row.shotAngle == null) {
    return null;
  }
  return {
    translationalVelocity: row.translationalVelocity,
    angularVelocity: row.angularVelocity,
    shotAngle: row.shotAngle,
  };
}
