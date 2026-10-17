# Giracle Bot フレームワーク

Giracle サーバー向け Bot フレームワーク（Bun ランタイム用、依存ゼロ）。

```text
Bot (Bun) ──HTTP──→ POST /ext/message/send | edit、DELETE /ext/message/delete   Authorization: <tokenCode>
          ←─WS──── /ext/ws                                                    signal: message::UpdateMessage 等
```

## セットアップ

1. Bun をインストール（`https://bun.sh`）
2. `bun install`
3. Bot の登録は管理者経由のみ: 管理者が `PUT /bot` で Bot を作成し、`tokenCode`（32バイトhex）を受け取る。`isApproved` が `true` になるまで接続は 401 になる。
   - サーバー設定 `BotEnabled` が ON である必要がある
   - **メッセージ送信には Bot ユーザーのチャンネル参加が必要**（通常ユーザーと同じ `ChannelJoin`）。作成者が Bot ユーザーをチャンネルへ参加させておくこと
   - WS でのメッセージ受信範囲は Bot ユーザーが**閲覧できる**チャンネル（ロールの可視設定に依存）。参加していなくても閲覧可なら **`message` イベントに流れるが送信は 400 になる**ので注意

## 使い方

```ts
import { GiracleBot } from "giracle-bot";

const bot = new GiracleBot({
  serverUrl: "http://localhost:3000",
  token: process.env.BOT_TOKEN!, // BotManage.tokenCode
});

bot.on("message", (msg) => {
  if (msg.isSystemMessage) return; // 入退室等のシステムメッセージは弾く
  bot.sendMessage(msg.channelId, `echo: ${msg.content}`).catch(console.error);
});

bot.on("inbox", (item) => {
  // メンション（@<botUserId>）されたとき届く
  console.log("called:", item.message.content, item.type);
});

bot.start();
```

実行: `bun run example/echo.ts`

## Bot を作る（コーディングエージェント向け）

`SKILL.md` はこのフレームワークで Bot を実装するためのエージェント向け手順書。新しい Bot の作成・コマンド/返信/編集監視の実装・イベントハンドラ追加を依頼する際は、これを読ませると API 表面・落とし穴・モックでの検証手順がそのまま使える。

動く雛形は `example/`（`echo` / `reply-bot` / `edit-watcher` / `edit-bot` / `delete-bot` / `ping`）。

## API

| メソッド | 説明 |
| --- | --- |
| `sendMessage(channelId, message, replyingMessageId?)` | 送信（Bot ユーザーがそのチャンネルに参加している必要あり）。レスポンスの保存行（旧ビルドは `data.messageSaved`）をほどいて Message を返す |
| `editMessage(messageId, message)` | 編集（**Bot 自身が送った行のみ**。他人の行は 403）。部分行 `{ id, channelId, userId, content, isEdited }` を返す（`createdAt` は無い） |
| `deleteMessage(messageId)` | 削除（**Bot 自身が送った行のみ**。他人の行は 403）。削除対象の最小情報 `{ id, userId, channelId }` を返す（本文は無い） |

Bot 用 HTTP API はこの 3 つのみ。**`getMessage`（取得）はサーバー側 `/ext` には存在しない**（通常ユーザー用の `/message` API は別に存在するが Bot は Cookie では使えない）。

メンションは本文に `@<userId>` を書くとサーバー側で処理される（Bot 送信からは通知されない。ユーザー送信時のみ）。

エラーは `GiracleApiError`（`status` / `body` を保持）。文言での分岐はしないこと（status code のみで判定）。err ステータス: 400 `Bot is not enabled on this server` / `Message is empty` / `Message is too long. Maximum length is <N>` / `You are not joined this channel` / `Replying message not found` / `Message is already same`、401 `Invalid token` / `Bot is not approved yet` / `This bot is disabled`、403 `You are not sender of this message`（edit）/ `You are not owner of this message`（delete）、404 `Message not found`（edit / delete）。

## イベント

