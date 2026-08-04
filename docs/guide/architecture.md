# アーキテクチャ

## 全体構成

サーバーは以下のCloudflareプリミティブで構成される。

- **Hono**: HTTPルーティング（`workers/src/app.ts`）
- **D1 + Drizzle ORM**: 試合データ・状態履歴等の永続化(`workers/src/db/schema.ts`)
- **Durable Objects（`MatchRoom`）**: 試合ごとのWebSocket/SSE配信状態を保持
- **Cron Triggers**: 期限切れ認証データの定期削除

エントリポイントは`workers/src/index.ts`で、`fetch`ハンドラが`app.fetch`（Hono）に委譲し、`scheduled`ハンドラがCron Triggerから起動される。

```jsonc
// workers/wrangler.jsonc(抜粋)
{
  "durable_objects": {
    "bindings": [{ "name": "MATCH_ROOM", "class_name": "MatchRoom" }]
  },
  "d1_databases": [
    { "binding": "DB", "database_name": "dc4-db", "migrations_dir": "drizzle" }
  ],
  "triggers": { "crons": ["0 0 * * *"] }
}
```

## ルーター構成

`app.ts`は2つのHonoルーターをマウントする。

- **`restapiRoutes`**（`workers/src/routes/restapi.ts`）: 認証不要・読み取り専用のREST APIと、観戦用SSEエンドポイント（`/matches/:matchId/viewer`）
- **`matchRoutes`**（`workers/src/routes/match.ts`）: Basic認証必須の試合作成・チーム設定登録・投球・mixed doubles end-setup・プレイヤー向けSSEエンドポイント（`/matches/:matchId/stream`）

これに加え、`app.ts`直下に`/simulate`（物理シミュレータ呼び出し）と`/ws`（WebSocket接続、`MatchRoom`へ委譲）が定義されている。

## Durable Objects（`MatchRoom`）による試合の分離

1試合(`match_id`)につき1つの`MatchRoom`インスタンスが`env.MATCH_ROOM.getByName(matchId)`で取得される。これにより、複数試合が同時に進行してもWebSocket/SSEの配信対象・接続状態が試合単位で完全に分離される。

`MatchRoom`はWebSocket Hibernation API（`ctx.acceptWebSocket`）を使うため、接続がアイドル状態のときはインスタンスが評価されず課金コストがかからない。一方SSE接続はHibernationの対象外のため、SSE接続が開いている間はインスタンスが常駐する。

試合作成・チーム設定登録・投球はREST側（`matchRoutes`）がD1への書き込みを担当し、`MatchRoom`はそれらの変化を自発的には検知できない。そのためREST側から`notifyTeamConfigUpdated(matchId)` / `pushStateUpdate(matchId)`というRPCメソッドを呼び出すことで、`MatchRoom`にD1の変更を通知する設計になっている。

## D1テーブル構成

主なテーブル（`workers/src/db/schema.ts`）:

| テーブル | 役割 |
|---|---|
| `match_data` | 試合の基本情報(チームID・ルール・時間制限等) |
| `match_mixed_doubles_settings` | mixed doubles固有の設定(配置パターン・パワープレー・エンド毎の先攻選択チーム) |
| `state` | 試合の状態スナップショット(残り時間・次投球チーム・スコアID等) |
| `shot_info` | 投球パラメータ(意図した入力値と、乱数摂動後の実際の計算値の両方) |
| `stone_coordinate` | ストーン座標データ |
| `score` | チームごとのエンド別得点 |
| `player` | プレイヤー設定(最大速度・投球/角度の標準偏差) |
| `tournament` / `physical_simulator` | 大会名・使用シミュレータのマスタデータ |
| `users` / `basic_authentication` | Basic認証用のユーザー情報と、試合参加中のセッション情報 |

## 定期処理

Cron Trigger（毎日0時）が期限切れの`basic_authentication`レコードを削除する。
