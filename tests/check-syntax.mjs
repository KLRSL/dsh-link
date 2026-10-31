#!/usr/bin/env node
/**
 * check-syntax —— 对 lib/ 下每个 .js 跑 `node --check`。
 *
 * 这就是本机做不了的「编译」：没有执行、只做语法解析，能一次性抓出所有语法错。
 *
 * ## ⚠️ 路径必须用 `fileURLToPath`，不能用 `URL.pathname`
 *
 * 2026-10-31 Windows 实测报错：
 *
 *     Error: ENOENT: scandir 'C:\C:\Users\<user>\Downloads\src\lib'
 *
 * 两个原因叠加：
 *   ① `URL.pathname` 给的是 `/C:/Users/...`（带前导斜杠），Windows 上再 `join`
 *      就变成畸形盘符路径；
 *   ② 目录名含中文时它给的是**百分号编码**（`%E6%BA%90%E7%A0%81` 是 `源码`），
 *      而文件系统要的是解码后的字面名。
 *
 * `fileURLToPath` 两条都处理对了。同一坑在 `lib/mobile/plugin-install.js` 与
 * `scripts/build-client-chunk.mjs` 里早就用对了，只有这里漏了。
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../lib', import.meta.url));
const files = [];

function walk(dir) {
	for (const name of readdirSync(dir)) {
		const p = join(dir, name);
		if (statSync(p).isDirectory()) walk(p);
		else if (name.endsWith('.js')) files.push(p);
	}
}

walk(root);
for (const file of files) {
	execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
console.log(`syntax ok · ${files.length} files`);
