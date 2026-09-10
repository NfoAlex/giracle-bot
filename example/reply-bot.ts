import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... BOT_USER_ID=... bun run example/reply-bot.ts
// BOT_USER_ID が無いとメンション判定ができない
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
  botUserId: process.env.BOT_USER_ID,
});

bot.on("message", (msg) => {
  if (msg.userId === bot.remoteUserId) return;
  if (!bot.remoteUserId) return;

  const mention = `@${bot.remoteUserId}`;
  if (!msg.content.includes(mention)) return;

  const body = msg.content.replaceAll(mention, "").trim() || "(無言)";

  bot.sendMessage(msg.channelId, `呼んだ？ ${body}`, msg.id);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
