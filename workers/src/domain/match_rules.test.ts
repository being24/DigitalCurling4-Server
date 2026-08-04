import { describe, expect, it } from "vitest";
import {
  calculateTotalScore,
  generateMixedDoublesInitialStones,
  generateResetStoneCoordinateData,
  getScoreFromDistanceList,
  SCORE_DISTANCE,
  stoneCountPerTeam,
  stoneDistanceFromTee,
  TEE_LINE,
  totalShotsPerEnd,
} from "./match_rules";

// Ported from tests/test_match_rules.py

describe("stoneCountPerTeam", () => {
  it("returns 8 for standard, 6 for mixed_doubles", () => {
    expect(stoneCountPerTeam("standard")).toBe(8);
    expect(stoneCountPerTeam("mixed_doubles")).toBe(6);
  });
});

describe("totalShotsPerEnd", () => {
  it("returns 16 for standard, 10 for mixed_doubles", () => {
    expect(totalShotsPerEnd("standard")).toBe(16);
    expect(totalShotsPerEnd("mixed_doubles")).toBe(10);
  });
});

describe("generateResetStoneCoordinateData", () => {
  it("standard: 8 stones per team, all at origin", () => {
    const data = generateResetStoneCoordinateData("standard");
    expect(Object.keys(data).sort()).toEqual(["team0", "team1"]);
    expect(data.team0).toHaveLength(8);
    expect(data.team1).toHaveLength(8);
    for (const coord of [...data.team0, ...data.team1]) {
      expect(coord).toEqual({ x: 0.0, y: 0.0 });
    }
  });

  it("mixed_doubles: 6 stones per team", () => {
    const data = generateResetStoneCoordinateData("mixed_doubles");
    expect(Object.keys(data).sort()).toEqual(["team0", "team1"]);
    expect(data.team0).toHaveLength(6);
    expect(data.team1).toHaveLength(6);
  });
});

describe("generateMixedDoublesInitialStones", () => {
  it("raises for invalid pattern (out of 0..5 range)", () => {
    expect(() =>
      generateMixedDoublesInitialStones("team0", null, -1),
    ).toThrow();
    expect(() => generateMixedDoublesInitialStones("team0", null, 6)).toThrow();
  });

  it("hammer gets house stone when hammerStonePosition='house'", () => {
    const data = generateMixedDoublesInitialStones("team0", null, 0, {
      hammerStonePosition: "house",
    });

    // Function returns 8 slots per team for simulator compatibility.
    expect(data.team0).toHaveLength(8);
    expect(data.team1).toHaveLength(8);

    expect(data.team0[0].x).toBeCloseTo(0.0, 5);
    expect(data.team0[0].y).toBeCloseTo(38.87, 5);
  });

  it("power play left flips x, right does not", () => {
    const left = generateMixedDoublesInitialStones("team0", "left", 0, {
      hammerStonePosition: "house",
    });
    const right = generateMixedDoublesInitialStones("team0", "right", 0, {
      hammerStonePosition: "house",
    });

    expect(left.team0[0].x).toBeLessThan(0);
    expect(right.team0[0].x).toBeGreaterThan(0);
    expect(left.team0[0].y).toBeCloseTo(right.team0[0].y, 5);
  });

  it("raises for invalid hammerStonePosition", () => {
    expect(() =>
      generateMixedDoublesInitialStones("team0", null, 0, {
        // @ts-expect-error - intentionally invalid value to test runtime validation
        hammerStonePosition: "invalid",
      }),
    ).toThrow();
  });
});

// Ported from tests/test_scoring_rules.py

describe("stoneDistanceFromTee", () => {
  it("is zero at the tee center", () => {
    expect(stoneDistanceFromTee(0.0, TEE_LINE)).toBeCloseTo(0.0, 5);
  });
});

describe("getScoreFromDistanceList", () => {
  it("returns blank end when no stone is in the house", () => {
    const distanceList: Array<[number, number]> = [
      [0, stoneDistanceFromTee(0.0, 0.0)],
      [1, stoneDistanceFromTee(0.0, 0.0)],
    ];
    const [scoredTeam, score] = getScoreFromDistanceList(distanceList);
    expect(scoredTeam).toBeNull();
    expect(score).toBe(0);
  });

  it("counts consecutive scoring stones only", () => {
    // team0 has two stones closer than team1's closest.
    const distanceList: Array<[number, number]> = [
      [0, 0.1],
      [0, 0.2],
      [1, 0.3],
    ];
    for (const [, d] of distanceList) {
      expect(d).toBeLessThanOrEqual(SCORE_DISTANCE);
    }

    const [scoredTeam, score] = getScoreFromDistanceList(distanceList);
    expect(scoredTeam).toBe(0);
    expect(score).toBe(2);
  });

  it("stops when an opponent stone is closer", () => {
    const distanceList: Array<[number, number]> = [
      [0, 0.1],
      [1, 0.2],
      [0, 0.3],
    ];
    for (const [, d] of distanceList) {
      expect(d).toBeLessThanOrEqual(SCORE_DISTANCE);
    }

    const [scoredTeam, score] = getScoreFromDistanceList(distanceList);
    expect(scoredTeam).toBe(0);
    expect(score).toBe(1);
  });
});

describe("calculateTotalScore", () => {
  it("sums the list", () => {
    expect(calculateTotalScore([0, 2, 0, 1])).toBe(3);
  });
});

describe("SCORE_DISTANCE constant", () => {
  it("is reasonable: > house radius and < 3m, finite", () => {
    expect(SCORE_DISTANCE).toBeGreaterThan(1.8);
    expect(SCORE_DISTANCE).toBeLessThan(3.0);
    expect(Number.isFinite(SCORE_DISTANCE)).toBe(true);
  });
});
