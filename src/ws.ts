import { log } from "./log";
import type { SignalEnvelope } from "./types";

/** WebSocket.OPEN 相当（型注入を容易にするための定数） */
const WS_OPEN = 1;

/** WebSocket.CLOSED 相当 */
const WS_CLOSED = 3;

/** close イベントの付帯情報（切断理由をログに出すためだけに使う） */
export type CloseInfo = { code?: number; reason?: string };

/** GiracleSocket が使う WebSocket の最小構造（テスト用 Mock を差し込みやすくする） */
export type SocketLike = {
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: CloseInfo) => void) | null;
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
const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** ジッタ係数の幅（delay を 0.5〜1.0 倍に散らす） */
const JITTER_MIN = 0.5;
const JITTER_SPAN = 0.5;

/**
 * /ext/ws のクライアント。受信 signal の正規化・自動再接続・定期 ping を担う。
 * 自身はイベントを保持せず、onSignal / onError で外へ知らせる。
 */
export class GiracleSocket {
  onSignal?: (env: SignalEnvelope) => void;
  onError?: (err: Error) => void;
  onOpen?: () => void;

  private url: string;
  private token: string;
  private opts: GiracleSocketOptions;
  private ws: SocketLike | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  /** stop() または ERROR signal 後は再接続しない */
  private noReconnect = false;
  private attempt = 0;
  /** 最後に pong を受けた時刻（半死接続の検知に使う） */
  private lastPongAt = 0;

  constructor(url: string, token: string, opts: GiracleSocketOptions = {}) {
    this.url = url;
    this.token = token;
    this.opts = opts;
  }

  /** 接続開始（明示的な停止前は切断時も自動再接続する） */
  start(): void {
    if (this.ws && this.ws.readyState !== WS_CLOSED) {
      log("start() は既に接続済みのため無視");

      return;
    }

    this.clearReconnect(); // 待機中の再接続と二重に接続しない
    this.noReconnect = false;
    this.attempt = 0;
    this.connect();
  }

  /** 明示的に切断（ping・再接続タイマーを止め、以後再接続しない） */
  stop(): void {
    this.noReconnect = true;
    this.clearPing();
    this.clearReconnect();
    this.clearConnect();

    this.ws?.close();
    // 実 WS の close は非同期（CLOSING → CLOSED）のため、readyState に頼らず手放す
    this.ws = null;
  }

  /** 接続を試みる。接続失敗も指数バックオフで再試行する（fatal にはしない）。 */
  private connect(): void {
    // SAFETY: Bun の WebSocket は (url, { headers }) を許すが、DOM lib の型には
    // headers オプションが無い。実行時互換であり、SocketLike の部分集合を満たす。
    const ctor =
      this.opts.WebSocketImpl ?? (WebSocket as unknown as SocketCtor);
    let ws: SocketLike;

    const label =
      this.attempt > 0 ? `再接続を試行 (attempt ${this.attempt})` : "接続開始";

    log(`${label}: ${this.url}`);

    try {
      ws = new ctor(this.url, { headers: { Authorization: this.token } });
    } catch (err) {
      // ソケット生成の失敗は一時障害として扱い、onError は呼ばず再試行に回す。
      log(`ソケット生成に失敗: ${String(err)}`);

      this.scheduleReconnect();

      return;
    }

    ws.onopen = () => {
      this.clearConnect();
      log(
        this.attempt > 0
          ? `再接続に成功 (attempt ${this.attempt})`
          : "接続確立",
      );

      // attempt はここで戻さない。open 直後に切れるサーバーだと毎回 1 秒で
      // 再接続し続け、指数バックオフが働かない（pong 受信で健全と確認してから戻す）。
      this.lastPongAt = Date.now();
      this.startPing();
      this.onOpen?.();
    };
    ws.onmessage = (ev) => this.handleMessage(ev.data);
    ws.onclose = (ev) => {
      // stop() 済み・再起動済みの古いソケットの close では再接続しない
      if (this.ws !== ws) return;

      this.clearPing();
      this.clearConnect();

      const code = ev?.code;
      const reason = ev?.reason;

      if (this.noReconnect) {
        log("切断を検知 (再接続しない)");

        return;
      }

      const codeInfo =
        code === undefined
          ? ""
          : ` (code ${code}${reason ? ` ${reason}` : ""})`;

      log(`切断を検知${codeInfo}`);

      this.scheduleReconnect();
    };
    this.ws = ws;

    // CONNECTING のまま open しないソケットを放置すると再接続に至らないため、close 経由で再接続させる
    this.connectTimer = setTimeout(() => {
      this.connectTimer = null;
      log(
        `接続が ${DEFAULT_CONNECT_TIMEOUT_MS}ms 以内に確立しない → close して再接続`,
      );

      ws.close();
    }, DEFAULT_CONNECT_TIMEOUT_MS);
  }

  /** 受信ペイロードを { signal, data } に正規化して処理する */
  private handleMessage(data: unknown): void {
    const env = this.normalize(data);

    if (env.signal === "pong") {
      // liveness の更新のみ。利用側へは流さない。
      // 健全な接続を確認できたのでバックオフを戻す（この時点が唯一の reset 点）。
      this.lastPongAt = Date.now();
      this.attempt = 0;

      return;
    }

    if (env.signal === "ERROR") {
      // トークン無効・未承認・BAN/削除。再接続しても同じ結果なので fatal 扱いで止める。
      log(`ERROR signal を受信: ${String(env.data)} → 再接続しない`);

      this.noReconnect = true;
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
    // 0 以下だと遅延 0 の再接続ホットループになるため既定値に落とす
    const base =
      this.opts.reconnectBaseMs && this.opts.reconnectBaseMs > 0
        ? this.opts.reconnectBaseMs
        : DEFAULT_BASE;
    const delay = Math.round(
      nextBackoffMs(this.attempt, base, DEFAULT_MAX) *
        (JITTER_MIN + Math.random() * JITTER_SPAN),
    );

    log(`再接続を予約: ${delay}ms 後 (attempt ${this.attempt + 1})`);

    this.attempt += 1;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  private startPing(): void {
    this.clearPing();
    // typeof ガードのみの緩い設定値。0 以下は liveness 閾値(2 周期)を常時 true 化するため既定値に落とす
    const interval =
      this.opts.pingIntervalMs && this.opts.pingIntervalMs > 0
        ? this.opts.pingIntervalMs
        : DEFAULT_PING;

    this.pingTimer = setInterval(() => {
      if (!this.ws || this.ws.readyState !== WS_OPEN) return;

      // 2 周期 pong が来なければ半死接続とみなし、close 経由で再接続させる。
      if (Date.now() - this.lastPongAt > interval * 2) {
        log(
          `pong 無応答 (最終受信から ${Date.now() - this.lastPongAt}ms) → 切断して再接続`,
        );

        this.ws.close();

        return;
      }

      // body は { signal, data } とも非空文字列が必須。data は任意の非空文字列でよい
      this.ws.send(JSON.stringify({ signal: "ping", data: "ping" }));
    }, interval);
  }

  private clearPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);

    this.pingTimer = null;
  }

  private clearReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);

    this.reconnectTimer = null;
  }

  private clearConnect(): void {
    if (this.connectTimer) clearTimeout(this.connectTimer);

    this.connectTimer = null;
  }
}
