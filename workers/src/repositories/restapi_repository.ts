import { and, desc, eq } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  matchData,
  matchMixedDoublesSettings,
  physicalSimulator,
  score,
  shotInfo,
  state,
  stoneCoordinate,
  tournament,
} from "../db/schema";

/**
 * `src/crud.py::ReadData` / `CollectID` 相当のDrizzleクエリ層。
 * レスポンスDTOは`src/models/schema_models.py`のPydanticモデルと同じsnake_caseフィールド名を持つ。
 */

export interface TournamentSchema {
  tournament_id: string;
  tournament_name: string | null;
}

export interface PhysicalSimulatorSchema {
  physical_simulator_id: string;
  simulator_name: string | null;
}

export interface ScoreSchema {
  score_id: string;
  team0: number[];
  team1: number[];
}

export interface StoneCoordinateSchema {
  stone_coordinate_id: string;
  data: unknown;
}

export interface ShotInfoSchema {
  shot_id: string;
  player_id: string | null;
  team_id: string | null;
  trajectory_id: string | null;
  pre_shot_state_id: string | null;
  post_shot_state_id: string | null;
  actual_translational_velocity: number | null;
  actual_shot_angle: number | null;
  actual_angular_velocity: number | null;
  translational_velocity: number | null;
  angular_velocity: number | null;
  shot_angle: number | null;
}

export interface MatchMixedDoublesSettingsSchema {
  positioned_stones_pattern: number;
  team0_power_play_end: number | null;
  team1_power_play_end: number | null;
  end_setup_team_ids: string[];
}

export interface StateSchema {
  state_id: string;
  winner_team_id: string | null;
  match_id: string | null;
  end_number: number | null;
  team_shot_number: number | null;
  total_shot_number: number | null;
  first_team_remaining_time: number | null;
  second_team_remaining_time: number | null;
  first_team_extra_end_remaining_time: number | null;
  second_team_extra_end_remaining_time: number | null;
  stone_coordinate_id: string | null;
  score_id: string | null;
  shot_id: string | null;
  next_shot_team_id: string | null;
  created_at: Date | null;
  stone_coordinate: StoneCoordinateSchema | null;
  score: ScoreSchema | null;
}

export interface MatchDataSchema {
  match_id: string;
  first_team_name: string | null;
  second_team_name: string | null;
  first_team_id: string | null;
  first_team_player1_id: string | null;
  first_team_player2_id: string | null;
  first_team_player3_id: string | null;
  first_team_player4_id: string | null;
  second_team_id: string | null;
  second_team_player1_id: string | null;
  second_team_player2_id: string | null;
  second_team_player3_id: string | null;
  second_team_player4_id: string | null;
  winner_team_id: string | null;
  score_id: string | null;
  time_limit: number | null;
  extra_end_time_limit: number | null;
  standard_end_count: number | null;
  physical_simulator_id: string | null;
  applied_rule: number | null;
  tournament_id: string | null;
  match_name: string | null;
  game_mode: string;
  created_at: Date | null;
  started_at: Date | null;
  score: ScoreSchema | null;
  tournament: TournamentSchema | null;
  simulator: PhysicalSimulatorSchema | null;
  mixed_doubles_settings: MatchMixedDoublesSettingsSchema | null;
}

export interface MatchSummarySchema {
  match_id: string;
  match_name: string | null;
  first_team_name: string | null;
  second_team_name: string | null;
  winner_team_id: string | null;
  game_mode: string;
  started_at: Date | null;
  tournament_id: string | null;
}

function toScoreSchema(
  row:
    | { scoreId: string | null; team0: number[] | null; team1: number[] | null }
    | null
    | undefined,
): ScoreSchema | null {
  if (!row || row.scoreId == null) return null;
  return {
    score_id: row.scoreId,
    team0: row.team0 ?? [],
    team1: row.team1 ?? [],
  };
}

function toStoneCoordinateSchema(
  row: { stoneCoordinateId: string | null; data: unknown } | null | undefined,
): StoneCoordinateSchema | null {
  if (!row || row.stoneCoordinateId == null) return null;
  return { stone_coordinate_id: row.stoneCoordinateId, data: row.data ?? {} };
}

