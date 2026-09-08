import { GiracleApiError } from "./errors";
import type { EditResult, Message } from "./types";

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

  /** GET /ext/message/:messageId */
  async getMessage(messageId: string): Promise<Message> {
    const res = await this.fetchImpl(
      `${this.baseUrl}/ext/message/${messageId}`,
      {
        headers: this.authHeaders(),
      },
    );

    return (await this.handle(res)) as Message;
  }

  /** POST /ext/message/send。ボディ: { channelId, message, replyingMessageId? }（undefined は JSON 化で消える） */
  async sendMessage(
    channelId: string,
    message: string,
    replyingMessageId?: string,
  ): Promise<Message> {
    const res = await this.fetchImpl(`${this.baseUrl}/ext/message/send`, {
      method: "POST",
      headers: { ...this.authHeaders(), ...JSON_HEADERS },
      body: JSON.stringify({ channelId, message, replyingMessageId }),
    });

    return (await this.handle(res)) as Message;
  }

  /** POST /ext/message/edit。ボディ: { targetMessageId, message } */
  async editMessage(
    targetMessageId: string,
    message: string,
  ): Promise<EditResult> {
    const res = await this.fetchImpl(`${this.baseUrl}/ext/message/edit`, {
      method: "POST",
      headers: { ...this.authHeaders(), ...JSON_HEADERS },
      body: JSON.stringify({ targetMessageId, message }),
    });

    return (await this.handle(res)) as EditResult;
  }

  /** 生の JSON を返す（ラッパー無し）。エラー時はテキストボディを GiracleApiError に載せる */
  private async handle(res: Response): Promise<unknown> {
    if (!res.ok) {
      const body = await res.text();

      throw new GiracleApiError(res.status, body);
    }

    return res.json();
  }

  private authHeaders(): Record<string, string> {
    return { Authorization: this.token };
  }
}
