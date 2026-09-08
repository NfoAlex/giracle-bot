/**
 * HTTP /ext API エラー。status と生ボディを保持する。
 * 文言は保持するだけで、分岐に使わない（サーバー文言に依存しない）。
 */
export declare class GiracleApiError extends Error {
    readonly status: number;
    readonly body: string;
    constructor(status: number, body: string);
}
