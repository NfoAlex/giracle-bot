import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GiracleBot } from "../src/bot";
import type { BotOptions } from "../src/types";
import { makeMessage, MockWebSocket, latestMock } from "./mockWebSocket";

const SERVER = "http://localhost:3000";
const TOKEN = "tok-1";

let bot: GiracleBot | null = null;

beforeEach(() => {
  MockWebSocket.instances = [];
});

afterEach(() => {
  bot?.removeAllListeners();
  bot?.stop();
  bot = null;
  MockWebSocket.instances = [];
});

/** fetch モック: POST /ext/message/send に固定の返信（userId=replyUser）を返す */
function okFetch(
  replyMessage = makeMessage({ userId: "alice" }),
): typeof fetch {
  return (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/ext/message/send")) {
      return new Response(JSON.stringify(replyMessage), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("not found", { status: 404 });
  }) as typeof fetch;
}

/** WebSocketImpl を必ず Mock に差し込んで生成するヘルパー */
function newBot(over: Partial<BotOptions> = {}): GiracleBot {
  return new GiracleBot({
    serverUrl: SERVER,
    token: TOKEN,
    WebSocketImpl: MockWebSocket as unknown as BotOptions["WebSocketImpl"],
    ...over,
  });
}

describe("GiracleBot", () => {
  test("start 後、他ユーザーの message::SendMessage で message イベント発火", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: makeMessage({ id: "m2", userId: "other" }),
      }),
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as { id: string }).id).toBe("m2");
  });

  test("botUserId 一致の自己送信は message イベントを発火しない", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: makeMessage({ userId: "me" }),
      }),
    );

    expect(messages).toHaveLength(0);
  });

  test("botUserId 未設定: sendMessage 成功の userId が remoteUserId にキャッシュされ、以後その signal はフィルタ", async () => {
    const b = newBot({ fetchImpl: okFetch() });
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    expect(b.remoteUserId).toBeUndefined();

    const sent = await b.sendMessage("c1", "hi");
    expect(sent.userId).toBe("alice");
    expect(b.remoteUserId).toBe("alice");

    // 自分（alice）の送信 → フィルタされる
    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: makeMessage({ userId: "alice" }),
      }),
    );
    // 他人 → emit される
    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: makeMessage({ userId: "bob" }),
      }),
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as { userId: string }).userId).toBe("bob");
  });

  test("自己 echo が HTTP レスポンスより先に届いても message は発火しない（identity race）", async () => {
    // send の応答を遅延させ、その間に自己 echo の signal が届く状況を作る
    let resolveSend: ((res: Response) => void) | undefined;
    const fetchImpl = ((input: unknown) => {
      if (!String(input).endsWith("/ext/message/send")) {
        return Promise.resolve(new Response("no", { status: 404 }));
      }

      return new Promise<Response>((r) => (resolveSend = r));
    }) as typeof fetch;
    const b = newBot({ fetchImpl });
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    const sent = b.sendMessage("c1", "hi");
    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: makeMessage({ userId: "alice", content: "hi" }),
      }),
    );

    // 未確定かつ送信中なので保留（まだ emit しない）
    expect(messages).toHaveLength(0);

    resolveSend?.(
      new Response(JSON.stringify(makeMessage({ userId: "alice" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await sent;

    expect(b.remoteUserId).toBe("alice");
    expect(messages).toHaveLength(0); // 保留分は自己送信と判定され捨てる
  });

  test("送信中に届いた他人の message は取りこぼさず、送信完了後に発火する", async () => {
    let resolveSend: ((res: Response) => void) | undefined;
    const fetchImpl = ((input: unknown) => {
      if (!String(input).endsWith("/ext/message/send")) {
        return Promise.resolve(new Response("no", { status: 404 }));
      }

      return new Promise<Response>((r) => (resolveSend = r));
    }) as typeof fetch;
    const b = newBot({ fetchImpl });
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    const sent = b.sendMessage("c1", "hi");
    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: makeMessage({ id: "m9", userId: "bob" }),
      }),
    );

    expect(messages).toHaveLength(0); // 保留中

    resolveSend?.(
      new Response(JSON.stringify(makeMessage({ userId: "alice" })), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await sent;

    expect(messages).toHaveLength(1); // 他人の分は emit される
    expect((messages[0] as { id: string }).id).toBe("m9");
  });

  test("messageUpdate / inbox のマッピング", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const updates: unknown[] = [];
    const inboxes: unknown[] = [];
    b.on("messageUpdate", (u) => updates.push(u));
    b.on("inbox", (i) => inboxes.push(i));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::UpdateMessage",
        data: { id: "m1", content: "edited", isEdited: true },
      }),
    );
    latestMock().receive(
      JSON.stringify({
        signal: "inbox::Added",
        data: { message: makeMessage({ id: "inbox-m" }), type: "mention" },
      }),
    );

    expect(updates).toEqual([{ id: "m1", content: "edited", isEdited: true }]);
    expect(inboxes).toHaveLength(1);
    expect((inboxes[0] as { type: string }).type).toBe("mention");
    expect((inboxes[0] as { message: { id: string } }).message.id).toBe(
      "inbox-m",
    );
  });

  test("WS ERROR signal → error イベント発火", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const errs: Error[] = [];
    b.on("error", (e) => errs.push(e));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "ERROR",
        data: "Authorization header is invalid",
      }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toBe("Authorization header is invalid");
  });

  test("stop() → close イベント発火", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    let closed = 0;
    b.on("close", () => (closed += 1));
    b.start();

    b.stop();

    expect(closed).toBe(1);
  });

  test("start() を 2 回呼んでもソケットは 1 個だけ", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    b.start();
    b.start();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("ERROR signal 後の stop() で close は合計 1 回", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    let closed = 0;
    b.on("error", () => {});
    b.on("close", () => (closed += 1));
    b.start();

    latestMock().receive(
      JSON.stringify({ signal: "ERROR", data: "unauthorized" }),
    );
    expect(closed).toBe(1);

    b.stop();
    expect(closed).toBe(1);
  });

  test("ERROR signal 時、error リスナー未登録でも throw せず console.error にフォールバック", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const original = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      logged.push(args);
    };

    try {
      b.start();

      expect(() =>
        latestMock().receive(
          JSON.stringify({ signal: "ERROR", data: "unauthorized" }),
        ),
      ).not.toThrow();
    } finally {
      console.error = original;
    }

    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain("giracle-bot: unhandled error:");
  });

  test("id 無しの message::UpdateMessage は messageUpdate を発火しない", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const updates: unknown[] = [];
    b.on("messageUpdate", (u) => updates.push(u));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::UpdateMessage",
        data: { content: "x" },
      }),
    );

    expect(updates).toHaveLength(0);
  });

  test("userId 無しの message::SendMessage は message を発火しない", () => {
    const b = newBot({ botUserId: "me" });
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::SendMessage",
        data: { id: "m", content: "x" },
      }),
    );

    expect(messages).toHaveLength(0);
  });
});
