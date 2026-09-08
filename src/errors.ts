/**
 * HTTP /ext API エラー。status と生ボディを保持する。
 * 文言は保持するだけで、分岐に使わない（サーバー文言に依存しない）。
 */
export class GiracleApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`Giracle API error ${status}: ${body}`);
    this.name = "GiracleApiError";
  }
}
