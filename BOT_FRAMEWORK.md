# Giracle Bot フレームワーク指示書

`/ext` エンドポイントと `/ws` を使った Bot を、Bun ランタイムで簡単に作るための簡易フレームワークの設計・実装指示書。
対象読者: フレームワークを実装する開発者。読者が Bot ユーザーを書く側ではない（Bot ユーザー向けの使い方は別途 README に抜き出す）。

前提知識: 本体は `src/external/` に外部 API（prefix `/ext`）を持つ。Bot は `BotManage` 行に紐付く `remoteUserId` のユーザーアカウント名義で動作する。

```text
Bot開発者                 Giracleサーバー
┌──────────┐   HTTP     ┌──────────────────────┐
│ Botプログラム │ ────────→ │ /ext/message/...      │  Authorization: <tokenCode>
│ (Bun)     │            │                      │
│           │   WS       │ /ws                  │  購読: channel::<id>, user::<remoteUserId>
└──────────┘ ←────────  └──────────────────────┘
             signal受信: message::SendMessage 等
```

---

## 1. サーバー側 API の分析結果（実装の入力）

### 1.1 認証

- HTTP / WS とも `Authorization` ヘッダに `BotManage.tokenCode`（UUID）をそのまま載せる。Bearer 等の scheme は不要。
- `approveStatus !== "APPROVED"` の Bot は 401（`"Your bot is not approved"`）。
- トークン無効時は 401 `"Authorization header is invalid"`。

### 1.2 HTTP エンドポイント（`src/external/components/Message/`）

| メソッド | パス | 権限フラグ | 成功レスポンス |
| --- | --- | --- | --- |
| GET | `/ext/message/:messageId` | `canReadMessage` | メッセージ行（`MessageUrlPreview` / `MessageFileAttached` 配列込み） |
| POST | `/ext/message/send` | `canSendMessage` | メッセージ行（同上） |
| POST | `/ext/message/edit` | `canSendMessage` | `{ id, channelId, content, isEdited, userId }`（部分行） |
| DELETE | `/ext/message/delete` | `canSendMessage` | `{ id, userId, channelId }`（削除前の部分行） |

リクエストボディ:

- `send`: `{ channelId: string, message: string, replyingMessageId?: string }`
- `edit`: `{ targetMessageId: string, message: string }`
- `delete`: `{ targetMessageId: string }`

エラー（status code と文言はサーバー側 `response` スキーマと一致するので、フレームワーク側で文言に依存した分岐を書かないこと。code だけで判定する）:

| status | 文言 | 条件 |
| --- | --- | --- |
| 400 | `Message is empty` | 空白のみの本文 |
| 400 | `Message is too long. Maximum length is <N>` | `ServerConfig.MessageMaxLength` 超過 |
| 400 | `Replying message not found` | 返信先が同チャンネルに存在しない |
| 400 | `Message is already same` | 編集内容が同一 |
| 401 | `Authorization header is invalid` / `Your bot is not approved` | トークン不正 / 未承認 |
| 403 | `Permission not enough` | `can*` フラグ不足 |
| 403 | `Channel not permitted` | `botChannelPermissions` に該当チャンネルが無い |
| 403 | `You are not sender of this message` | 他人のメッセージを編集・削除 |
| 404 | `Message not found` | 存在しない or 許可チャンネル外 |

補足:

- **レスポンス形式が通常モジュールと異なる。** `/ext` は `{ message, data }` ラッパー無しで生のメッセージ行を返す。エラー時はボディがテキスト（JSON ではない）。
- メンションは `@<userId>` 形式。Bot 送信でもチャンネル参加者にメンション通知される（サービス側で処理済みのため、フレームワーク側で通知処理は不要）。
- URL プレビューは `send` / `edit` の afterResponse で非同期生成され、`message::UpdateMessage` が配信される。直後の GET にはまだ反映されていないことがある。
- `delete` は自分（`remoteUserId`）が送信したメッセージのみ削除可。関連データ（URL プレビュー・リアクション・添付ファイル・inbox）を1トランザクションで削除し、ファイル実体も消す。WS へは GLOBAL に `message::MessageDeleted`（data: `{ messageId, channelId }`）が publish されるが、**Bot は GLOBAL を購読しないためこの signal は届かない**。

