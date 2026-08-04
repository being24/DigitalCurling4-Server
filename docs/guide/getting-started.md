# セットアップ・利用ガイド

## セットアップ

```sh
cd workers
bun install
```

## 開発サーバーの起動

```sh
bun run dev
```

`wrangler dev`でローカル開発サーバーが起動する。

## スクリプト一覧

| コマンド | 内容 |
|---|---|
| `bun run dev` | ローカル開発サーバー（`wrangler dev`） |
| `bun run deploy` | Cloudflareへデプロイ |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run test` | `vitest run` |
| `bun run lint` | `biome check .` |
| `bun run format` | `biome format --write .` |

`test`が使う`repositories/match.test.ts`等は`node:sqlite`（Node.js組込みの実験的機能）に依存する。ローカルにNode.js本体がインストールされていない環境では、`bun run test`はBunが自動注入する`node`シム（Bun自身へのシンボリックリンク）経由で実行されてしまい、`No such built-in module: node:sqlite`で失敗する。ローカルでテストを実行する場合は事前にNode.js（v22以降）をインストールしてPATHに通しておくこと。CI（`.github/workflows/ci.yml`）は`actions/setup-node`で正規のNode.jsをセットアップするため、この問題は起きない。

## 認証

`POST /matches`・`POST /store-team-config`・`POST /shots`・`POST /matches/:matchId/end-setup`・`GET /matches/:matchId/stream`はBasic認証が必須。ユーザー名・パスワードのハッシュは`users`テーブルに登録されたものと照合される。観戦用の`GET /matches/:matchId/viewer`と、`api/rest`配下の読み取り専用エンドポイントは認証不要。

## 試合の始め方

1. `POST /matches`で試合を作成する（試合形式・ルール・使用シミュレータ等を指定）。レスポンスとして`match_id`（UUIDv7）が返る
2. 両チームがそれぞれ`POST /store-team-config?match_id=<id>&expected_match_team_name=team0`（もう一方は`team1`）でチーム名・プレイヤー設定を登録する。両チームの登録が揃うと、接続中のWebSocket/SSEクライアントへ初期同期が配信される（詳細は[WebSocket/SSEプロトコル](/api/protocol)を参照）
3. 各チームは`GET /matches/:matchId/stream`（Basic認証、自チームの投球順のときに`POST /shots`で投球）または`/ws`（WebSocket）で接続する
4. 観戦者は`GET /matches/:matchId/viewer`（認証不要）でSSE接続できる

## 複数試合の同時進行

`match_id`ごとに独立したDurable Object（`MatchRoom`）インスタンスが割り当てられるため、複数の試合が同時に進行しても状態やWebSocket/SSE配信は互いに分離される。
