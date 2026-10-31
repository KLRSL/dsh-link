/**
 * pairing-info —— 电脑端「配对码 + 已配对设备」的**完整 id** 视图。
 *
 * ## 为什么需要单独一层
 *
 * `device-auth.readClaimInfo()` 出于展示目的只返回裁短的 8 位 id；但
 * 配置页的「解绑 / 断开全部配对」要调网关的 `devices.revoke()`，它按
 * **完整 id 全等**匹配 —— 拿裁短 id 去撤销永远失败。
 *
 * 这里把 `devices.json` 里的完整 id 按前 8 位贴回去，并把「读文件 + 映射」
 * 这件纯逻辑抽出来单测（见 `tests/pairing-info.mjs`），`desktop/index.js`
 * 只负责把它交给配置页。
 *
 * @module dsh-link/desktop/pairing-info
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { readClaimInfo } from './device-auth.js';

/** 读 `devices.json` 里所有完整 id 与前 8 位。 */
function readFullIds(dir) {
	try {
		const parsed = JSON.parse(readFileSync(join(dir, 'devices.json'), 'utf8'));
		if (!Array.isArray(parsed)) return [];
		return parsed
			.filter((item) => item && typeof item.id === 'string' && item.id !== '')
			.map((item) => ({ id: item.id, short: String(item.id).slice(0, 8) }));
	} catch {
		return [];
	}
}

/**
 * 配对码 + 设备列表（id 为完整值）。
 *
 * @param {string} dir - `$DSH_HOME/dsh-remote`。
 * @returns {{needsClaim: boolean, code: string|null, expiresAt: number|null, devices: Array<object>}}
 */
export function readPairingInfo(dir) {
	const info = readClaimInfo(dir);
	const full = readFullIds(dir);
	const devices = (Array.isArray(info.devices) ? info.devices : []).map((device) => {
		const hit = full.find((row) => row.short === device.id);
		return { ...device, id: hit !== undefined ? hit.id : device.id };
	});
	return { ...info, devices };
}