### 1.3 WebSocket

- エンドポイント: `ws://<host>/ws`、ヘッダ `Authorization: <tokenCode>`。
- 接続時、サーバーが `user::<remoteUserId>` と許可された全 `channel::<channelId>` を自動購読する。**Bot は `GLOBAL` を購読しない**（`user::Connected` / `user::Disconnected` は受け取れない）。
- トークン不正・未承認時: `{ signal: "ERROR", data: "..." }` 受信後にサーバーから close される。
- クライアント → サーバー: `{ signal: "ping", data: "pong" }` で `pong` が返る（これ以外の signal は無視される）。ヘッダ `Authorization` を付ける。
- サーバー → クライアントの signal（Bot が受け取り得るもの）:

| signal | data |
| --- | --- |
| `message::SendMessage` | メッセージ行（自分の送信分も含む。`data.userId === bot.remoteUserId` で自己送信を判別） |
| `message::UpdateMessage` | 編集後メッセージ（編集は部分行、URLプレビューは差分行） |
| `inbox::Added` | `{ message, type }` |
| `pong` | `"pong"` |
| `ERROR` | エラー文言 |

- ペイロードは原則文字列 JSON（publish は `JSON.stringify`、`ws.send` も送出時に文字列化される）。受信側は `JSON.parse` を try し、失敗時はそのまま扱う正規化を入れること。

### 1.4 Bot の登録・権限（フレームワークのスコープ外だがREADMEに書く内容）

- Bot の作成エンドポイントは現状存在しない。`BotManage` 行はサーバー管理者が seeds / 直接 DB 挿入で作り、`/server/bot/approval`（要 `manageServer`）で `APPROVED` にする。tokenCode は作成時に自動採番（UUID）。
- チャンネルごとの許可も `botChannelPermissions` テーブルで手動管理。
- フレームワークは「tokenCode をもらっている」状態を前提とし、登録フローの実装は含めない。

---

## 2. フレームワーク要件

### 2.1 目指す体験

Bot ユーザー（フレームワークの利用者）は設定オブジェクトとイベントハンドラだけ書けば動く:

```ts
import { GiracleBot } from "giracle-bot";

const bot = new GiracleBot({ serverUrl: "http://localhost:3000", token: process.env.BOT_TOKEN! });

bot.on("message", (msg) => {
  if (msg.userId === bot.remoteUserId) return; // 自己送信は無視
  bot.sendMessage(msg.channelId, `echo: ${msg.content}`);
});

bot.start();
```

### 2.2 機能要件

1. **API クライアント** — `/ext` の 4 エンドポイントを型付きメソッドでラップ。
   - `getMessage(messageId): Promise<Message>`
   - `sendMessage(channelId, message, replyTo?): Promise<Message>`
   - `editMessage(messageId, message): Promise<EditResult>`
   - `deleteMessage(messageId): Promise<DeleteResult>`（`DeleteResult = { id, userId, channelId }`）
   - エラーはカスタムエラー `GiracleApiError`（`status`, `body` を保持）で送出し、文言は保持するだけで分岐に使わない。
2. **WS クライアント** — 自動再接続（指数バックオフ、上限あり）、受信 signal の `signal`/`data` 正規化、`ping` 定期送信（30 秒間隔。サーバーが inactive 切断をするかは未確認のため、実測して調整）。
3. **イベント** — `message` / `messageUpdate` / `inbox` / `error` / `close` の最低 5 種。Node 標準 `EventEmitter` か自前の薄い `Map<string, Set<fn>>` で良い。
4. **自己送信フィルタ** — `start()` 時に `GET /ext` なしで remoteUserId が分からないため、WS 接続後にサーバーへ `Authorization` トークン照合の結果として `bot.remoteUserId` を取得する手段が無い。**`bot.remoteUserId` は利用者に設定させるか、最初の自己送信 signal から推定する。** 仕様上 `CheckApiCode` コンテキストに remoteUserId があるが HTTP でそれを返すエンドポイントは無いため、設定項目 `botUserId`（省略可）とする。省略時は自己フィルタ無効。

   → 実装時に要検討: 最初に `sendMessage` した際のレスポンス `userId` を remoteUserId としてキャッシュするのが最も簡単。
