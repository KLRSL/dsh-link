/**
 * setup-store —— 「安装后配置」的**持久化层**（零依赖）。
 *
 * ## 这个文件管什么
 *
 * 把整套配置（地址 / 配对码 / 工作区 / 隐藏策略 / 会话同步 / 通知 / 已配对设备）
 * 落盘成一个 JSON 文件。三条铁律：
 *
 * 1. **原子写**：先写 `.tmp` 再 `rename`，中途崩了不会留下半截文件，也不会让旧配置消失
 *    —— 配置写坏比「没有配置」更难排查。
 * 2. **读容错**：文件不存在 → 退回默认值；JSON 解析失败 → 退回默认值（坏文件也留着，
 *    调用方想排查可去读 `.corrupt` 副本）。永不因为配置问题直接崩启动。
 * 3. **不内置业务规则**：本文件只管「读 / 写 / 改」，所有判定（地址校验、LWW 合并、
 *    隐藏可见性等）都在 `setup-wizard.js`。store 拿到的是已经算好的新状态。
 *
 * ## 完整状态结构（写在 {@link DEFAULT_SETUP_STATE}）
 *
 * 字段分两类：
 * - 被 `setup-wizard.js` 的 `normalizeSetupConfig()` 归一化的（地址 / 工作区 / 隐藏 / 会话同步 / 通知）；
 * - 本文件自己补的运行时字段（配对码、设备、连接代号、是否已配对）。
 *
 * 只依赖 node 内置模块（`node:fs` / `node:path`），不新增依赖。
 * @module dsh-link/shared/setup-store
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
	DEFAULT_PORT, DEFAULT_SESSION_SYNC, DEFAULT_NOTIFY,
	normalizeSetupConfig,
} from './setup-wizard.js';

/** 完整状态的缺省值（首次安装 / 配置损坏时的起点）。 */
export const DEFAULT_SETUP_STATE = Object.freeze({
	/** 配置结构版本，便于以后做迁移。 */
	version: 1,
	/** 本机角色：电脑端 `desktop` / 手机端 `mobile`。 */
	role: 'desktop',
	/** 地址族。 */
	family: 'ipv4',
	/** 主机（IPv4 字面量 / IPv6 字面量 / 域名）。 */
	host: '',
	/** 网关端口。 */
	port: DEFAULT_PORT,
	/** 是否开启 DDNS 自动跟踪（IPv6 / 域名场景）。 */
	ddns: false,
	/** 地址是否已就绪（通过校验且用户点过「连通」）。 */
	addressReady: false,
	/** 当前配对码记录 `{ code, at, expireAt }`，无码为 `null`。 */
	/** 工作区清单（含墓碑）`[{ path, updatedAt, deleted }]`。 */
	workspaces: [],
	/** 隐藏策略 `path → { ttl, scope, epoch, deviceId }`。 */
	hides: {},
	/** 会话同步配置。 */
	sessionSync: { ...DEFAULT_SESSION_SYNC },
	/** 通知配置。 */
	notify: { ...DEFAULT_NOTIFY },
	/** 已配对设备列表 `[{ id, name, fingerprint, pairedAt }]`。 */
	devices: [],
	/** 连接代号：每次重启 / 重连自增。用于「仅这次」隐藏的时效判定。 */
	epoch: 0,
	/** 是否已配对成功（手机端校验通过 / 电脑端已确认）。 */
	paired: false,
	/** 首次完成配置的时刻（毫秒），未配置为 `null`。 */
	configuredAt: null,
	/**
	 * 首次自动弹出向导的时刻（毫秒）。**有值 = 已经自动弹过一次**：
	 * 之后若仍未配置，只问「是否打开配置页面」，不再直接弹整页。
	 */
	promptedAt: null,
	/**
	 * 是否允许自动打开配置页。用户点「否」后置 false —— 之后不再自动打开、
	 * 也不再询问，直到在设置里「重新启用向导」。这对应产品口径：
	 * 没配置又一次次弹窗是骚扰，用户明确拒绝后插件就等于静默。
	 */
	autoOpen: true,
	/** 用户点「否」的时刻（毫秒；排查用，不参与判定）。 */
	declinedAt: null,
});

