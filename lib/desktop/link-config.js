/**
 * link-config —— 电脑端两份配置文件的读写（`link.json` / `link-peer.json`）。
 *
 * ## 为什么单独一个模块
 *
 * `desktop/index.js` 已经 3000+ 行，而这两份配置的读写逻辑是纯文件操作、
 * 不依赖 Cordis 上下文，适合抽出来单测（见 `tests/link-config.mjs`）。
 * 抽出去之后，`desktop/index.js` 只负责「什么时候读写」，不再重复实现
 * 原子写与合并规则。
 *
 * ## 三条口径
 *
 * 1. **合并写**：只覆盖传入的字段，其余原样保留 —— 用户手工加过的
 *    `resolveSources` / `ddns` 子字段不能被一次保存抹掉。
 * 2. **原子写**：先写 `.tmp` 再 rename，写一半崩了不会留下半截配置。
 * 3. **读容错**：文件不存在 / 坏 JSON 一律当空对象，调用方永远拿到对象，
 *    不需要自己 try/catch。
 *
 * @module dsh-link/desktop/link-config
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 读 JSON 文件；不存在/坏了返回 `null`。 */
function readJson(file) {
	try {
		const parsed = JSON.parse(readFileSync(file, 'utf8'));
		return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
	} catch {
		return null;
	}
}

/** 合并写 JSON（保留其余字段，原子写）。 */
function patchJson(file, dir, patch) {
	const previous = readJson(file) ?? {};
	const next = { ...previous, ...patch };
	mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	return next;
}

/** 读 `link.json`（网关真实监听配置）。 */
export function readLinkConfig(dir) {
	return readJson(join(dir, 'link.json'));
}

/** 合并写 `link.json`。 */
export function patchLinkConfig(dir, patch) {
	return patchJson(join(dir, 'link.json'), dir, patch);
}

/** 合并写 `link-peer.json`。 */
export function patchLinkPeer(dir, patch) {
	return patchJson(join(dir, 'link-peer.json'), dir, patch);
}

/** 通知开关：`link-peer.json` 的 `notify`（`link-notify` 每次发送都会读它）。 */
export function notifyEnabled(dir) {
	const peer = readJson(join(dir, 'link-peer.json'));
	return peer !== null && peer.notify === true;
}
