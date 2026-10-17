import { describe, expect, test } from "bun:test";
import { GiracleClient } from "../src/client";
import { GiracleApiError } from "../src/errors";
import { makeMessage, makeUpdate } from "./mockWebSocket";

/** 呼び出し記録付きの fetch モック。Response は Bun/undici の実物を使う（サーバーは立てない）。 */
function mockFetch(handler: (url: string, init?: RequestInit) => Response): {
  impl: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });

    return handler(url, init);
  }) as typeof fetch;

  return { impl, calls };
}

function okJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textRes(status: number, body: string): Response {
  return new Response(body, { status });
}

const SERVER = "http://localhost:3000";
const TOKEN = "00000000-0000-0000-0000-000000000000";

describe("GiracleClient", () => {
  test("sendMessage 成功: data.messageSaved を Message として返す", async () => {
    const msg = makeMessage({ id: "m-abc" });
    const { impl } = mockFetch((url, init) => {
      expect(url).toBe(`${SERVER}/ext/message/send`);
      expect(init?.method).toBe("POST");
      expect(init?.headers).toEqual({
        Authorization: TOKEN,
        "content-type": "application/json",
      });

      return okJson({ message: "Sent message", data: { messageSaved: msg, messageReplyingTo: null } });
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const got = await client.sendMessage("c1", "hi");

    expect(got).toEqual(msg);
    expect(got.id).toBe("m-abc");
  });

  test("sendMessage 成功: 現行サーバーの保存行そのものを Message として返す", async () => {
    const msg = makeMessage({ id: "m-raw" });
    const { impl } = mockFetch(() => okJson(msg));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const got = await client.sendMessage("c1", "hi");

    expect(got).toEqual(msg);
    expect(got.id).toBe("m-raw");
  });

  test("sendMessage のリクエストボディ形状。replyingMessageId 省略時はボディに載らない", async () => {
    const { impl, calls } = mockFetch(() =>
      okJson({ message: "Sent message", data: { messageSaved: makeMessage(), messageReplyingTo: null } }),
    );
    const client = new GiracleClient(SERVER, TOKEN, impl);

    await client.sendMessage("c1", "hi", "m9");
    await client.sendMessage("c1", "hi");

    expect(calls).toHaveLength(2);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      channelId: "c1",
      message: "hi",
      replyingMessageId: "m9",
    });
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({
      channelId: "c1",
      message: "hi",
    });
  });

  test("401 テキストボディ → GiracleApiError(status=401, body 保持)。Authorization に token が生のまま載る", async () => {
    const { impl, calls } = mockFetch((_url, init) => {
      // POST は JSON ボディ付き → content-type も載る
      expect(init?.headers).toEqual({
        Authorization: TOKEN,
        "content-type": "application/json",
      });

      return textRes(401, "Bot is not approved yet");
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.sendMessage("c1", "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    const apiErr = err as GiracleApiError;
    expect(apiErr.status).toBe(401);
    expect(apiErr.body).toBe("Bot is not approved yet");
    expect(calls).toHaveLength(1);
  });

  test("非 2xx には Bot 無効化 (400) も GiracleApiError にそのまま載る", async () => {
    const { impl } = mockFetch(() => textRes(400, "Bot is not enabled on this server"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.sendMessage("c1", "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).status).toBe(400);
    expect((err as GiracleApiError).body).toBe("Bot is not enabled on this server");
  });

  test("200 だが本文が JSON でない → GiracleApiError(status=200, body 保持)", async () => {
    const { impl } = mockFetch(() => textRes(200, "<html>oops</html>"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.sendMessage("c1", "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).status).toBe(200);
    expect((err as GiracleApiError).body).toBe("<html>oops</html>");
  });

  test("204 空ボディ → GiracleApiError(status=204, body=\"\")", async () => {
    const { impl } = mockFetch(() => textRes(204, ""));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.sendMessage("c1", "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).status).toBe(204);
    expect((err as GiracleApiError).body).toBe("");
  });

  test("serverUrl の末尾スラッシュは正規化され二重スラッシュにならない", async () => {
    const { impl, calls } = mockFetch(() =>
      okJson({ message: "Sent message", data: { messageSaved: makeMessage(), messageReplyingTo: null } }),
    );
    const client = new GiracleClient(`${SERVER}/`, TOKEN, impl);

    await client.sendMessage("c1", "hi");

    expect(calls[0]?.url).toBe(`${SERVER}/ext/message/send`);
  });

  test("レスポンスの data.messageSaved が無い JSON → GiracleApiError", async () => {
    const { impl } = mockFetch(() => okJson({ message: "no data" }));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.sendMessage("c1", "hi").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).body).toBe("unexpected response shape");
  });

  test("editMessage 成功: 行そのもの（ラッパー無し）を返す", async () => {
    const row = makeUpdate({ id: "m-abc", content: "after" });
    const { impl, calls } = mockFetch((url, init) => {
      expect(url).toBe(`${SERVER}/ext/message/edit`);
      expect(init?.method).toBe("POST");

      return okJson(row);
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const got = await client.editMessage("m-abc", "after");

    expect(got).toEqual(row);
    expect(got.content).toBe("after");
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      messageId: "m-abc",
      message: "after",
    });
  });

  test("editMessage 403 → GiracleApiError(status=403, body 保持)", async () => {
    const { impl } = mockFetch(() => textRes(403, "You are not sender of this message"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.editMessage("m1", "x").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).status).toBe(403);
    expect((err as GiracleApiError).body).toBe("You are not sender of this message");
  });

  test("editMessage 200 だが id 無し JSON → GiracleApiError", async () => {
    const { impl } = mockFetch(() => okJson({ message: "ok" }));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.editMessage("m1", "x").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).body).toBe("unexpected response shape");
  });

  test("deleteMessage 成功: DELETE + ボディ { messageId } で最小情報を返す", async () => {
    const row = { id: "m-abc", userId: "u1", channelId: "c1" };
    const { impl, calls } = mockFetch((url, init) => {
      expect(url).toBe(`${SERVER}/ext/message/delete`);
      expect(init?.method).toBe("DELETE");
      expect(init?.headers).toEqual({
        Authorization: TOKEN,
        "content-type": "application/json",
      });

      return okJson(row);
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const got = await client.deleteMessage("m-abc");

    expect(got).toEqual(row);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      messageId: "m-abc",
    });
  });

  test("deleteMessage 403 → GiracleApiError(status=403, body 保持)", async () => {
    const { impl } = mockFetch(() => textRes(403, "You are not owner of this message"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.deleteMessage("m1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).status).toBe(403);
    expect((err as GiracleApiError).body).toBe("You are not owner of this message");
  });

  test("deleteMessage 200 だが id 無し JSON → GiracleApiError", async () => {
    const { impl } = mockFetch(() => okJson({ deleted: true }));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.deleteMessage("m1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).body).toBe("unexpected response shape");
  });

  test("serverUrl が不正なら構築時に throw する", () => {
    expect(() => new GiracleClient("localhost:3000", TOKEN)).toThrow();
    expect(() => new GiracleClient("httpx://h", TOKEN)).toThrow();
  });
});
