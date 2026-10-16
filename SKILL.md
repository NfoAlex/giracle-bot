name: giracle-bot
description: Giracle Bot フレームワーク（Bun / src/index.ts の GiracleBot）で Bot を新規作成・修正するときの実装手順と落とし穴。新しい Bot の作成、コマンド/返信/編集監視の実装、イベントハンドラ追加、モックテストや実機確認を依頼されたときに使用する。
---

# Giracle Bot を作る

Bun 専用・依存ゼロのクライアントライブラリ。Bot は `POST /ext/message/send`（HTTP）で投稿し、`/ext/ws` で `message::UpdateMessage` 等を受信する。**登録・承認・チャンネル参加はサーバー側の管理 API / 通常ユーザー API）で行う**（フレームワークは登録フローを持たない）。フレームワークがやるのは token 認証・受信 signal の正規化・自動再接続まで。

## 0. 作業前に必ず読む

| 読むもの | 得られるもの |
| --- | --- |
| `src/types.ts` | イベント名・ペイロード型の唯一の正。推測でイベント名を書かない |
| `example/echo.ts` `example/reply-bot.ts` `example/edit-watcher.ts` `example/ping.ts` | 動く雛形。新規 Bot はこのどれかを土台にする |
| `test/bot.test.ts` `test/mockWebSocket.ts` | 実サーバー無しで検証するための注入方法 |

フレームワーク自体（`src/`）は変更しない。Bot の実装は `example/` か利用側プロジェクトのエントリ 1 ファイルに閉じる。

## 1. API 表面（これ以上は無い）

```ts
const bot = new GiracleBot({
  serverUrl: "http://localhost:3000", // 末尾スラッシュ可、http→ws は内部変換
  token: process.env.BOT_TOKEN!,      // BotManage.tokenCode。Bearer 不要、生値を Authorization に載せる
  // テスト用: fetchImpl / WebSocketImpl / pingIntervalMs / reconnectBaseMs
});

bot.start();                       // WS 接続開始（戻り値なし、非同期の完了通知もない）
bot.stop();                        // 明示停止 + close イベント

await bot.sendMessage(channelId, content, replyId?);   // Message（送信結果）
```

Bot 用 HTTP API は **send の 1 つのみ**。編集・削除・取得は `/ext` に存在しない。

イベント（`bot.on(name, handler)`）:

| イベント | ペイロード | 注意 |
| --- | --- | --- |
| `message` | `Message` | 新規投稿（signal 名は `message::UpdateMessage`）。**Bot 自身の送信は配信されない**ため自己送信ガード不要。システムメッセージも含む |
| `messageUpdate` | `MessageUpdate` | 編集のみ。`{ id, channelId, userId, content, isEdited: true }` の部分行 |
| `inbox` | `{ message, type }` | Bot ユーザーがメンション（type `mention`）・返信（type `reply`）されたとき |
| `error` | `Error` | WS `ERROR` signal の受信時のみ（fatal。`close` も続けて発火）。HTTP 失敗は `sendMessage` の reject なので catch する |
| `close` | なし | `stop()` または `ERROR` signal 後 |

無い機能: メッセージ編集・削除（Bot API に無い）、リアクション、タイピング、削除の受信（Bot は `GLOBAL` を購読しないため `message::MessageDeleted` は届かない）、URL プレビューの更新配信。必要になったら「フレームワークのスコープ外」と報告する。

## 2. ゴールデンパス

```ts
import { GiracleBot } from "giracle-bot";
import { GiracleApiError } from "giracle-bot";

const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN!,
});

bot.on("message", (msg) => {
  if (msg.isSystemMessage) return;                     // 入退室等のシステムメッセージ

  if (msg.content.trim() !== "!ping") return;
  bot.sendMessage(msg.channelId, "pong").catch(report);
});

bot.on("error", (err) => console.error("bot error:", err));
bot.start();

function report(err: unknown) {
  if (err instanceof GiracleApiError) console.error(`API error ${err.status}: ${err.body}`);
  else console.error(err);
}
```

実行: `SERVER_URL=... BOT_TOKEN=... bun run <file>`

## 3. 落とし穴（ここを外すと本番で壊れる）

