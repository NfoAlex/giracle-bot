import { EventEmitter } from "node:events";
import { GiracleClient } from "./client";
import { GiracleSocket, type SocketCtor } from "./ws";
import type {
  BotEventMap,
  BotOptions,
  EditResult,
  InboxAdded,
  Message,
} from "./types";

/**
 * Bot の本体。HTTP クライアント + WS 接続 + イベント発火を束ねる。
 * remoteUserId が既知（botUserId 設定 or 初回 sendMessage キャッシュ）のときは
 * 自己送信の message イベントを emit しない（BOT_FRAMEWORK.md 2.2-4）。
 */
export class GiracleBot extends EventEmitter {
  private options: BotOptions;
  private client: GiracleClient;
  private socket: GiracleSocket | null = null;
  private cachedUserId: string | undefined;

  constructor(options: BotOptions) {
    super();
    this.options = options;
    this.cachedUserId = options.botUserId;
    this.client = new GiracleClient(
      options.serverUrl,
      options.token,
      options.fetchImpl,
    );
  }

  override on<K extends keyof BotEventMap>(
    event: K,
    listener: (...args: BotEventMap[K]) => void,
  ): this {
    return super.on(event as string, listener as (...args: unknown[]) => void);
  }

  override emit<K extends keyof BotEventMap>(
    event: K,
    ...args: BotEventMap[K]
  ): boolean {
    return super.emit(event as string, ...args);
  }

  /** Bot の remoteUserId。明示設定が無ければ最初の sendMessage 成功時にキャッシュ */
  get remoteUserId(): string | undefined {
    return this.cachedUserId;
  }

  /** WS へ接続開始 */
  start(): void {
    // SAFETY: WebSocketImpl は typeof WebSocket で、実行時は SocketCtor の部分集合を満たす。
    // DOM lib の型には headers オプションが無いため unknown を経由して絞る。
    const wsImpl = this.options.WebSocketImpl as unknown as
      | SocketCtor
      | undefined;

    this.socket = new GiracleSocket(this.wsUrl(), this.options.token, {
      WebSocketImpl: wsImpl,
      pingIntervalMs: this.options.pingIntervalMs,
      reconnectBaseMs: this.options.reconnectBaseMs,
      reconnectMaxMs: this.options.reconnectMaxMs,
    });
    this.socket.onSignal = (env) => this.handleSignal(env);
    this.socket.onError = (err) => {
      // ERROR signal（トークン無効・未承認）。fatal で終了する。
      this.emit("error", err);
      this.emit("close");
    };
    this.socket.start();
  }

  /** 明示的に切断 */
  stop(): void {
    this.socket?.stop();
    this.socket = null;
    this.emit("close");
  }

  /** GET /ext/message/:messageId */
  getMessage(messageId: string): Promise<Message> {
    return this.client.getMessage(messageId);
  }

  /** POST /ext/message/send。成功時はレスポンスの userId を remoteUserId としてキャッシュ */
  async sendMessage(
    channelId: string,
    message: string,
    replyingMessageId?: string,
  ): Promise<Message> {
    const res = await this.client.sendMessage(
      channelId,
      message,
      replyingMessageId,
    );

    this.cachedUserId ??= res.userId;

    return res;
  }

  /** POST /ext/message/edit */
  editMessage(targetMessageId: string, message: string): Promise<EditResult> {
    return this.client.editMessage(targetMessageId, message);
  }

  private wsUrl(): string {
    return `${this.options.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;
  }

  private handleSignal(env: { signal: string; data: unknown }): void {
    switch (env.signal) {
      case "message::SendMessage": {
        const msg = env.data as Message;

        // 自己送信はフィルタ（echo 無限ループ防止）。identity 未確定時は素通し。
        if (
          this.remoteUserId !== undefined &&
          msg.userId === this.remoteUserId
        ) {
          return;
        }

        this.emit("message", msg);

        return;
      }
      case "message::UpdateMessage":
        this.emit(
          "messageUpdate",
          env.data as Partial<Message> & { id: string },
        );

        return;
      case "inbox::Added":
        this.emit("inbox", env.data as InboxAdded);

        return;
      default:
        // "pong" / "raw" / 未知 signal は無視
        return;
    }
  }
}
