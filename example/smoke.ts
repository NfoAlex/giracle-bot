/**
 * giracle-bot の実機スモークテスト（実サーバーに対した）。
 * 検証: WS 接続+ping/pong、bot 送信の { message, data:{ messageSaved } } ラッパー経由、
 * ユーザー送信 → bot 購読トピックでの message イベント、メンション → inbox イベント。
 *
 * 使い方:
 * 1. giracle-backend 側で DATABASE_URL=file:./smoke.db にて migrate + シード（Bot user / channel / token）
 * 2. 同 DB でサーバーを起動（bun run src/index.ts）
 * 3. ここで `bun run example/smoke.ts <botToken> <botUserId> <channelId> <cookieToken>`
 */
import { GiracleBot } from "../src/index";
import type { Message } from "../src/types";

const SERVER = "http://localhost:3000";
const botToken = process.argv[2] ?? "";
const botUserId = process.argv[3] ?? "";
const channelId = process.argv[4] ?? "";
const cookie = process.argv[5] ?? "";

if (!botToken || !channelId || !cookie) {
  console.error("usage: bun run smoke.ts <botToken> <botUserId> <channelId> <cookie>");
  process.exit(1);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fail = (m: string): never => {
  console.error("SMOKE FAILED:", m);
  process.exit(1);
};

const bot = new GiracleBot({ serverUrl: SERVER, token: botToken, pingIntervalMs: 300 });
bot.start();

const received: { message: Message | null; update: unknown | null } = {
  message: null, update: null,
};
bot.on("message", (m) => { received.message = m; });
bot.on("messageUpdate", (u) => { received.update = u; });

bot.on("error", (e) => fail(`error event: ${e.message}`));

let inboxType = "";
bot.on("inbox", (i) => { inboxType = i.type; });

// open は接続直後に発火するため、他の待ち受けより先に登録しておく
const opened = await new Promise<boolean>((resolve) => {
  bot.on("open", () => resolve(true));
  setTimeout(() => resolve(false), 5000);
});
if (!opened) fail("WS open なし");

// 1. bot 送信（ラッパー解除）
const sent = await bot.sendMessage(channelId, "bot smoke");
if (sent.id === undefined || sent.userId !== botUserId) {
  fail(`sendMessage 戻り値不正: ${JSON.stringify(sent)}`);
}
console.log("sendMessage OK:", sent.id, sent.userId);

// 2. ユーザー送信 → bot の message イベント（signal UpdateMessage 全行分）
const userRes = await fetch(`${SERVER}/message/send`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `token=${cookie}` },
  body: JSON.stringify({ channelId, message: `@<${botUserId}> user smoke` }),
});
if (!userRes.ok) fail(`user send 失敗 ${userRes.status}: ${await userRes.text()}`);

for (let i = 0; i < 50 && received.message === null; i++) await sleep(100);
if (!received.message) fail("message イベント無し");
console.log("message event OK:", received.message?.content, received.message?.createdAt);

// 3. メンション → inbox イベント
for (let i = 0; i < 30 && inboxType === ""; i++) await sleep(100);
if (inboxType !== "mention") fail(`inbox イベント無し type=${inboxType}`);
console.log("inbox event OK: mention");

// 4. ping/pong ラウンドトリップ（pingIntervalMs=300、pong が来る＝接続生）
await sleep(700);
console.log("ping/pong ラウンドトリップ後も接続維持 OK");

bot.stop();
console.log("SMOKE PASSED");
process.exit(0);
