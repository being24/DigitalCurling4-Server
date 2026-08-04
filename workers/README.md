# dc4-workers

DigitalCurling4-Server（FastAPI + Postgres + Redis）をCloudflare Workers（Hono + D1/Drizzle ORM + Durable Objects）に移植するPoC。

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
