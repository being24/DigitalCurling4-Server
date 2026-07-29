import { readFileSync } from "node:fs";
import { join } from "node:path";
import { drizzle } from "drizzle-orm/d1";
import { beforeEach, describe, expect, it } from "vitest";
import { createFakeD1Database } from "../test-utils/fake-d1";
import {
  createMatchAuth,
  createMatchData,
  createPlayerData,
  createStateData,
  EndSetupValueError,
  performMixedDoublesEndSetup,
  readMatchAuthTeamName,
  readMatchData,
  readMixedDoublesSettingsRow,
  readPlayerData,
  readPlayerId,
  readSimulatorId,
  readTeamId,
  readUserHashPassword,
  recordLastShotOfEnd,
  recordShotResult,
  setEndSetupTeamForEnd,
  updateFirstTeam,
  updateMatchDataWithTeamName,
  updateNextShotTeam,
  updateSecondTeam,
} from "./match";

const schemaSql = readFileSync(join(__dirname, "../../drizzle/0000_furry_toro.sql"), "utf-8");

function freshDb() {
  // biome-ignore lint: fake shim is structurally compatible with D1Database for what drizzle-orm/d1 uses (prepare/batch only)
  return drizzle(createFakeD1Database(schemaSql) as never);
}

describe("repositories/match", () => {
  let db: ReturnType<typeof freshDb>;

  beforeEach(() => {
    db = freshDb();
  });

  it("readSimulatorId returns null when nothing is seeded", async () => {
    expect(await readSimulatorId(db, "fcv1")).toBeNull();
  });

  describe("match creation + team config + shot flow (five-rock / standard)", () => {
    const simulatorId = "sim-1";
    const matchId = "match-1";
    const scoreId = "score-1";

    beforeEach(async () => {
      const raw = db.$client as ReturnType<typeof createFakeD1Database>;
      // Seed physical_simulator directly via the fake client (mirrors src/main.py lifespan seeding).
      await raw.prepare("INSERT INTO physical_simulator (physical_simulator_id, simulator_name) VALUES (?, ?)").bind(simulatorId, "fcv1").run();
      await raw
        .prepare("INSERT INTO users (username, hash_password, salt) VALUES (?, ?, ?)")
        .bind("alice", "hashed-alice", "salt-alice")
        .run();
      await raw
        .prepare("INSERT INTO users (username, hash_password, salt) VALUES (?, ?, ?)")
        .bind("bob", "hashed-bob", "salt-bob")
        .run();
    });

    it("readSimulatorId finds the seeded simulator by name", async () => {
      expect(await readSimulatorId(db, "fcv1")).toBe(simulatorId);
      expect(await readSimulatorId(db, "unknown")).toBeNull();
    });

    it("createMatchData + createStateData persist a standard match and its initial state readable via readMatchData", async () => {
      await createMatchData(db, {
        matchId,
        scoreId,
        tournamentId: "tour-1",
        tournamentName: "test-tournament",
        teamScore: [0, 0],
        firstTeamId: "first-team-default",
        firstTeamPlayer1Id: "ai-1",
        firstTeamPlayer2Id: "ai-1",
        firstTeamPlayer3Id: "ai-1",
        firstTeamPlayer4Id: "ai-1",
        secondTeamId: "second-team-default",
        secondTeamPlayer1Id: "ai-2",
        secondTeamPlayer2Id: "ai-2",
        secondTeamPlayer3Id: "ai-2",
        secondTeamPlayer4Id: "ai-2",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 1,
        appliedRule: 0,
        physicalSimulatorId: simulatorId,
        matchName: "test-match",
        gameMode: "standard",
        createdAt: new Date(),
        startedAt: new Date(),
        mixedDoublesSettings: null,
      });

      const match = await readMatchData(db, matchId);
      expect(match).not.toBeNull();
      expect(match?.gameMode).toBe("standard");
      expect(match?.standardEndCount).toBe(1);
      expect(match?.appliedRule).toBe(0);
      expect(match?.firstTeamName).toBeNull();
      expect(match?.mixedDoublesSettings).toBeNull();
    });

    it("updateMatchDataWithTeamName assigns team0 then team1, and rejects a third registration", async () => {
      await createMatchData(db, {
        matchId,
        scoreId,
        tournamentId: "tour-1",
        tournamentName: "t",
        teamScore: [0, 0],
        firstTeamId: "first-team-default",
        firstTeamPlayer1Id: "ai-1",
        firstTeamPlayer2Id: "ai-1",
        firstTeamPlayer3Id: "ai-1",
        firstTeamPlayer4Id: "ai-1",
        secondTeamId: "second-team-default",
        secondTeamPlayer1Id: "ai-2",
        secondTeamPlayer2Id: "ai-2",
        secondTeamPlayer3Id: "ai-2",
        secondTeamPlayer4Id: "ai-2",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 8,
        appliedRule: 0,
        physicalSimulatorId: simulatorId,
        matchName: "t",
        gameMode: "standard",
        createdAt: new Date(),
        startedAt: new Date(),
        mixedDoublesSettings: null,
      });

      const first = await updateMatchDataWithTeamName(db, matchId, "Team Alice", "team0");
      expect(first).toBe("team0");
      const second = await updateMatchDataWithTeamName(db, matchId, "Team Bob", "team1");
      expect(second).toBe("team1");
      const third = await updateMatchDataWithTeamName(db, matchId, "Team Carol", "team0");
      expect(third).toBeNull();
    });

    it("createMatchAuth + readMatchAuthTeamName round-trips the team binding", async () => {
      const hash = await readUserHashPassword(db, "alice");
      expect(hash).toBe("hashed-alice");
      await createMatchAuth(db, "alice", hash as string, "team0", matchId);
      expect(await readMatchAuthTeamName(db, "alice", matchId)).toBe("team0");
      expect(await readMatchAuthTeamName(db, "bob", matchId)).toBeNull();
    });

    it("readPlayerId / createPlayerData / readPlayerData round-trip", async () => {
      expect(await readPlayerId(db, "player-x", "team-x")).toBeNull();
      await createPlayerData(db, {
        playerId: "player-1",
        teamId: "team-x",
        maxVelocity: 4.0,
        shotStdDev: 0.01,
        angleStdDev: 0.002,
        playerName: "player-x",
      });
      expect(await readPlayerId(db, "player-x", "team-x")).toBe("player-1");
      const data = await readPlayerData(db, "player-1");
      expect(data?.maxVelocity).toBe(4.0);
      expect(data?.playerName).toBe("player-x");
    });

    it("readTeamId resolves the most recently created match for a team name", async () => {
      await createMatchData(db, {
        matchId: "match-old",
        scoreId: "score-old",
        tournamentId: "tour-old",
        tournamentName: "t",
        teamScore: [0],
        firstTeamId: "team-old-id",
        firstTeamPlayer1Id: "ai-1",
        firstTeamPlayer2Id: "ai-1",
        firstTeamPlayer3Id: "ai-1",
        firstTeamPlayer4Id: "ai-1",
        secondTeamId: "second-old",
        secondTeamPlayer1Id: "ai-2",
        secondTeamPlayer2Id: "ai-2",
        secondTeamPlayer3Id: "ai-2",
        secondTeamPlayer4Id: "ai-2",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 1,
        appliedRule: 0,
        physicalSimulatorId: simulatorId,
        matchName: "t",
        gameMode: "standard",
        createdAt: new Date(2020, 0, 1),
        startedAt: new Date(2020, 0, 1),
        mixedDoublesSettings: null,
      });
      await updateMatchDataWithTeamName(db, "match-old", "Reused Team", "team0");

      await createMatchData(db, {
        matchId: "match-new",
        scoreId: "score-new",
        tournamentId: "tour-new",
        tournamentName: "t",
        teamScore: [0],
        firstTeamId: "team-new-id",
        firstTeamPlayer1Id: "ai-1",
        firstTeamPlayer2Id: "ai-1",
        firstTeamPlayer3Id: "ai-1",
        firstTeamPlayer4Id: "ai-1",
        secondTeamId: "second-new",
        secondTeamPlayer1Id: "ai-2",
        secondTeamPlayer2Id: "ai-2",
        secondTeamPlayer3Id: "ai-2",
        secondTeamPlayer4Id: "ai-2",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 1,
        appliedRule: 0,
        physicalSimulatorId: simulatorId,
        matchName: "t",
        gameMode: "standard",
        createdAt: new Date(2030, 0, 1),
        startedAt: new Date(2030, 0, 1),
        mixedDoublesSettings: null,
      });
      await updateMatchDataWithTeamName(db, "match-new", "Reused Team", "team0");

      expect(await readTeamId(db, "Reused Team")).toBe("team-new-id");
    });

    it("updateNextShotTeam updates the latest state's next_shot_team_id", async () => {
      await createMatchData(db, {
        matchId,
        scoreId,
        tournamentId: "tour-1",
        tournamentName: "t",
        teamScore: [0],
        firstTeamId: "first-team-default",
        firstTeamPlayer1Id: "ai-1",
        firstTeamPlayer2Id: "ai-1",
        firstTeamPlayer3Id: "ai-1",
        firstTeamPlayer4Id: "ai-1",
        secondTeamId: "second-team-default",
        secondTeamPlayer1Id: "ai-2",
        secondTeamPlayer2Id: "ai-2",
        secondTeamPlayer3Id: "ai-2",
        secondTeamPlayer4Id: "ai-2",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 1,
        appliedRule: 0,
        physicalSimulatorId: simulatorId,
        matchName: "t",
        gameMode: "standard",
        createdAt: new Date(),
        startedAt: new Date(),
        mixedDoublesSettings: null,
      });
      await createStateData(db, {
        stateId: "state-0",
        winnerTeamId: null,
        matchId,
        endNumber: 0,
        teamShotNumber: 0,
        totalShotNumber: 0,
        firstTeamRemainingTime: 600,
        secondTeamRemainingTime: 600,
        firstTeamExtraEndRemainingTime: 60,
        secondTeamExtraEndRemainingTime: 60,
        scoreId,
        shotId: null,
        nextShotTeamId: "first-team-default",
        createdAt: new Date(),
        stoneCoordinate: { stoneCoordinateId: "sc-0", data: { team0: [], team1: [] } },
      });

      await updateFirstTeam(db, matchId, "new-team-id", ["p1", "p2", "p3", "p4"], "Team Alice");
      await updateNextShotTeam(db, matchId, "new-team-id");

      const updated = await db
        .select()
        .from((await import("../db/schema")).state)
        .all();
      const row = updated.find((r) => r.stateId === "state-0");
      expect(row?.nextShotTeamId).toBe("new-team-id");
    });

    it("recordShotResult persists shot_info + new state + links pre-state shot_id (mid-end)", async () => {
      const { state, shotInfo } = await import("../db/schema");
      await createMatchData(db, {
        matchId,
        scoreId,
        tournamentId: "tour-1",
        tournamentName: "t",
        teamScore: [0],
        firstTeamId: "first-team-default",
        firstTeamPlayer1Id: "ai-1",
        firstTeamPlayer2Id: "ai-1",
        firstTeamPlayer3Id: "ai-1",
        firstTeamPlayer4Id: "ai-1",
        secondTeamId: "second-team-default",
        secondTeamPlayer1Id: "ai-2",
        secondTeamPlayer2Id: "ai-2",
        secondTeamPlayer3Id: "ai-2",
        secondTeamPlayer4Id: "ai-2",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 1,
        appliedRule: 0,
        physicalSimulatorId: simulatorId,
        matchName: "t",
        gameMode: "standard",
        createdAt: new Date(),
        startedAt: new Date(),
        mixedDoublesSettings: null,
      });
      await createStateData(db, {
        stateId: "state-0",
        winnerTeamId: null,
        matchId,
        endNumber: 0,
        teamShotNumber: 0,
        totalShotNumber: 0,
        firstTeamRemainingTime: 600,
        secondTeamRemainingTime: 600,
        firstTeamExtraEndRemainingTime: 60,
        secondTeamExtraEndRemainingTime: 60,
        scoreId,
        shotId: null,
        nextShotTeamId: "first-team-default",
        createdAt: new Date(),
        stoneCoordinate: { stoneCoordinateId: "sc-0", data: { team0: [], team1: [] } },
      });

      await recordShotResult(db, {
        shotInfo: {
          shotId: "shot-1",
          playerId: "ai-1",
          teamId: "first-team-default",
          trajectoryId: "traj-1",
          preShotStateId: "state-0",
          postShotStateId: "state-1",
          actualTranslationalVelocity: 2.5,
          actualShotAngle: 1.5707,
          actualAngularVelocity: 1.5707,
          translationalVelocity: 2.4,
          shotAngle: 1.56,
          angularVelocity: -1.5707,
        },
        postState: {
          stateId: "state-1",
          winnerTeamId: null,
          matchId,
          endNumber: 0,
          teamShotNumber: 0,
          totalShotNumber: 1,
          firstTeamRemainingTime: 599,
          secondTeamRemainingTime: 600,
          firstTeamExtraEndRemainingTime: 60,
          secondTeamExtraEndRemainingTime: 60,
          scoreId,
          shotId: null,
          nextShotTeamId: "second-team-default",
          createdAt: new Date(),
          stoneCoordinate: { stoneCoordinateId: "sc-1", data: { team0: [{ x: 0, y: 10 }], team1: [] } },
        },
        preStateId: "state-0",
      });

      const shotRows = await db.select().from(shotInfo).all();
      expect(shotRows).toHaveLength(1);
      expect(shotRows[0].shotId).toBe("shot-1");

      const stateRows = await db.select().from(state).all();
      const pre = stateRows.find((r) => r.stateId === "state-0");
      const post = stateRows.find((r) => r.stateId === "state-1");
      expect(pre?.shotId).toBe("shot-1");
      expect(post?.totalShotNumber).toBe(1);
    });
  });

  describe("mixed doubles end-setup", () => {
    async function seedMinimalMatchRow(matchId: string): Promise<void> {
      const raw = db.$client as ReturnType<typeof createFakeD1Database>;
      await raw
        .prepare("INSERT INTO match_data (match_id, game_mode) VALUES (?, ?)")
        .bind(matchId, "mixed_doubles")
        .run();
    }

    it("performMixedDoublesEndSetup rejects a caller who is not the current selector", async () => {
      await seedMinimalMatchRow("md-1");
      const matchDataRow = {
        matchId: "md-1",
        firstTeamName: "A",
        secondTeamName: "B",
        firstTeamId: "team0-id",
        firstTeamPlayer1Id: "p1",
        firstTeamPlayer2Id: "p2",
        firstTeamPlayer3Id: null,
        firstTeamPlayer4Id: null,
        secondTeamId: "team1-id",
        secondTeamPlayer1Id: "p3",
        secondTeamPlayer2Id: "p4",
        secondTeamPlayer3Id: null,
        secondTeamPlayer4Id: null,
        winnerTeamId: null,
        scoreId: "score-1",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 8,
        appliedRule: 2,
        physicalSimulatorId: "sim-1",
        tournamentId: "tour-1",
        matchName: "t",
        gameMode: "mixed_doubles",
        mixedDoublesSettings: {
          matchId: "md-1",
          positionedStonesPattern: 0,
          team0PowerPlayEnd: null,
          team1PowerPlayEnd: null,
          endSetupTeamIds: ["team1-id"],
        },
      };

      // Seed the settings row directly so readMixedDoublesSettingsRow can find it.
      const raw = db.$client as ReturnType<typeof createFakeD1Database>;
      await raw
        .prepare(
          "INSERT INTO match_mixed_doubles_settings (match_id, positioned_stones_pattern, team0_power_play_end, team1_power_play_end, end_setup_team_ids) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("md-1", 0, null, null, JSON.stringify(["team1-id"]))
        .run();

      await expect(
        performMixedDoublesEndSetup(db, {
          matchData: matchDataRow,
          latestState: {
            endNumber: 0,
            firstTeamRemainingTime: 600,
            secondTeamRemainingTime: 600,
            firstTeamExtraEndRemainingTime: 60,
            secondTeamExtraEndRemainingTime: 60,
            scoreId: "score-1",
          },
          matchTeamName: "team0",
          request: "center_house",
        }),
      ).rejects.toBeInstanceOf(EndSetupValueError);
    });

    it("performMixedDoublesEndSetup places the selector as hammer (center_house) and sets next_shot_team_id to the other team", async () => {
      await seedMinimalMatchRow("md-1");
      const raw = db.$client as ReturnType<typeof createFakeD1Database>;
      await raw
        .prepare(
          "INSERT INTO match_mixed_doubles_settings (match_id, positioned_stones_pattern, team0_power_play_end, team1_power_play_end, end_setup_team_ids) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("md-1", 0, null, null, JSON.stringify(["team1-id"]))
        .run();
      await raw.prepare("INSERT INTO score (score_id, team0, team1) VALUES (?, ?, ?)").bind("score-1", "[0]", "[0]").run();

      const matchDataRow = {
        matchId: "md-1",
        firstTeamName: "A",
        secondTeamName: "B",
        firstTeamId: "team0-id",
        firstTeamPlayer1Id: "p1",
        firstTeamPlayer2Id: "p2",
        firstTeamPlayer3Id: null,
        firstTeamPlayer4Id: null,
        secondTeamId: "team1-id",
        secondTeamPlayer1Id: "p3",
        secondTeamPlayer2Id: "p4",
        secondTeamPlayer3Id: null,
        secondTeamPlayer4Id: null,
        winnerTeamId: null,
        scoreId: "score-1",
        timeLimit: 600,
        extraEndTimeLimit: 60,
        standardEndCount: 8,
        appliedRule: 2,
        physicalSimulatorId: "sim-1",
        tournamentId: "tour-1",
        matchName: "t",
        gameMode: "mixed_doubles",
        mixedDoublesSettings: {
          matchId: "md-1",
          positionedStonesPattern: 0,
          team0PowerPlayEnd: null,
          team1PowerPlayEnd: null,
          endSetupTeamIds: ["team1-id"],
        },
      };

      const result = await performMixedDoublesEndSetup(db, {
        matchData: matchDataRow,
        latestState: {
          endNumber: 0,
          firstTeamRemainingTime: 600,
          secondTeamRemainingTime: 600,
          firstTeamExtraEndRemainingTime: 60,
          secondTeamExtraEndRemainingTime: 60,
          scoreId: "score-1",
        },
        matchTeamName: "team1",
        request: "center_house",
      });

      expect(result.stateId).toBeTruthy();

      const { state, stoneCoordinate } = await import("../db/schema");
      const stateRows = await db.select().from(state).all();
      const setupState = stateRows.find((r) => r.stateId === result.stateId);
      expect(setupState?.nextShotTeamId).toBe("team0-id"); // hammer(team1) is not first to throw
      expect(setupState?.totalShotNumber).toBe(0);

      const scRows = await db.select().from(stoneCoordinate).all();
      const sc = scRows.find((r) => r.stoneCoordinateId === setupState?.stoneCoordinateId);
      expect(sc?.data).toBeTruthy();
    });

    it("setEndSetupTeamForEnd appends the selector for the next end", async () => {
      await seedMinimalMatchRow("md-2");
      const raw = db.$client as ReturnType<typeof createFakeD1Database>;
      await raw
        .prepare(
          "INSERT INTO match_mixed_doubles_settings (match_id, positioned_stones_pattern, team0_power_play_end, team1_power_play_end, end_setup_team_ids) VALUES (?, ?, ?, ?, ?)",
        )
        .bind("md-2", 0, null, null, JSON.stringify(["team1-id"]))
        .run();

      await setEndSetupTeamForEnd(db, "md-2", 1, "team0-id");
      const row = await readMixedDoublesSettingsRow(db, "md-2");
      expect(row?.endSetupTeamIds).toEqual(["team1-id", "team0-id"]);
    });
  });
});
