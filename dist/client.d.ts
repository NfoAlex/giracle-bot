import type { EditMessageInput, EditResult, Message, SendMessageInput } from "./types";
/**
 * /ext API の薄い fetch ラッパ。
 * レスポンスは { message, data } ラッパー無しの生 JSON。
 */
export declare class GiracleClient {
    private baseUrl;
    private token;
    private fetchImpl;
    constructor(serverUrl: string, token: string, fetchImpl?: typeof fetch);
    /** GET /ext/message/:messageId */
    getMessage(messageId: string): Promise<Message>;
    /** POST /ext/message/send */
    sendMessage(input: SendMessageInput): Promise<Message>;
    /** POST /ext/message/edit */
    editMessage(input: EditMessageInput): Promise<EditResult>;
    /** 生の JSON を返す（ラッパー無し）。エラー時はテキストボディを GiracleApiError に載せる */
    private handle;
    private authHeaders;
}
