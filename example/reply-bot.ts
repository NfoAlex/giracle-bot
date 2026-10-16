import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... bun run example/reply-bot.ts
// メンション（@<botUserId>）されると inbox イベントが届く
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.on("inbox", (item) => {
  // メンションに対して返信する
  bot
    .sendMessage(item.message.channelId, "呼んだ？", item.message.id)
    .catch(console.error);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
