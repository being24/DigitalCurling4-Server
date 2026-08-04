# REST API

## 共通仕様

- ベースURL: デプロイ先のWorkers URL(例: `https://dc4-workers-poc.<account>.workers.dev`)
- レスポンスは`Content-Type: application/json`
- エラーレスポンスは`{"detail": string}`形式。主なステータスコード:
  - `400`: アプリケーションロジック上の制約違反(例: 手番でないチームの投球)
  - `401`: Basic認証の失敗、または試合データ不整合
  - `404`: 対象が存在しない
  - `409`: 状態競合(例: 既に開始済みの試合への再参加)
  - `422`: リクエストパラメータの形式不正(必須値の欠落・UUID形式不正等)
- パスパラメータの`matchId`等はUUID形式であることが要求される(不正な形式は422)

## 認証不要エンドポイント

`workers/src/routes/restapi.ts`に実装されている。読み取り専用。

### 試合情報

`match_id`で直接指定する形と、`tournament_name`内の最新の試合を`match_name`で探す`by-name`系の2系統がある。

| メソッド・パス | 内容 |
|---|---|
| `GET /matches/:matchId` | 試合データ(チーム名・ルール・時間制限等)取得 |
| `GET /matches/by-name/latest` | `?match_name=`で指定した試合名の最新試合を同様に取得 |
| `GET /matches/:matchId/score` | チームごとのエンド別得点 |
| `GET /matches/by-name/score` | 同上(by-name版) |
| `GET /matches/:matchId/stone-coordinate/latest` | 最新のストーン座標 |
| `GET /matches/by-name/stone-coordinate/latest` | 同上(by-name版) |
| `GET /matches/:matchId/ends` | 開始済みエンド番号の配列 |
| `GET /matches/by-name/ends` | 同上(by-name版) |
| `GET /matches/:matchId/latest-state` | 最新の状態(state)データ |
| `GET /matches/by-name/latest-state` | 同上(by-name版) |
| `GET /matches/:matchId/ends/:endNumber/states` | 指定エンド内の全状態データ |
| `GET /matches/by-name/ends/:endNumber/states` | 同上(by-name版) |
| `GET /matches` | `?tournament_name=`で指定した大会に属する試合一覧 |

`by-name`系は`match_name`が必須クエリパラメータ(未指定は422、該当試合なしは404)。

### 投球

| メソッド・パス | 内容 |
|---|---|
| `GET /matches/:matchId/ends/:endNumber/shots` | 指定エンド内の全投球情報 |
| `GET /matches/by-name/ends/:endNumber/shots` | 同上(by-name版) |
| `GET /matches/:matchId/ends/:endNumber/shots/:totalShotNumber` | エンド内の通算投球数を指定して1件取得 |
| `GET /matches/:matchId/shots/latest` | 試合内の最新投球情報 |
| `GET /shots/:shotId` | `shot_id`で直接指定して取得 |
| `GET /shots/by-post-state/:postStateId` | 投球後の`state_id`から逆引き |

投球情報のレスポンスには、クライアントが送信した意図値(`actual_translational_velocity`等)と、乱数摂動後の実際の計算値(`translational_velocity`等)の両方が含まれる。詳細は[WebSocket/SSEプロトコル](/api/protocol#投球パラメータの乱数摂動)を参照。

### その他の個別リソース

| メソッド・パス | 内容 |
|---|---|
| `GET /states/:stateId` | 状態データを1件取得 |
| `GET /states` | 全状態IDの一覧 |
| `GET /stone_coordinate/:stoneCoordinateId` | ストーン座標データを1件取得 |
| `GET /scores/:scoreId` | 得点データを1件取得 |
| `GET /tournaments` | 大会一覧 |

### 観戦(SSE)

`GET /matches/:matchId/viewer`は認証不要のSSEストリーム。詳細は[WebSocket/SSEプロトコル](/api/protocol)を参照。

## 認証必須エンドポイント

`workers/src/routes/match.ts`に実装されている。すべてBasic認証が必須。

### `POST /matches`

試合を作成する。

リクエストボディ:

```json
{
  "game_mode": "standard",
  "tournament": { "tournament_name": "string" },
  "simulator": { "simulator_name": "string" },
  "applied_rule": "fgz_rule",
  "time_limit": 600,
  "extra_end_time_limit": 60,
  "standard_end_count": 8,
  "match_name": "string",
  "positioned_stones_pattern": 0
}
```

- `game_mode`: `"standard"` または `"mixed_doubles"`
- `applied_rule`: `"fgz_rule"` / `"no_tick_rule"` / `"modified_fgz_rule"`。`modified_fgz_rule`は`mixed_doubles`専用(組み合わせが違うと400)
- `positioned_stones_pattern`: `mixed_doubles`のときのみ有効(0〜5、範囲外は400)

レスポンス: 生成された`match_id`(文字列)。

### `POST /store-team-config`

チーム設定を登録する。クエリパラメータ`match_id`・`expected_match_team_name`(`team0`または`team1`)が必須。

リクエストボディ:

```json
{
  "use_default_config": false,
  "team_name": "string",
  "player1": { "max_velocity": 4.0, "shot_std_dev": 0.0076, "angle_std_dev": 0.0018, "player_name": "string" },
  "player2": { "...": "..." },
  "player3": { "...": "..." },
  "player4": { "...": "..." }
}
```

`standard`モードでは`player3`・`player4`が必須、`mixed_doubles`では省略(null)必須。両チームの登録が揃うと、接続中のWebSocket/SSEクライアントへ初期同期が配信される。

### `POST /shots`

投球する。クエリパラメータ`match_id`が必須。手番でないチームからの投球は400、試合終了後は409。

リクエストボディ:

```json
{
  "translational_velocity": 2.5,
  "angular_velocity": 1.5707,
  "shot_angle": 1.5707
}
```

レスポンス成功時は`null`。投球結果はWebSocket/SSE配信(`latest_state_update`)で通知される。

### `POST /matches/:matchId/end-setup`

mixed doubles専用。クエリパラメータ`request`で配置パターン(`pp_left` / `pp_right` / `center_house` / `center_guard`)を指定する。standardモードの試合に対しては400。
