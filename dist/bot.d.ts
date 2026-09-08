import { EventEmitter } from "node:events";
import type { BotEventMap, BotOptions, EditResult, Message } from "./types";
/**
 * Bot の本体。HTTP クライアント + WS 接続 + イベント発火を束ねる。
 * remoteUserId が既知（botUserId 設定 or 初回 sendMessage キャッシュ）のときは
 * 自己送信の message イベントを emit しない（BOT_FRAMEWORK.md 2.2-4）。
 */
export declare class GiracleBot extends EventEmitter {
    private options;
    private client;
    private socket;
    private cachedUserId;
    constructor(options: BotOptions);
    on<K extends keyof BotEventMap>(event: K, listener: (...args: BotEventMap[K]) => void): this;
    emit<K extends keyof BotEventMap>(event: K, ...args: BotEventMap[K]): boolean;
    /** Bot の remoteUserId。明示設定が無ければ最初の sendMessage 成功時にキャッシュ */
    get remoteUserId(): string | undefined;
    /** WS へ接続開始 */
    start(): void;
    /** 明示的に切断 */
    stop(): void;
    /** GET /ext/message/:messageId */
    getMessage(messageId: string): Promise<Message>;
    /** POST /ext/message/send。成功時はレスポンスの userId を remoteUserId としてキャッシュ */
    sendMessage(channelId: string, message: string, replyingMessageId?: string): Promise<Message>;
    /** POST /ext/message/edit */
    editMessage(targetMessageId: string, message: string): Promise<EditResult>;
    private wsUrl;
    private handleSignal;
}
