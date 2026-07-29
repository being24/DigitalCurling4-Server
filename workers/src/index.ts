import { drizzle } from "drizzle-orm/d1";
import { lt } from "drizzle-orm";
import { app } from "./app";
import { MatchRoom } from "./match_room";
import { basicAuthentication } from "./db/schema";
import type { Bindings } from "./env";

export { MatchRoom };

export default {
  fetch: app.fetch,
  /**
   * `src/main.py`のlifespan内APScheduler(`basic_auth.delete_expired_match_data`, interval hours=24)の移植。
   * wrangler.jsonc `triggers.crons`(毎日0時)から起動される。
   */
  async scheduled(
    _controller: ScheduledController,
    env: Bindings,
    _ctx: ExecutionContext,
  ): Promise<void> {
    const db = drizzle(env.DB);
    await db
      .delete(basicAuthentication)
      .where(lt(basicAuthentication.expiredAt, new Date()));
  },
} satisfies ExportedHandler<Bindings>;
