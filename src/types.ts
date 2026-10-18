/**
 * /ext API と /ext/ws signal の型。実サーバー（giracle-backend）の実レスポンスに
 * 合わせる（過剰な型にしない）。
 *
 * Bot 関係の API 現状:
 * - HTTP は POST /ext/message/send, POST /ext/message/edit, DELETE /ext/message/delete,
 *   GET /ext/user/:userId（makeGet はサーバー側に存在しない）
 * - send のレスポンスは保存行そのもの（旧ビルドは { message, data } ラッパー付き）、edit / delete も行そのもの
 * - WS は bot::channel::<channelId> と user::<remoteUserId> を購読し、
 *   user 送信 / 編集をともに signal "message::UpdateMessage" で受ける
 */

import type { SocketCtor } from "./ws";

/** メッセージに添付されたファイル行 */
export type MessageFile = {
  id: string;
  channelId: string;
  userId: string;
  actualFileName: string;
  savedFileName: string;
  size: number;
  type: string;
  messageId: string | null;
};

/** URL プレビュー行（Bot の WS には配信経路から付かない） */
export type MessageUrlPreview = {
  id: number;
  url: string;
  type: string;
  messageId: string;
  title: string;
  description: string | null;
  faviconLink: string | null;
  imageLink: string | null;
  videoLink: string | null;
};

/**
 * メッセージ行（POST /ext/message/send の data、および WS の新規メッセージ:
 * signal "message::UpdateMessage" の全行分ペイロード）。
 * ws 配信では MessageFileAttached が付き、MessageUrlPreview は付かない
 * （URL プレビュー更新は bot::channel トピックに配信されないため Bot では受け取れない）。
 */
export type Message = {
  id: string;
  channelId: string;
  userId: string;
  /** システムメッセージは JSON 文字列 */
  content: string;
  /** 入退室等のシステムメッセージ。応答する Bot はこれで弾く */
  isSystemMessage: boolean;
  isEdited: boolean;
  replyingMessageId: string | null;
  /** ISO 8601 */
  createdAt: string;
  MessageFileAttached?: MessageFile[];
  MessageUrlPreview?: MessageUrlPreview[];
};

/**
 * 編集更新（signal "message::UpdateMessage" の部分行ペイロード）。
 * 新規メッセージと同一 signal のため、フレームワーク側で createdAt の有無
 * （部分行は createdAt を持たない）により振り分ける。
 * POST /ext/message/edit の成功レスポンスも同じ形（updateMessage の returning）。
 */
export type MessageUpdate = {
  id: string;
  channelId: string;
  userId: string;
  content: string;
  isEdited: boolean;
};

/**
 * 削除対象の最小情報（DELETE /ext/message/delete の成功レスポンス）。
 * 本文は返らず id / userId / channelId のみ（getSingleWithMinimum 相当）。
 */
export type DeletedMessage = {
  id: string;
  userId: string;
  channelId: string;
};

/**
 * ユーザー行（GET /ext/user/:userId の成功レスポンス）。
 * ChannelJoin は Bot が閲覧可能なチャンネルのみ、RoleLink は { roleId } のみ付く。
 * 論理削除・BAN 済みでも行が残っていれば返る（isDeleted / isBanned で判定する）。
 */
export type User = {
  id: string;
  name: string | null;
  selfIntroduction: string;
  isBanned: boolean;
  isBot: boolean;
  isDeleted: boolean;
  /** ISO 8601 */
  createdAt: string;
  ChannelJoin: Array<{ channelId: string }>;
  RoleLink: Array<{ roleId: string }>;
};

/** POST /ext/message/send の引数（単一オブジェクト） */
export type SendMessageParams = {
  channelId: string;
  message: string;
  replyingMessageId?: string;
};

/** POST /ext/message/edit の引数（単一オブジェクト） */
export type EditMessageParams = {
  messageId: string;
  message: string;
};

/** DELETE /ext/message/delete の引数（単一オブジェクト） */
export type DeleteMessageParams = {
  messageId: string;
};

/** GET /ext/user/:userId の引数（単一オブジェクト） */
export type GetUserParams = {
  userId: string;
};

/** inbox::Added signal の data（Bot がメンションされたとき受け取る） */
export type InboxAdded = {
  message: Message;
  type: string;
};

/** サーバー → クライアント signal エンベロープ（JSON parse 前の形状） */
export type SignalEnvelope = {
  signal: string;
  data: unknown;
};

export type BotOptions = {
  serverUrl: string; // 例: "http://localhost:3000"（末尾スラッシュ無し想定、正規化する）
  /** BotManage.tokenCode（32バイトhex）。scheme 無しでそのまま Authorization ヘッダに載せる */
  token: string;
  /** テスト用差し替え口。省略時はグローバル fetch / WebSocket */
  fetchImpl?: typeof fetch;
  WebSocketImpl?: SocketCtor;
  /** ping 送信間隔 ms（既定 30_000） */
  pingIntervalMs?: number;
  /** 再接続バックオフ初期値 ms（既定 1_000、上限 60_000 固定） */
  reconnectBaseMs?: number;
};

/** GiracleBot のイベントマップ（EventEmitter の on/emit に使用） */
export type BotEventMap = {
  /**
   * 新規メッセージ（signal message::UpdateMessage の全行分）。
   * Bot 自身の HTTP 送信は WS 配信されないため自己送信は流れない。
   * システムメッセージも流れる
   */
  message: [message: Message];
  /** 編集による部分行（isEdited: true 固定） */
  messageUpdate: [update: MessageUpdate];
  /** inbox::Added — ユーザーにメンション（@<userId>）されたとき */
  inbox: [inbox: InboxAdded];
  /** WS 接続確立（初回・再接続の度に発火。送信可能の合図） */
  open: [];
  /** WS ERROR signal 受信時のみ（fatal。HTTP 失敗は sendMessage の reject で通知する） */
  error: [error: Error];
  /** stop() または ERROR signal 後の終了 */
  close: [];
};
