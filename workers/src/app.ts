import { Hono } from "hono";
import type { Bindings } from "./env";
import { matchRoutes } from "./routes/match";
import { restapiRoutes } from "./routes/restapi";
import { handleSimulate } from "./simulate";

export const app = new Hono<{ Bindings: Bindings }>();

app.post("/simulate", (c) => handleSimulate(c.req.raw));

app.get("/ws", async (c) => {
  const matchId = c.req.query("match");
  if (!matchId) {
    return c.text("missing ?match=<id>", 400);
  }
  const stub = c.env.MATCH_ROOM.getByName(matchId);
  return stub.fetch(c.req.raw);
});

app.route("/", restapiRoutes);
app.route("/", matchRoutes);
