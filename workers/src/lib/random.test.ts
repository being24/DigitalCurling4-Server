import { describe, expect, it } from "vitest";
import { distortShot, randomNormal } from "./random";

function sampleStats(samples: number[]): { mean: number; std: number } {
  const mean = samples.reduce((sum, v) => sum + v, 0) / samples.length;
  const variance =
    samples.reduce((sum, v) => sum + (v - mean) ** 2, 0) / samples.length;
  return { mean, std: Math.sqrt(variance) };
}

describe("randomNormal", () => {
  it("matches numpy.random.normal(loc=0, scale=1) statistically", () => {
    const N = 20000;
    const samples = Array.from({ length: N }, () => randomNormal(0, 1));
    const { mean, std } = sampleStats(samples);

    // 標準誤差 = std/sqrt(N) ≈ 0.0071。5シグマ相当の余裕を持たせてflaky化を防ぐ
    expect(mean).toBeGreaterThan(-0.05);
    expect(mean).toBeLessThan(0.05);
    expect(std).toBeGreaterThan(0.95);
    expect(std).toBeLessThan(1.05);
  });

  it("matches numpy.random.normal(loc=mean, scale=std) statistically for arbitrary parameters", () => {
    const N = 20000;
    const samples = Array.from({ length: N }, () => randomNormal(10, 3));
    const { mean, std } = sampleStats(samples);

    expect(mean).toBeGreaterThan(9.85);
    expect(mean).toBeLessThan(10.15);
    expect(std).toBeGreaterThan(2.85);
    expect(std).toBeLessThan(3.15);
  });

  it("returns exactly the mean when std is 0 (deterministic)", () => {
    for (let i = 0; i < 50; i++) {
      expect(randomNormal(4.2, 0)).toBe(4.2);
    }
  });
});

describe("distortShot", () => {
  const player = { maxVelocity: 10, shotStdDev: 0, angleStdDev: 0 };

  it("caps translational_velocity at max_velocity before adding noise (std=0 => deterministic)", () => {
    const result = distortShot(
      { translationalVelocity: 15, shotAngle: 0, angularVelocity: 0.1 },
      player,
    );
    expect(result.translationalVelocity).toBe(10);
  });

  it("passes translational_velocity through unchanged when below max_velocity", () => {
    const result = distortShot(
      { translationalVelocity: 5, shotAngle: 0, angularVelocity: 0.1 },
      player,
    );
    expect(result.translationalVelocity).toBe(5);
  });

  it("floors translational_velocity at 0", () => {
    const result = distortShot(
      { translationalVelocity: 5, shotAngle: 0, angularVelocity: 0.1 },
      { ...player, maxVelocity: -1 },
    );
    expect(result.translationalVelocity).toBe(0);
  });

  it("clamps angular_velocity magnitude to [pi/6, pi/2] and flips sign for positive input", () => {
    const result = distortShot(
      { translationalVelocity: 1, shotAngle: 0, angularVelocity: 1.0 },
      player,
    );
    // abs(1.0)はpi/6〜pi/2の範囲内なのでクランプされずそのまま、符号のみ反転する
    expect(result.angularVelocity).toBeCloseTo(-1.0, 10);
    expect(result.actualAngularVelocity).toBeCloseTo(-1.0, 10);
  });

  it("clamps angular_velocity magnitude to [pi/6, pi/2] and flips sign for negative input", () => {
    const result = distortShot(
      { translationalVelocity: 1, shotAngle: 0, angularVelocity: -1.0 },
      player,
    );
    expect(result.angularVelocity).toBeCloseTo(1.0, 10);
    expect(result.actualAngularVelocity).toBeCloseTo(-1.0, 10);
  });

  it("clamps to pi/6 lower bound when magnitude is below the minimum", () => {
    const result = distortShot(
      { translationalVelocity: 1, shotAngle: 0, angularVelocity: 0.1 },
      player,
    );
    expect(result.angularVelocity).toBeCloseTo(-Math.PI / 6, 10);
    expect(result.actualAngularVelocity).toBeCloseTo(-0.1, 10);
  });

  it("clamps to pi/2 upper bound when magnitude exceeds the maximum", () => {
    const result = distortShot(
      { translationalVelocity: 1, shotAngle: 0, angularVelocity: 10 },
      player,
    );
    expect(result.angularVelocity).toBeCloseTo(-Math.PI / 2, 10);
    // actual側はクランプされず符号反転のみ
    expect(result.actualAngularVelocity).toBeCloseTo(-10, 10);
  });

  it("does not flip the sign when angular_velocity is exactly 0", () => {
    const result = distortShot(
      { translationalVelocity: 1, shotAngle: 0, angularVelocity: 0 },
      player,
    );
    expect(result.angularVelocity).toBeCloseTo(Math.PI / 6, 10);
    expect(result.actualAngularVelocity).toBe(0);
  });

  it("adds gaussian noise to shot_angle with the configured std_dev statistically", () => {
    const N = 20000;
    const samples = Array.from(
      { length: N },
      () =>
        distortShot(
          { translationalVelocity: 1, shotAngle: 2.0, angularVelocity: 1.0 },
          { maxVelocity: 10, shotStdDev: 0, angleStdDev: 0.5 },
        ).shotAngle,
    );
    const { mean, std } = sampleStats(samples);

    expect(mean).toBeGreaterThan(1.9);
    expect(mean).toBeLessThan(2.1);
    expect(std).toBeGreaterThan(0.45);
    expect(std).toBeLessThan(0.55);
  });
});
