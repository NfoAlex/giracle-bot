import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... CHANNEL_ID=... bun run example/delete-bot.ts
// Bot の送信は WS に流れないため、削除対象の id は sendMessage の戻り値から取る。
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.on("open", async () => {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;

  const sent = await bot.sendMessage(channelId, "この投稿はすぐ消える");
  const deleted = await bot.deleteMessage(sent.id);
  console.log("deleted:", deleted.id, deleted.channelId);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
