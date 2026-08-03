/**
 * `src/converter.py::DataConverter.convert_stateschema_to_statemodel` と
 * `src/redis_subscriber.py::RedisSubscriber._sort_states_for_replay` の移植。
 * D1/Drizzleに依存しない純粋関数として切り出し、MatchRoom(DO)とTask06のREST実装の両方から再利用する。
 */

export interface CoordinateData {
  x: number;
  y: number;
}

export interface StoneCoordinateModel {
  data: Record<string, CoordinateData[]>;
}

export interface ScoreModel {
  team0: number[];
  team1: number[];
}

export interface ShotInfoModel {
  translational_velocity: number;
  angular_velocity: number;
  shot_angle: number;
}

export interface PowerPlayEndModel {
  team0: number | null;
  team1: number | null;
}

export interface MixedDoublesSettingsModel {
  end_setup_team: string;
  positioned_stones_pattern: number;
  power_play_end: PowerPlayEndModel;
}

export interface StateModel {
  winner_team: string | null;
  first_team_name: string | null;
  second_team_name: string | null;
  end_number: number;
  team_shot_number: number | null;
  total_shot_number: number | null;
  next_shot_team: string | null;
  first_team_remaining_time: number;
  second_team_remaining_time: number;
  first_team_extra_end_remaining_time: number;
  second_team_extra_end_remaining_time: number;
  mixed_doubles_settings: MixedDoublesSettingsModel | null;
  last_move: ShotInfoModel | null;
  stone_coordinate: StoneCoordinateModel;
  score: ScoreModel;
}

export interface MixedDoublesSettingsRow {
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
  secondTeamId: string | null;
  gameMode: string;
  mixedDoublesSettings: MixedDoublesSettingsRow | null;
}

export interface StateRow {
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
  stoneCoordinateId: string;
  scoreId: string;
  shotId: string | null;
  nextShotTeamId: string | null;
  createdAt: Date | null;
}

export interface ShotInfoRow {
  translationalVelocity: number;
  angularVelocity: number;
  shotAngle: number;
}

/**
 * DBの`stone_coordinate.data`はチーム毎の座標配列だが、ネストしたリスト([[x,y座標オブジェクト]...])
 * の形で入っている場合があるため1段階フラット化する（Python版のnormalized処理と同じ）。
 */
function normalizeCoordinates(coords: unknown): CoordinateData[] {
  if (coords == null) {
    return [];
  }
  if (Array.isArray(coords) && coords.length > 0 && Array.isArray(coords[0])) {
    const flattened: CoordinateData[] = [];
    for (const item of coords) {
      if (Array.isArray(item)) {
        flattened.push(...(item as CoordinateData[]));
      } else {
        flattened.push(item as CoordinateData);
      }
    }
    return flattened;
  }
  return coords as CoordinateData[];
}

/**
 * Replay順のソート。team_shot_numberを主キーとし、created_at・state_idをタイブレーカーに使う
 * （team_shot_numberがNone/mixed doublesのpre-end-setup状態を先頭に置くため-1扱い）。
 */
export function sortStatesForReplay<T extends StateRow>(states: T[]): T[] {
  return [...states].sort((a, b) => {
    const shotA = a.teamShotNumber ?? -1;
    const shotB = b.teamShotNumber ?? -1;
    if (shotA !== shotB) return shotA - shotB;

    const createdA = a.createdAt ? Math.floor(a.createdAt.getTime() / 1000) : 0;
    const createdB = b.createdAt ? Math.floor(b.createdAt.getTime() / 1000) : 0;
    if (createdA !== createdB) return createdA - createdB;

    if (a.stateId < b.stateId) return -1;
    if (a.stateId > b.stateId) return 1;
    return 0;
  });
}

export interface BuildStateModelParams {
  matchData: MatchDataRow;
  stateData: StateRow;
  stoneCoordinateData: unknown;
  scoreData: ScoreModel;
  shotInfoData?: ShotInfoRow | null;
}

/** StateSchema+関連データをクライアント送信用のStateModelに変換する */
export function buildStateModel(params: BuildStateModelParams): StateModel {
  const { matchData, stateData, stoneCoordinateData, scoreData, shotInfoData } =
    params;

  let winnerTeam: string | null = null;
  if (stateData.winnerTeamId != null) {
    winnerTeam =
      stateData.winnerTeamId === matchData.firstTeamId ? "team0" : "team1";
  }

  let nextShotTeam: string | null = null;
  if (stateData.nextShotTeamId != null) {
    nextShotTeam =
      stateData.nextShotTeamId === matchData.firstTeamId ? "team0" : "team1";
  }

  const lastMove: ShotInfoModel | null = shotInfoData
    ? {
        translational_velocity: shotInfoData.translationalVelocity,
        angular_velocity: shotInfoData.angularVelocity,
        shot_angle: shotInfoData.shotAngle,
      }
    : null;

  const isPreEndSetup =
    matchData.gameMode === "mixed_doubles" && stateData.nextShotTeamId == null;
  const teamShotNumber = isPreEndSetup ? null : stateData.teamShotNumber;
  const totalShotNumber = isPreEndSetup ? null : stateData.totalShotNumber;

  const stoneCoordinateModel: StoneCoordinateModel = { data: {} };
  const rawStoneData = (stoneCoordinateData ?? {}) as Record<string, unknown>;
  for (const [team, coords] of Object.entries(rawStoneData)) {
    stoneCoordinateModel.data[team] = normalizeCoordinates(coords);
  }

  let endSetupTeamId = matchData.secondTeamId;
  const endSetupTeamIds = matchData.mixedDoublesSettings?.endSetupTeamIds;
  if (
    endSetupTeamIds &&
    stateData.endNumber >= 0 &&
    stateData.endNumber < endSetupTeamIds.length
  ) {
    endSetupTeamId = endSetupTeamIds[stateData.endNumber];
  }

  const mixedDoublesSettings: MixedDoublesSettingsModel | null =
    matchData.mixedDoublesSettings
      ? {
          end_setup_team:
            endSetupTeamId === matchData.firstTeamId ? "team0" : "team1",
          positioned_stones_pattern:
            matchData.mixedDoublesSettings.positionedStonesPattern,
          power_play_end: {
            team0: matchData.mixedDoublesSettings.team0PowerPlayEnd,
            team1: matchData.mixedDoublesSettings.team1PowerPlayEnd,
          },
        }
      : null;

  return {
    winner_team: winnerTeam,
    first_team_name: matchData.firstTeamName,
    second_team_name: matchData.secondTeamName,
    end_number: stateData.endNumber,
    team_shot_number: teamShotNumber,
    total_shot_number: totalShotNumber,
    next_shot_team: nextShotTeam,
    first_team_remaining_time: stateData.firstTeamRemainingTime,
    second_team_remaining_time: stateData.secondTeamRemainingTime,
    first_team_extra_end_remaining_time:
      stateData.firstTeamExtraEndRemainingTime,
    second_team_extra_end_remaining_time:
      stateData.secondTeamExtraEndRemainingTime,
    mixed_doubles_settings: mixedDoublesSettings,
    last_move: lastMove,
    stone_coordinate: stoneCoordinateModel,
    score: { team0: scoreData.team0 ?? [], team1: scoreData.team1 ?? [] },
  };
}
