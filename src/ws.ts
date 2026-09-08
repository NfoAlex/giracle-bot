import type { SignalEnvelope } from "./types";

/** WebSocket.OPEN 相当（型注入を容易にするための定数） */
export const WS_OPEN = 1;

/** GiracleSocket が使う WebSocket の最小構造（テスト用 Mock を差し込みやすくする） */
export type SocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  send(data: string): void;
  close(): void;
};

/** new WebSocket(url, { headers }) のコンストラクタ型 */
export type SocketCtor = new (
  url: string,
  options?: { headers?: Record<string, string> },
) => SocketLike;

export type GiracleSocketOptions = {
  WebSocketImpl?: SocketCtor;
  pingIntervalMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

/** 指数バックオフの遅延(ms)。上限 max を超えない純関数（テスト容易性のため切り出し） */
export function nextBackoffMs(
  attempt: number,
  base: number,
  max: number,
): number {
  const delay = base * 2 ** attempt;

  return Math.min(delay, max);
}

const DEFAULT_BASE = 1_000;
const DEFAULT_MAX = 60_000;
const DEFAULT_PING = 30_000;

/**
 * /ws のクライアント。受信 signal の正規化・自動再接続・定期 ping を担う。
 * 自身はイベントを保持せず、onSignal / onError で外へ知らせる。
 */
export class GiracleSocket {
  onSignal?: (env: SignalEnvelope) => void;
  onError?: (err: Error) => void;

  private url: string;
  private token: string;
  private opts: GiracleSocketOptions;
  private ws: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private fatalError = false;
  private attempt = 0;

  constructor(url: string, token: string, opts: GiracleSocketOptions = {}) {
    this.url = url;
    this.token = token;
    this.opts = opts;
  }

  /** 接続開始（明示的な停止前は切断時も自動再接続する） */
  start(): void {
    this.stopped = false;
    this.fatalError = false;
    this.attempt = 0;
    this.connect();
  }

  /** 明示的に切断（ping・再接続タイマーを止め、以後再接続しない） */
  stop(): void {
    this.stopped = true;
    this.clearPing();
    this.clearReconnect();

    this.ws?.close();
  }

  private connect(): void {
    // SAFETY: Bun の WebSocket は (url, { headers }) を許すが、DOM lib の型には
    // headers オプションが無い。実行時互換であり、SocketLike の部分集合を満たす。
    const ctor =
      this.opts.WebSocketImpl ?? (WebSocket as unknown as SocketCtor);
    const ws = new ctor(this.url, { headers: { Authorization: this.token } });

    ws.onopen = () => {
      this.attempt = 0;
      this.startPing();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = () => {
      this.clearPing();

      if (this.stopped || this.fatalError) return;

      this.scheduleReconnect();
    };
    this.ws = ws;
  }

  /** 受信ペイロードを { signal, data } に正規化して処理する */
  private handleMessage(data: unknown): void {
    const env = this.normalize(data);

    if (env.signal === "ERROR") {
      // トークン無効・未承認。再接続しても同じ結果なので fatal 扱いで止める。
      this.fatalError = true;
      this.clearPing();

      this.onError?.(new Error(String(env.data)));

      return;
    }

    this.onSignal?.(env);
  }

  /** JSON.parse を試し、失敗・形式外は signal:"raw" として生文字列を渡す */
  private normalize(data: unknown): SignalEnvelope {
    if (typeof data !== "string") return { signal: "raw", data };

    try {
      const parsed: unknown = JSON.parse(data);

      if (
        parsed &&
        typeof parsed === "object" &&
        typeof (parsed as { signal?: unknown }).signal === "string"
      ) {
        return parsed as SignalEnvelope;
      }
    } catch {
      // fallthrough: そのまま raw 扱い
    }

    return { signal: "raw", data };
  }

  private scheduleReconnect(): void {
    const base = this.opts.reconnectBaseMs ?? DEFAULT_BASE;
    const max = this.opts.reconnectMaxMs ?? DEFAULT_MAX;
    const delay = nextBackoffMs(this.attempt, base, max);

    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) return;

      this.ws.send(JSON.stringify({ signal: "ping", data: "pong" }));
    }, this.opts.pingIntervalMs ?? DEFAULT_PING);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);

    this.pingTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = null;
  }
}
