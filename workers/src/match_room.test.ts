import { describe, expect, it } from "vitest";
import {
  buildStateModel,
  sortStatesForReplay,
  type MatchDataRow,
  type StateRow,
} from "./services/state_replay";

/**
 * MatchRoom(Durable Object)本体はWebSocket Hibernation APIとD1バインディングに依存するため、
 * `@cloudflare/vitest-pool-workers`を導入しないと実行時テストができない。
 * 本リポジトリのworkers/vitest設定は他タスク(match_rules.test.ts等)と共有されており、
 * pool変更は並行実装中の他タスクのテストにも影響するため今回は見送った。
 * 代わりに、MatchRoomのpresence/team_configバリア判定から呼び出される純粋ロジック
 * (State→StateModel変換・replay順ソート)を`services/state_replay.ts`に切り出し、そちらを検証する。
 * DO配線自体(presence判定・RPC・WebSocket送信)は`workers/wrangler.jsonc`経由の実機確認が必要。
 */

function makeMatchData(overrides: Partial<MatchDataRow> = {}): MatchDataRow {
  return {
    matchId: "match-1",
    firstTeamName: "Team A",
    secondTeamName: "Team B",
    firstTeamId: "team0-id",
    secondTeamId: "team1-id",
    gameMode: "standard",
    mixedDoublesSettings: null,
    ...overrides,
  };
}

function makeStateRow(overrides: Partial<StateRow> = {}): StateRow {
  return {
    stateId: "state-1",
    winnerTeamId: null,
    matchId: "match-1",
    endNumber: 0,
    teamShotNumber: 1,
    totalShotNumber: 1,
    firstTeamRemainingTime: 100,
    secondTeamRemainingTime: 100,
    firstTeamExtraEndRemainingTime: 30,
    secondTeamExtraEndRemainingTime: 30,
    stoneCoordinateId: "stone-1",
    scoreId: "score-1",
    shotId: null,
    nextShotTeamId: "team1-id",
    createdAt: new Date("2026-07-29T00:00:00Z"),
    ...overrides,
  };
}

describe("sortStatesForReplay", () => {
  it("team_shot_numberの昇順に並べ、Noneは先頭(-1扱い)にする", () => {
    const states = [
      makeStateRow({ stateId: "s2", teamShotNumber: 2 }),
      makeStateRow({ stateId: "s0", teamShotNumber: null }),
      makeStateRow({ stateId: "s1", teamShotNumber: 1 }),
    ];
    const sorted = sortStatesForReplay(states);
    expect(sorted.map((s) => s.stateId)).toEqual(["s0", "s1", "s2"]);
  });

  it("team_shot_numberが同一ならcreated_atの昇順でタイブレークする", () => {
    const states = [
      makeStateRow({ stateId: "later", teamShotNumber: 1, createdAt: new Date("2026-07-29T00:01:00Z") }),
      makeStateRow({ stateId: "earlier", teamShotNumber: 1, createdAt: new Date("2026-07-29T00:00:00Z") }),
    ];
    const sorted = sortStatesForReplay(states);
    expect(sorted.map((s) => s.stateId)).toEqual(["earlier", "later"]);
  });

  it("team_shot_number・created_atが同一ならstate_idの文字列昇順でタイブレークする", () => {
    const createdAt = new Date("2026-07-29T00:00:00Z");
    const states = [
      makeStateRow({ stateId: "b", teamShotNumber: 1, createdAt }),
      makeStateRow({ stateId: "a", teamShotNumber: 1, createdAt }),
    ];
    const sorted = sortStatesForReplay(states);
    expect(sorted.map((s) => s.stateId)).toEqual(["a", "b"]);
  });

  it("元配列を破壊しない", () => {
    const states = [makeStateRow({ stateId: "s2", teamShotNumber: 2 }), makeStateRow({ stateId: "s1", teamShotNumber: 1 })];
    const original = [...states];
    sortStatesForReplay(states);
    expect(states).toEqual(original);
  });
});

