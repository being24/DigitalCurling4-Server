# dc4-workers

DigitalCurling4のサーバー実装。Cloudflare Workers（Hono + D1/Drizzle ORM + Durable Objects）で構築されている。

REST API・WebSocket/SSEプロトコル・アーキテクチャの詳細は[ドキュメントサイト](https://being24.github.io/DigitalCurling4-Server/)を参照。

## セットアップ

```sh
bun install
```

## スクリプト

| コマンド | 内容 |
|---|---|
| `bun run dev` | ローカル開発サーバー（`wrangler dev`） |
| `bun run deploy` | Cloudflareへデプロイ |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | `vitest run` |
| `bun run lint` | `biome check .` |
| `bun run format` | `biome format --write .` |

`test`が使う`repositories/match.test.ts`等は`node:sqlite`（Node.js組込みの実験的機能）に依存する。ローカルにNode.js本体がインストールされていない環境では、`bun run test`はBunが自動注入する`node`シム（Bun自身へのシンボリックリンク）経由で実行されてしまい、`No such built-in module: node:sqlite`で失敗する。ローカルでテストを実行する場合は事前にNode.js（v22以降）をインストールしてPATHに通しておくこと。CI（`.github/workflows/ci.yml`）は`actions/setup-node`で正規のNode.jsをセットアップするため、この問題は起きない。

## 既知のセキュリティ課題（未対応）

### `/ws`（`MatchRoom` DO接続）に認証・認可が無い

`app.ts`の`GET /ws`は`?match=<id>`のみで`MatchRoom`へfetchを素通しし、認証チェックが無い。`match_room.ts`の`fetch()`も`team`をクライアント指定の`?team=team0|team1|viewer`のままサーバー側検証せずに受理する。

対して同じ盤面配信を行う`GET /matches/:matchId/stream`（SSE、`routes/match.ts`）は`requireBasicAuth` + `readMatchAuthTeamName(db, authUser.username, matchId)`で、認証済みユーザーが実際にそのmatchのteamに属するかをサーバー側で検証してからteamを決定している。`/ws`にはこの検証が無い。

実害: match_idを知っていれば誰でも`team0`/`team1`を名乗って接続でき、(1) presenceバリア（`maybeSyncPlayers`）を満たして盤面リプレイ（石座標・スコア・投球履歴）を取得できる、(2) `webSocketMessage`経由で`from: team0`等を偽装したメッセージを相手チームへ送信できる。投球自体は別途認証済みREST(`/shots`)経由のため、これだけでは不正投球はできない。

修正案: `/ws`接続時にも`/matches/:matchId/stream`と同じ`readMatchAuthTeamName`を要求し、teamをクライアント入力でなくサーバー側で決定する。

### `/simulate`が未認証・レート制限なしで本番公開されている

`simulate.ts`の`handleSimulate`はコメント上「デバッグ用HTTPエンドポイント」だが、`app.ts`で`requireBasicAuth`/`rateLimitByUser`の対象パスから外れており、本番ドメイン(`dc-cf.being24.org`)にそのまま公開されている。中身はCPU重量級のWASM物理演算呼び出し（実測40ms前後/回、Free plan上限10msを超過する水準）で、`/shots`と異なり認証もrate limitも無いため、無制限に叩いてCPU時間課金を積み増せる。

修正案: デバッグ用途が不要なら削除。残す場合は`/shots`と同じ`requireBasicAuth` + `rateLimitByUser`を適用する。
