import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

/**
 * 例は SKILL.md が雛形として配るため、二つの事故を機械的に禁じる:
 * - open で副作用を実行 → 再接続の度に多重実行（once を使う）
 * - await の reject 未捕捉
 */
const ONCE_OPEN_EXAMPLES = ["example/edit-bot.ts", "example/delete-bot.ts"];

function source(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
}

describe("example: open ハンドラ", () => {
  for (const path of ONCE_OPEN_EXAMPLES) {
    test(`${path} は open で一度だけ実行し、失敗を catch する`, () => {
      const src = source(path);

      expect(src).toContain('once("open"');
      expect(src).not.toContain('on("open"');
      expect(src).toMatch(/catch\s*\(/);
    });
  }
});
