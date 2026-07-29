import { DurableObject } from "cloudflare:workers";
import { drizzle } from "drizzle-orm/d1";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import type { Bindings } from "./env";
import {
  readLatestStateData,
  readMatchDataRow,
  readShotInfoByPostShotStateId,
  readStateDataInEnd,
  type StateWithRelations,
} from "./services/match_room_queries";
import { buildStateModel, sortStatesForReplay, type MatchDataRow } from "./services/state_replay";

type PlayerTeam = "team0" | "team1";

const PLAYER_TEAMS: PlayerTeam[] = ["team0", "team1"];

interface WsAttachment {
  synced: boolean;
}

/**
 * `src/redis_subscriber.py::RedisSubscriber`の移植。
 *
 * Redis版はSSE接続ごとの非同期ジェネレータで、presence/team_configキー(Redis, TTL付き)を
 * 複数プロセス間で共有することでバリア同期していた。DOは単一インスタンスであるため、
 * presenceは`ctx.getWebSockets(tag)`（DOの接続状態そのもの）を真実源とし、Redisキーを廃止する。
 * team_configはD1のmatch_data.first_team_name/second_team_nameの非NULLを直接判定する
 * （Redis版もキー欠落時はDBへフォールバックしていた箇所と同じ判定）。
 *
 * team_config更新やState更新はTask06(REST側)がD1へ書き込む処理を担うため、DOはそれらの変化を
 * 自発的には検知できない。そこでRPCメソッド`notifyTeamConfigUpdated`/`pushStateUpdate`を公開し、
 * Task06側のエンドポイントから`env.MATCH_ROOM.getByName(matchId).notifyTeamConfigUpdated(matchId)`
 * のように呼び出してもらう設計とする。
 */
export class MatchRoom extends DurableObject<Bindings> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matchId = url.searchParams.get("match");
    const team = url.searchParams.get("team") ?? "unknown";

    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket upgrade", { status: 426 });
    }
    if (!matchId) {
      return new Response("missing ?match=<id>", { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, [team]);

    this.broadcast(JSON.stringify({ type: "presence", team, event: "joined" }), server);

    if (team === "viewer") {
      await this.sendViewerInitialSync(matchId, server);
    } else if (team === "team0" || team === "team1") {
      server.serializeAttachment({ synced: false } satisfies WsAttachment);
      await this.maybeSyncPlayers(matchId);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * Task06のteam-config登録エンドポイントが、D1へのteam_config書き込み完了後に呼び出す。
   * `src/routers/match.py::store_team_config`のRedis publish("team_config_updated")に相当。
   */
  async notifyTeamConfigUpdated(matchId: string): Promise<void> {
    await this.maybeSyncPlayers(matchId);
  }

  /**
   * Task06の投球処理エンドポイントが、D1への新規State書き込み完了後に呼び出す。
   * `src/redis_subscriber.py::_stream_latest_updates`の通常配信に相当し、
   * 接続中の全team0/team1/viewerへ最新盤面をpushする。
   */
  async pushStateUpdate(matchId: string): Promise<void> {
    const db = drizzle(this.env.DB);
    const latest = await readLatestStateData(db, matchId);
    if (!latest) return;

    const matchDataRow = await readMatchDataRow(db, matchId);
    if (!matchDataRow) return;

    const shotInfoData = await readShotInfoByPostShotStateId(db, latest.stateRow.stateId);
    const model = buildStateModel({
      matchData: matchDataRow,
      stateData: latest.stateRow,
      stoneCoordinateData: latest.stoneCoordinateData,
      scoreData: latest.scoreData,
      shotInfoData,
    });

    this.broadcast(JSON.stringify({ type: "latest_state_update", payload: model }));
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
    this.broadcast(JSON.stringify({ type: "presence", team, event: "left" }), ws);
    ws.close(code, reason);
  }

  private broadcast(payload: string, exclude?: WebSocket): void {
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === exclude) continue;
      ws.send(payload);
    }
  }

  /**
   * `_initial_sync_for_viewer`相当。バリアなしで現在Endの全State履歴を即座にreplayする。
   * DB未書き込みの間は何も送らず、通常配信(pushStateUpdate)が来るまで待つ。
   */
  private async sendViewerInitialSync(matchId: string, ws: WebSocket): Promise<void> {
    const db = drizzle(this.env.DB);
    const latest = await readLatestStateData(db, matchId);
    if (!latest) return;

    const matchDataRow = await readMatchDataRow(db, matchId);
    if (!matchDataRow) return;

    const statesInEnd = await readStateDataInEnd(db, matchId, latest.stateRow.endNumber);
    await this.replayStates(db, matchDataRow, statesInEnd.length > 0 ? statesInEnd : [latest], ws);
  }

  /**
   * `_initial_sync_for_player`相当。presence(両team接続) かつ team_config(両team設定完了)が
   * 揃った時点で、未同期のplayer接続へ現在Endの全State履歴をreplayする。
   *
   * 同時に複数のplayer接続が完了しfetch()が並行実行された場合、D1読み取り(外部I/O)を挟むため
   * 理論上は同一socketへ二重replayが起こり得る（DOの入出力ゲートはstorage操作のみを保護し、
   * fetch()間の並行実行自体は妨げない）。synced化を先に行うことで実害は「稀に二重送信される」
   * 程度に留めている（内容の破損はない）。
   */
  private async maybeSyncPlayers(matchId: string): Promise<void> {
    const bothPresent = PLAYER_TEAMS.every((t) => this.ctx.getWebSockets(t).length > 0);
    if (!bothPresent) return;

    const db = drizzle(this.env.DB);
    const matchDataRow = await readMatchDataRow(db, matchId);
    const bothConfigured =
      matchDataRow !== null && matchDataRow.firstTeamName !== null && matchDataRow.secondTeamName !== null;
    if (!bothConfigured || matchDataRow === null) return;

    const unsyncedPlayerSockets = PLAYER_TEAMS.flatMap((t) => this.ctx.getWebSockets(t)).filter(
      (ws) => !(ws.deserializeAttachment() as WsAttachment | null)?.synced,
    );
    if (unsyncedPlayerSockets.length === 0) return;

    const latest = await readLatestStateData(db, matchId);
    if (!latest) return;

    const statesInEnd = await readStateDataInEnd(db, matchId, latest.stateRow.endNumber);
    const statesToReplay = statesInEnd.length > 0 ? statesInEnd : [latest];

    for (const ws of unsyncedPlayerSockets) {
      ws.serializeAttachment({ synced: true } satisfies WsAttachment);
      await this.replayStates(db, matchDataRow, statesToReplay, ws);
    }
  }

  private async replayStates(
    db: DrizzleD1Database,
    matchDataRow: MatchDataRow,
    states: StateWithRelations[],
    ws: WebSocket,
  ): Promise<void> {
    const sorted = sortStatesForReplay(states.map((s) => s.stateRow));
    const byStateId = new Map(states.map((s) => [s.stateRow.stateId, s]));

    for (let i = 0; i < sorted.length; i++) {
      const stateRow = sorted[i];
      const withRelations = byStateId.get(stateRow.stateId);
      if (!withRelations) continue;

      const shotInfoData = await readShotInfoByPostShotStateId(db, stateRow.stateId);
      const model = buildStateModel({
        matchData: matchDataRow,
        stateData: stateRow,
        stoneCoordinateData: withRelations.stoneCoordinateData,
        scoreData: withRelations.scoreData,
        shotInfoData,
      });

      const eventType = i === sorted.length - 1 ? "latest_state_update" : "state_update";
      ws.send(JSON.stringify({ type: eventType, payload: model }));
    }
  }
}
