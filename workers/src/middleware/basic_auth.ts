import { basicAuth } from "hono/basic-auth";
import type { Context } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { eq } from "drizzle-orm";
import { users } from "../db/schema";
import { hashPassword, timingSafeEqual } from "../lib/auth";
import type { Bindings } from "../env";

/**
 * `src/authentication/basic_authentication.py::check_user_data`の移植。
 * username/passwordをD1の`users`テーブルと照合する。
 * match_id単位のアクセス権チェック(check_match_data相当)はここでは行わない。
 * 各ルートハンドラ側で個別に判定する。
 */
export const requireBasicAuth = basicAuth({
  verifyUser: async (
    username: string,
    password: string,
    c: Context<{ Bindings: Bindings }>,
  ): Promise<boolean> => {
    const db = drizzle(c.env.DB);
    const rows = await db
      .select()
      .from(users)
      .where(eq(users.username, username))
      .limit(1);
    const user = rows[0];
    if (!user || !user.hashPassword || !user.salt) {
      return false;
    }
    const hashed = await hashPassword(password, user.salt, c.env.PEPPER_DATA);
    return timingSafeEqual(hashed, user.hashPassword);
  },
});
