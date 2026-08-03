import { and, desc, eq, or } from "drizzle-orm";
import type { BatchItem } from "drizzle-orm/batch";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import {
  basicAuthentication,
  matchData,
  matchMixedDoublesSettings,
  physicalSimulator,
  player,
  score,
  shotInfo,
  state,
  stoneCoordinate,
  tournament,
  trajectory,
  users,
} from "../db/schema";
import type {
  PowerPlaySide,
  StoneCoordinateData,
  TeamName,
} from "../domain/match_rules";
import { generateMixedDoublesInitialStones } from "../domain/match_rules";
import { generateUuid7 } from "../lib/uuid7";

/**
 * `src/services/match_db.py` + `src/crud.py`(match関連の一部)の移植。
 * D1はBEGIN/COMMIT形式の明示トランザクションをサポートしないため
 * (公式には`db.batch()`のみがアトミック実行を保証する)、
 * `session.begin()`ブロックに相当する複数文はすべて`db.batch()`でまとめる。
 * `with_for_update()`(行ロック)に相当する機構はD1に無いため、読み取り後に書き込む
 * 素朴な手順とし、Task07(MatchRoom)と同様に競合はスコープ外の既知のトレードオフとする。
 */

async function runBatch(
  db: DrizzleD1Database,
  statements: BatchItem<"sqlite">[],
): Promise<void> {
  if (statements.length === 0) return;
  await db.batch(statements as [BatchItem<"sqlite">, ...BatchItem<"sqlite">[]]);
}

// ---- Types ----

export interface PlayerRow {
  playerId: string;
  teamId: string | null;
  maxVelocity: number;
  shotStdDev: number;
  angleStdDev: number;
  playerName: string | null;
}

export interface MixedDoublesSettingsRow {
  matchId: string;
  positionedStonesPattern: number;
  team0PowerPlayEnd: number | null;
  team1PowerPlayEnd: number | null;
  endSetupTeamIds: string[];
}

export interface MatchDataRow {
  matchId: string;
  firstTeamName: string | null;
  secondTeamName: string | null;
  firstTeamId: string | null;
  firstTeamPlayer1Id: string | null;
  firstTeamPlayer2Id: string | null;
  firstTeamPlayer3Id: string | null;
  firstTeamPlayer4Id: string | null;
  secondTeamId: string | null;
  secondTeamPlayer1Id: string | null;
  secondTeamPlayer2Id: string | null;
  secondTeamPlayer3Id: string | null;
  secondTeamPlayer4Id: string | null;
  winnerTeamId: string | null;
  scoreId: string | null;
  timeLimit: number | null;
  extraEndTimeLimit: number | null;
  standardEndCount: number;
  appliedRule: number;
  physicalSimulatorId: string | null;
  tournamentId: string | null;
  matchName: string | null;
  gameMode: string;
  mixedDoublesSettings: MixedDoublesSettingsRow | null;
}

export interface StoneCoordinateInsert {
  stoneCoordinateId: string;
  data: StoneCoordinateData;
}

export interface StateInsertRow {
  stateId: string;
  winnerTeamId: string | null;
  matchId: string;
  endNumber: number;
  teamShotNumber: number | null;
  totalShotNumber: number | null;
  firstTeamRemainingTime: number;
  secondTeamRemainingTime: number;
  firstTeamExtraEndRemainingTime: number;
  secondTeamExtraEndRemainingTime: number;
  scoreId: string;
  shotId: string | null;
  nextShotTeamId: string | null;
  createdAt: Date;
  stoneCoordinate: StoneCoordinateInsert;
}

export interface ShotInfoInsertRow {
  shotId: string;
  playerId: string;
  teamId: string;
  trajectoryId: string;
  preShotStateId: string;
  postShotStateId: string;
  actualTranslationalVelocity: number;
  actualShotAngle: number;
  actualAngularVelocity: number;
  translationalVelocity: number;
  shotAngle: number;
  angularVelocity: number;
}

// ---- Read ----

/** `src/crud.py::ReadData.read_simulator_id`相当 */
export async function readSimulatorId(
  db: DrizzleD1Database,
  simulatorName: string,
): Promise<string | null> {
  const rows = await db
    .select({ physicalSimulatorId: physicalSimulator.physicalSimulatorId })
    .from(physicalSimulator)
    .where(eq(physicalSimulator.simulatorName, simulatorName))
    .limit(1);
  return rows[0]?.physicalSimulatorId ?? null;
}

