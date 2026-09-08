# giracle-bot

Giracle サーバー向け Bot フレームワーク（Bun ランタイム用、依存ゼロ）。

```text
Bot (Bun) ──HTTP──→ /ext/message/...   Authorization: <tokenCode>
          ←─WS──── /ws                 signal: message::SendMessage 等
```

## セットアップ

1. Bun をインストール（`https://bun.sh`）
2. `bun install`
3. Bot の登録は管理者経由のみ: 管理者に `BotManage` 行を作成してもらい、`tokenCode`（UUID）と `remoteUserId` を受け取る。`approveStatus` が `APPROVED` になるまで接続は 401 になる。チャンネルごとの許可（`botChannelPermissions`）も管理者に依頼すること。

## 使い方

```ts
import { GiracleBot } from "giracle-bot";

const bot = new GiracleBot({
  serverUrl: "http://localhost:3000",
  token: process.env.BOT_TOKEN!, // BotManage.tokenCode
  botUserId: process.env.BOT_USER_ID, // 省略可。初回 sendMessage 成功時に自動キャッシュ
});

bot.on("message", (msg) => {
  // remoteUserId が確定している間は自己送信がフレームワーク側でフィルタされるが、
  // 確定前は流れるのでガードしておくのが安全（echo 無限ループ防止）
  if (msg.userId === bot.remoteUserId) return;

  bot.sendMessage(msg.channelId, `echo: ${msg.content}`);
});

bot.start();
```

実行: `bun run example/echo.ts`

## API

| メソッド | 説明 |
| --- | --- |
| `getMessage(messageId)` | メッセージ 1 件取得 |
| `sendMessage(channelId, message, replyingMessageId?)` | 送信 |
| `editMessage(targetMessageId, message)` | 編集 |

エラーは `GiracleApiError`（`status` / `body` を保持）。文言での分岐はしないこと（status code のみで判定）。

## イベント

| イベント | ペイロード | 説明 |
| --- | --- | --- |
| `message` | `Message` | 新規メッセージ（自己送信は `remoteUserId` 確定後にフィルタ） |
| `messageUpdate` | `Message` 差分 | 編集 / URL プレビュー生成後の更新。`isEdited` で判別 |
| `inbox` | `InboxAdded` | inbox::Added |
| `error` | `Error` | HTTP/WS エラー。`ERROR` signal（トークン無効・未承認）受信時は**再接続しない** |
| `close` | なし | `stop()` または fatal エラーによる終了 |

WS は異常切断時に 1 秒から指数バックオフ（上限 60 秒）で自動再接続。ping は 30 秒間隔で自動送信。

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

- echo ボットは必ず自己送信ガードを入れる（上記サンプル参照）
- `send` 直後に URL プレビュー生成で `messageUpdate` が飛ぶ。編集と誤認しない（`isEdited` で判別）
