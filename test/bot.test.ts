import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GiracleBot } from "../src/bot";
import type { BotOptions } from "../src/types";
import { makeMessage, makeUpdate, MockWebSocket, latestMock } from "./mockWebSocket";

const SERVER = "http://localhost:3000";
const TOKEN = "tok-1";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** WebSocketImpl を必ず Mock に差し込んで生成するヘルパー */
function newBot(over: Partial<BotOptions> = {}): GiracleBot {
  return new GiracleBot({
    serverUrl: SERVER,
    token: TOKEN,
    WebSocketImpl: MockWebSocket,
    ...over,
  });
}

describe("GiracleBot serverUrl 検証", () => {
  test("scheme 無し / 非対応 scheme は構築時に throw する", () => {
    expect(() => newBot({ serverUrl: "localhost:3000" })).toThrow();
    expect(() => newBot({ serverUrl: "httpx://h" })).toThrow();
  });

  test("http(s) / ws(s) は受理する（大文字 scheme 含む）", () => {
    for (const url of ["http://h", "https://h", "ws://h", "wss://h", "HTTP://h/"]) {
      expect(() => newBot({ serverUrl: url })).not.toThrow();
    }
  });
});

describe("GiracleBot", () => {
  test("WS 接続先は http→ws 変換 + 末尾スラッシュ正規化で ws://…/ext/ws", () => {
    const b = new GiracleBot({
      serverUrl: `${SERVER}/`,
      token: TOKEN,
      WebSocketImpl: MockWebSocket,
    });
    bot = b;

    b.start();

    expect(latestMock().url).toBe("ws://localhost:3000/ext/ws");
    expect(latestMock().options?.headers).toEqual({ Authorization: TOKEN });
  });

  test("他ユーザーの新規メッセージ（全行分 UpdateMessage）で message イベント発火", () => {
    const b = newBot();
    bot = b;
    const messages: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::UpdateMessage",
        data: makeMessage({ id: "m2", userId: "other" }),
      }),
    );

    expect(messages).toHaveLength(1);
    expect((messages[0] as { id: string }).id).toBe("m2");
    expect((messages[0] as { userId: string }).userId).toBe("other");
  });

  test("編集（部分行 UpdateMessage）は message ではなく messageUpdate で発火", () => {
    const b = newBot();
    bot = b;
    const messages: unknown[] = [];
    const updates: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.on("messageUpdate", (u) => updates.push(u));
    b.start();

    latestMock().receive(
      JSON.stringify({ signal: "message::UpdateMessage", data: makeUpdate({ id: "m3" }) }),
    );

    expect(messages).toHaveLength(0);
    expect(updates).toEqual([makeUpdate({ id: "m3" })]);
  });

  test("id 無しの UpdateMessage はイベントを発火しない", () => {
    const b = newBot();
    bot = b;
    const got: unknown[] = [];
    b.on("message", (m) => got.push(m));
    b.on("messageUpdate", (u) => got.push(u));
    b.start();

    latestMock().receive(
      JSON.stringify({ signal: "message::UpdateMessage", data: { content: "x" } }),
    );

    expect(got).toHaveLength(0);
  });

  test("createdAt 無しでも id + channelId + userId があれば部分行として messageUpdate", () => {
    const b = newBot();
    bot = b;
    const messages: unknown[] = [];
    const updates: unknown[] = [];
    b.on("message", (m) => messages.push(m));
    b.on("messageUpdate", (u) => updates.push(u));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "message::UpdateMessage",
        data: { id: "m4", channelId: "c1", userId: "u1", content: "x", isEdited: true },
      }),
    );

    expect(messages).toHaveLength(0);
    expect(updates).toHaveLength(1);
  });

  test("isEdited が真偽値でない部分行（id あり）は捨てられる", () => {
    const b = newBot();
    bot = b;
    const got: unknown[] = [];
    b.on("message", (m) => got.push(m));
    b.on("messageUpdate", (u) => got.push(u));
    b.start();

    // 文字列 / 数値の isEdited は部分行と認めない（壊れた payload を誤流用しない）
    latestMock().receive(
      JSON.stringify({
        signal: "message::UpdateMessage",
        data: { id: "m5", channelId: "c1", userId: "u1", content: "x", isEdited: "true" },
      }),
    );
    latestMock().receive(
      JSON.stringify({
        signal: "message::UpdateMessage",
        data: { id: "m6", channelId: "c1", userId: "u1", content: "x", isEdited: 1 },
      }),
    );

    expect(got).toHaveLength(0);
  });

  test("inbox::Added のマッピング（メンション）", () => {
    const b = newBot();
    bot = b;
    const inboxes: unknown[] = [];
    b.on("inbox", (i) => inboxes.push(i));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "inbox::Added",
        data: { message: makeMessage({ id: "inbox-m" }), type: "mention" },
      }),
    );

    expect(inboxes).toHaveLength(1);
    expect((inboxes[0] as { type: string }).type).toBe("mention");
    expect((inboxes[0] as { message: { id: string } }).message.id).toBe("inbox-m");
  });

  test("message 無しの inbox::Added は発火しない", () => {
    const b = newBot();
    bot = b;
    const inboxes: unknown[] = [];
    b.on("inbox", (i) => inboxes.push(i));
    b.start();

    latestMock().receive(JSON.stringify({ signal: "inbox::Added", data: { type: "mention" } }));

    expect(inboxes).toHaveLength(0);
  });

  test("type が文字列でない inbox::Added は発火しない（InboxAdded.type は string 契約）", () => {
    const b = newBot();
    bot = b;
    const inboxes: unknown[] = [];
    b.on("inbox", (i) => inboxes.push(i));
    b.start();

    latestMock().receive(
      JSON.stringify({ signal: "inbox::Added", data: { message: makeMessage({ id: "t1" }) } }),
    );
    latestMock().receive(
      JSON.stringify({
        signal: "inbox::Added",
        data: { message: makeMessage({ id: "t2" }), type: 1 },
      }),
    );

    expect(inboxes).toHaveLength(0);
  });

  test("未知 signal / raw は無視する", () => {
    const b = newBot();
    bot = b;
    let n = 0;
    b.on("message", () => (n += 1));
    b.on("messageUpdate", () => (n += 1));
    b.on("inbox", () => (n += 1));
    b.start();

    latestMock().receive("not-json");
    latestMock().receive(JSON.stringify({ signal: "unknown::X", data: {} }));
    latestMock().receive(JSON.stringify({ signal: 123 }));

    expect(n).toBe(0);
  });

  test("部分行は id + isEdited のみでは発火しない", () => {
    const b = newBot();
    bot = b;
    const got: unknown[] = [];
    b.on("message", (m) => got.push(m));
    b.on("messageUpdate", (u) => got.push(u));
    b.start();

    latestMock().receive(
      JSON.stringify({ signal: "message::UpdateMessage", data: { id: "x", isEdited: true } }),
    );

    expect(got).toHaveLength(0);
  });

  test("inbox は message 全行必須（id のみは捨てる）", () => {
    const b = newBot();
    bot = b;
    const inboxes: unknown[] = [];
    b.on("inbox", (i) => inboxes.push(i));
    b.start();

    latestMock().receive(
      JSON.stringify({
        signal: "inbox::Added",
        data: { message: { id: "m" }, type: "mention" },
      }),
    );

    expect(inboxes).toHaveLength(0);
  });

  test("sendMessage は { channelId, message, replyingMessageId } を POST する", async () => {
    const b = newBot({
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe(`${SERVER}/ext/message/send`);
        expect(init?.method).toBe("POST");

        return new Response(
          JSON.stringify({ message: "Sent message", data: { messageSaved: makeMessage(), messageReplyingTo: null } }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    bot = b;
    const sent = await b.sendMessage({ channelId: "c1", message: "hi", replyingMessageId: "m9" });

    expect(sent.id).toBe("m1");
  });

  test("editMessage は { messageId, message } を /ext/message/edit へ POST する", async () => {
    const b = newBot({
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe(`${SERVER}/ext/message/edit`);
        expect(init?.method).toBe("POST");
        expect(JSON.parse(String(init?.body))).toEqual({
          messageId: "m1",
          message: "after",
        });

        return new Response(JSON.stringify(makeUpdate({ id: "m1", content: "after" })), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });
    bot = b;
    const edited = await b.editMessage({ messageId: "m1", message: "after" });

    expect(edited.id).toBe("m1");
    expect(edited.content).toBe("after");
    expect(edited.isEdited).toBeTrue();
  });

  test("deleteMessage は DELETE + ボディ { messageId } で /ext/message/delete を呼ぶ", async () => {
    const b = newBot({
      fetchImpl: (async (input: unknown, init?: RequestInit) => {
        expect(String(input)).toBe(`${SERVER}/ext/message/delete`);
        expect(init?.method).toBe("DELETE");
        expect(JSON.parse(String(init?.body))).toEqual({ messageId: "m1" });

        return new Response(
          JSON.stringify({ id: "m1", userId: "u1", channelId: "c1" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as typeof fetch,
    });
    bot = b;
    const deleted = await b.deleteMessage({ messageId: "m1" });

    expect(deleted.id).toBe("m1");
    expect(deleted.channelId).toBe("c1");
  });

  test("WS ERROR signal → error イベント発火", () => {
    const b = newBot();
    bot = b;
    const errs: Error[] = [];
    b.on("error", (e) => errs.push(e));
    b.start();

    latestMock().receive(
      JSON.stringify({ signal: "ERROR", data: "Bot token not valid" }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toBe("Bot token not valid");
  });

  test("stop() 前は close を発火しない / stop() で 1 回発火", () => {
    const b = newBot();
    bot = b;
    let closed = 0;
    b.on("close", () => (closed += 1));

    b.stop();

    expect(closed).toBe(0);
    const b2 = newBot();
    bot = b2;
    b2.on("close", () => (closed += 1));
    b2.start();
    b2.stop();

    expect(closed).toBe(1);
  });

  test("異常切断では error を発火しない（自動再接続のみ）", () => {
    const b = newBot();
    bot = b;
    const errs: Error[] = [];
    b.on("error", (e) => errs.push(e));
    b.start();

    latestMock().open();
    latestMock().serverClose();

    expect(errs).toHaveLength(0);
  });

  test("start() を 2 回呼んでもソケットは 1 個だけ", () => {
    const b = newBot();
    bot = b;
    b.start();
    b.start();

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("ERROR signal 後の stop() で close は合計 1 回", () => {
    const b = newBot();
    bot = b;
    let closed = 0;
    b.on("error", () => {});
    b.on("close", () => (closed += 1));
    b.start();

    latestMock().receive(JSON.stringify({ signal: "ERROR", data: "This bot is disabled" }));
    expect(closed).toBe(1);

    b.stop();
    expect(closed).toBe(1);
  });

  test("fatal ERROR 中に error ハンドラが start() しても、各セッションで close が 1 回ずつ出る", () => {
    const b = newBot();
    bot = b;
    let closed = 0;
    b.on("close", () => (closed += 1));
    b.on("error", () => b.start()); // ハンドラ内で再起動
    b.start();

    latestMock().receive(JSON.stringify({ signal: "ERROR", data: "Invalid token" }));

    expect(closed).toBe(1); // 1 セッション目の close
    expect(MockWebSocket.instances).toHaveLength(2); // 再起動済み

    b.stop();

    expect(closed).toBe(2); // close が飲まれると 1 のまま
  });

  test("ERROR signal 時、error リスナー未登録でも throw せず console.error にフォールバック", () => {
    const b = newBot();
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
          JSON.stringify({ signal: "ERROR", data: "Bot token not valid" }),
        ),
      ).not.toThrow();
    } finally {
      console.error = original;
    }

    expect(logged).toHaveLength(1);
    expect(String(logged[0]?.[0])).toContain("giracle-bot: unhandled error:");
  });

  describe("open イベント", () => {
    test("WS open 前は発火せず、open 1 回につき 1 回だけ発火", () => {
      const b = newBot();
      bot = b;
      const opened: unknown[][] = [];
      b.on("open", (...args) => opened.push(args));
      b.start();

      expect(opened).toHaveLength(0);

      latestMock().open();

      expect(opened).toEqual([[]]); // 引数なしで 1 回
    });

    test("start() を重ねても open は 1 回だけ（ソケットが 1 個のため）", () => {
      const b = newBot();
      bot = b;
      let opened = 0;
      b.on("open", () => (opened += 1));
      b.start();
      b.start();

      latestMock().open();

      expect(MockWebSocket.instances).toHaveLength(1);
      expect(opened).toBe(1);
    });

    test("再接続した新ソケットの open でも発火する（接続ごとに 1 回）", async () => {
      const b = newBot({ reconnectBaseMs: 10 });
      bot = b;
      let opened = 0;
      b.on("open", () => (opened += 1));
      b.start();

      latestMock().open();
      expect(opened).toBe(1);

      latestMock().serverClose();
      await sleep(40);

      expect(MockWebSocket.instances).toHaveLength(2);
      latestMock().open();

      expect(opened).toBe(2);
    });

    test("fatal ERROR 後の start() でも新ソケットの open が発火する", () => {
      const b = newBot();
      bot = b;
      let opened = 0;
      b.on("open", () => (opened += 1));
      b.on("error", () => {});
      b.start();

      latestMock().open();
      expect(opened).toBe(1);

      latestMock().receive(JSON.stringify({ signal: "ERROR", data: "unauthorized" }));

      b.start(); // ERROR でソケットは破棄済み → 再起動できる
      expect(MockWebSocket.instances).toHaveLength(2);
      latestMock().open();

      expect(opened).toBe(2);
    });

    test("once('open') は再接続しても 1 回だけ（例の重複実行防止）", async () => {
      const b = newBot({ reconnectBaseMs: 10 });
      bot = b;
      let opened = 0;
      b.once("open", () => (opened += 1));
      b.start();

      latestMock().open();
      latestMock().serverClose();
      await sleep(40);
      latestMock().open();

      expect(opened).toBe(1);
    });
  });
});
