/**
 * giracle-bot の実機スモークテスト（実サーバーに対した）。
 * 検証: WS 接続+ping/pong、bot 送信の { message, data:{ messageSaved } } ラッパー経由と
 * 「Bot 自身の送信は WS 配信されない」こと、ユーザー送信 → bot 購読トピックでの message イベント、
 * メンション → inbox イベント。
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
// 関数宣言にしないと never による絞り込みが効かない（userMsg 以降の undefined 検査）
function fail(m: string): never {
  console.error("SMOKE FAILED:", m);
  process.exit(1);
}

const bot = new GiracleBot({
  serverUrl: SERVER,
  token: botToken,
  pingIntervalMs: 300,
  reconnectBaseMs: 50,
});
bot.start();

const messages: Message[] = [];
const received: { update: unknown | null } = { update: null };
bot.on("message", (m) => { messages.push(m); });
bot.on("messageUpdate", (u) => { received.update = u; });

bot.on("error", (e) => fail(`error event: ${e.message}`));

let inboxType = "";
bot.on("inbox", (i) => { inboxType = i.type; });

// open は接続直後に発火するため、他の待ち受けより先に登録しておく。
// 2 回目以降の open は「切断 → 再接続」を意味する（step 4 の liveness 検証に使う）
let openCount = 0;
const opened = await new Promise<boolean>((resolve) => {
  bot.on("open", () => {
    openCount += 1;
    resolve(true);
  });
  setTimeout(() => resolve(false), 5000);
});
if (!opened) fail("WS open なし");

// 1. bot 送信（ラッパー解除）
const sent = await bot.sendMessage(channelId, "bot smoke");
if (sent.id === undefined || sent.userId !== botUserId) {
  fail(`sendMessage 戻り値不正: ${JSON.stringify(sent)}`);
}
console.log("sendMessage OK:", sent.id, sent.userId);

// Bot 自身の送信が WS 配信されないこと（自己送信フィルタを削除した根拠）を確かめる。
// 配信されるなら user 送信より先にここで message が埋まる
await sleep(500);
if (messages.length > 0) {
  fail(`bot 自身の送信が WS 配信された: ${JSON.stringify(messages[0])}`);
}

// 2. ユーザー送信 → bot の message イベント（signal UpdateMessage 全行分）
const userRes = await fetch(`${SERVER}/message/send`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie: `token=${cookie}` },
  body: JSON.stringify({ channelId, message: `@<${botUserId}> user smoke` }),
});
if (!userRes.ok) fail(`user send 失敗 ${userRes.status}: ${await userRes.text()}`);

for (let i = 0; i < 50 && !messages.some((m) => m.userId !== botUserId); i++) await sleep(100);
const userMsg = messages.find((m) => m.userId !== botUserId);
if (!userMsg) fail("message イベント無し");
console.log("message event OK:", userMsg.content, userMsg.createdAt);

// 3. メンション → inbox イベント
for (let i = 0; i < 30 && inboxType === ""; i++) await sleep(100);
if (inboxType !== "mention") fail(`inbox イベント無し type=${inboxType}`);
console.log("inbox event OK: mention");

// 4. ping/pong ラウンドトリップ。pong が 2 周期途切れると liveness 切断 → 再接続するため、
//    接続維持できていれば open は 1 回のままになる
await sleep(1200); // 3 周期(900ms) + 再接続バックオフ 50ms より長い
if (openCount !== 1) fail(`pong 無応答で再接続した (open ${openCount} 回)`);

// 遅れて届いた自己送信も見逃さない（step 1 の早期チェックは 500ms 窓しか見ていない）
const selfEcho = messages.find((m) => m.userId === botUserId);
if (selfEcho) fail(`bot 自身の送信が WS 配信された: ${JSON.stringify(selfEcho)}`);
console.log("ping/pong ラウンドトリップ後も接続維持 OK");

bot.stop();
console.log("SMOKE PASSED");
process.exit(0);
