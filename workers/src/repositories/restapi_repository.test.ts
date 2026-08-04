import { describe, expect, it } from "vitest";
import type { shotInfo } from "../db/schema";
import { toShotInfoSchema } from "./restapi_repository";

/**
 * DrizzleクエリはD1バインディングが必要(`@cloudflare/vitest-pool-workers`未導入、
 * `src/match_room.test.ts`のコメント参照)なため、ここではDB非依存のマッピングロジックのみ検証する。
 */

function makeShotInfoRow(
  overrides: Partial<typeof shotInfo.$inferSelect> = {},
): typeof shotInfo.$inferSelect {
  return {
    shotId: "shot-1",
    playerId: "player-1",
    teamId: "team-1",
    trajectoryId: "trajectory-1",
    preShotStateId: "pre-state-1",
    postShotStateId: "post-state-1",
    actualTranslationalVelocity: 2.5,
    actualShotAngle: 0.1,
    actualAngularVelocity: null,
    translationalVelocity: 2.4,
    angularVelocity: 3.14,
    shotAngle: 0.1,
    ...overrides,
  };
}

describe("toShotInfoSchema", () => {
  it("actual_angular_velocityが未計測(null)の場合はangular_velocityにフォールバックする", () => {
    const result = toShotInfoSchema(
      makeShotInfoRow({ actualAngularVelocity: null, angularVelocity: 3.14 }),
    );
    expect(result.actual_angular_velocity).toBe(3.14);
  });

  it("actual_angular_velocityが計測済みの場合はその値をそのまま使う", () => {
    const result = toShotInfoSchema(
      makeShotInfoRow({ actualAngularVelocity: -2.9, angularVelocity: 3.14 }),
    );
    expect(result.actual_angular_velocity).toBe(-2.9);
  });

  it("snake_caseのレスポンス構造にマッピングする", () => {
    const result = toShotInfoSchema(makeShotInfoRow());
    expect(result).toEqual({
      shot_id: "shot-1",
      player_id: "player-1",
      team_id: "team-1",
      trajectory_id: "trajectory-1",
      pre_shot_state_id: "pre-state-1",
      post_shot_state_id: "post-state-1",
      actual_translational_velocity: 2.5,
      actual_shot_angle: 0.1,
      actual_angular_velocity: 3.14,
      translational_velocity: 2.4,
      angular_velocity: 3.14,
      shot_angle: 0.1,
    });
  });
});