function toTournamentSchema(
  row:
    | { tournamentId: string | null; tournamentName: string | null }
    | null
    | undefined,
): TournamentSchema | null {
  if (!row || row.tournamentId == null) return null;
  return {
    tournament_id: row.tournamentId,
    tournament_name: row.tournamentName,
  };
}

function toSimulatorSchema(
  row:
    | { physicalSimulatorId: string | null; simulatorName: string | null }
    | null
    | undefined,
): PhysicalSimulatorSchema | null {
  if (!row || row.physicalSimulatorId == null) return null;
  return {
    physical_simulator_id: row.physicalSimulatorId,
    simulator_name: row.simulatorName,
  };
}

export function toShotInfoSchema(
  row: typeof shotInfo.$inferSelect,
): ShotInfoSchema {
  return {
    shot_id: row.shotId,
    player_id: row.playerId,
    team_id: row.teamId,
    trajectory_id: row.trajectoryId,
    pre_shot_state_id: row.preShotStateId,
    post_shot_state_id: row.postShotStateId,
    actual_translational_velocity: row.actualTranslationalVelocity,
    actual_shot_angle: row.actualShotAngle,
    // Python版のShotInfoSchema.fill_actual_angular_velocity相当: 未計測時はリクエスト値にフォールバック
    actual_angular_velocity: row.actualAngularVelocity ?? row.angularVelocity,
    translational_velocity: row.translationalVelocity,
    angular_velocity: row.angularVelocity,
    shot_angle: row.shotAngle,
  };
}

function selectStateJoined(db: DrizzleD1Database) {
  return db
    .select({ state, stoneCoordinate, score })
    .from(state)
    .leftJoin(
      stoneCoordinate,
      eq(state.stoneCoordinateId, stoneCoordinate.stoneCoordinateId),
    )
    .leftJoin(score, eq(state.scoreId, score.scoreId));
}

type StateJoinedRow = Awaited<
  ReturnType<ReturnType<typeof selectStateJoined>["where"]>
>[number];

function toStateSchema(row: StateJoinedRow): StateSchema {
  return {
    state_id: row.state.stateId,
    winner_team_id: row.state.winnerTeamId,
    match_id: row.state.matchId,
    end_number: row.state.endNumber,
    team_shot_number: row.state.teamShotNumber,
    total_shot_number: row.state.totalShotNumber,
    first_team_remaining_time: row.state.firstTeamRemainingTime,
    second_team_remaining_time: row.state.secondTeamRemainingTime,
    first_team_extra_end_remaining_time:
      row.state.firstTeamExtraEndRemainingTime,
    second_team_extra_end_remaining_time:
      row.state.secondTeamExtraEndRemainingTime,
    stone_coordinate_id: row.state.stoneCoordinateId,
    score_id: row.state.scoreId,
    shot_id: row.state.shotId,
    next_shot_team_id: row.state.nextShotTeamId,
    created_at: row.state.createdAt,
    stone_coordinate: toStoneCoordinateSchema(row.stoneCoordinate),
    score: toScoreSchema(row.score),
  };
}

