import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... BOT_USER_ID=... bun run example/echo.ts
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
  botUserId: process.env.BOT_USER_ID, // 省略時は初回 sendMessage から自動キャッシュ
});

bot.on("message", (msg) => {
  // 自己送信は無視（echo の無限ループ防止）
  if (msg.userId === bot.remoteUserId) return;

  bot.sendMessage(msg.channelId, `echo: ${msg.content}`);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

console.log("started");
bot.start();
