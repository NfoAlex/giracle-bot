import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... bun run example/ping.ts
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.on("message", (msg) => {
  if (msg.isSystemMessage) return;
  if (msg.content.trim() !== "/ping") return;

  bot.sendMessage(msg.channelId, "pong").catch(console.error);
});

bot.on("error", console.error);

console.log("started");
bot.start();
