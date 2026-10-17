# Giracle Bot フレームワーク指示書

`/ext` エンドポイントと `/ext/ws` を使った Bot を、Bun ランタイムで簡単に作るための簡易フレームワークの設計・実装指示書。
対象読者: フレームワークを実装する開発者。読者が Bot ユーザーを書く側ではない（Bot ユーザー向けの使い方は別途 README・SKILL.md に抜き出す）。

前提知識: 本体は `src/components/Ext/ext.module.ts` に外部 API（prefix `/ext`）を持ち、`src/ws.ext.ts` に Bot 用 WS ハンドラ（`/ext/ws`）を持つ。Bot は `BotManage` 行に紐付く `remoteUserId` のユーザーアカウント名義で動作する。

```text
Bot開発者                 Giracleサーバー(giracle-backend)
┌──────────┐   HTTP     ┌──────────────────────┐
│ Botプログラム │ ────────→ │ POST /ext/message/send│  Authorization: <tokenCode>
│ (Bun)     │            │                      │
│           │   WS       │ /ext/ws              │  購読: bot::channel::<id>, user::<remoteUserId>
└──────────┘ ←────────  └──────────────────────┘
             signal受信: message::UpdateMessage 等
```

---

## 1. サーバー側 API の分析結果（実装の入力）

### 1.1 認証（`Middleware.CheckBotToken`）

- HTTP / WS とも `Authorization` ヘッダに `BotManage.tokenCode`（32バイトhex、UUIDではない）をそのまま載せる。Bearer 等の scheme は不要。
- サーバー設定 `ServerConfig.BotEnabled` が OFF なら 400（`Bot is not enabled on this server`）。
- `isApproved !== true` の Bot は 401（`Bot is not approved yet`）。
- token 無効は 401（`Invalid token`）。
- 作成ユーザーが BAN / 論理削除済みなら 401（`This bot is disabled`）。

### 1.2 HTTP エンドポイント

| メソッド | パス | 成功レスポンス |
| --- | --- | --- |
| POST | `/ext/message/send` | `{ message: "Sent message", data: { messageSaved: <メッセージ行 + MessageFileAttached 配列>, messageReplyingTo: <返信先行 or null> } }` |
| POST | `/ext/message/edit` | `{ id, channelId, userId, content, isEdited: true }`（`updateMessage` の returning。ラッパー無し・`createdAt` 無し） |
| DELETE | `/ext/message/delete` | `{ id, userId, channelId }`（`getSingleWithMinimum` 相当の削除対象。ラッパー無し・本文無し） |

リクエストボディ: send は `{ channelId: string, message: string, replyingMessageId?: string }`、edit は `{ messageId: string, message: string }`、delete は `{ messageId: string }`（**DELETE でも JSON ボディ**）。

edit / delete は **Bot 自身（`remoteUserId`）名義のメッセージのみ**操作可。
- edit の戻りは WS 部分行と同じ形のため `MessageUpdate` 型を使い回す。
- delete は本文を返さず、関連データ（添付ファイル実体・リアクション・通知）もサーバー側の 1 トランザクションで消える。

エラー（文言は保持するだけで分岐に使わないこと。status code だけで判定する）:

| status | 条件 |
| --- | --- |
| 400 | `Bot is not enabled on this server` / `Message is empty`（空白のみ）/ `Message is too long. Maximum length is <N>` / `You are not joined this channel` / `Replying message not found` / `Message is already same`（edit で本文が不変） |
| 401 | token 不正 / 未承認 / Bot 無効化 |
| 403 | `You are not sender of this message`（edit）/ `You are not owner of this message`（delete）で Bot 名義でない行 |
| 404 | `Message not found`（edit / delete で行が存在しない） |

補足:

- **`/ext` のエンドポイントは send / edit / delete のみ。** 旧仕様の `GET /ext/message/:id` / `makeGet` は廃止され、Bot のメッセージ取得はできない。
- send のレスポンスは通常モジュールと同じ `{ message, data }` ラッパー付き、edit / delete は行そのもの。エラー時はボディがテキスト（JSON ではない）。
- **Bot の送信・編集・削除は WS へ配信されない。** send / edit は `channel::<channelId>` への publish のため Bot の購読トピック（`bot::channel::`）には届かず、delete は `GLOBAL` への publish だが Bot は `GLOBAL` を購読しない。自分の操作はどの Bot にも届かず、echo ループは原理的に発生しない。
- Bot 送信でもメンション処理・URL プレビュー通知は走らない（ユーザー送信時のみ）。`bindUrlPreview` が付いているため URL プレビュー行自体は生成され得る。
- `/ext` には Bot 単位のレート制限は現状適用されていない（全体の anonymous/IP レート制限の対象外）。

