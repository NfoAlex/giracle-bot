import { GiracleApiError } from "./errors";
import type { Message } from "./types";

/** POST で JSON を送るための共通ヘッダ */
const JSON_HEADERS = { "content-type": "application/json" };

/** POST /ext/message/send のレスポンス。data は ServiceMessage.Send の戻り（保存行 + 返信先行） */
type SendResponse = {
  message: unknown;
  data: { messageSaved?: unknown; messageReplyingTo?: unknown } | null;
};

/**
 * /ext API の fetch ラッパ。現在ログインしているエンドポイントは
 * POST /ext/message/send のみ（他はサーバー側に存在しない）。
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