/** `src/crud.py::ReadData.read_team_id`相当。同名チームを最後に使ったmatchのteam_idを返す */
export async function readTeamId(
  db: DrizzleD1Database,
  teamName: string,
): Promise<string | null> {
  const rows = await db
    .select({
      firstTeamName: matchData.firstTeamName,
      secondTeamName: matchData.secondTeamName,
      firstTeamId: matchData.firstTeamId,
      secondTeamId: matchData.secondTeamId,
    })
    .from(matchData)
    .where(
      or(
        eq(matchData.firstTeamName, teamName),
        eq(matchData.secondTeamName, teamName),
      ),
    )
    .orderBy(desc(matchData.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  if (row.firstTeamName === teamName) return row.firstTeamId;
  if (row.secondTeamName === teamName) return row.secondTeamId;
  return null;
}

/** `src/crud.py::ReadData.read_player_id`相当 */
export async function readPlayerId(
  db: DrizzleD1Database,
  playerName: string,
  teamId: string,
): Promise<string | null> {
  const rows = await db
    .select({ playerId: player.playerId })
    .from(player)
    .where(and(eq(player.playerName, playerName), eq(player.teamId, teamId)))
    .limit(1);
  return rows[0]?.playerId ?? null;
}

/** `src/crud.py::ReadData.read_player_data`相当 */
export async function readPlayerData(
  db: DrizzleD1Database,
  playerId: string,
): Promise<PlayerRow | null> {
  const rows = await db
    .select()
    .from(player)
    .where(eq(player.playerId, playerId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    playerId: row.playerId,
    teamId: row.teamId,
    maxVelocity: row.maxVelocity ?? 0,
    shotStdDev: row.shotStdDev ?? 0,
    angleStdDev: row.angleStdDev ?? 0,
    playerName: row.playerName,
  };
}

/** `src/crud.py::ReadData.read_mixed_doubles_settings_row_for_update`相当(行ロックはD1に無いため通常read) */
export async function readMixedDoublesSettingsRow(
  db: DrizzleD1Database,
  matchId: string,
): Promise<MixedDoublesSettingsRow | null> {
  const rows = await db
    .select()
    .from(matchMixedDoublesSettings)
    .where(eq(matchMixedDoublesSettings.matchId, matchId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    matchId: row.matchId,
    positionedStonesPattern: row.positionedStonesPattern,
    team0PowerPlayEnd: row.team0PowerPlayEnd,
    team1PowerPlayEnd: row.team1PowerPlayEnd,
    endSetupTeamIds: row.endSetupTeamIds,
  };
}

/** `src/crud.py::ReadData.read_match_data`相当。mixed_doubles_settingsも結合して返す */
export async function readMatchData(
  db: DrizzleD1Database,
  matchId: string,
): Promise<MatchDataRow | null> {
  const rows = await db
    .select()
    .from(matchData)
    .where(eq(matchData.matchId, matchId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const mixedDoublesSettings = await readMixedDoublesSettingsRow(db, matchId);
  return {
    matchId: row.matchId,
    firstTeamName: row.firstTeamName,
    secondTeamName: row.secondTeamName,
    firstTeamId: row.firstTeamId,
    firstTeamPlayer1Id: row.firstTeamPlayer1Id,
    firstTeamPlayer2Id: row.firstTeamPlayer2Id,
    firstTeamPlayer3Id: row.firstTeamPlayer3Id,
    firstTeamPlayer4Id: row.firstTeamPlayer4Id,
    secondTeamId: row.secondTeamId,
    secondTeamPlayer1Id: row.secondTeamPlayer1Id,
    secondTeamPlayer2Id: row.secondTeamPlayer2Id,
    secondTeamPlayer3Id: row.secondTeamPlayer3Id,
    secondTeamPlayer4Id: row.secondTeamPlayer4Id,
    winnerTeamId: row.winnerTeamId,
    scoreId: row.scoreId,
    timeLimit: row.timeLimit,
    extraEndTimeLimit: row.extraEndTimeLimit,
    standardEndCount: row.standardEndCount ?? 0,
    appliedRule: row.appliedRule ?? 0,
    physicalSimulatorId: row.physicalSimulatorId,
    tournamentId: row.tournamentId,
    matchName: row.matchName,
    gameMode: row.gameMode,
    mixedDoublesSettings,
  };
}

/** `src/authentication/basic_authentication_crud.py::ReadAuthentication.read_user_data`のうちhash_password取得部分相当 */
export async function readUserHashPassword(
  db: DrizzleD1Database,
  username: string,
): Promise<string | null> {
  const rows = await db
    .select({ hashPassword: users.hashPassword })
    .from(users)
    .where(eq(users.username, username))
    .limit(1);
  return rows[0]?.hashPassword ?? null;
}

/** `src/authentication/basic_authentication_crud.py::ReadAuthentication.read_match_data`相当 */
export async function readMatchAuthTeamName(
  db: DrizzleD1Database,
  username: string,
  matchId: string,
): Promise<TeamName | null> {
  const rows = await db
    .select({ matchTeamName: basicAuthentication.matchTeamName })
    .from(basicAuthentication)
    .where(
      and(
        eq(basicAuthentication.username, username),
        eq(basicAuthentication.matchId, matchId),
      ),
    )
    .limit(1);
  const value = rows[0]?.matchTeamName;
  return value === "team0" || value === "team1" ? value : null;
}

// ---- Write ----

/** `src/authentication/basic_authentication_crud.py::CreateAuthentication.create_match_data`相当。有効期限14日 */
export async function createMatchAuth(
  db: DrizzleD1Database,
  username: string,
  hashPassword: string,
  matchTeamName: TeamName,
  matchId: string,
): Promise<void> {
  const now = new Date();
  const expiredAt = new Date(now.getTime() + 14 * 24 * 60 * 60 * 1000);
  await db.insert(basicAuthentication).values({
    username,
    hashPassword,
    matchTeamName,
    matchId,
    createdAt: now,
    expiredAt,
  });
}

export interface CreateMatchDataInput {
  matchId: string;
  scoreId: string;
  tournamentId: string;
  tournamentName: string;
  teamScore: number[];
  firstTeamId: string;
  firstTeamPlayer1Id: string;
  firstTeamPlayer2Id: string;
  firstTeamPlayer3Id: string | null;
  firstTeamPlayer4Id: string | null;
  secondTeamId: string;
  secondTeamPlayer1Id: string;
  secondTeamPlayer2Id: string;
  secondTeamPlayer3Id: string | null;
  secondTeamPlayer4Id: string | null;
  timeLimit: number;
  extraEndTimeLimit: number;
  standardEndCount: number;
  appliedRule: number;
  physicalSimulatorId: string;
  matchName: string;
  gameMode: string;
  createdAt: Date;
  startedAt: Date;
  mixedDoublesSettings: {
    positionedStonesPattern: number;
    endSetupTeamIds: string[];
  } | null;
}

/** `src/crud.py::CreateData.create_match_data`相当。score/tournament/match_data(/mixed_doubles_settings)を1バッチで作成 */
export async function createMatchData(
  db: DrizzleD1Database,
  input: CreateMatchDataInput,
): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [
    db.insert(score).values({
      scoreId: input.scoreId,
      team0: input.teamScore,
      team1: input.teamScore,
    }),
    db.insert(tournament).values({
      tournamentId: input.tournamentId,
      tournamentName: input.tournamentName,
    }),
    db.insert(matchData).values({
      matchId: input.matchId,
      firstTeamName: null,
      secondTeamName: null,
      firstTeamId: input.firstTeamId,
      firstTeamPlayer1Id: input.firstTeamPlayer1Id,
      firstTeamPlayer2Id: input.firstTeamPlayer2Id,
      firstTeamPlayer3Id: input.firstTeamPlayer3Id,
      firstTeamPlayer4Id: input.firstTeamPlayer4Id,
      secondTeamId: input.secondTeamId,
      secondTeamPlayer1Id: input.secondTeamPlayer1Id,
      secondTeamPlayer2Id: input.secondTeamPlayer2Id,
      secondTeamPlayer3Id: input.secondTeamPlayer3Id,
      secondTeamPlayer4Id: input.secondTeamPlayer4Id,
      winnerTeamId: null,
      scoreId: input.scoreId,
      timeLimit: input.timeLimit,
      extraEndTimeLimit: input.extraEndTimeLimit,
      standardEndCount: input.standardEndCount,
      appliedRule: input.appliedRule,
      physicalSimulatorId: input.physicalSimulatorId,
      tournamentId: input.tournamentId,
      matchName: input.matchName,
      gameMode: input.gameMode,
      createdAt: input.createdAt,
      startedAt: input.startedAt,
    }),
  ];
  if (input.mixedDoublesSettings) {
    statements.push(
      db.insert(matchMixedDoublesSettings).values({
        matchId: input.matchId,
        positionedStonesPattern:
          input.mixedDoublesSettings.positionedStonesPattern,
        team0PowerPlayEnd: null,
        team1PowerPlayEnd: null,
        endSetupTeamIds: input.mixedDoublesSettings.endSetupTeamIds,
      }),
    );
  }
  await runBatch(db, statements);
}

function stateInsertStatements(
  db: DrizzleD1Database,
  row: StateInsertRow,
): BatchItem<"sqlite">[] {
  return [
    db.insert(stoneCoordinate).values({
      stoneCoordinateId: row.stoneCoordinate.stoneCoordinateId,
      data: row.stoneCoordinate.data,
    }),
    db.insert(state).values({
      stateId: row.stateId,
      winnerTeamId: row.winnerTeamId,
      matchId: row.matchId,
      endNumber: row.endNumber,
      teamShotNumber: row.teamShotNumber,
      totalShotNumber: row.totalShotNumber,
      firstTeamRemainingTime: row.firstTeamRemainingTime,
      secondTeamRemainingTime: row.secondTeamRemainingTime,
      firstTeamExtraEndRemainingTime: row.firstTeamExtraEndRemainingTime,
      secondTeamExtraEndRemainingTime: row.secondTeamExtraEndRemainingTime,
      stoneCoordinateId: row.stoneCoordinate.stoneCoordinateId,
      scoreId: row.scoreId,
      shotId: row.shotId,
      nextShotTeamId: row.nextShotTeamId,
      createdAt: row.createdAt,
    }),
  ];
}

/** `src/crud.py::CreateData.create_state_data`相当(match作成直後の初期State) */
export async function createStateData(
  db: DrizzleD1Database,
  row: StateInsertRow,
): Promise<void> {
  await runBatch(db, stateInsertStatements(db, row));
}

/** `src/crud.py::CreateData.create_player_data`相当 */
export async function createPlayerData(
  db: DrizzleD1Database,
  row: PlayerRow,
): Promise<void> {
  await db.insert(player).values({
    playerId: row.playerId,
    teamId: row.teamId,
    maxVelocity: row.maxVelocity,
    shotStdDev: row.shotStdDev,
    angleStdDev: row.angleStdDev,
    playerName: row.playerName,
  });
}

/** `src/crud.py::UpdateData.update_match_data_with_team_name`相当(行ロック無し) */
export async function updateMatchDataWithTeamName(
  db: DrizzleD1Database,
  matchId: string,
  teamName: string,
  expectedMatchTeamName: TeamName,
): Promise<TeamName | null> {
  const rows = await db
    .select({
      firstTeamName: matchData.firstTeamName,
      secondTeamName: matchData.secondTeamName,
    })
    .from(matchData)
    .where(eq(matchData.matchId, matchId))
    .limit(1);
  const row = rows[0];
  if (!row) return null;

  if (row.firstTeamName === null && row.secondTeamName === null) {
    if (expectedMatchTeamName === "team0") {
      await db
        .update(matchData)
        .set({ firstTeamName: teamName })
        .where(eq(matchData.matchId, matchId));
      return "team0";
    }
    await db
      .update(matchData)
      .set({ secondTeamName: teamName })
      .where(eq(matchData.matchId, matchId));
    return "team1";
  }
  if (row.firstTeamName === null && row.secondTeamName !== null) {
    await db
      .update(matchData)
      .set({ firstTeamName: teamName })
      .where(eq(matchData.matchId, matchId));
    return "team0";
  }
  if (row.firstTeamName !== null && row.secondTeamName === null) {
    await db
      .update(matchData)
      .set({ secondTeamName: teamName })
      .where(eq(matchData.matchId, matchId));
    return "team1";
  }
  return null;
}

/** `src/crud.py::UpdateData.update_first_team`相当 */
export async function updateFirstTeam(
  db: DrizzleD1Database,
  matchId: string,
  teamId: string,
  playerIds: string[],
  teamName: string,
): Promise<void> {
  const isFour = playerIds.length === 4;
  await db
    .update(matchData)
    .set({
      firstTeamName: teamName,
      firstTeamId: teamId,
      firstTeamPlayer1Id: playerIds[0],
      firstTeamPlayer2Id: playerIds[1],
      firstTeamPlayer3Id: isFour ? playerIds[2] : null,
      firstTeamPlayer4Id: isFour ? playerIds[3] : null,
    })
    .where(eq(matchData.matchId, matchId));
}

/** `src/crud.py::UpdateData.update_second_team`相当 */
export async function updateSecondTeam(
  db: DrizzleD1Database,
  matchId: string,
  teamId: string,
  playerIds: string[],
  teamName: string,
): Promise<void> {
  const isFour = playerIds.length === 4;
  await db
    .update(matchData)
    .set({
      secondTeamName: teamName,
      secondTeamId: teamId,
      secondTeamPlayer1Id: playerIds[0],
      secondTeamPlayer2Id: playerIds[1],
      secondTeamPlayer3Id: isFour ? playerIds[2] : null,
      secondTeamPlayer4Id: isFour ? playerIds[3] : null,
    })
    .where(eq(matchData.matchId, matchId));
}

/** `src/crud.py::UpdateData.update_next_shot_team`相当。latest stateのnext_shot_team_idを更新する */
export async function updateNextShotTeam(
  db: DrizzleD1Database,
  matchId: string,
  teamId: string,
): Promise<void> {
  const rows = await db
    .select({ stateId: state.stateId })
    .from(state)
    .where(eq(state.matchId, matchId))
    .orderBy(
      desc(state.endNumber),
      desc(state.totalShotNumber),
      desc(state.stateId),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return;
  await db
    .update(state)
    .set({ nextShotTeamId: teamId })
    .where(eq(state.stateId, row.stateId));
}

/** `src/services/match_db.py::set_end_setup_team_for_end`相当 */
export async function setEndSetupTeamForEnd(
  db: DrizzleD1Database,
  matchId: string,
  endNumber: number,
  selectorTeamId: string,
): Promise<void> {
  const settingsRow = await readMixedDoublesSettingsRow(db, matchId);
  if (!settingsRow) throw new Error("Mixed doubles settings row not found.");

  const selectorList =
    settingsRow.endSetupTeamIds.length > 0
      ? [...settingsRow.endSetupTeamIds]
      : [selectorTeamId];

  if (endNumber < 0) throw new Error("end_number must be >= 0");
  if (endNumber < selectorList.length) {
    selectorList[endNumber] = selectorTeamId;
  } else if (endNumber === selectorList.length) {
    selectorList.push(selectorTeamId);
  } else {
    throw new Error(
      "end_setup_team_ids has a gap; cannot set future end without previous entries.",
    );
  }

  await db
    .update(matchMixedDoublesSettings)
    .set({ endSetupTeamIds: selectorList })
    .where(eq(matchMixedDoublesSettings.matchId, matchId));
}

function shotInfoInsertStatements(
  db: DrizzleD1Database,
  row: ShotInfoInsertRow,
): BatchItem<"sqlite">[] {
  return [
    db
      .insert(trajectory)
      .values({ trajectoryId: row.trajectoryId })
      .onConflictDoNothing(),
    db.insert(shotInfo).values({
      shotId: row.shotId,
      playerId: row.playerId,
      teamId: row.teamId,
      trajectoryId: row.trajectoryId,
      preShotStateId: row.preShotStateId,
      postShotStateId: row.postShotStateId,
      actualTranslationalVelocity: row.actualTranslationalVelocity,
      actualShotAngle: row.actualShotAngle,
      actualAngularVelocity: row.actualAngularVelocity,
      translationalVelocity: row.translationalVelocity,
      shotAngle: row.shotAngle,
      angularVelocity: row.angularVelocity,
    }),
  ];
}

export interface RecordShotResultInput {
  shotInfo: ShotInfoInsertRow;
  postState: StateInsertRow;
  preStateId: string;
}

/** `src/services/match_db.py::record_shot_result`相当。End途中の1投を1バッチでアトミックに記録する */
export async function recordShotResult(
  db: DrizzleD1Database,
  input: RecordShotResultInput,
): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [
    ...shotInfoInsertStatements(db, input.shotInfo),
    ...stateInsertStatements(db, input.postState),
    db
      .update(state)
      .set({ shotId: input.shotInfo.shotId })
      .where(eq(state.stateId, input.preStateId)),
  ];
  await runBatch(db, statements);
}

export interface RecordLastShotOfEndInput {
  shotInfo: ShotInfoInsertRow;
  postState: StateInsertRow;
  preStateId: string;
  scoreData: { scoreId: string; team0: number[]; team1: number[] };
  nextEndInitialState: StateInsertRow | null;
  nextEndSelectorTeamId: string | null;
  matchId: string;
}

/** `src/services/match_db.py::record_last_shot_of_end`相当。Endの最後の1投を1バッチでアトミックに記録する */
export async function recordLastShotOfEnd(
  db: DrizzleD1Database,
  input: RecordLastShotOfEndInput,
): Promise<void> {
  const statements: BatchItem<"sqlite">[] = [
    db
      .update(score)
      .set({ team0: input.scoreData.team0, team1: input.scoreData.team1 })
      .where(eq(score.scoreId, input.scoreData.scoreId)),
    ...shotInfoInsertStatements(db, input.shotInfo),
    ...stateInsertStatements(db, input.postState),
    db
      .update(state)
      .set({ shotId: input.shotInfo.shotId })
      .where(eq(state.stateId, input.preStateId)),
  ];

  if (input.nextEndInitialState) {
    statements.push(...stateInsertStatements(db, input.nextEndInitialState));
  }

  if (input.nextEndSelectorTeamId !== null && input.nextEndInitialState) {
    const settingsRow = await readMixedDoublesSettingsRow(db, input.matchId);
    if (!settingsRow) throw new Error("Mixed doubles settings row not found.");
    const selectorList = [...settingsRow.endSetupTeamIds];
    const nextEndNumber = input.nextEndInitialState.endNumber;
    if (nextEndNumber < selectorList.length) {
      selectorList[nextEndNumber] = input.nextEndSelectorTeamId;
    } else if (nextEndNumber === selectorList.length) {
      selectorList.push(input.nextEndSelectorTeamId);
    } else {
      throw new Error(
        `end_setup_team_ids has a gap at index ${nextEndNumber}; current length=${selectorList.length}`,
      );
    }
    statements.push(
      db
        .update(matchMixedDoublesSettings)
        .set({ endSetupTeamIds: selectorList })
        .where(eq(matchMixedDoublesSettings.matchId, input.matchId)),
    );
  }

  await runBatch(db, statements);
}

/**
 * `perform_mixed_doubles_end_setup`内のPython ValueErrorに相当。
 * ルーター側で`"only be used" in message`判定によりbad_request/conflictへ振り分ける
 * (現行メッセージには"only be used"を含むものが無く、実質すべてconflictになる。原実装の分岐をそのまま踏襲)。
 */
export class EndSetupValueError extends Error {}

export interface PerformEndSetupInput {
  matchData: MatchDataRow;
  latestState: {
    endNumber: number;
    firstTeamRemainingTime: number;
    secondTeamRemainingTime: number;
    firstTeamExtraEndRemainingTime: number;
    secondTeamExtraEndRemainingTime: number;
    scoreId: string;
  };
  matchTeamName: TeamName;
  request: "pp_left" | "pp_right" | "center_house" | "center_guard";
}

/** `src/services/match_db.py::perform_mixed_doubles_end_setup`相当 */
export async function performMixedDoublesEndSetup(
  db: DrizzleD1Database,
  input: PerformEndSetupInput,
): Promise<{ stateId: string }> {
  const { matchData: md, latestState, matchTeamName, request } = input;
  const callerTeamId =
    matchTeamName === "team0" ? md.firstTeamId : md.secondTeamId;
  const otherTeamId =
    matchTeamName === "team0" ? md.secondTeamId : md.firstTeamId;
  const otherTeamName: TeamName = matchTeamName === "team0" ? "team1" : "team0";

  const settingsRow = await readMixedDoublesSettingsRow(db, md.matchId);
  if (!settingsRow) throw new Error("Mixed doubles settings row not found.");

  const selectorList =
    settingsRow.endSetupTeamIds.length > 0
      ? [...settingsRow.endSetupTeamIds]
      : md.secondTeamId
        ? [md.secondTeamId]
        : [];

  const currentEnd = latestState.endNumber;
  if (currentEnd < 0) throw new EndSetupValueError("Invalid end_number");
  if (currentEnd >= selectorList.length) {
    throw new EndSetupValueError(
      "end_setup_team_ids is missing entries for current end.",
    );
  }

  const expectedSelectorTeamId = selectorList[currentEnd];
  if (callerTeamId !== expectedSelectorTeamId) {
    throw new EndSetupValueError("Not your turn to setup positioned stones.");
  }

  let powerPlaySide: PowerPlaySide;
  let selectorIsHammer: boolean;
  if (request === "pp_left") {
    powerPlaySide = "left";
    selectorIsHammer = true;
  } else if (request === "pp_right") {
    powerPlaySide = "right";
    selectorIsHammer = true;
  } else if (request === "center_house") {
    powerPlaySide = null;
    selectorIsHammer = true;
  } else if (request === "center_guard") {
    powerPlaySide = null;
    selectorIsHammer = false;
  } else {
    throw new EndSetupValueError("Invalid positioned_stones option.");
  }
  let powerPlayRequested = powerPlaySide !== null;

  // Mixed doubles rule: power play cannot be used in extra ends.
  const isExtraEnd = currentEnd >= md.standardEndCount;
  if (powerPlayRequested && isExtraEnd) {
    powerPlaySide = null;
    selectorIsHammer = true;
    powerPlayRequested = false;
  }

  let team0PowerPlayEnd = settingsRow.team0PowerPlayEnd;
  let team1PowerPlayEnd = settingsRow.team1PowerPlayEnd;

  if (powerPlayRequested) {
    const usedEnd =
      matchTeamName === "team0" ? team0PowerPlayEnd : team1PowerPlayEnd;
    if (usedEnd !== null) {
      // Do not block the match if client mistakenly requests power play twice; fall back to center_house.
      powerPlaySide = null;
      selectorIsHammer = true;
      powerPlayRequested = false;
    } else if (matchTeamName === "team0") {
      team0PowerPlayEnd = currentEnd;
    } else {
      team1PowerPlayEnd = currentEnd;
    }
  }

  const hammerTeamName: TeamName = selectorIsHammer
    ? matchTeamName
    : otherTeamName;
  const firstThrowTeamId: string | null = selectorIsHammer
    ? otherTeamId
    : callerTeamId;

  const pattern = md.mixedDoublesSettings?.positionedStonesPattern ?? 0;
  const stoneData = generateMixedDoublesInitialStones(
    hammerTeamName,
    powerPlaySide,
    pattern,
    {
      hammerStonePosition: "house",
    },
  );

  const setupStateId = generateUuid7();
  const stoneCoordinateId = generateUuid7();

  const statements: BatchItem<"sqlite">[] = [
    db.insert(stoneCoordinate).values({ stoneCoordinateId, data: stoneData }),
    db.insert(state).values({
      stateId: setupStateId,
      winnerTeamId: null,
      matchId: md.matchId,
      endNumber: latestState.endNumber,
      teamShotNumber: 0,
      totalShotNumber: 0,
      firstTeamRemainingTime: latestState.firstTeamRemainingTime,
      secondTeamRemainingTime: latestState.secondTeamRemainingTime,
      firstTeamExtraEndRemainingTime:
        latestState.firstTeamExtraEndRemainingTime,
      secondTeamExtraEndRemainingTime:
        latestState.secondTeamExtraEndRemainingTime,
      stoneCoordinateId,
      scoreId: latestState.scoreId,
      shotId: null,
      nextShotTeamId: firstThrowTeamId,
      createdAt: new Date(),
    }),
  ];

  if (
    team0PowerPlayEnd !== settingsRow.team0PowerPlayEnd ||
    team1PowerPlayEnd !== settingsRow.team1PowerPlayEnd
  ) {
    statements.push(
      db
        .update(matchMixedDoublesSettings)
        .set({ team0PowerPlayEnd, team1PowerPlayEnd })
        .where(eq(matchMixedDoublesSettings.matchId, md.matchId)),
    );
  }

  await runBatch(db, statements);
  return { stateId: setupStateId };
}
