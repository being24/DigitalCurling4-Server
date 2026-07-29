import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "./env";

export class MatchRoom extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const team = url.searchParams.get("team") ?? "unknown";

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [team]);

    this.broadcast(
      JSON.stringify({ type: "presence", team, event: "joined" }),
      server,
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const team = tags[0] ?? "unknown";
    this.broadcast(
      JSON.stringify({ type: "message", from: team, payload: message.toString() }),
      ws,
    );
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const team = tags[0] ?? "unknown";
    this.broadcast(
      JSON.stringify({ type: "presence", team, event: "left" }),
      ws,
    );
    ws.close(code, reason);
  }

  private broadcast(payload: string, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      ws.send(payload);
    }
  }
}