1. **send にはチャンネル参加が必須。** 対象チャンネルに Bot ユーザーが参加していないと 400（`You are not joined this channel`）。参加は作成者が通常ユーザー API で行う。一方 `message` の受信は「閲覧可能」なチャンネル（ロールの可視設定）に及ぶので、受信できても送信できるとは限らない。
2. **`message` の signal 名は `message::UpdateMessage`。** サーバーは新規メッセージも bot 購読トピックには Update として流す。フレームワークが createdAt の有無で振り分けるため、利用側はイベント名だけ見ればよい。
3. **エラー分岐は `err.status` のみ。** `err.body` の文言はサーバー実装依存。400 = Bot 無効（`Bot is not enabled`）・空・長すぎ・未参加・返信先なし、401 = token 不正 / 未承認 / 無効化。文言で `if (body.includes(...))` を書かない。
4. **`ERROR` signal は fatal。** 再接続しない（`close` → `error`）。原因はトークン無効・未承認・無効化など。401 が続く場合は token か承認状態を疑い、コードではなく運用（管理者への確認）を促す。
5. **HTTP 例外は投げっぱなし。** `sendMessage` は reject する。`await ... .catch(report)` か `try/catch` を必ず付ける。
6. **送信前バリデーション。** 空白のみ / 長すぎはサーバーが 400 を返す。ユーザー入力をそのまま送らず `trim()` し、`startsWith("!cmd")` 系は空ボディを弾く。
7. **メンションは `@<userId>` 文字列。** 自分へのメンション検知は `inbox` イベントで受けるのが確実（本文の mention 判定には Bot の userId を知る必要がある）。メンション通知はチャンネル参加者が送った場合のみ来る。
8. **Bun 専用・依存ゼロ。** `fetch` / `WebSocket` はネイティブ。npm パッケージを足さない。Node API 前提のライブラリ（`ws`, `node-fetch` 等）も不要。
9. **SQLite 書き込み競合。** 連投・全チャンネル一斉送信は避ける。必要なら Bot 側で送信間隔を空ける。
10. **システムメッセージを応答対象にしない。** `isSystemMessage: true`（`content` は JSON 文字列）が `message` に流れる。`if (msg.isSystemMessage) return;` をガードに足す。
11. **Bot 送信は他 Bot / 自分へ配信されない。** `/ext` の送信は WS へ publish しないため、Bot 同士・自分自身の echo ループは起きない。その代わり自分の投稿を `message` イベントからは追えない。

## 4. 実装パターン

- **コマンド**: `const [cmd, ...rest] = msg.content.trim().split(/\s+/);` → `switch (cmd)`。未知コマンドは無視。
- **返信**: `bot.sendMessage(msg.channelId, body, msg.id)` で `replyingMessageId` を渡す。
- **メンション応答**: `inbox` イベントで `item.message` に反応する（`example/reply-bot.ts`）。
- **編集監視**: `messageUpdate`。内容が要るなら部分行の `content` を使う（最新全体が必要ならメッセージ取得 API は Bot に無いので、WS の `message` と照合して自分で持つ）。
- **チャンネル別挙動**: ハンドラ内で `msg.channelId` を判定する（購読フィルタは無い）。

## 5. 検証（実機を立てる前にここまで）

**型・既存テスト（必須）**

```sh
bunx tsc --noEmit && bun test
```

**モックでハンドラを検証**（実サーバー不要）。`fetchImpl` と `WebSocketImpl` を注入する。

```ts
import { GiracleBot } from "../src";
import { MockWebSocket, makeMessage } from "../test/mockWebSocket";

const fetchImpl = (async (_input: unknown) =>
  new Response(JSON.stringify({ message: "Sent message", data: makeMessage() }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })) as typeof fetch;

const bot = new GiracleBot({ serverUrl: "http://x", token: "t", fetchImpl, WebSocketImpl: MockWebSocket });
bot.start();
const ws = MockWebSocket.instances.at(-1)!;
ws.open();
ws.receive(JSON.stringify({ signal: "message::UpdateMessage", data: makeMessage({ userId: "alice", content: "!ping" }) }));
// → ハンドラの副作用（ws.sent / 送信回数）を assert する
```

**実機スモーク（サーバーと token がある場合のみ）**: Bot を起動 → 通常ユーザーで対象チャンネルに投稿 → 期待応答を目視 → `stop()`。サーバーが無い／token が無い場合は「実機未検証」と明記して報告する（推測で動いたと言わない）。

## 6. 完了チェックリスト

- [ ] イベント名・型を `src/types.ts` と照合した
- [ ] `message` ハンドラの先頭に `isSystemMessage` ガード
- [ ] `error` ハンドラを登録し、HTTP 例外を catch した
- [ ] `err.status` で分岐（文言に依存していない）
- [ ] 送信先チャンネルに Bot ユーザーが参加している前提を確認した
- [ ] 新規依存を追加していない
- [ ] `bunx tsc --noEmit && bun test` が通る
- [ ] 実機確認の有無と結果を報告に書いた
