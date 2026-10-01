import { GiracleApiError } from "./errors";
import type { DeleteResult, EditResult, Message } from "./types";

/** POST で JSON を送るための共通ヘッダ */
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * /ext API の薄い fetch ラッパ。
 * レスポンスは { message, data } ラッパー無しの生 JSON。
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

  /** GET /ext/message/:messageId（id は URL エンコードして埋め込む） */
  async getMessage(messageId: string): Promise<Message> {
    return (await this.call(
      `/ext/message/${encodeURIComponent(messageId)}`,
      "GET",
    )) as Message;
  }

  /** POST /ext/message/send。ボディ: { channelId, message, replyingMessageId? }（undefined は JSON 化で消える） */
  async sendMessage(
    channelId: string,
    message: string,
    replyingMessageId?: string,
  ): Promise<Message> {
    return (await this.call("/ext/message/send", "POST", {
      channelId,
      message,
      replyingMessageId,
    })) as Message;
  }

  /** POST /ext/message/edit。ボディ: { targetMessageId, message } */
  async editMessage(
    targetMessageId: string,
    message: string,
  ): Promise<EditResult> {
    return (await this.call("/ext/message/edit", "POST", {
      targetMessageId,
      message,
    })) as EditResult;
  }

  /** DELETE /ext/message/delete。ボディ: { targetMessageId }。自分の送信メッセージのみ削除可 */
  async deleteMessage(targetMessageId: string): Promise<DeleteResult> {
    return (await this.call("/ext/message/delete", "DELETE", {
      targetMessageId,
    })) as DeleteResult;
  }

  /** body 省略時は content-type を付けない（GET 用） */
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
   * 生の JSON を返す（ラッパー無し）。
   * 非 2xx、および 2xx でも本文が JSON でない場合はテキストボディを GiracleApiError に載せる。
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
