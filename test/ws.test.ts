import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GiracleSocket, nextBackoffMs, WS_OPEN } from "../src/ws";
import type { SignalEnvelope } from "../src/types";
import { MockWebSocket, latestMock } from "./mockWebSocket";

const URL = "ws://localhost:3000/ws";
const TOKEN = "tok-secret";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let sockets: GiracleSocket[] = [];

beforeEach(() => {
  MockWebSocket.instances = [];
  sockets = [];
});

afterEach(() => {
  for (const s of sockets) s.stop();
  MockWebSocket.instances = [];
});

function makeSocket(
  over: {
    pingIntervalMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
  } = {},
): GiracleSocket {
  const s = new GiracleSocket(URL, TOKEN, {
    WebSocketImpl: MockWebSocket as never,
    ...over,
  });
  sockets.push(s);

  return s;
}

describe("GiracleSocket 正規化", () => {
  test("受信 JSON → onSignal に { signal, data }", () => {
    const s = makeSocket();
    const got: SignalEnvelope[] = [];
    s.onSignal = (env) => got.push(env);
    s.start();

    latestMock().receive(
      JSON.stringify({ signal: "message::SendMessage", data: { id: "m1" } }),
    );

    expect(got).toEqual([
      { signal: "message::SendMessage", data: { id: "m1" } },
    ]);
  });

  test('JSON.parse 失敗の生文字列 → { signal: "raw", data } に正規化', () => {
    const s = makeSocket();
    const got: SignalEnvelope[] = [];
    s.onSignal = (env) => got.push(env);
    s.start();

    latestMock().receive("not-json");

    expect(got).toEqual([{ signal: "raw", data: "not-json" }]);
  });

  test("非文字列ペイロード → raw 扱い", () => {
    const s = makeSocket();
    const got: SignalEnvelope[] = [];
    s.onSignal = (env) => got.push(env);
    s.start();

    latestMock().receive(12345);

    expect(got).toEqual([{ signal: "raw", data: 12345 }]);
  });
});

describe("GiracleSocket ERROR / 再接続", () => {
  test("ERROR signal → onError 発火し、close しても再接続しない", () => {
    const s = makeSocket();
    const errs: Error[] = [];
    s.onError = (e) => errs.push(e);
    s.start();

    const ws = latestMock();
    expect(ws.options?.headers).toEqual({ Authorization: TOKEN });

    ws.receive(
      JSON.stringify({ signal: "ERROR", data: "Your bot is not approved" }),
    );

    expect(errs).toHaveLength(1);
    expect(errs[0]?.message).toBe("Your bot is not approved");

    // サーバーが close してきても再接続しない
    ws.serverClose();
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("異常 close → 自動再接続（小さい baseMs で実際に新接続される）", async () => {
    const s = makeSocket({ reconnectBaseMs: 10, reconnectMaxMs: 60_000 });
    s.start();
    const ws0 = latestMock();
    ws0.open(); // attempt reset → 0
    expect(sockets[0]).toBe(s);

    ws0.serverClose(); // 異常切断 → 再接続を予約

    expect(MockWebSocket.instances).toHaveLength(1); // まだ即時ではない
    await sleep(40);

    expect(MockWebSocket.instances).toHaveLength(2); // 再接続された
  });

  test("正常な OPEN 後にバックオフ遅延はリセットされる（attempt が進んでも開通で 0 に）", async () => {
    const s = makeSocket({ reconnectBaseMs: 10, reconnectMaxMs: 60_000 });
    s.start();
    const ws0 = latestMock();
    ws0.open();
    ws0.serverClose();
    await sleep(40);

    expect(MockWebSocket.instances).toHaveLength(2);
    const ws1 = latestMock();
    ws1.open(); // attempt → 0
    expect((ws1 as unknown as { readyState: number }).readyState).toBe(WS_OPEN);
  });
});

describe("GiracleSocket ping", () => {
  test("open 後 pingIntervalMs 間隔で {signal:ping,data:pong} を送信", async () => {
    const s = makeSocket({ pingIntervalMs: 15 });
    s.start();
    const ws = latestMock();
    ws.open();

    expect(ws.sent).toEqual([]);
    await sleep(45);

    const pings = ws.sent.filter(
      (m) => m === JSON.stringify({ signal: "ping", data: "pong" }),
    );

    expect(pings.length).toBeGreaterThanOrEqual(2);
  });
});

describe("nextBackoffMs 純関数", () => {
  test("指数バックオフが上限でキャップされる", () => {
    const base = 1_000;
    const max = 60_000;

    expect(nextBackoffMs(0, base, max)).toBe(1_000);
    expect(nextBackoffMs(1, base, max)).toBe(2_000);
    expect(nextBackoffMs(2, base, max)).toBe(4_000);
    expect(nextBackoffMs(3, base, max)).toBe(8_000);
    expect(nextBackoffMs(4, base, max)).toBe(16_000);
    expect(nextBackoffMs(5, base, max)).toBe(32_000);
    expect(nextBackoffMs(6, base, max)).toBe(60_000);
    expect(nextBackoffMs(10, base, max)).toBe(60_000);
  });
});
