/**
 * Match/game rules that are independent from HTTP and DB.
 *
 * Ported from src/domain/match_rules.py (Python, primary source).
 * NOTE: Python版はfloat32キャストで精度を落としている箇所があるが、
 * TSはnumber(float64)のみのため、呼び出し側は許容誤差での比較を前提とすること。
 */

export type GameMode = "standard" | "mixed_doubles";
export type TeamName = "team0" | "team1";
export type PowerPlaySide = "left" | "right" | null;
export type HammerStonePosition = "guard" | "house";

export interface Coordinate {
  x: number;
  y: number;
}

export interface StoneCoordinateData {
  team0: Coordinate[];
  team1: Coordinate[];
}

export const MIXED_DOUBLES_TOTAL_SHOTS_PER_END = 10;
export const STANDARD_TOTAL_SHOTS_PER_END = 16;

// Values are meters in the simulator coordinate system.
// workers/wasm-src/fcv1_simulator_core.hppのtee_line/house_radius/kStoneRadiusと一致させること。
export const TEE_LINE = 38.405;
export const HOUSE_RADIUS = 1.829;
export const STONE_RADIUS = 0.145;
export const SCORE_DISTANCE = HOUSE_RADIUS + STONE_RADIUS;

export const MD_POSITIONED_STONE_IN_HOUSE: readonly [number, number] = [0.0, 38.87];
export const MD_POWER_PLAY_IN_HOUSE: readonly [number, number] = [1.219, 38.26];

// Pattern index (0-5) matches positionedStonesPattern.
export const MD_POSITIONED_STONE_GUARD: ReadonlyArray<readonly [number, number]> = [
  [0.0, 35.35],
  [0.0, 35.06],
  [0.0, 34.435],
  [0.0, 34.145],
  [0.0, 33.52],
  [0.0, 33.23],
];

export const MD_POWER_PLAY_GUARD: ReadonlyArray<readonly [number, number]> = [
  [1.093, 35.35],
  [1.087, 35.06],
  [1.073, 34.435],
  [1.067, 34.145],
  [1.053, 33.52],
  [1.047, 33.23],
];

/** Return stone count per team for the given mode. */
export function stoneCountPerTeam(gameMode: GameMode): number {
  if (gameMode === "mixed_doubles") {
    return 6;
  }
  return 8;
}

/** Return total shots per end for the given mode. */
export function totalShotsPerEnd(gameMode: GameMode): number {
  if (gameMode === "mixed_doubles") {
    return MIXED_DOUBLES_TOTAL_SHOTS_PER_END;
  }
  return STANDARD_TOTAL_SHOTS_PER_END;
}

/** Generate initial stone coordinate dict for a new end. */
export function generateResetStoneCoordinateData(gameMode: GameMode): StoneCoordinateData {
  const count = stoneCountPerTeam(gameMode);
  return {
    team0: Array.from({ length: count }, () => ({ x: 0.0, y: 0.0 })),
    team1: Array.from({ length: count }, () => ({ x: 0.0, y: 0.0 })),
  };
}

/** Return the distance from tee (0, TEE_LINE). */
export function stoneDistanceFromTee(x: number, y: number): number {
  const dy = y - TEE_LINE;
  return Math.sqrt(x * x + dy * dy);
}

/**
 * Compute score from list of (teamIndex, distance).
 *
 * Returns [scoredTeam, points]. If no stones are in the house, returns [null, 0].
 */
export function getScoreFromDistanceList(
  distanceList: ReadonlyArray<readonly [number, number]>,
): [number | null, number] {
  if (distanceList.length === 0) {
    return [null, 0];
  }

  const sortedDistanceList = [...distanceList].sort((a, b) => a[1] - b[1]);
  if (sortedDistanceList[0][1] > SCORE_DISTANCE) {
    return [null, 0];
  }

  const scoredTeam = sortedDistanceList[0][0];
  let score = 1;
  for (const [team, distance] of sortedDistanceList.slice(1)) {
    if (team === scoredTeam && distance <= SCORE_DISTANCE) {
      score += 1;
    } else {
      break;
    }
  }
  return [scoredTeam, score];
}

/** Sum the per-end scores. */
export function calculateTotalScore(scoreList: readonly number[]): number {
  return scoreList.reduce((sum, s) => sum + s, 0);
}

/**
 * Generate initial pre-positioned stones for mixed doubles.
 *
 * We keep 8 stones per team for simulator compatibility; unused stones remain at (0, 0).
 * NOTE: power play coordinates are defined for the RIGHT side; LEFT side flips x.
 */
export function generateMixedDoublesInitialStones(
  hammerTeamName: TeamName,
  powerPlaySide: PowerPlaySide,
  positionedStonesPattern: number,
  options: { hammerStonePosition?: HammerStonePosition } = {},
): StoneCoordinateData {
  const { hammerStonePosition = "guard" } = options;

  if (positionedStonesPattern < 0 || positionedStonesPattern > 5) {
    throw new Error("positionedStonesPattern must be between 0 and 5");
  }

  const xSign = powerPlaySide === "left" ? -1.0 : 1.0;

  const data: StoneCoordinateData = {
    team0: Array.from({ length: 8 }, () => ({ x: 0.0, y: 0.0 })),
    team1: Array.from({ length: 8 }, () => ({ x: 0.0, y: 0.0 })),
  };

  const nonHammerTeamName: TeamName = hammerTeamName === "team0" ? "team1" : "team0";

  let houseX: number;
  let houseY: number;
  let guardX: number;
  let guardY: number;

  if (powerPlaySide === "left" || powerPlaySide === "right") {
    [houseX, houseY] = MD_POWER_PLAY_IN_HOUSE;
    [guardX, guardY] = MD_POWER_PLAY_GUARD[positionedStonesPattern];
    houseX *= xSign;
    guardX *= xSign;
  } else {
    [houseX, houseY] = MD_POSITIONED_STONE_IN_HOUSE;
    [guardX, guardY] = MD_POSITIONED_STONE_GUARD[positionedStonesPattern];
  }

  if (hammerStonePosition !== "guard" && hammerStonePosition !== "house") {
    throw new Error("hammerStonePosition must be 'guard' or 'house'");
  }

  // By default, place one stone in the house for the non-hammer team,
  // and one guard stone for the hammer team.
  if (hammerStonePosition === "guard") {
    data[nonHammerTeamName][0] = { x: houseX, y: houseY };
    data[hammerTeamName][0] = { x: guardX, y: guardY };
  } else {
    // Swap: hammer gets the house stone, non-hammer gets the guard.
    data[hammerTeamName][0] = { x: houseX, y: houseY };
    data[nonHammerTeamName][0] = { x: guardX, y: guardY };
  }
  return data;
}
