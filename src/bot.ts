import { EventEmitter } from "node:events";
import { GiracleClient } from "./client";
import { log } from "./log";
import { GiracleSocket, type SocketCtor } from "./ws";
import type {
  BotEventMap,
  BotOptions,
  DeleteResult,
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
  private closed = false;
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

  /** WS へ接続開始。既に接続中なら何もしない（孤児ソケットを作らない） */
  start(): void {
    if (this.socket) {
      log("start() は既に接続済みのため無視");

      return;
    }

    log("bot を起動");

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
      // ソケットを破棄してから通知し、stop() → start() での再起動を可能にする。
      this.socket?.stop();
      this.socket = null;
      this.emitError(err);
      this.emitClose();
    };
    this.closed = false;
    this.socket.start();
  }

  /** 明示的に切断 */
  stop(): void {
    if (this.socket) log("bot を停止");

    this.socket?.stop();
    this.socket = null;
    this.emitClose();
  }

  /** close イベントを一度だけ emit する（stop と fatal の二重発火防止） */
  private emitClose(): void {
    if (this.closed) return;

    this.closed = true;
    this.emit("close");
  }

  /**
   * error イベントを emit する。リスナー未登録時は console.error にフォールバックし
   * throw しない（ネットワーク由来コールバックでプロセスを落とさないため）。
   */
  private emitError(err: Error): void {
    if (this.listenerCount("error") > 0) {
      this.emit("error", err);

      return;
    }

    console.error("giracle-bot: unhandled error:", err);
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

  /** DELETE /ext/message/delete。自分の送信メッセージのみ削除可 */
  deleteMessage(targetMessageId: string): Promise<DeleteResult> {
    return this.client.deleteMessage(targetMessageId);
  }

  private wsUrl(): string {
    return `${this.options.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ws`;
  }

  private handleSignal(env: { signal: string; data: unknown }): void {
    switch (env.signal) {
      case "message::SendMessage": {
        const data = env.data;

        // フレームワークが使うフィールドのみ検証する。不正 payload は黙って捨てる。
        if (
          typeof data !== "object" ||
          data === null ||
          !("id" in data) ||
          typeof data.id !== "string" ||
          !("userId" in data) ||
          typeof data.userId !== "string"
        ) {
          return;
        }

        // SAFETY: 直上で id / userId の型を検証済み。他フィールドは利用側の責務。
        const msg = data as Message;

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
      case "message::UpdateMessage": {
        const data = env.data;

        // フレームワークが使うフィールドのみ検証する。不正 payload は黙って捨てる。
        if (
          typeof data !== "object" ||
          data === null ||
          !("id" in data) ||
          typeof data.id !== "string"
        ) {
          return;
        }

        // SAFETY: 直上で id の型を検証済み。他フィールドは利用側の責務。
        this.emit("messageUpdate", data as Partial<Message> & { id: string });

        return;
      }
      case "inbox::Added":
        this.emit("inbox", env.data as InboxAdded);

        return;
      default:
        // "pong" / "raw" / 未知 signal は無視
        return;
    }
  }
}
