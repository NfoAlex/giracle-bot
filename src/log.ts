/**
 * フレームワークの状態変化ログ。接頭辞の定義を 1 箇所に集約する。
 * 出力先を変えたい場合はここだけを触る（設定オプション化は需要が出てから）。
 */
export function log(message: string): void {
  console.log(`[giracle-bot] ${message}`);
}
