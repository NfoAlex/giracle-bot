import { GiracleBot } from "../src/index";
import { GiracleApiError } from "../src/errors";

// 実行: BOT_TOKEN=... BOT_USER_ID=... bun run example/delete-bot.ts
// BOT_USER_ID が無いと自己判定ができないため必須
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
  botUserId: process.env.BOT_USER_ID,
});

// !say <text> → Bot が告知を投稿
// Bot のメッセージに !del でリプライ → そのメッセージを削除
bot.on("message", async (msg) => {
  if (!bot.remoteUserId || msg.userId === bot.remoteUserId) return;

  if (msg.content.startsWith("!say ")) {
    const body = msg.content.slice("!say ".length).trim();
    if (body.length === 0) return;
    await bot.sendMessage(msg.channelId, body).catch(report);
    return;
  }

  // リプライ先が Bot 自身のメッセージなら削除
  if (msg.content.trim() === "!del" && msg.replyingMessageId) {
    const target = await bot.getMessage(msg.replyingMessageId).catch(() => null);
    if (!target || target.userId !== bot.remoteUserId) return;

    await bot.deleteMessage(target.id).then(
      () => console.log(`deleted: ${target.id}`),
      report,
    );
  }
});

function report(err: unknown) {
  if (err instanceof GiracleApiError) {
    console.error(`API error ${err.status}: ${err.body}`);
  } else {
    console.error("bot error:", err);
  }
}

bot.on("error", report);
console.log("started");
bot.start();
