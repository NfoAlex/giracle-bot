---
name: giracle-bot
description: Giracle Bot フレームワーク（Bun / src/index.ts の GiracleBot）で Bot を新規作成・修正するときの実装手順と落とし穴。新しい Bot の作成、コマンド/返信/編集監視/削除の実装、イベントハンドラ追加、モックテストや実機確認を依頼されたときに使用する。
---

# Giracle Bot を作る

Bun 専用・依存ゼロのクライアントライブラリ。Bot は `/ext`（HTTP）で投稿・編集・削除し、`/ws` で `message::SendMessage` 等を受信する。**登録・承認・チャンネル許可の API は存在しない**（管理者が `BotManage` 行と `botChannelPermissions` を直接作る）。フレームワークがやるのは token 認証・受信 signal の正規化・自己送信フィルタ・自動再接続まで。

## 0. 作業前に必ず読む

| 読むもの | 得られるもの |
| --- | --- |
| `src/types.ts` | イベント名・ペイロード型の唯一の正。推測でイベント名を書かない |
| `example/echo.ts` `example/reply-bot.ts` `example/delete-bot.ts` `example/edit-watcher.ts` | 動く雛形。新規 Bot はこのどれかを土台にする |
| `test/bot.test.ts` `test/mockWebSocket.ts` | 実サーバー無しで検証するための注入方法 |

フレームワーク自体（`src/`）は変更しない。Bot の実装は `example/` か利用側プロジェクトのエントリ 1 ファイルに閉じる。

## 1. API 表面（これ以上は無い）

```ts
const bot = new GiracleBot({
  serverUrl: "http://localhost:3000", // 末尾スラッシュ可、http→ws は内部変換
  token: process.env.BOT_TOKEN!,      // BotManage.tokenCode。Bearer 不要、生値を Authorization に載せる
  botUserId: process.env.BOT_USER_ID, // 省略可。強く推奨（後述）
  // テスト用: fetchImpl / WebSocketImpl / pingIntervalMs / reconnectBaseMs / reconnectMaxMs
});

bot.start();                       // WS 接続開始（戻り値なし、非同期の完了通知もない）
bot.stop();                        // 明示停止 + close イベント
bot.remoteUserId;                  // string | undefined。botUserId 未指定なら初回 sendMessage 成功時に確定

await bot.getMessage(messageId);                       // Message
await bot.sendMessage(channelId, content, replyId?);   // Message（送信結果）
await bot.editMessage(targetMessageId, content);       // EditResult
await bot.deleteMessage(targetMessageId);              // DeleteResult（自分の送信分のみ可）
```

イベント（`bot.on(name, handler)`）:

| イベント | ペイロード | 注意 |
| --- | --- | --- |
| `message` | `Message` | 新規投稿。**自己送信は `remoteUserId` 確定後のみ**フレームワークが除外 |
| `messageUpdate` | `Partial<Message> & { id: string }` | 編集 と URL プレビュー生成の両方で飛ぶ。`isEdited === true` で判別 |
| `inbox` | `{ message, type }` | `inbox::Added` |
| `error` | `Error` | HTTP 失敗 / WS `ERROR` signal / 異常切断 |
| `close` | なし | `stop()` または `ERROR` signal 後 |

無い機能: チャンネル一覧、ユーザー一覧、リアクション、タイピング、削除の受信（Bot は `GLOBAL` を購読しないため `message::MessageDeleted` は届かない）。必要になったら「フレームワークのスコープ外」と報告する。

## 2. ゴールデンパス

```ts
import { GiracleBot } from "giracle-bot";
import { GiracleApiError } from "giracle-bot";

const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN!,
  botUserId: process.env.BOT_USER_ID, // 自己判定を確実にするため必ず設定
});

bot.on("message", async (msg) => {
  if (!bot.remoteUserId) return;                       // 身元未確定なら何もしない（安全側）
  if (msg.userId === bot.remoteUserId) return;         // 自己送信ガード（ループ防止・必須）
  if (msg.isBot) return;                               // Bot 同士の応酬を避けるなら

  if (msg.content.trim() !== "!ping") return;
  await bot.sendMessage(msg.channelId, "pong").catch(report);
});

bot.on("error", (err) => console.error("bot error:", err));
bot.start();

function report(err: unknown) {
  if (err instanceof GiracleApiError) console.error(`API error ${err.status}: ${err.body}`);
  else console.error(err);
}
```

実行: `SERVER_URL=... BOT_TOKEN=... BOT_USER_ID=... bun run <file>`

## 3. 落とし穴（ここを外すと本番で壊れる）