### 1.3 WebSocket（`src/ws.ext.ts`）

- エンドポイント: `ws://<host>/ext/ws`、ヘッダ `Authorization: <tokenCode>`（通常ユーザーは `/ws`）。
- 接続時、サーバーが `user::<remoteUserId>` と **閲覧可能な全チャンネルの `bot::channel::<channelId>`** を自動購読する。閲覧可否はロールの `ChannelViewableRole` ベース（旧仕様の `botChannelPermissions` は廃止）。**`GLOBAL` は購読しない。**
- トークン不正・未承認・無効化時: `{ signal: "ERROR", data: "..." }` 受信後にサーバーから close される。文言は `Bot token not valid` / `Your bot is not approved yet` / `User not found. This is a server side issue` / `This bot is disabled`。接続切り替え（承認剥がし・BAN）もサーバー側がインスタンスを close する。
- クライアント → サーバー: body は `{ signal: "ping", data: <非空文字列> }`（両方 minLength 1）。`signal === "ping"` で `{ signal: "pong", data: "pong" }` が返る。これ以外の signal は無視される。
- サーバー → クライアントの signal（Bot が受け取り得るもの）:

| signal | data | 配信元 |
| --- | --- | --- |
| `message::UpdateMessage`（全行分） | メッセージ行 + `MessageFileAttached`（`createdAt` / `isSystemMessage` / `replyingMessageId` を含む） | ユーザー送信時に `bot::channel::<channelId>` へ |
| `message::UpdateMessage`（部分行） | `{ id, channelId, userId, content, isEdited: true }`（`createdAt` 無し） | ユーザー編集時に `bot::channel::<channelId>` へ |
| `inbox::Added` | `{ message, type: "mention" \| "reply" }` | Bot がメンション・返信されたとき `user::<remoteUserId>` へ |
| `pong` | `"pong"` | ping への応答 |
| `ERROR` | エラー文言 | 認証失敗時 |

- **新規メッセージと編集が同一 signal 名 で配信される。** 振り分けは部分行が持たない `createdAt` の有無で行う（フレームワーク実装済み）。
- **Bot として送信/編集/削除したメッセージはこの WS には配信されない。** send / edit は `channel::<channelId>` にのみ publish するため `bot::channel::` を購読する Bot には自分も他 Bot も届かず、delete は `GLOBAL` へ publish されるが Bot は `GLOBAL` を購読しない。`message` / `messageUpdate` はユーザーの行動でしか発火しない。
- `message::SendMessage` は `channel::<id>`（通常ユーザー用）へのみ publish され、`bot::channel::` へは発行されない。URL プレビュー更新（`UrlPreviewControl`）、リアクション、既読時間、削除（`message::MessageDeleted` は GLOBAL へ）も Bot には届かない。
- ペイロードは文字列 JSON（内部で JSON.stringify される）。受信側は JSON.parse を試し、失敗時は raw とする正規化を入れる（実装済み）。

### 1.4 メッセージ行の型（`src/db/schema.ts` → JSON）

`Message` 行は `id, channelId, userId, content, isSystemMessage, isEdited, replyingMessageId, createdAt`（updatedAt 等は無い。旧仕様の `isBot` フィールドは廃止）。`createdAt` は timestamp_ms の Date → ISO 8601 文字列。リレーション `MessageFileAttached[]`（HTTP send / WS send 配信）と `MessageUrlPreview[]`（HTTP ユーザー系 API のみ。Bot が受け取るペイロードには付かない）はオプショナル配列。

### 1.5 Bot の登録・承認・参加（フレームワークのスコープ外だが README に書く内容）

- 登録: 作成者が `PUT /bot`（Cookie 認証）で作成。`tokenCode` はサーバー側で自動採番（32バイトhex）し、作成者一覧 `GET /bot/list` / `GET /bot/all`（要 manageServer）や `GET /bot/:remoteUserId` で確認できる。
- 承認: 管理者が `POST /server/bot/set-approve` で `isApproved` を true/false に。改名（`POST /bot`）すると自動で未承認に戻る。
- 送信可否: `ServiceMessage.Send` は `ChannelJoin`（Bot がそのチャンネルに参加していること）を要求する。参加は作成者が通常ユーザー API で Bot ユーザーを参加させる。
- 受信可否: `GetUserViewableChannel`（ロール + チャンネル可視設定）で決まる。

