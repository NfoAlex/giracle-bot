import { GiracleApiError } from "./errors";
import type {
  DeleteMessageParams,
  DeletedMessage,
  EditMessageParams,
  Message,
  MessageUpdate,
  SendMessageParams,
} from "./types";
import { baseUrl } from "./url";

/** POST で JSON を送るための共通ヘッダ */
const JSON_HEADERS = { "content-type": "application/json" };

/**
 * 現行 giracle-backend の /ext/message/send は保存行そのものを返す。
 * 旧ビルドは { message, data: { messageSaved } } で包むため、そちらも受ける。
 */
type SendResponse = {
  data?: { messageSaved?: unknown } | null;
};

/**
 * /ext API の fetch ラッパ。対応エンドポイントは send / edit / delete の 3 つ。
 */
export class GiracleClient {
  private baseUrl: string;
  private token: string;
  private fetchImpl: typeof fetch;

  constructor(serverUrl: string, token: string, fetchImpl?: typeof fetch) {
    this.baseUrl = baseUrl(serverUrl);
    this.token = token;
    this.fetchImpl = fetchImpl ?? fetch;
  }

  /** POST /ext/message/send。引数はサーバー body と同形。undefined は JSON 化で消える */
  async sendMessage(params: SendMessageParams): Promise<Message> {
    const res: unknown = await this.call("/ext/message/send", "POST", {
      channelId: params.channelId,
      message: params.message,
      replyingMessageId: params.replyingMessageId,
    });

    // 行そのもの、または ラッパーの data.messageSaved を Message として返す。
    // どちらの形状でもなければエラーを見せる
    const row = isRow(res)
      ? res
      : (res as SendResponse | undefined)?.data?.messageSaved;

    if (!isRow(row)) {
      throw new GiracleApiError(200, "unexpected response shape");
    }

    return row as Message;
  }

  /**
   * POST /ext/message/edit。ボディ: { messageId, message }。
   * 戻りは部分行（updatedAt 等は無い）。send と違い { message, data } ラッパーが無い。
   * 編集できるのは Bot 自身が送信したメッセージのみ（他人の行は 403）。
   */
  async editMessage(params: EditMessageParams): Promise<MessageUpdate> {
    const res = await this.call("/ext/message/edit", "POST", {
      messageId: params.messageId,
      message: params.message,
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
  async deleteMessage(params: DeleteMessageParams): Promise<DeletedMessage> {
    const res = await this.call("/ext/message/delete", "DELETE", {
      messageId: params.messageId,
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