1. **自己送信ガードは必須。** `message::SendMessage` は Bot 自身の HTTP 送信でも配信される。`botUserId` 未指定の間は `remoteUserId === undefined` でフィルタが無効なので、echo 型 Bot は無限ループする。`botUserId` を設定し、かつ `if (!bot.remoteUserId) return;` を先頭に置く。
2. **`messageUpdate` を編集と決め打ちしない。** `send`/`edit` 直後の URL プレビュー生成でも飛ぶ。`update.isEdited` を見る。また差分ペイロードに `channelId` が無いことがある → 返信したいなら `await bot.getMessage(update.id)` で完全な `Message` を取り直す。
3. **エラー分岐は `err.status` のみ。** `err.body` の文言はサーバー実装依存。401 = token 不正 or 未承認、403 = `can*` 権限不足 / チャンネル未許可 / 他人のメッセージ、404 = 存在しない or 許可外、400 = 空・長すぎ・返信先なし・同内容編集。文言で `if (body.includes(...))` を書かない。
4. **削除前に所有者確認。** `deleteMessage` は自分の送信分しか消せない（他人のは 403）。`example/delete-bot.ts` のように `getMessage` して `userId === bot.remoteUserId` を確認してから消す。
5. **`ERROR` signal は fatal。** 再接続しない（`error` → `close`）。401 が続く場合は token か承認状態を疑い、コードではなく運用（管理者への確認）を促す。
6. **HTTP 例外は投げっぱなし。** `sendMessage` 等は reject する。`await ... .catch(report)` か `try/catch` を必ず付ける。素の `void bot.sendMessage(...)` は unhandled rejection になる。
7. **送信前バリデーション。** 空白のみ / 長すぎはサーバーが 400 を返す。ユーザー入力をそのまま送らず `trim()` し、`startsWith("!cmd")` 系は空ボディを弾く。
8. **メンションは `@<userId>` 文字列。** 通知はサーバー側処理済み。`replaceAll(\`@${bot.remoteUserId}\`, "")` で本文を抽出（`example/reply-bot.ts`）。
9. **Bun 専用・依存ゼロ。** `fetch` / `WebSocket` はネイティブ。npm パッケージを足さない。Node API 前提のライブラリ（`ws`, `node-fetch` 等）も不要。
10. **SQLite 書き込み競合。** 連投・全チャンネル一斉送信は避ける。必要なら Bot 側で送信間隔を空ける（フレームワークに連投抑制は無い）。

## 4. 実装パターン

- **コマンド**: `const [cmd, ...rest] = msg.content.trim().split(/\s+/);` → `switch (cmd)`。未知コマンドは無視。
- **返信**: `bot.sendMessage(msg.channelId, body, msg.id)` で `replyingMessageId` を渡す。
- **編集監視**: `messageUpdate` + `isEdited`。チャンネルへ返す必要があるなら `getMessage(update.id)`。
- **モデレーション削除**: `getMessage` で所有者・内容を確認 → `deleteMessage`。
- **チャンネル別挙動**: ハンドラ内で `msg.channelId` を判定する（購読フィルタは無い）。

## 5. 検証（実機を立てる前にここまで）

**型・既存テスト（必須）**

```sh
bunx tsc --noEmit && bun test
```

**モックでハンドラを検証**（実サーバー不要）。`fetchImpl` と `WebSocketImpl` を注入する。

```ts
import type { BotOptions } from "../src/types"; // 利用側プロジェクトなら "giracle-bot"
import { GiracleBot } from "../src";
import { MockWebSocket, makeMessage } from "../test/mockWebSocket";

const fetchImpl = (async (_input: unknown) =>
  new Response(JSON.stringify(makeMessage({ userId: "bot-1" })), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const bot = new GiracleBot({
  serverUrl: "http://x", token: "t", botUserId: "bot-1", fetchImpl,
  WebSocketImpl: MockWebSocket as unknown as BotOptions["WebSocketImpl"],
});
bot.start();
const ws = MockWebSocket.instances.at(-1)!;
ws.open();
ws.receive(JSON.stringify({ signal: "message::SendMessage", data: makeMessage({ userId: "alice", content: "!ping" }) }));
// → ハンドラの副作用（ws.sent / 送信回数）を assert する
```

**実機スモーク（サーバーと token がある場合のみ）**: Bot を起動 → 通常ユーザーで対象チャンネルに投稿 → 期待応答を目視 → `stop()`。サーバーが無い／token が無い場合は「実機未検証」と明記して報告する（推測で動いたと言わない）。

## 6. 完了チェックリスト

- [ ] イベント名・型を `src/types.ts` と照合した
- [ ] 全ハンドラの先頭に自己送信ガード（`!bot.remoteUserId` → `userId === bot.remoteUserId`）
- [ ] `error` ハンドラを登録し、HTTP 例外を catch した
- [ ] `err.status` で分岐（文言に依存していない）
- [ ] `messageUpdate` は `isEdited` を確認している
- [ ] 新規依存を追加していない
- [ ] `bunx tsc --noEmit && bun test` が通る
- [ ] 実機確認の有無と結果を報告に書いた
