import type { Message } from "../src/types";
import type { SocketLike } from "../src/ws";

/** 実サーバー・ネットワークを使わず WS を差し替える Mock。 */
export class MockWebSocket implements SocketLike {
  static instances: MockWebSocket[] = [];

  /** CONNECTING 相当 */
  readyState = 0;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  url: string;
  options: { headers?: Record<string, string> } | undefined;
  sent: string[] = [];
  closed = false;

  constructor(url: string, options?: { headers?: Record<string, string> }) {
    this.url = url;
    this.options = options;
    MockWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = 3;
    this.onclose?.();
  }

  /** サーバー側が OPEN を送ってきた想定（ping 開始を trigger） */
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }

  /** サーバーからペイロードを受信 */
  receive(data: unknown): void {
    this.onmessage?.({ data });
  }

  /** サーバー側から close（異常/正常どちらでも使える） */
  serverClose(): void {
    this.readyState = 3;
    this.onclose?.();
  }
}

export function latestMock(): MockWebSocket {
  const ws = MockWebSocket.instances.at(-1);
  if (!ws) throw new Error("no MockWebSocket instance created");

  return ws;
}

export function makeMessage(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    channelId: "c1",
    userId: "u1",
    content: "hello",
    replyingMessageId: null,
    isBot: false,
    isEdited: false,
    createdAt: "2024-01-01T00:00:00.000Z",
    MessageUrlPreview: [],
    MessageFileAttached: [],
    ...over,
  };
}
