import type { MatchRoom } from "./match_room";

export interface Bindings {
  MATCH_ROOM: DurableObjectNamespace<MatchRoom>;
  DB: D1Database;
  /** password hashing pepper (Workers Secret, see .dev.vars.example) */
  PEPPER_DATA: string;
}
