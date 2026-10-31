/**
 * build-client-chunk —— 手机端客户端 chunk 构建。
 *
 * ## 产物与源的唯一差异（就这两处，别再加）
 *
 * | # | 差异 | 为什么 |
 * |---|---|---|
 * | 1 | 首行加一行生成标记（含源文件 SHA256） | 一眼看出 chunk 有没有过期 |
 * | 2 | 模块描述里多一行 `chunk: 'client.mobile.js'` | `lib/client.js` 用 `require.async('./client.mobile.js')` 拉它，缺这个 id 命中不了模块缓存 |
 *
 * ## 为什么必须是「真重建」
 *
 * 手机 WebView 只加载 `lib/client.mobile.js`，**不会**读 `lib/mobile/client.js`。
 * 这里原先只是个「文件存在就跳过」的守卫（原打包脚本没随源码分发），于是源文件
 * 改了、手机还在跑旧代码 —— 0.15.11 就是这样：`lib/mobile/client.js` 里调用了
 * `showAskCard` / `showPromptFailure` / `retireTransient`，而 chunk 里根本没有
 * 这些函数，手机上表现为「授权卡片不弹」「发消息失败没提示」。
 *
 * 现在改为按源重建，`npm pack` 的 `prepack` 也会跑它，两边不会再漂移。
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(here, '../lib/mobile/client.js');
const chunkPath = resolve(here, '../lib/client.mobile.js');

/** 注入点：模块描述里 `id` 之后。 */
const ANCHOR = "\tid: 'dsh-link',\n";
/** 只有 chunk 才有的那行。 */
const CHUNK_LINE = "\tchunk: 'client.mobile.js',\n";

const source = readFileSync(sourcePath, 'utf8');
if (!source.includes(ANCHOR)) {
	console.error(`[dsh-link] 构建失败：${sourcePath} 里找不到注入点 ${JSON.stringify(ANCHOR)}`);
	process.exit(1);
}
if (source.includes(CHUNK_LINE)) {
	console.error('[dsh-link] 构建失败：源文件里不应出现 chunk 描述行（那是生成物专属）');
	process.exit(1);
}

const body = source.replace(ANCHOR, ANCHOR + CHUNK_LINE);
const sha = createHash('sha256').update(source).digest('hex');
const header = `/* 生成文件，勿手改：scripts/build-client-chunk.mjs 从 lib/mobile/client.js 生成。 源 SHA256=${sha} */\n`;

writeFileSync(chunkPath, header + body, 'utf8');
console.log(`[dsh-link] 手机端 chunk 已重建（lib/client.mobile.js，源 SHA256=${sha.slice(0, 12)}…）`);