describe("buildStateModel", () => {
  const scoreData = { team0: [1, 0], team1: [0, 2] };

  it("winner_team_idがfirst_team_idと一致すればteam0、それ以外はteam1と判定する", () => {
    const matchData = makeMatchData();

    const asTeam0 = buildStateModel({
      matchData,
      stateData: makeStateRow({ winnerTeamId: "team0-id" }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(asTeam0.winner_team).toBe("team0");

    const asTeam1 = buildStateModel({
      matchData,
      stateData: makeStateRow({ winnerTeamId: "team1-id" }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(asTeam1.winner_team).toBe("team1");
  });

  it("winner_team_id/next_shot_team_idがnullの場合はnullを返す", () => {
    const model = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow({ winnerTeamId: null, nextShotTeamId: null }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(model.winner_team).toBeNull();
    expect(model.next_shot_team).toBeNull();
  });

  it("shotInfoDataがあればlast_moveを構築し、なければnullにする", () => {
    const withShot = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow(),
      stoneCoordinateData: {},
      scoreData,
      shotInfoData: { translationalVelocity: 2.5, angularVelocity: 1.2, shotAngle: 0.1 },
    });
    expect(withShot.last_move).toEqual({
      translational_velocity: 2.5,
      angular_velocity: 1.2,
      shot_angle: 0.1,
    });

    const withoutShot = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow(),
      stoneCoordinateData: {},
      scoreData,
      shotInfoData: null,
    });
    expect(withoutShot.last_move).toBeNull();
  });

  it("mixed doublesのpre-end-setup(next_shot_team_id=None)ではteam_shot_number/total_shot_numberをnullにする", () => {
    const model = buildStateModel({
      matchData: makeMatchData({ gameMode: "mixed_doubles" }),
      stateData: makeStateRow({ nextShotTeamId: null, teamShotNumber: 3, totalShotNumber: 5 }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(model.team_shot_number).toBeNull();
    expect(model.total_shot_number).toBeNull();
  });

  it("standardモードではnext_shot_team_id=Noneでもteam_shot_number/total_shot_numberを維持する", () => {
    const model = buildStateModel({
      matchData: makeMatchData({ gameMode: "standard" }),
      stateData: makeStateRow({ nextShotTeamId: null, teamShotNumber: 3, totalShotNumber: 5 }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(model.team_shot_number).toBe(3);
    expect(model.total_shot_number).toBe(5);
  });

  it("stone_coordinateがフラットな配列の場合はそのまま使う", () => {
    const model = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow(),
      stoneCoordinateData: { team0: [{ x: 1, y: 2 }], team1: [{ x: 3, y: 4 }] },
      scoreData,
    });
    expect(model.stone_coordinate.data).toEqual({
      team0: [{ x: 1, y: 2 }],
      team1: [{ x: 3, y: 4 }],
    });
  });

  it("stone_coordinateがネストしたリストの場合は1段階フラット化する", () => {
    const model = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow(),
      stoneCoordinateData: {
        team0: [[{ x: 1, y: 2 }], [{ x: 5, y: 6 }]],
      },
      scoreData,
    });
    expect(model.stone_coordinate.data.team0).toEqual([
      { x: 1, y: 2 },
      { x: 5, y: 6 },
    ]);
  });

  it("stone_coordinateがnullのチームは空配列にする", () => {
    const model = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow(),
      stoneCoordinateData: { team0: null },
      scoreData,
    });
    expect(model.stone_coordinate.data.team0).toEqual([]);
  });

  it("mixed_doubles_settingsがnullの場合はmixed_doubles_settingsもnullにする", () => {
    const model = buildStateModel({
      matchData: makeMatchData({ mixedDoublesSettings: null }),
      stateData: makeStateRow(),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(model.mixed_doubles_settings).toBeNull();
  });

  it("end_setup_team_ids[end_number]でend_setup_teamを決定する", () => {
    const matchData = makeMatchData({
      mixedDoublesSettings: {
        positionedStonesPattern: 1,
        team0PowerPlayEnd: null,
        team1PowerPlayEnd: 3,
        endSetupTeamIds: ["team1-id", "team0-id"],
      },
    });

    const endZero = buildStateModel({
      matchData,
      stateData: makeStateRow({ endNumber: 0 }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(endZero.mixed_doubles_settings?.end_setup_team).toBe("team1");

    const endOne = buildStateModel({
      matchData,
      stateData: makeStateRow({ endNumber: 1 }),
      stoneCoordinateData: {},
      scoreData,
    });
    expect(endOne.mixed_doubles_settings?.end_setup_team).toBe("team0");
  });

  it("end_setup_team_idsの範囲外のend_numberではsecond_team_idにフォールバックする", () => {
    const matchData = makeMatchData({
      mixedDoublesSettings: {
        positionedStonesPattern: 1,
        team0PowerPlayEnd: null,
        team1PowerPlayEnd: null,
        endSetupTeamIds: ["team1-id"],
      },
    });

    const model = buildStateModel({
      matchData,
      stateData: makeStateRow({ endNumber: 5 }),
      stoneCoordinateData: {},
      scoreData,
    });
    // second_team_id("team1-id")にフォールバックするため team1 になる
    expect(model.mixed_doubles_settings?.end_setup_team).toBe("team1");
  });

  it("scoreをそのまま透過する", () => {
    const model = buildStateModel({
      matchData: makeMatchData(),
      stateData: makeStateRow(),
      stoneCoordinateData: {},
      scoreData: { team0: [1, 2, 3], team1: [0, 1, 0] },
    });
    expect(model.score).toEqual({ team0: [1, 2, 3], team1: [0, 1, 0] });
  });
});
