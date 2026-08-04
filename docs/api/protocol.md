# WebSocket/SSEプロトコル

盤面の状態配信は、試合ごとに1つ割り当てられるDurable Object(`MatchRoom`)がWebSocketとSSEの両トランスポートで提供する。

## 接続方法

| 用途 | トランスポート | エンドポイント |
|---|---|---|
| プレイヤー(自チーム) | WebSocket | `GET /ws?match=<matchId>&team=team0`(または`team1`) |
| プレイヤー(自チーム) | SSE | `GET /matches/:matchId/stream`(Basic認証必須。認証情報から`team0`/`team1`を解決) |
| 観戦者 | WebSocket | `GET /ws?match=<matchId>&team=viewer` |
| 観戦者 | SSE | `GET /matches/:matchId/viewer`(認証不要) |

SSEのイベント形式は`event: <type>\ndata: <json>\n\n`。公式クライアントライブラリ(`dc4client`)の`receive_state_data()`はこの形式を読む。SSE接続は30秒間隔でコメント行(`: ping\n\n`)のkeep-aliveを送信する。

## イベントタイプ

| type | 送信タイミング |
|---|---|
| `state_update` | 初期同期(リプレイ)で、現在エンドの過去の状態を送るとき(WS/SSE共通) |
| `latest_state_update` | 初期同期の最後の1件、および投球・end-setup等で新しい状態が確定したとき(通常配信) |
| `presence` | WS接続の入退室通知(`{"type":"presence","team":"team0","event":"joined"}`等)。WSのみ、SSEには存在しない |
| `message` | WS上でクライアントが送信したメッセージのブロードキャスト。WSのみ |

`state_update`/`latest_state_update`のペイロード(`payload`)は共通の状態モデルで、主なフィールドは以下。

| フィールド | 内容 |
|---|---|
| `winner_team` | 勝者チーム(`"team0"` / `"team1"` / `null`) |
| `first_team_name` / `second_team_name` | チーム名 |
| `end_number` | 現在のエンド番号 |
| `team_shot_number` / `total_shot_number` | エンド内投球数 / 通算投球数(mixed doublesのend-setup前は`null`) |
| `next_shot_team` | 次に投球するチーム |
| `first_team_remaining_time` / `second_team_remaining_time` | 残り時間 |
| `first_team_extra_end_remaining_time` / `second_team_extra_end_remaining_time` | 延長エンドの残り時間 |
| `mixed_doubles_settings` | mixed doubles設定(配置パターン・パワープレー・エンド毎の先攻チーム)。standardモードは`null` |
| `last_move` | 直前の投球パラメータ(`translational_velocity` / `angular_velocity` / `shot_angle`) |
| `stone_coordinate` | ストーン座標(`{"data": {"team0": [...], "team1": [...]}}`) |
| `score` | エンドごとの得点(`{"team0": number[], "team1": number[]}`) |

## 初期同期(リプレイ)

接続直後の挙動はプレイヤーと観戦者で異なる。

- **観戦者**: 接続直後、即座に現在エンドの状態履歴を`state_update`(過去分)→`latest_state_update`(最新)の順で送信する。バリアは無い
- **プレイヤー**: 両チーム(team0・team1、WS+SSE合算)の接続が揃い、かつ両チームのteam-config登録がD1上で完了して初めて、未同期の接続へ現在エンドの状態履歴をリプレイする。どちらか一方が欠けている間は何も送信されない

D1未書き込みの間(試合作成直後等)は、状態が存在しないため何も送信されず、後続の通常配信(`pushStateUpdate`)を待つ。

## 複数試合の分離

`match_id`ごとに独立した`MatchRoom`インスタンスが割り当てられる(`env.MATCH_ROOM.getByName(matchId)`)ため、複数試合が同時に進行しても配信内容が別の試合に混ざることはない。

## 投球パラメータの乱数摂動

投球リクエスト(`POST /shots`)で送信した値は、プレイヤー設定(`max_velocity` / `shot_std_dev` / `angle_std_dev`)に基づくガウス分布ノイズを加えられた上でシミュレータに渡される。この歪みを乗せた実際の計算値が、`shot_info`テーブルおよび配信ペイロードの`last_move`に格納される。

| 概念 | DBカラム(`shot_info`) | 内容 |
|---|---|---|
| クライアントが送信した意図値 | `actual_translational_velocity` / `actual_shot_angle` / `actual_angular_velocity` | 乱数摂動前の入力値(角速度は符号反転後) |
| 実際にシミュレータへ渡された値 | `translational_velocity` / `shot_angle` / `angular_velocity` | ガウス分布ノイズを加えた後の値。`state_update`/`latest_state_update`の`last_move`に入るのはこちら |

REST APIの投球情報エンドポイント(`GET /shots/:shotId`等)は両方のフィールドを返すため、クライアント側で実際の計算に使われたパラメータ(歪みあり値)を取得したい場合は、このREST APIまたは配信ペイロードの`last_move`を参照する。