/** `src/crud.py::ReadData.read_match_data`相当 */
export async function readMatchData(
  db: DrizzleD1Database,
  matchId: string,
): Promise<MatchDataSchema | null> {
  const rows = await db
    .select({
      match: matchData,
      score,
      tournament,
      simulator: physicalSimulator,
    })
    .from(matchData)
    .leftJoin(score, eq(matchData.scoreId, score.scoreId))
    .leftJoin(tournament, eq(matchData.tournamentId, tournament.tournamentId))
    .leftJoin(
      physicalSimulator,
      eq(matchData.physicalSimulatorId, physicalSimulator.physicalSimulatorId),
    )
    .where(eq(matchData.matchId, matchId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  const mdsRows = await db
    .select()
    .from(matchMixedDoublesSettings)
    .where(eq(matchMixedDoublesSettings.matchId, matchId))
    .limit(1);
  const mds = mdsRows[0];

  return {
    match_id: row.match.matchId,
    first_team_name: row.match.firstTeamName,
    second_team_name: row.match.secondTeamName,
    first_team_id: row.match.firstTeamId,
    first_team_player1_id: row.match.firstTeamPlayer1Id,
    first_team_player2_id: row.match.firstTeamPlayer2Id,
    first_team_player3_id: row.match.firstTeamPlayer3Id,
    first_team_player4_id: row.match.firstTeamPlayer4Id,
    second_team_id: row.match.secondTeamId,
    second_team_player1_id: row.match.secondTeamPlayer1Id,
    second_team_player2_id: row.match.secondTeamPlayer2Id,
    second_team_player3_id: row.match.secondTeamPlayer3Id,
    second_team_player4_id: row.match.secondTeamPlayer4Id,
    winner_team_id: row.match.winnerTeamId,
    score_id: row.match.scoreId,
    time_limit: row.match.timeLimit,
    extra_end_time_limit: row.match.extraEndTimeLimit,
    standard_end_count: row.match.standardEndCount,
    physical_simulator_id: row.match.physicalSimulatorId,
    applied_rule: row.match.appliedRule,
    tournament_id: row.match.tournamentId,
    match_name: row.match.matchName,
    game_mode: row.match.gameMode,
    created_at: row.match.createdAt,
    started_at: row.match.startedAt,
    score: toScoreSchema(row.score),
    tournament: toTournamentSchema(row.tournament),
    simulator: toSimulatorSchema(row.simulator),
    mixed_doubles_settings: mds
      ? {
          positioned_stones_pattern: mds.positionedStonesPattern,
          team0_power_play_end: mds.team0PowerPlayEnd,
          team1_power_play_end: mds.team1PowerPlayEnd,
          end_setup_team_ids: mds.endSetupTeamIds ?? [],
        }
      : null,
  };
}

/** `src/routers/restapi.py::_resolve_latest_match_id_by_name`相当 */
export async function resolveLatestMatchIdByName(
  db: DrizzleD1Database,
  matchName: string,
): Promise<string | null> {
  const rows = await db
    .select({ matchId: matchData.matchId })
    .from(matchData)
    .where(eq(matchData.matchName, matchName))
    .orderBy(desc(matchData.startedAt))
    .limit(1);
  return rows[0]?.matchId ?? null;
}

/** `src/crud.py::ReadData.read_state_data`相当 */
export async function readStateData(
  db: DrizzleD1Database,
  stateId: string,
): Promise<StateSchema | null> {
  const rows = await selectStateJoined(db)
    .where(eq(state.stateId, stateId))
    .limit(1);
  return rows[0] ? toStateSchema(rows[0]) : null;
}

/** `src/crud.py::ReadData.read_latest_state_data`相当。SQLiteのDESCはNULLを末尾に置くため`.nullslast()`は不要 */
export async function readLatestStateData(
  db: DrizzleD1Database,
  matchId: string,
): Promise<StateSchema | null> {
  const rows = await selectStateJoined(db)
    .where(eq(state.matchId, matchId))
    .orderBy(
      desc(state.endNumber),
      desc(state.totalShotNumber),
      desc(state.stateId),
    )
    .limit(1);
  return rows[0] ? toStateSchema(rows[0]) : null;
}

/** `src/crud.py::ReadData.read_state_data_in_end`相当 */
export async function readStateDataInEnd(
  db: DrizzleD1Database,
  matchId: string,
  endNumber: number,
): Promise<StateSchema[]> {
  const rows = await selectStateJoined(db)
    .where(and(eq(state.matchId, matchId), eq(state.endNumber, endNumber)))
    .orderBy(state.totalShotNumber);
  return rows.map(toStateSchema);
}

/** `src/crud.py::CollectID.collect_state_ids`相当 */
export async function collectStateIds(
  db: DrizzleD1Database,
): Promise<string[]> {
  const rows = await db.select({ stateId: state.stateId }).from(state);
  return rows.map((r) => r.stateId).filter((id): id is string => id != null);
}

/** `src/crud.py::ReadData.read_stone_data`相当 */
export async function readStoneData(
  db: DrizzleD1Database,
  stoneCoordinateId: string,
): Promise<StoneCoordinateSchema | null> {
  const rows = await db
    .select()
    .from(stoneCoordinate)
    .where(eq(stoneCoordinate.stoneCoordinateId, stoneCoordinateId))
    .limit(1);
  return toStoneCoordinateSchema(rows[0]);
}

/** `src/crud.py::ReadData.read_score_data`相当 */
export async function readScoreData(
  db: DrizzleD1Database,
  scoreId: string,
): Promise<ScoreSchema | null> {
  const rows = await db
    .select()
    .from(score)
    .where(eq(score.scoreId, scoreId))
    .limit(1);
  return toScoreSchema(rows[0]);
}

/** `src/crud.py::ReadData.read_shot_info_data`相当 */
export async function readShotInfoData(
  db: DrizzleD1Database,
  shotId: string,
): Promise<ShotInfoSchema | null> {
  const rows = await db
    .select()
    .from(shotInfo)
    .where(eq(shotInfo.shotId, shotId))
    .limit(1);
  return rows[0] ? toShotInfoSchema(rows[0]) : null;
}

/** `src/crud.py::ReadData.read_last_shot_info_by_post_state_id`相当 */
export async function readLastShotInfoByPostStateId(
  db: DrizzleD1Database,
  postShotStateId: string,
): Promise<ShotInfoSchema | null> {
  const rows = await db
    .select()
    .from(shotInfo)
    .where(eq(shotInfo.postShotStateId, postShotStateId))
    .limit(1);
  return rows[0] ? toShotInfoSchema(rows[0]) : null;
}

/** `src/crud.py::ReadData.read_latest_shot_info_by_match_id`相当 */
export async function readLatestShotInfoByMatchId(
  db: DrizzleD1Database,
  matchId: string,
): Promise<ShotInfoSchema | null> {
  const rows = await db
    .select({ shotInfo })
    .from(shotInfo)
    .innerJoin(state, eq(shotInfo.postShotStateId, state.stateId))
    .where(eq(state.matchId, matchId))
    .orderBy(desc(state.endNumber), desc(state.totalShotNumber))
    .limit(1);
  return rows[0] ? toShotInfoSchema(rows[0].shotInfo) : null;
}

/** `src/routers/restapi.py::MatchShotsAPI.list_shots_in_end`相当 */
export async function readShotsInEnd(
  db: DrizzleD1Database,
  matchId: string,
  endNumber: number,
): Promise<ShotInfoSchema[]> {
  const rows = await db
    .select({ shotInfo })
    .from(shotInfo)
    .innerJoin(state, eq(shotInfo.postShotStateId, state.stateId))
    .where(and(eq(state.matchId, matchId), eq(state.endNumber, endNumber)))
    .orderBy(state.totalShotNumber);
  return rows.map((r) => toShotInfoSchema(r.shotInfo));
}

/** `src/routers/restapi.py::MatchShotsAPI.get_shot_in_end`相当 */
export async function readShotInEndByTotalShotNumber(
  db: DrizzleD1Database,
  matchId: string,
  endNumber: number,
  totalShotNumber: number,
): Promise<ShotInfoSchema | null> {
  const rows = await db
    .select({ shotInfo })
    .from(shotInfo)
    .innerJoin(state, eq(shotInfo.postShotStateId, state.stateId))
    .where(
      and(
        eq(state.matchId, matchId),
        eq(state.endNumber, endNumber),
        eq(state.totalShotNumber, totalShotNumber),
      ),
    )
    .limit(1);
  return rows[0] ? toShotInfoSchema(rows[0].shotInfo) : null;
}

/** `src/crud.py::ReadData.read_all_tournaments`相当 */
export async function readAllTournaments(
  db: DrizzleD1Database,
): Promise<TournamentSchema[]> {
  const rows = await db
    .select()
    .from(tournament)
    .orderBy(tournament.tournamentName);
  return rows
    .map(toTournamentSchema)
    .filter((t): t is TournamentSchema => t !== null);
}

/** `src/crud.py::ReadData.read_matches_by_tournament_name`相当 */
export async function readMatchesByTournamentName(
  db: DrizzleD1Database,
  tournamentName: string,
): Promise<MatchSummarySchema[]> {
  const rows = await db
    .select({ match: matchData })
    .from(matchData)
    .innerJoin(tournament, eq(matchData.tournamentId, tournament.tournamentId))
    .where(eq(tournament.tournamentName, tournamentName))
    .orderBy(desc(matchData.startedAt));
  return rows.map((r) => ({
    match_id: r.match.matchId,
    match_name: r.match.matchName,
    first_team_name: r.match.firstTeamName,
    second_team_name: r.match.secondTeamName,
    winner_team_id: r.match.winnerTeamId,
    game_mode: r.match.gameMode,
    started_at: r.match.startedAt,
    tournament_id: r.match.tournamentId,
  }));
}
