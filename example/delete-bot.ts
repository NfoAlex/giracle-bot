import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... CHANNEL_ID=... bun run example/delete-bot.ts
// Bot の送信は WS に流れないため、削除対象の id は sendMessage の戻り値から取る。
// open は再接続の度に発火する。一度だけ実行したい処理は once を使う（on だと再接続で再送される）。
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
});

bot.once("open", async () => {
  const channelId = process.env.CHANNEL_ID;
  if (!channelId) return;

  try {
    const sent = await bot.sendMessage({ channelId, message: "この投稿はすぐ消える" });
    const deleted = await bot.deleteMessage({ messageId: sent.id });
    console.log("deleted:", deleted.id, deleted.channelId);
  } catch (err) {
    console.error("bot error:", err);
  }
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
