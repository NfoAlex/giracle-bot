import { GiracleApiError } from "./errors";
import type { DeletedMessage, Message, MessageUpdate } from "./types";

/** POST で JSON を送るための共通ヘッダ */
const JSON_HEADERS = { "content-type": "application/json" };

/** POST /ext/message/send のレスポンス。data は ServiceMessage.Send の戻り（保存行 + 返信先行） */
type SendResponse = {
  message: unknown;
  data: { messageSaved?: unknown; messageReplyingTo?: unknown } | null;
};

/**
 * /ext API の fetch ラッパ。対応エンドポイントは send / edit / delete の 3 つ。
 */
export class GiracleClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(serverUrl: string, token: string, fetchImpl?: typeof fetch) {
    this.baseUrl = serverUrl.replace(/\/+$/, "");
    this.token = token;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** POST /ext/message/send。ボディ: { channelId, message, replyingMessageId? }（undefined は JSON 化で消える） */
  async sendMessage(
    channelId: string,
    message: string,
    replyingMessageId?: string,
  ): Promise<Message> {
    const res = (await this.call("/ext/message/send", "POST", {
      channelId,
      message,
      replyingMessageId,
    })) as SendResponse | undefined;

    // ラッパーの data.messageSaved を Message として返す。形状が壊れていればエラーを見せる
    if (
      res === null ||
      typeof res !== "object" ||
      typeof res.data !== "object" ||
      res.data === null ||
      typeof res.data.messageSaved !== "object" ||
      res.data.messageSaved === null
    ) {
      throw new GiracleApiError(200, "unexpected response shape");
    }

    return res.data.messageSaved as Message;
  }

  /**
   * POST /ext/message/edit。ボディ: { messageId, message }。
   * 戻りは部分行（updatedAt 等は無い）。send と違い { message, data } ラッパーが無い。
   * 編集できるのは Bot 自身が送信したメッセージのみ（他人の行は 403）。
   */
  async editMessage(
    messageId: string,
    message: string,
  ): Promise<MessageUpdate> {
    const res = await this.call("/ext/message/edit", "POST", {
      messageId,
      message,
    });

    if (!isRow(res)) {
      throw new GiracleApiError(200, "unexpected response shape");
    }

    return res as MessageUpdate;
  }

  /**
   * DELETE /ext/message/delete。ボディ: { messageId }。
   * DELETE でもボディに JSON を載せる（サーバー側が body で受ける）。
   * 削除できるのは Bot 自身が送信したメッセージのみ（他人の行は 403）。
   * 戻りは削除対象の最小情報で、本文は含まれない。
   */
  async deleteMessage(messageId: string): Promise<DeletedMessage> {
    const res = await this.call("/ext/message/delete", "DELETE", {
      messageId,
    });

    if (!isRow(res)) {
      throw new GiracleApiError(200, "unexpected response shape");
    }

    return res as DeletedMessage;
  }

  /** body 省略時は content-type を付けない */
  private async call(
    path: string,
    method: string,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const res = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers:
        body === undefined
          ? this.authHeaders()
          : { ...this.authHeaders(), ...JSON_HEADERS },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    return this.handle(res);
  }

  /**
   * 2xx かつ本文が JSON のときだけ生の JSON を返す。
   * それ以外（非 2xx、本文が JSON でない）はテキストボディを GiracleApiError に載せる。
   */
  private async handle(res: Response): Promise<unknown> {
    const text = await res.text();

    if (!res.ok) {
      throw new GiracleApiError(res.status, text);
    }

    try {
      return JSON.parse(text);
    } catch {
      throw new GiracleApiError(res.status, text);
    }
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: this.token };
  }
}

/** メッセージ行らしさの最小判定（フレームワークが使う id だけ見る） */
function isRow(data: unknown): data is Record<string, unknown> {
  return (
    typeof data === "object" &&
    data !== null &&
    typeof (data as Record<string, unknown>).id === "string"
  );
}
