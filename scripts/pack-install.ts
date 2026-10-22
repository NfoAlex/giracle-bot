// dist だけを tarball にして利用側プロジェクトへ入れる。
// 使い方: bun run pack:install ../my-bot
import { $ } from "bun";
import path from "node:path";

const target = process.argv[2];
if (target === undefined) {
  console.error("usage: bun run pack:install <bot project dir>");
  process.exit(1);
}

const pkg = (await Bun.file("package.json").json()) as { version: string };
const tgz = `giracle-bot-${pkg.version}.tgz`;

await $`bun run pack`;

// Windows の file: 指定でも扱えるよう区切りを / に寄せる
const tgzPath = path.resolve(tgz).replaceAll("\\", "/");
await $`bun add file:${tgzPath} --cwd ${path.resolve(target)}`;

console.log(`installed ${tgz} -> ${path.resolve(target)}`);
