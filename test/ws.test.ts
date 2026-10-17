import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { GiracleSocket, nextBackoffMs } from "../src/ws";
import type { SignalEnvelope } from "../src/types";
import { MockWebSocket, latestMock } from "./mockWebSocket";

const URL = "ws://localhost:3000/ws";
const TOKEN = "tok-secret";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 条件成立まで最大 timeoutMs 待つ（タイマー依存テスト用。sleep の固定待ちは環境で揺れる） */
async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const start = Date.now();

  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");

    await sleep(1);
  }
}

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
  } = {},
): GiracleSocket {
  const s = new GiracleSocket(URL, TOKEN, {
    WebSocketImpl: MockWebSocket,
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
      JSON.stringify({ signal: "message::UpdateMessage", data: { id: "m1" } }),
    );

    expect(got).toEqual([
      { signal: "message::UpdateMessage", data: { id: "m1" } },
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

  test("stop() 後は、遅れて close が来ても再接続しない", async () => {
    const s = makeSocket({ reconnectBaseMs: 10 });
    s.start();
    const ws = latestMock();
    ws.open();

    s.stop();
    ws.serverClose(); // stop 後に届き得る close

    await sleep(40);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("異常 close → 自動再接続（小さい baseMs で実際に新接続される）", async () => {
    const s = makeSocket({ reconnectBaseMs: 10 });
    s.start();
    const ws0 = latestMock();
    ws0.open(); // attempt reset → 0
    expect(sockets[0]).toBe(s);

    ws0.serverClose(); // 異常切断 → 再接続を予約

    expect(MockWebSocket.instances).toHaveLength(1); // まだ即時ではない
    await sleep(40);

    expect(MockWebSocket.instances).toHaveLength(2); // 再接続された
  });

  test("reconnectBaseMs: 0 は既定値扱いになり、接続断後も再接続 hot-loop しない", async () => {
    const s = makeSocket({ reconnectBaseMs: 0 });
    s.start();
    const ws = latestMock();
    ws.open();
    ws.serverClose();

    // 0 が素通りすると遅延 0 で即再接続されるが、clamp（既定 1s）なら 50ms 内に新接続は無い
    await sleep(50);

    expect(MockWebSocket.instances).toHaveLength(1);
  });

  /** 接続 → open → 即異常切断 を 1 回行い、次のソケットが現れるのを待つ */
  async function flap(index: number): Promise<void> {
    const ws = MockWebSocket.instances[index];
    if (!ws) throw new Error(`no socket #${index}`);

    ws.open();
    ws.serverClose();

    await waitFor(() => MockWebSocket.instances.length >= index + 2);
  }

  test("open 直後の切断を繰り返すとバックオフが増加する（attempt は open で 0 に戻らない）", async () => {
    const s = makeSocket({ reconnectBaseMs: 20 });
    s.start();

    const created: number[] = [Date.now()];

    for (let i = 0; i < 3; i++) {
      await flap(i);
      created.push(Date.now());
    }

    const gaps = created.slice(1).map((t, i) => t - created[i]!);

    // 期待 20 → 40 → 80ms。open で attempt が 0 に戻ると全部 20ms のまま増えない
    expect(gaps[0]).toBeGreaterThanOrEqual(15);
    expect(gaps[1]).toBeGreaterThanOrEqual(30);
    expect(gaps[2]).toBeGreaterThanOrEqual(60);
  });

  test("pong を受けた健全な接続の次はバックオフが base に戻る", async () => {
    const s = makeSocket({ reconnectBaseMs: 30 });
    s.start();

    // 3 回フラップして attempt を進める（遅延 30 → 60 → 120ms）
    for (let i = 0; i < 3; i++) await flap(i);

    // 4 個目で pong を返し「接続は健全」と判定させる → attempt が 0 に戻る
    const ws = MockWebSocket.instances[3]!;
    ws.open();
    ws.receive(JSON.stringify({ signal: "pong", data: "pong" }));

    const before = Date.now();
    ws.serverClose();

    await waitFor(() => MockWebSocket.instances.length >= 5);

    const gap = Date.now() - before;

    // reset されれば 30ms。pong でも reset しない過剰修正なら 30*2^3 = 240ms
    expect(gap).toBeLessThan(90);
  });

  test("コンストラクタ throw は未捕捉にならず、再試行が予約される", async () => {
    let calls = 0;

    class FlakySocket extends MockWebSocket {
      constructor(url: string, options?: { headers?: Record<string, string> }) {
        calls += 1;
        if (calls === 1) throw new Error("ctor failure");

        super(url, options);
      }
    }

    const s = new GiracleSocket(URL, TOKEN, {
      WebSocketImpl: FlakySocket,
      reconnectBaseMs: 10,
    });
    sockets.push(s);

    s.start();
    expect(MockWebSocket.instances).toHaveLength(0); // 1 回目は throw

    await sleep(40);

    expect(calls).toBe(2);
    expect(MockWebSocket.instances).toHaveLength(1); // 再試行で接続できた
  });
});

describe("GiracleSocket ping", () => {
  test("open 後 pingIntervalMs 間隔で {signal:ping,data:ping} を送信", async () => {
    const s = makeSocket({ pingIntervalMs: 15 });
    s.start();
    const ws = latestMock();
    ws.open();

    expect(ws.sent).toEqual([]);

    // liveness 監視で close されないよう pong を返しつつ、ping が間隔送信されることを見る
    for (let i = 0; i < 3; i++) {
      await sleep(20);
      ws.receive(JSON.stringify({ signal: "pong", data: "pong" }));
    }

    const pings = ws.sent.filter(
      (m) => m === JSON.stringify({ signal: "ping", data: "ping" }),
    );

    expect(pings.length).toBeGreaterThanOrEqual(2);
  });

  test("pingIntervalMs: 0 は既定値扱いになり、即切断ループにならない", async () => {
    const s = makeSocket({ pingIntervalMs: 0, reconnectBaseMs: 0 });
    s.start();
    const ws = latestMock();
    ws.open();

    // 0 が素通りすると liveness 閾値 0 のため open 直後に close される。既定値（30s）なら切断しない
    await sleep(50);

    expect(ws.closed).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
  });

  test("pong 無応答 → 半死接続とみなし close して再接続する", async () => {
    const s = makeSocket({
      pingIntervalMs: 15,
      reconnectBaseMs: 10,
    });
    s.start();
    const ws = latestMock();
    ws.open();

    await sleep(60);

    expect(ws.closed).toBe(true);
    expect(MockWebSocket.instances).toHaveLength(2);
  });

  test("pong 応答あり → close せず、pong は onSignal に流れない", async () => {
    const s = makeSocket({ pingIntervalMs: 15 });
    const got: SignalEnvelope[] = [];
    s.onSignal = (env) => got.push(env);
    s.start();
    const ws = latestMock();
    ws.open();

    for (let i = 0; i < 6; i++) {
      await sleep(10);
      ws.receive(JSON.stringify({ signal: "pong", data: "pong" }));
    }

    expect(ws.closed).toBe(false);
    expect(MockWebSocket.instances).toHaveLength(1);
    expect(got).toEqual([]);
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
