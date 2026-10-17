import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... CHANNEL_ID=... bun run example/edit-bot.ts
// Bot の送信は WS に流れないため、編集対象の id は sendMessage の戻り値から取る。
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.on("open", async () => {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;

  const sent = await bot.sendMessage(channelId, "編集中…");
  const edited = await bot.editMessage(sent.id, "編集後");
  console.log("edited:", edited.id, edited.content, edited.isEdited);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