/**
 * 把任意「磁盘上的原始对象」收敛成完整状态：
 * 已知字段交给 `normalizeSetupConfig()`，运行时字段用缺省补。
 *
 * @param {object} [raw]
 * @returns {object} 与 {@link DEFAULT_SETUP_STATE} 同构。
 */
export function fullStateFromRaw(raw = {}) {
	const input = raw !== null && typeof raw === 'object' ? raw : {};
	const base = normalizeSetupConfig(input, input?.configuredAt ?? Date.now());
	const devices = Array.isArray(input.devices)
		? input.devices
			.filter((d) => d && typeof d.id === 'string')
			.map((d) => ({
				id: String(d.id),
				name: typeof d.name === 'string' ? d.name : '',
				fingerprint: typeof d.fingerprint === 'string' ? d.fingerprint : '',
				pairedAt: Number.isFinite(Number(d.pairedAt)) ? Number(d.pairedAt) : 0,
			}))
		: [];
	return {
		...base,
		version: Number(input.version) || DEFAULT_SETUP_STATE.version,
		devices,
		epoch: Number.isFinite(Number(input.epoch)) ? Number(input.epoch) : 0,
		paired: input.paired === true,
		promptedAt: finiteOrNull(input.promptedAt),
		autoOpen: input.autoOpen !== false,
		declinedAt: finiteOrNull(input.declinedAt),
	};
}

/** 时间戳字段归一化：非有限数字一律 `null`（不把 NaN 写回盘）。 */
function finiteOrNull(value) {
	if (value === null || value === undefined || value === '') return null;
	const number = Number(value);
	return Number.isFinite(number) ? number : null;
}

/**
 * 创建一个配置存储。
 *
 * @param {object} options
 * @param {string} [options.file] - JSON 文件路径；不传则**纯内存**（不落盘，便于测试）。
 * @param {object} [options.defaults] - 覆盖缺省状态的初始值。
 * @returns {{
 *   load: () => object,
 *   save: (state: object) => object,
 *   update: (mutator: (state: object) => object) => object,
 *   path: (string|null),
 * }}
 */
export function createSetupStore({ file = null, defaults = {} } = {}) {
	const initial = { ...DEFAULT_SETUP_STATE, ...defaults };
	/** 内存模式的当前状态：无 `file` 时靠它持久化，有 `file` 时作为热缓存。 */
	let mem = null;

	/** 读盘 → 完整状态（容错）。 */
	function load() {
		if (mem) return mem;
		if (!file || !existsSync(file)) return fullStateFromRaw(initial);
		let text;
		try {
			text = readFileSync(file, 'utf8');
		} catch {
			return fullStateFromRaw(initial);
		}
		let parsed;
		try {
			parsed = JSON.parse(text);
		} catch {
			// 写坏了：保留坏文件副本，退回缺省，避免静默丢配置。
			try { copyFileSync(file, `${file}.corrupt`); } catch { /* 忽略 */ }
			return fullStateFromRaw(initial);
		}
		return fullStateFromRaw(parsed);
	}

	/** 原子落盘（写临时文件 → rename）。 */
	function save(state) {
		const next = { ...DEFAULT_SETUP_STATE, ...state };
		mem = next;
		if (!file) return next;
		mkdirSync(dirname(file), { recursive: true });
		const tmp = `${file}.tmp`;
		writeFileSync(tmp, JSON.stringify(next, null, 2));
		renameSync(tmp, file);
		return next;
	}

	/** 读 → 改 → 写，一步完成；改函数**必须返回新状态**（不直接改入参）。 */
	function update(mutator) {
		const current = load();
		const next = mutator(current);
		return save(next);
	}

	return { load, save, update, path: file };
}

export default createSetupStore;
