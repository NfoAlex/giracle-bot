import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... bun run example/edit-watcher.ts
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.on("messageUpdate", (update) => {
  // 編集による部分行。isEdited は常に true
  console.log("message edited:", update.id, update.channelId, update.content);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
