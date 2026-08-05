import type { MatchRoom } from "./match_room";

export interface Bindings {
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  DB: D1Database;
  /** password hashing pepper (Workers Secret, see .dev.vars.example) */
  PEPPER_DATA: string;
  /** 認証済みユーザー単位・エンドポイント単位でのリクエスト頻度制限(60秒あたり30回) */
  SHOT_RATE_LIMITER: RateLimit;
}
