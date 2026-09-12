import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... BOT_USER_ID=... bun run example/ping.ts
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
  botUserId: process.env.BOT_USER_ID, // 自己判定を確実にするため設定推奨
});

bot.on("message", (msg) => {
  if (!bot.remoteUserId || msg.userId === bot.remoteUserId || msg.isBot) return;
  if (msg.content.trim() !== "/ping") return;

  bot.sendMessage(msg.channelId, "pong").catch(console.error);
});

bot.on("error", console.error);

console.log("started");
bot.start();