5. **依存はゼロで作る。** Bun は `fetch` / `WebSocket` をネイティブ持つため、npm パッケージ不要。

### 2.3 型定義

サーバーの実レスポンスに合わせる（過剰な型にしない）。`Message` は主要フィールドのみ:

```ts
type Message = {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  replyingMessageId: string | null;
  isBot: boolean;
  isEdited: boolean;
  createdAt: string; // 実レスポンスの型は生成時に確認
  MessageUrlPreview: unknown[];
  MessageFileAttached: unknown[];
};
```

`createdAt` 等の日時・細部の型は、実サーバーに curl を打って確認してから確定する（推測で書かない）。

### 2.4 ディレクトリ構成（目安）

```text
giracle-bot/
├── src/
│   ├── client.ts      # /ext API ラッパ（fetch）
│   ├── ws.ts          # WS 接続・再接続・正規化
│   ├── bot.ts         # GiracleBot クラス（client + ws + events）
│   └── types.ts
├── example/echo.ts    # 動作確認用サンプル（自己送信 echo）
├── package.json       # type: module, bun 実行
└── README.md          # 利用者向け README（Bot 登録は tokenCode を管理者にもらう手順のみ）
```

実行: `bun run example/echo.ts`。テストも `bun test`（サーバー側 `test/` と同様、実サーバーを立てての結合テスト 1 ファイルで良い）。

### 2.5 エラー・再接続設計

- HTTP エラーは throw。WS 切断（close 以外の 1006 等）は `close` イベント → 1 秒から始まる指数バックオフ（上限 60 秒）で再接続。
- `ERROR` signal 受信（トークン無効・未承認）は再接続しても同じ結果のため、`error` イベント発火のみで再接続しない。
- 再接続後は自動で購読が復元される（購読はサーバー側 open ハンドラで行われるため、クライアント側の購読リスト管理は不要）。

### 2.6 実装手順

1. `types.ts` を書く。`bun run` で実サーバーに curl/fetch し、実レスポンスから型を確定。
2. `client.ts`（`fetch` ラッパ。エラー時はテキストボディを `GiracleApiError` に載せる）。
3. `ws.ts`（Bun の `new WebSocket(url, { headers })` が Authorization ヘッダに対応しているか要確認。非対応なら `Bun.WebSocket` または接続用の代替手段を調査 — ここは動作確認を必ず行う）。
4. `bot.ts` で合成し、イベント発火。
5. `example/echo.ts` で実機確認: 通常ユーザーでメッセージを送り、Bot が echo するか。
6. `bun test` で 1 本の結合テスト: seed 済み `TESTBOT1` / `TESTTOKEN1` 相当の Bot を立てて echo を検証。

### 2.7 スコープ外（作らないもの）

- Bot 登録・承認・チャンネル許可の管理 UI/API 呼び出し（現状サーバー側に作成エンドポイントが無いため）
- リアルタイム購読のフィルタリング（channelId 指定 etc.）— 利用者がハンドラ内で判定すれば十分
- Web Push / Inbox 処理 — サーバー側で済んでいる

---

## 3. 留意事項

- サーバーは SQLite のため、Bot が高頻度で `sendMessage` すると書き込み競合・通知ループ（echo ボットの自己応答無限ループ）の危険がある。フレームワークは連投抑制を入れず、README に自己送信無視のサンプルを必ず掲載する。
- `message::SendMessage` は自分の HTTP 送信でも配信される。echo 型ボットは必ず `userId === bot.remoteUserId` ガードを入れる（2.2-4 のキャッシュ方式）。
- サーバーの `bindUrlPreview` により `send` 応答直後に `message::UpdateMessage` が飛ぶ。これを「編集」と誤処理しない（`isEdited` で判別できる場合のみ編集扱いにする等、data の差分に注意）。
