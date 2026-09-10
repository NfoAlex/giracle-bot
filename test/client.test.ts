import { describe, expect, test } from "bun:test";
import { GiracleClient } from "../src/client";
import { GiracleApiError } from "../src/errors";
import { makeMessage } from "./mockWebSocket";

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
  test("GET 成功: ラッパー無しの生行がそのまま Message で返る", async () => {
    const msg = makeMessage({ id: "m-abc" });
    const { impl } = mockFetch((url) => {
      expect(url).toBe(`${SERVER}/ext/message/m-abc`);

      return okJson(msg);
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const got = await client.getMessage("m-abc");

    expect(got).toEqual(msg);
    expect(got.id).toBe("m-abc");
  });

  test("404 テキストボディ → GiracleApiError(status=404, body 保持)", async () => {
    const { impl } = mockFetch(() => textRes(404, "Message not found"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.getMessage("missing").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    const apiErr = err as GiracleApiError;
    expect(apiErr.status).toBe(404);
    expect(apiErr.body).toBe("Message not found");
  });

  test("401 → GiracleApiError、Authorization ヘッダに token が生のまま載る", async () => {
    const { impl, calls } = mockFetch((_url, init) => {
      expect(init?.headers).toEqual({ Authorization: TOKEN });

      return textRes(401, "Your bot is not approved");
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.getMessage("x").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    expect((err as GiracleApiError).status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  test("sendMessage のリクエストボディ形状と URL/method", async () => {
    const { impl, calls } = mockFetch((url, init) => {
      expect(url).toBe(`${SERVER}/ext/message/send`);
      expect(init?.method).toBe("POST");

      return okJson(makeMessage());
    });
    const client = new GiracleClient(SERVER, TOKEN, impl);

    await client.sendMessage("c1", "hi", "m9");

    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body).toEqual({
      channelId: "c1",
      message: "hi",
      replyingMessageId: "m9",
    });
    expect(calls[0]?.init?.headers).toEqual({
      Authorization: TOKEN,
      "content-type": "application/json",
    });
  });

  test("sendMessage で replyingMessageId 省略時はボディに載らない", async () => {
    const { impl, calls } = mockFetch(() => okJson(makeMessage()));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    await client.sendMessage("c1", "hi");

    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<
      string,
      unknown
    >;

    expect(body).toEqual({ channelId: "c1", message: "hi" });
    expect("replyingMessageId" in body).toBe(false);
  });

  test("200 だが本文が JSON でない → GiracleApiError(status=200, body 保持)", async () => {
    const { impl } = mockFetch(() => textRes(200, "<html>oops</html>"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.getMessage("m1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    const apiErr = err as GiracleApiError;
    expect(apiErr.status).toBe(200);
    expect(apiErr.body).toBe("<html>oops</html>");
  });

  test("204 空ボディ → GiracleApiError(status=204, body=\"\")", async () => {
    const { impl } = mockFetch(() => textRes(204, ""));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.getMessage("m1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    const apiErr = err as GiracleApiError;
    expect(apiErr.status).toBe(204);
    expect(apiErr.body).toBe("");
  });

  test("送信系でも 2xx 非 JSON は同じフォールバックに乗る", async () => {
    const { impl } = mockFetch(() => textRes(200, "OK"));
    const client = new GiracleClient(SERVER, TOKEN, impl);

    const err = await client.deleteMessage("m1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(GiracleApiError);
    const apiErr = err as GiracleApiError;
    expect(apiErr.status).toBe(200);
    expect(apiErr.body).toBe("OK");
  });
});
