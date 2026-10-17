import { EventEmitter } from "node:events";
import { GiracleClient } from "./client";
import { log } from "./log";
import { GiracleSocket } from "./ws";
import type {
  BotEventMap,
  BotOptions,
  DeletedMessage,
  InboxAdded,
  Message,
  MessageUpdate,
} from "./types";

/** 文字列フィールドの型ガード（例: hasStr(data, "id")）。フレームワークが使う列だけ検証する */
function hasStr(data: unknown, key: string): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>)[key] === "string"
  );
}

/**
 * message::UpdateMessage のペイロードが新規メッセージ（全行分）かどうか。
 * 新規メッセージと編集が同一 signal で配信されるため、部分行が持たない
 * createdAt の有無で振り分ける。
 */
function isFullRow(data: unknown): data is Record<string, unknown> {
  return (
    hasStr(data, "id") &&
    hasStr(data, "channelId") &&
    hasStr(data, "userId") &&
    hasStr(data, "createdAt")
  );
}

/**
 * Bot の本体。HTTP クライアント + WS 接続 + イベント発火を束ねる。
 * Bot 自身の HTTP 送信は WS 配信されないため自己送信フィルタは不要。
 */
export class GiracleBot extends EventEmitter {
  private options: BotOptions;
  private client: GiracleClient;
  private socket: GiracleSocket | null = null;
  private closed = false;

  constructor(options: BotOptions) {
    super();
    this.options = options;
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

  /** WS へ接続開始。既に接続中なら何もしない（孤児ソケットを作らない） */
  start(): void {
    if (this.socket) {
      log("start() は既に接続済みのため無視");

      return;
    }

    log("bot を起動");

    this.socket = new GiracleSocket(
      `${this.options.serverUrl.replace(/\/+$/, "").replace(/^http/, "ws")}/ext/ws`,
      this.options.token,
      {
        WebSocketImpl: this.options.WebSocketImpl,
        pingIntervalMs: this.options.pingIntervalMs,
        reconnectBaseMs: this.options.reconnectBaseMs,
      },
    );
    this.socket.onSignal = (env) => this.handleSignal(env);
    this.socket.onOpen = () => this.emit("open");
    this.socket.onError = (err) => {
      // ERROR signal（トークン無効・未承認・BAN/削除）。fatal で終了する。
      // ソケットを破棄し、close → error の順に通知する（close を先に確定させないと、
      // error ハンドラの start() が closed を再武装して以降 close が出なくなる）。
      this.socket?.stop();
      this.socket = null;
      this.emitClose();
      this.emitError(err);
    };
    this.closed = false;
    this.socket.start();
  }

  /** 明示的に切断（未接続なら何もしない） */
  stop(): void {
    if (!this.socket) return;

    log("bot を停止");

    this.socket.stop();
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

  /** POST /ext/message/send。チャンネルへ参加済みである必要がある */
  sendMessage(
    channelId: string,
    message: string,
    replyingMessageId?: string,
  ): Promise<Message> {
    return this.client.sendMessage(channelId, message, replyingMessageId);
  }

  /**
   * POST /ext/message/edit。編集できるのは Bot 自身が送ったメッセージのみ。
   * 自分で送信した行の id は sendMessage の戻り値から取る（Bot の送信は WS に流れない）。
   */
  editMessage(messageId: string, message: string): Promise<MessageUpdate> {
    return this.client.editMessage(messageId, message);
  }

  /**
   * DELETE /ext/message/delete。削除できるのは Bot 自身が送ったメッセージのみ。
   * 関連データ（添付ファイル実体・リアクション・通知）もサーバー側で削除される。
   */
  deleteMessage(messageId: string): Promise<DeletedMessage> {
    return this.client.deleteMessage(messageId);
  }

  private handleSignal(env: { signal: string; data: unknown }): void {
    switch (env.signal) {
      case "message::UpdateMessage": {
        // 新規メッセージ（全行分）と編集（部分行）が同一 signal で来るため振り分ける。
        // フレームワークが使うフィールドのみ検証し、不正 payload は黙って捨てる。
        if (isFullRow(env.data)) {
          // SAFETY: 直上で必須フィールドを検証済み。他フィールドは利用側の責務。
          this.emit("message", env.data as unknown as Message);

          return;
        }
        const isBoolEdited =
          typeof env.data === "object" &&
          env.data !== null &&
          typeof (env.data as { isEdited?: unknown }).isEdited === "boolean";
        if (hasStr(env.data, "id") && isBoolEdited) {
          // SAFETY: 直上で id を検証済み。他フィールドは利用側の責務。
          this.emit("messageUpdate", env.data as unknown as MessageUpdate);

          return;
        }

        return;
      }
      case "inbox::Added": {
        // メンション通知。message が行っぽければ流す。
        if (
          typeof env.data === "object" &&
          env.data !== null &&
          hasStr(
            (env.data as { message?: unknown }).message,
            "id",
          )
        ) {
          this.emit("inbox", env.data as InboxAdded);
        }

        return;
      }
      default:
        // "pong" / "raw" / 未知 signal は無視
        return;
    }
  }
}