| イベント | ペイロード | 説明 |
| --- | --- | --- |
| `message` | `Message` | 新規メッセージ（signal は `message::UpdateMessage`。全行分が流れる）。システムメッセージも流れる。**Bot として送信したメッセージは WS 配信されない**ため自己送信ガードは不要 |
| `messageUpdate` | `MessageUpdate` | 編集（部分行 `{ id, channelId, userId, content, isEdited: true }`）。新規メッセージと同一 signal がフレームワーク側で振り分け済み。**Bot として編集した結果も `messageUpdate` には流れない** |
| `inbox` | `InboxAdded` | Bot がメンション・返信されたとき（`{ message, type: "mention" \| "reply" }`）。メンションはチャンネル参加者が送った場合のみ |
| `error` | `Error` | WS の `ERROR` signal（トークン無効・未承認・無効化）受信時のみ。fatal で再接続しない（`close` も続けて発火）。HTTP 失敗は `sendMessage` / `editMessage` の reject で通知される。リスナー未登録時は `console.error` にフォールバック（プロセスは落とさない） |
| `close` | なし | `stop()` または fatal エラーによる終了 |

**Bot として送信/編集/削除したメッセージの WS 通知は来ない。** `/ext` の send / edit は `channel::<channelId>` にのみ publish するため `bot::channel::<channelId>` を購読する Bot には届かず、delete の `message::MessageDeleted` は `GLOBAL` にのみ publish される（Bot は `GLOBAL` を購読しない）。これは自分自身にも他の Bot にも同様で、`message` / `messageUpdate` は**ユーザーの**投稿・編集でしか発火しない。自分が送った行の id や内容は `sendMessage` / `editMessage` / `deleteMessage` の戻り値から取る。

WS は異常切断時に 1 秒から指数バックオフ（上限 60 秒）で自動再接続。ping は 30 秒間隔で自動送信し、`pong` が 2 周期連続で返らなければ（最終受信から `pingIntervalMs × 2` を超えた次の周期で）半死接続とみなして切断 → 再接続する。

## ログ

接続状態の変化は `[giracle-bot]` 接頭辞で標準出力に出力する（出力先は `src/log.ts` の 1 箇所）。

```text
[giracle-bot] bot を起動
[giracle-bot] 接続開始: ws://localhost:3000/ext/ws
[giracle-bot] 接続確立
[giracle-bot] 切断を検知 (code 1006 abnormal closure)
[giracle-bot] 再接続を予約: 1000ms 後 (attempt 1)
[giracle-bot] 再接続に成功 (attempt 1)
[giracle-bot] ERROR signal を受信: Bot token not valid → 再接続しない
[giracle-bot] bot を停止
```

## 配布（バンドル）

```sh
bun run build   # dist/index.js（単一 ESM バンドル）+ .d.ts
```

Bundler は Bun 標準の `bun build`（`--target bun`）。npm publish する場合は `package.json` の `files` に `dist` を含めてある。

## 開発

```sh
bun test        # モックのみで検証（実サーバー不要）
bunx tsc --noEmit
bun run build
```

## 注意事項

- **Bot 自身の送信・編集・削除は WS に流れない**（自分にも他の Bot にも届かない）。echo でもループにはならないが、Bot は「自分が送った/編集したメッセージ」を `message` / `messageUpdate` イベントからは知り得ない（`sendMessage` / `editMessage` / `deleteMessage` の戻り値で確認する）
- ユーザー送信時、サーバーは bot 購読トピックへ **`message::UpdateMessage`** を発行する。そのため新規メッセージも「Update」という signal 名で届く（フレームワークで振り分け済み）
- URL プレビュー生成後の更新は `bot::channel` トピックへ配信されない
- メッセージ削除（`message::MessageDeleted`）は GLOBAL トピックのみのため、Bot には届かない（削除した結果を自分で受け取ることも無い）
- システムメッセージ（`isSystemMessage: true` / `content` は JSON 文字列）も `message` に流れる。応答する Bot は `msg.isSystemMessage` で弾く
- WS 受信可能チャンネル = 閲覧可能チャンネル、送信可能チャンネル = 参加チャンネル。参加未満のチャンネルには `message` は流れても送信は 400
- SQLite 書き込み競合があるため連投は避ける。サーバー全体のレート制限が `/ext` に適用される場合は 429 を GiracleApiError で受け取る
