import type { SignalEnvelope } from "./types";
/** WebSocket.OPEN 相当（型注入を容易にするための定数） */
export declare const WS_OPEN = 1;
/** GiracleSocket が使う WebSocket の最小構造（テスト用 Mock を差し込みやすくする） */
export type SocketLike = {
    readyState: number;
    onopen: (() => void) | null;
    onmessage: ((ev: {
        data: unknown;
    }) => void) | null;
    onclose: (() => void) | null;
    send(data: string): void;
    close(): void;
};
/** new WebSocket(url, { headers }) のコンストラクタ型 */
export type SocketCtor = new (url: string, options?: {
    headers?: Record<string, string>;
}) => SocketLike;
export type GiracleSocketOptions = {
    WebSocketImpl?: SocketCtor;
    pingIntervalMs?: number;
    reconnectBaseMs?: number;
    reconnectMaxMs?: number;
};
/** 指数バックオフの遅延(ms)。上限 max を超えない純関数（テスト容易性のため切り出し） */
export declare function nextBackoffMs(attempt: number, base: number, max: number): number;
/**
 * /ws のクライアント。受信 signal の正規化・自動再接続・定期 ping を担う。
 * 自身はイベントを保持せず、onSignal / onError で外へ知らせる。
 */
export declare class GiracleSocket {
    onSignal?: (env: SignalEnvelope) => void;
    onError?: (err: Error) => void;
    private url;
    private token;
    private opts;
    private ws;
    private pingTimer;
    private reconnectTimer;
    private stopped;
    private fatalError;
    private attempt;
    constructor(url: string, token: string, opts?: GiracleSocketOptions);
    /** 接続開始（明示的な停止前は切断時も自動再接続する） */
    start(): void;
    /** 明示的に切断（ping・再接続タイマーを止め、以後再接続しない） */
    stop(): void;
    private connect;
    /** 受信ペイロードを { signal, data } に正規化して処理する */
    private handleMessage;
    /** JSON.parse を試し、失敗・形式外は signal:"raw" として生文字列を渡す */
    private normalize;
    private scheduleReconnect;
    private startPing;
    private clearPing;
    private clearReconnect;
}
