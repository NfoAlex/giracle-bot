import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... bun run example/echo.ts
// Bot 自身の HTTP 送信は WS 配信されないため、自己送信ガードは不要。
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.on("message", (msg) => {
  // システムメッセージ（入退室等）には応答しない
  if (msg.isSystemMessage) return;

  bot.sendMessage({ channelId: msg.channelId, message: `echo: ${msg.content}` }).catch(console.error);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

console.log("started");
bot.start();
