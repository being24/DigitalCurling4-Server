import { sqliteTable, text, integer, real } from "drizzle-orm/sqlite-core";

/**
 * Postgres版(src/models/schemas.py)の全テーブルと、認証用SQLite
 * (src/models/basic_authentication_shemas.py)を単一のD1データベースに統合したスキーマ。
 * JSONB/ARRAY型はD1(SQLite)に無いため text({mode:"json"}) で表現する。
 */

export const tournament = sqliteTable("tournament", {
  tournamentId: text("tournament_id").primaryKey(),
  tournamentName: text("tournament_name"),
});

export const physicalSimulator = sqliteTable("physical_simulator", {
  physicalSimulatorId: text("physical_simulator_id").primaryKey(),
  simulatorName: text("simulator_name"),
});

export const player = sqliteTable("player", {
  playerId: text("player_id").primaryKey(),
  teamId: text("team_id"),
  maxVelocity: real("max_velocity"),
  shotStdDev: real("shot_std_dev"),
  angleStdDev: real("angle_std_dev"),
  playerName: text("player_name"),
});

export const score = sqliteTable("score", {
  scoreId: text("score_id").primaryKey(),
  team0: text("team0", { mode: "json" }).$type<number[]>(),
  team1: text("team1", { mode: "json" }).$type<number[]>(),
});

export const stoneCoordinate = sqliteTable("stone_coordinate", {
  stoneCoordinateId: text("stone_coordinate_id").primaryKey(),
  data: text("data", { mode: "json" }),
});

export const trajectory = sqliteTable("trajectory", {
  trajectoryId: text("trajectory_id").primaryKey(),
  trajectoryData: text("trajectory_data", { mode: "json" }),
  dataFormatVersion: text("data_format_version"),
});

// applied_rule: 0=fgz_rule(5-rock), 1=no_tick_rule, 2=modified_fgz_rule(mixed doubles)
export const matchData = sqliteTable("match_data", {
  matchId: text("match_id").primaryKey(),
  firstTeamName: text("first_team_name"),
  secondTeamName: text("second_team_name"),
  firstTeamId: text("first_team_id"),
  firstTeamPlayer1Id: text("first_team_player1_id"),
  firstTeamPlayer2Id: text("first_team_player2_id"),
  firstTeamPlayer3Id: text("first_team_player3_id"),
  firstTeamPlayer4Id: text("first_team_player4_id"),
  secondTeamId: text("second_team_id"),
  secondTeamPlayer1Id: text("second_team_player1_id"),
  secondTeamPlayer2Id: text("second_team_player2_id"),
  secondTeamPlayer3Id: text("second_team_player3_id"),
  secondTeamPlayer4Id: text("second_team_player4_id"),
  winnerTeamId: text("winner_team_id"),
  scoreId: text("score_id").references(() => score.scoreId),
  timeLimit: real("time_limit"),
  extraEndTimeLimit: real("extra_end_time_limit"),
  standardEndCount: integer("standard_end_count"),
  appliedRule: integer("applied_rule"),
  physicalSimulatorId: text("physical_simulator_id").references(
    () => physicalSimulator.physicalSimulatorId,
  ),
  tournamentId: text("tournament_id").references(() => tournament.tournamentId),
  matchName: text("match_name"),
  gameMode: text("game_mode").notNull().default("standard"),
  createdAt: integer("created_at", { mode: "timestamp" }),
  startedAt: integer("started_at", { mode: "timestamp" }),
});

export const matchMixedDoublesSettings = sqliteTable("match_mixed_doubles_settings", {
  matchId: text("match_id")
    .primaryKey()
    .references(() => matchData.matchId, { onDelete: "cascade" }),
  positionedStonesPattern: integer("positioned_stones_pattern").notNull(),
  team0PowerPlayEnd: integer("team0_power_play_end"),
  team1PowerPlayEnd: integer("team1_power_play_end"),
  // Per-end selector(hammer) team_id list. Index corresponds to end_number.
  endSetupTeamIds: text("end_setup_team_ids", { mode: "json" })
    .$type<string[]>()
    .notNull(),
});

export const shotInfo = sqliteTable("shot_info", {
  shotId: text("shot_id").primaryKey(),
  playerId: text("player_id"),
  teamId: text("team_id"),
  trajectoryId: text("trajectory_id"),
  preShotStateId: text("pre_shot_state_id"),
  postShotStateId: text("post_shot_state_id"),
  actualTranslationalVelocity: real("actual_translational_velocity"),
  actualShotAngle: real("actual_shot_angle"),
  actualAngularVelocity: real("actual_angular_velocity"),
  translationalVelocity: real("translational_velocity"),
  angularVelocity: real("angular_velocity"),
  shotAngle: real("shot_angle"),
});

export const state = sqliteTable("state", {
  stateId: text("state_id").primaryKey(),
  winnerTeamId: text("winner_team_id"),
  matchId: text("match_id").references(() => matchData.matchId),
  endNumber: integer("end_number"),
  teamShotNumber: integer("team_shot_number"),
  totalShotNumber: integer("total_shot_number"),
  firstTeamRemainingTime: real("first_team_remaining_time"),
  secondTeamRemainingTime: real("second_team_remaining_time"),
  firstTeamExtraEndRemainingTime: real("first_team_extra_end_remaining_time"),
  secondTeamExtraEndRemainingTime: real("second_team_extra_end_remaining_time"),
  stoneCoordinateId: text("stone_coordinate_id").references(
    () => stoneCoordinate.stoneCoordinateId,
  ),
  scoreId: text("score_id").references(() => score.scoreId),
  shotId: text("shot_id"),
  nextShotTeamId: text("next_shot_team_id"),
  createdAt: integer("created_at", { mode: "timestamp" }),
});

// 認証用(元は別SQLite: src/models/basic_authentication_shemas.py)。メインD1に統合。
export const basicAuthentication = sqliteTable("basic_authentication", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  username: text("username"),
  hashPassword: text("hash_password"),
  matchTeamName: text("match_team_name"), // "team0" | "team1"
  matchId: text("match_id"),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  expiredAt: integer("expired_at", { mode: "timestamp" }).notNull(),
});

export const users = sqliteTable("users", {
  username: text("username").primaryKey(),
  hashPassword: text("hash_password"),
  salt: text("salt"),
});
