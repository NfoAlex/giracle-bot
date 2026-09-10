/**
 * /ext API と /ws signal の型。BOT_FRAMEWORK.md 2.3 に基づく。
 * 実サーバーのレスポンスに合わせる（過剰な型にしない）。
 */

/** メッセージ行（GET /ext/message/:id と WS signal の data） */
export type Message = {
 id: string;
 channelId: string;
 userId: string;
 content: string;
 replyingMessageId: string | null;
 isBot: boolean;
 isEdited: boolean;
 createdAt: string; // ponytail: 実サーバー未確認。curl で確定次第修正
 MessageUrlPreview: unknown[];
 MessageFileAttached: unknown[];
};

/** POST /ext/message/edit の部分行レスポンス */
export type EditResult = {
 id: string;
 channelId: string;
 content: string;
 isEdited: boolean;
 userId: string;
};

/** DELETE /ext/message/delete のレスポンス（削除前の部分行） */
export type DeleteResult = {
  id: string;
  userId: string;
  channelId: string;
};

/** inbox::Added signal の data */
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
 /** BotManage.tokenCode（UUID）。scheme なしでそのまま Authorization ヘッダに載せる */
 token: string;
 /**
  * Bot の remoteUserId（自己送信フィルタ用）。省略時はフィルタ無効だが、
  * 最初の sendMessage 成功レスポンスの userId を自動キャッシュする。
  */
 botUserId?: string;
 /** テスト用差し替え口。省略時はグローバル fetch / WebSocket */
 fetchImpl?: typeof fetch;
 WebSocketImpl?: typeof WebSocket;
 /** ping 送信間隔 ms（既定 30_000） */
 pingIntervalMs?: number;
 /** 再接続バックオフ初期値 ms（既定 1_000、上限 reconnectMaxMs=60_000） */
 reconnectBaseMs?: number;
 reconnectMaxMs?: number;
};

/** GiracleBot のイベントマップ（EventEmitter の on/emit に使用） */
export type BotEventMap = {
 /** message::SendMessage — 自分の送信分も流れる。self filter 済み */
 message: [message: Message];
 /** message::UpdateMessage — 編集部分行 or URL プレビュー差分（isEdited で判別） */
 messageUpdate: [message: Partial<Message> & { id: string }];
 /** inbox::Added */
 inbox: [inbox: InboxAdded];
 /** HTTP エラー / WS ERROR signal / WS 異常切断など */
 error: [error: Error];
 /** stop() または ERROR signal 後の終了 */
 close: [];
};
