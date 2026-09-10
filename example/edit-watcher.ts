import { GiracleBot } from "../src/index";

// 実行: BOT_TOKEN=... BOT_USER_ID=... bun run example/edit-watcher.ts
const bot = new GiracleBot({
  serverUrl: process.env.SERVER_URL ?? "http://localhost:3000",
  token: process.env.BOT_TOKEN ?? "",
  botUserId: process.env.BOT_USER_ID,
});

bot.on("messageUpdate", (update) => {
  // URL プレビュー生成による更新は isEdited が false のまま
  if (!update.isEdited) return;

  // 編集されたメッセージに対して反応する例
  // 実際に返信する場合は channelId が必要だが、UpdateMessage には含まれないことがある
  console.log("message edited:", update.id, update.content);
});

bot.on("error", (err) => {
  console.error("bot error:", err);
});

bot.start();