---

## 2. フレームワーク要件

### 2.1 目指す体験

Bot ユーザーは設定オブジェクトとイベントハンドラだけ書けば動く:

```ts
import { GiracleBot } from "giracle-bot";

const bot = new GiracleBot({ serverUrl: "http://localhost:3000", token: process.env.BOT_TOKEN! });

bot.on("message", (msg) => {
  if (msg.isSystemMessage) return;
  bot.sendMessage(msg.channelId, `echo: ${msg.content}`).catch(console.error);
});

bot.start();
```

### 2.2 機能要件

1. **API クライアント** — `/ext` の 3 エンドポイントを型付きメソッドでラップ: `sendMessage`（`POST /ext/message/send`、`{ message, data }` ラッパーをほどいて `Message`）、`editMessage`（`POST /ext/message/edit`、行そのものを `MessageUpdate`）、`deleteMessage`（`DELETE /ext/message/delete`、削除対象の最小情報 `DeletedMessage`）。エラーはカスタムエラー `GiracleApiError`（`status`, `body` を保持）で送出し、文言は保持するだけで分岐に使わない。
2. **WS クライアント** — 自動再接続（指数バックオフ、上限 60 秒）、受信 signal の `signal`/`data` 正規化、`ping` 定期送信（30 秒間隔。pong 無応答 2 周期で半死接続とみなして再接続）。
3. **イベント** — `message` / `messageUpdate` / `inbox` / `open` / `error` / `close`。
4. **signal 振り分け** — `message::UpdateMessage` は `createdAt` 有無で全行分（`message` イベント）と部分行（`messageUpdate` イベント）に分ける。不正 payload（`id` 無し等）は黙って捨てる。
5. **依存はゼロ。** Bun は `fetch` / `WebSocket`（(url, { headers }) で Authorization 対応）をネイティブ持つ。

### 2.3 ディレクトリ構成

```text
giracle-bot/
├── src/
│   ├── client.ts      # /ext API ラッパ（fetch）
│   ├── ws.ts          # WS 接続・再接続・正規化
│   ├── bot.ts         # GiracleBot クラス（client + ws + events）
│   ├── types.ts
│   ├── errors.ts
│   ├── log.ts
│   └── index.ts       # エクスポート
├── example/           # echo / reply-bot / edit-watcher / edit-bot / delete-bot / ping
├── test/              # bun test（モックのみで実サーバー不要）
├── README.md          # 利用者向け README
└── SKILL.md           # Bot 実装エージェント向け手順書
```

### 2.4 エラー・再接続設計

- HTTP エラーは throw。WS 切断（1006 等）は 1 秒から指数バックオフ（上限 60 秒）で再接続。
- `ERROR` signal 受信（トークン無効・未承認・無効化）は再接続しても同じ結果のため、`error` + `close` イベント発火のみで再接続しない。
- 再接続後は自動で購読が復元される（購読はサーバー側 open ハンドラで行われるため、クライアント側の購読リスト管理は不要）。

### 2.5 スコープ外（作らないもの）

- Bot 登録・承認・チャンネル参加の管理 API 呼び出し（作成者 / 管理者操作）
- リアルタイム購読のフィルタリング（channelId 指定 etc.）— 利用者がハンドラ内で判定すれば十分
- Web Push / Inbox の保存処理 — サーバー側で済んでいる

---

## 3. 留意事項

- 旧仕様との違い（破壊的変更）: `/ext` の makeGet 廃止（edit / delete は後日再追加）、レスポンスの `{ message, data }` ラッパー化、`approveStatus` 文字列 → `isApproved` boolean、WS 購読トピックの `bot::channel::` 化、新規メッセージ配信 signal の `message::UpdateMessage` 化、`Message.isBot` フィールド廃止、Bot 単位レート制限の撤廃。
- Bot 自身の送信は WS 配信されないため、旧仕様にあった自己送信フィルタ・identity 未確定時の echo race 対策は不要（削除済み）。
- サーバーは SQLite のため Bot が高頻度で `sendMessage` すると書き込み競合の危険がある。フレームワークは連投抑制を入れず、README に注意を書く。
