/**
 * serverUrl の検証と正規化。ここを通さない URL は受け付けない。
 *
 * 目的は fail loud: scheme の typo（`localhost:3000` や `httpx://`）は WebSocket の
 * 生成が毎回 throw し、無言で再接続を繰り返す（error / close も出ない）。構築時に落とす。
 *
 * http(s) / ws(s) 以外と scheme 無しは TypeError。大文字 scheme は URL が正規化する。
 */
const ALLOWED_PROTOCOLS = new Set(["http:", "https:", "ws:", "wss:"]);

function parse(serverUrl: string): URL {
  let url: URL;

  try {
    url = new URL(serverUrl);
  } catch {
    throw new TypeError(`serverUrl が不正: ${serverUrl}`);
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    throw new TypeError(`serverUrl は http(s) / ws(s) のみ: ${serverUrl}`);
  }

  return url;
}

/**
 * HTTP の base URL。末尾スラッシュだけ落とし、それ以外は元文字列を保つ
 * （URL 再構築によるパスのエンコード変化を避ける）。
 */
export function baseUrl(serverUrl: string): string {
  parse(serverUrl);

  return serverUrl.replace(/\/+$/, "");
}

/** /ext/ws の WS URL。http→ws, https→wss（大文字 scheme も URL が吸収する） */
export function wsUrl(serverUrl: string): string {
  const url = parse(serverUrl);

  if (url.protocol === "http:") url.protocol = "ws:";
  else if (url.protocol === "https:") url.protocol = "wss:";

  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ext/ws`;
  url.search = "";
  url.hash = "";

  return url.toString();
}
