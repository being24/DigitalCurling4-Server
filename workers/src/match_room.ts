import { DurableObject } from "cloudflare:workers";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import { drizzle } from "drizzle-orm/d1";
import type { Bindings } from "./env";
import {
  readLatestStateData,
  readMatchDataRow,
  readShotInfoByPostShotStateId,
  readStateDataInEnd,
  type StateWithRelations,
} from "./services/match_room_queries";
import {
  buildStateModel,
  formatSseEvent,
  type MatchDataRow,
  type StateEventType,
  type StateModel,
  sortStatesForReplay,
} from "./services/state_replay";

type PlayerTeam = "team0" | "team1";

const PLAYER_TEAMS: PlayerTeam[] = ["team0", "team1"];
// Python版`redis_subscriber.py`のHEART_BEAT(30秒)と揃える。
const SSE_PING_INTERVAL_MS = 30_000;

interface WsAttachment {
  synced: boolean;
}

/** WS/SSEの両トランスポートで共通の「Stateモデルを1件送る」抽象。 */
interface StateEventSink {
  send(type: StateEventType, model: StateModel): void;
}

interface PlayerSseSink extends StateEventSink {
  synced: boolean;
}

function wsSink(ws: WebSocket): StateEventSink {
  return {
    send: (type, model) => ws.send(JSON.stringify({ type, payload: model })),
  };
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
 *
 * WebSocket(自前クライアント向け)に加え、公式クライアントライブラリ(`dc4client`)が要求する
 * SSE(`GET /matches/:matchId/stream`・`/viewer`)にも対応する(Task14)。SSE接続はWS Hibernation
 * APIの対象外のため、SSE接続が開いている間はDOインスタンスが常駐する(WS接続はHibernationにより
 * 非アクティブ時に評価コストがかからないが、SSE接続にはその恩恵がない)。
 */
export class MatchRoom extends DurableObject<Bindings> {
  private viewerSseSinks = new Set<StateEventSink>();
  private playerSseSinks: Map<PlayerTeam, Set<PlayerSseSink>> = new Map([
    ["team0", new Set()],
    ["team1", new Set()],
  ]);

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const matchId = url.searchParams.get("match");
    if (!matchId) {
      return new Response("missing ?match=<id>", { status: 400 });
    }

    if (url.pathname === "/sse") {
      const teamParam = url.searchParams.get("team") ?? "viewer";
      if (
        teamParam !== "team0" &&
        teamParam !== "team1" &&
        teamParam !== "viewer"
      ) {
        return new Response("invalid team", { status: 400 });
      }
      return this.handleSseStream(matchId, teamParam);
    }

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

    if (team === "viewer") {
      await this.sendViewerInitialSync(matchId, wsSink(server));
    } else if (team === "team0" || team === "team1") {
      server.serializeAttachment({ synced: false } satisfies WsAttachment);
      await this.maybeSyncPlayers(matchId);
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * `src/redis_subscriber.py::event_generator`の移植(SSEトランスポート版)。
   * `GET /matches/:matchId/stream`(team0/team1)・`/viewer`(viewer)から、Hono側で
   * pathnameを`/sse`に付け替えたリクエストとして呼び出される。
   */
  private async handleSseStream(
    matchId: string,
    team: PlayerTeam | "viewer",
  ): Promise<Response> {
    const encoder = new TextEncoder();
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let registeredSink: StateEventSink | undefined;

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (type: StateEventType, model: StateModel) => {
          try {
            controller.enqueue(encoder.encode(formatSseEvent(type, model)));
          } catch {
            // ストリームが既に閉じている場合は無視する(cancel()側でクリーンアップ済み)。
          }
        };

        pingTimer = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": ping\n\n"));
          } catch {
            // ignore
          }
        }, SSE_PING_INTERVAL_MS);

        if (team === "viewer") {
          const sink: StateEventSink = { send };
          registeredSink = sink;
          this.viewerSseSinks.add(sink);
          await this.sendViewerInitialSync(matchId, sink);
        } else {
          const sink: PlayerSseSink = { send, synced: false };
          registeredSink = sink;
          this.playerSseSinks.get(team)?.add(sink);
          await this.maybeSyncPlayers(matchId);
        }
      },
      cancel: () => {
        if (pingTimer !== undefined) clearInterval(pingTimer);
        if (registeredSink === undefined) return;
        if (team === "viewer") {
          this.viewerSseSinks.delete(registeredSink);
        } else {
          this.playerSseSinks
            .get(team)
            ?.delete(registeredSink as PlayerSseSink);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
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
   * 接続中の全team0/team1/viewer(WS+SSE)へ最新盤面をpushする。
   */
  async pushStateUpdate(matchId: string): Promise<void> {
    const db = drizzle(this.env.DB);
    const latest = await readLatestStateData(db, matchId);
    if (!latest) return;

    const matchDataRow = await readMatchDataRow(db, matchId);
    if (!matchDataRow) return;

    const shotInfoData = await readShotInfoByPostShotStateId(
      db,
      latest.stateRow.stateId,
    );
    const model = buildStateModel({
      matchData: matchDataRow,
      stateData: latest.stateRow,
      stoneCoordinateData: latest.stoneCoordinateData,
      scoreData: latest.scoreData,
      shotInfoData,
    });

    this.broadcast(
      JSON.stringify({ type: "latest_state_update", payload: model }),
    );
    for (const sink of this.viewerSseSinks) {
      sink.send("latest_state_update", model);
    }
    for (const sinks of this.playerSseSinks.values()) {
      for (const sink of sinks) {
        sink.send("latest_state_update", model);
      }
    }
  }

  async webSocketMessage(
    ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    const tags = this.ctx.getTags(ws);
    const team = tags[0] ?? "unknown";
    this.broadcast(
      JSON.stringify({
        type: "message",
        from: team,
        payload: message.toString(),
      }),
      ws,
    );
  }

  async webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
  ): Promise<void> {
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

  private playerPresenceCount(team: PlayerTeam): number {
    return (
      this.ctx.getWebSockets(team).length +
      (this.playerSseSinks.get(team)?.size ?? 0)
    );
  }

  /**
   * `_initial_sync_for_viewer`相当。バリアなしで現在Endの全State履歴を即座にreplayする。
   * DB未書き込みの間は何も送らず、通常配信(pushStateUpdate)が来るまで待つ。
   */
  private async sendViewerInitialSync(
    matchId: string,
    sink: StateEventSink,
  ): Promise<void> {
    const db = drizzle(this.env.DB);
    const latest = await readLatestStateData(db, matchId);
    if (!latest) return;

    const matchDataRow = await readMatchDataRow(db, matchId);
    if (!matchDataRow) return;

    const statesInEnd = await readStateDataInEnd(
      db,
      matchId,
      latest.stateRow.endNumber,
    );
    await this.replayStates(
      db,
      matchDataRow,
      statesInEnd.length > 0 ? statesInEnd : [latest],
      sink,
    );
  }

  /**
   * `_initial_sync_for_player`相当。presence(両team接続、WS+SSE合算) かつ
   * team_config(両team設定完了)が揃った時点で、未同期のplayer接続(WS+SSE)へ
   * 現在Endの全State履歴をreplayする。
   *
   * 同時に複数のplayer接続が完了しfetch()が並行実行された場合、D1読み取り(外部I/O)を挟むため
   * 理論上は同一sinkへ二重replayが起こり得る（DOの入出力ゲートはstorage操作のみを保護し、
   * fetch()間の並行実行自体は妨げない）。synced化を先に行うことで実害は「稀に二重送信される」
   * 程度に留めている（内容の破損はない）。
   */
  private async maybeSyncPlayers(matchId: string): Promise<void> {
    const bothPresent = PLAYER_TEAMS.every(
      (t) => this.playerPresenceCount(t) > 0,
    );
    if (!bothPresent) return;

    const db = drizzle(this.env.DB);
    const matchDataRow = await readMatchDataRow(db, matchId);
    const bothConfigured =
      matchDataRow !== null &&
      matchDataRow.firstTeamName !== null &&
      matchDataRow.secondTeamName !== null;
    if (!bothConfigured || matchDataRow === null) return;

    const pendingWs = PLAYER_TEAMS.flatMap((t) => this.ctx.getWebSockets(t))
      .filter(
        (ws) => !(ws.deserializeAttachment() as WsAttachment | null)?.synced,
      )
      .map((ws) => ({
        sink: wsSink(ws),
        markSynced: () =>
          ws.serializeAttachment({ synced: true } satisfies WsAttachment),
      }));

    const pendingSse = PLAYER_TEAMS.flatMap((t) =>
      Array.from(this.playerSseSinks.get(t) ?? []),
    )
      .filter((sink) => !sink.synced)
      .map((sink) => ({
        sink,
        markSynced: () => {
          sink.synced = true;
        },
      }));

    const pending = [...pendingWs, ...pendingSse];
    if (pending.length === 0) return;

    const latest = await readLatestStateData(db, matchId);
    if (!latest) return;

    const statesInEnd = await readStateDataInEnd(
      db,
      matchId,
      latest.stateRow.endNumber,
    );
    const statesToReplay = statesInEnd.length > 0 ? statesInEnd : [latest];

    for (const { sink, markSynced } of pending) {
      markSynced();
      await this.replayStates(db, matchDataRow, statesToReplay, sink);
    }
  }

  private async replayStates(
    db: DrizzleD1Database,
    matchDataRow: MatchDataRow,
    states: StateWithRelations[],
    sink: StateEventSink,
  ): Promise<void> {
    const sorted = sortStatesForReplay(states.map((s) => s.stateRow));
    const byStateId = new Map(states.map((s) => [s.stateRow.stateId, s]));

    for (let i = 0; i < sorted.length; i++) {
      const stateRow = sorted[i];
      const withRelations = byStateId.get(stateRow.stateId);
      if (!withRelations) continue;

      const shotInfoData = await readShotInfoByPostShotStateId(
        db,
        stateRow.stateId,
      );
      const model = buildStateModel({
        matchData: matchDataRow,
        stateData: stateRow,
        stoneCoordinateData: withRelations.stoneCoordinateData,
        scoreData: withRelations.scoreData,
        shotInfoData,
      });

      const eventType: StateEventType =
        i === sorted.length - 1 ? "latest_state_update" : "state_update";
      sink.send(eventType, model);
    }
  }
}
