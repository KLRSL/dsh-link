/**
 * setup-service —— 「安装后配置」的**领域服务层**（零依赖）。
 *
 * ## 这个文件管什么
 *
 * 把「配置弹窗 + 设置页」要做的事，从 HTTP / UI 里抽出来，变成一组纯动作。
 * 上层（HTTP 网关、webview 消息）只负责把请求转成这里的调用、把返回值转成响应；
 * 所有**判定**要么在本文件，要么在 `setup-wizard.js`（规则层）。
 *
 * 依赖：{@link createSetupStore}（持久化）+ `setup-wizard.js`（规则层）。
 *
 * ⚠️ 和 `setup-wizard.js` 一样，三条口径写死在这层（且注释交代原因）：
 *
 * 1. **地址一变，验证码作废重来**：`submitAddress()` 里，family/host/port 任一实质变化
 * 2. **配对不再用码**：手机发起、电脑弹窗确认（v1 起）。
 *    对齐，接进去时同步改那边。
 * 3. **`local` 隐藏绝不上报**：`mergeSync()` 同步前先 `exportableHides()`，手机端
 *    「不想看」不会变成电脑端「没了」。
 *
 * @module dsh-link/shared/setup-service
 */
import { randomInt } from 'node:crypto';
import {
	validateSetupAddress,
	applyWorkspaceOp, syncWorkspaceLists, activeWorkspaces,
	parseHideMode, exportableHides, unbindDevice,
	DEFAULT_SESSION_SYNC, DEFAULT_NOTIFY, KEEP_DAYS_CHOICES, LONG_MIN_CHOICES,
} from './setup-wizard.js';
import { createSetupStore, DEFAULT_SETUP_STATE } from './setup-store.js';

/**
 * 创建一个配置服务。
 *
 * @param {object} options
 * @param {object} [options.store] - 缺省内部建一个纯内存 store；传外部 store 可接真实落盘。
 * @param {() => number} [options.now] - 注入时钟（测试用）。
 * @param {(max: number) => number} [options.random] - 注入随机源（测试用）。
 * @returns {SetupService}
 */
export function createSetupService({ store, now = Date.now, random = (max) => randomInt(max) } = {}) {
	const storage = store ?? createSetupStore({ defaults: {} });

	/** 当前完整状态（按角色决定是否含配对码明文）。 */
	function getState() {
		const s = storage.load();
		const base = {
			version: s.version,
			role: s.role,
			family: s.family,
			host: s.host,
			port: s.port,
			ddns: s.ddns,
			addressReady: s.addressReady,
			workspaces: activeWorkspaces(s.workspaces),
			hides: s.hides,
			sessionSync: s.sessionSync,
			notify: s.notify,
			devices: s.devices,
			paired: s.paired,
			configuredAt: s.configuredAt,
			promptedAt: s.promptedAt,
			autoOpen: s.autoOpen,
			declinedAt: s.declinedAt,
		};
		return base;
	}

	/** 手机端视角：不含配对码明文，只给「是否就绪 / 码状态 / 工作区 / 是否已配对」。 */
	function claimInfo() {
		const s = storage.load();
		return {
			family: s.family,
			host: s.host,
			port: s.port,
			addressReady: s.addressReady,
			workspaces: activeWorkspaces(s.workspaces),
			paired: s.paired,
			configuredAt: s.configuredAt,
			promptedAt: s.promptedAt,
			autoOpen: s.autoOpen,
		};
	}

	/**
	 * 提交地址（① 连接地址）。地址就绪后触发配对码生成。
	 *
	 * - 校验不通过 → 原样返回 `{ ok:false, ... }`，不动状态；
	 * - 校验通过 → `addressReady=true`；family/host/port 任一实质变化 → 旧码作废；
	 *   若此刻无存活码 → 生成新 6 位码（5 分钟）。
	 *
	 * @param {{family?: string, host?: string, port?: number|string, ddns?: boolean}} input
	 * @param {{generateCode?: boolean}} [options] - `generateCode:false` 时不生成本地码。
	 *   电脑端的码由网关（`device-auth`）生成，配置页只显示那一份；本地再生成一个
	 *   只会写进 setup.json 变成一个谁也校验不过的假码（0.2.0 的真实缺陷）。
	 * @returns {{ok: true, state: object} | {ok: false, field: string, reason: string}}
	 */
	function submitAddress(input = {}) {
		const checked = validateSetupAddress(input);
		if (checked.ok !== true) return { ok: false, field: checked.field, reason: checked.reason };
		storage.update((s) => ({
			...s,
			family: checked.family,
			host: checked.host,
			port: checked.port,
			ddns: input.ddns === true,
			addressReady: true,
		}));
		return { ok: true, state: getState() };
	}



	/**
	 * 工作区增删（③ 工作区）。两端都可发起，靠 `applyWorkspaceOp` 记墓碑。
	 *
	 * @param {{kind: 'add'|'remove', path: string}} op - `at` 用服务时钟。
	 * @returns {{ok: true, state: object}}
	 */
	function applyWorkspaceOpApi(op = {}) {
		storage.update((s) => ({ ...s, workspaces: applyWorkspaceOp(s.workspaces, { ...op, at: now() }, now()) }));
		return { ok: true, state: getState('desktop') };
	}

	/**
	 * 双向同步（手机端拉 / 电脑端推，或任一方发全量）。
	 *
	 * - 工作区清单按 `syncWorkspaceLists()` 的 LWW 合并；
	 * - 隐藏记录先用 `exportableHides()` 剔掉 `local`，再按 path 的 `updatedAt` 覆盖合并，
	 *   本端 `local` 项始终保留（永不因对端而丢失）。
	 *
	 * @param {object} input
	 * @param {Array} [input.workspaces] - 对端工作区清单。
	 * @param {object} [input.hides] - 对端隐藏记录（应已是无 `local` 的）。
	 * @returns {{ok: true, added: string[], removed: string[], state: object}}
	 */
	function mergeSync(input = {}) {
		const merged = storage.update((s) => {
			const ws = syncWorkspaceLists(s.workspaces, input.workspaces ?? [], now());
			const remoteHides = exportableHides(input.hides ?? {});
			const hides = { ...s.hides };
			for (const [path, entry] of Object.entries(remoteHides)) {
				const mine = hides[path];
				if (!mine || Number(entry.updatedAt ?? 0) >= Number(mine.updatedAt ?? 0)) hides[path] = entry;
			}
			return { ...s, workspaces: ws.list, hides };
		});
		const a = activeWorkspaces(merged.workspaces);
		const b = activeWorkspaces(input.workspaces ?? []);
		return {
			ok: true,
			added: b.filter((p) => a.includes(p)),
			removed: a.filter((p) => !b.includes(p)),
			state: getState('desktop'),
		};
	}

	/**
	 * 设置某工作区的隐藏方式（④ 隐藏）。
	 *
	 * @param {object} input
	 * @param {string} input.path
	 * @param {'once'|'forever'} input.ttl
	 * @param {'both'|'local'} input.scope
	 * @param {string} [input.deviceId] - `local` 记录归属哪台设备。
	 * @param {string|number} [input.epoch] - 当前连接代号。
	 * @returns {{ok: true, state: object} | {ok: false, reason: string}}
	 */
	function setHide(input = {}) {
		const mode = parseHideMode(`${input.ttl}:${input.scope}`);
		if (mode === null) return { ok: false, reason: '隐藏方式非法（应为 once/forever × both/local）' };
		const path = String(input.path ?? '').trim();
		if (path === '') return { ok: false, reason: '工作区路径不能为空' };
		storage.update((s) => {
			const hides = { ...s.hides };
			hides[path] = {
				ttl: mode.ttl,
				scope: mode.scope,
				epoch: input.epoch ?? s.epoch,
				deviceId: mode.scope === 'local' ? (input.deviceId ?? 'self') : undefined,
				updatedAt: now(),
			};
			return { ...s, hides };
		});
		return { ok: true, state: getState('desktop') };
	}

	/** 取消某工作区的隐藏（恢复显示）。 */
	function clearHide(path) {
		storage.update((s) => {
			const hides = { ...s.hides };
			delete hides[String(path ?? '').trim()];
			return { ...s, hides };
		});
		return { ok: true, state: getState('desktop') };
	}

	/** 读取会话同步 / 通知配置（⑤ ⑥）。 */
	function getConfig() {
		const s = storage.load();
		return { sessionSync: s.sessionSync, notify: s.notify };
	}

	/**
	 * 更新会话同步 / 通知配置。
	 *
	 * 非法值**收敛到默认**而不是报错（与规则层 `tombstoneExpiry` / `shouldNotify`
	 * 的容错口径一致）：存储里不允许出现 `keepDays:-1`、`when:'sometimes'` 这类
	 * 会让下游判据走偏的值。
	 *
	 * @param {object} patch - `{ sessionSync?: Partial, notify?: Partial }`。
	 * @returns {{ok: true, config: object}}
	 */
	function setConfig(patch = {}) {
		storage.update((s) => {
			const sessionSync = { ...s.sessionSync, ...clampSessionSync(pick(patch.sessionSync, ['scope', 'newSync', 'delSync', 'keepDays'])) };
			const notify = { ...s.notify, ...clampNotify(pick(patch.notify, ['on', 'when', 'longMin'])) };
			return { ...s, sessionSync, notify };
		});
		return { ok: true, config: getConfig() };
	}

	/**
	 * 解绑一台设备（⑦ 设备）。
	 *
	 * @param {string} id
	 * @returns {{ok: true, removed: boolean, state: object}}
	 */
	function unbind(id) {
		let removed = false;
		storage.update((s) => {
			const res = unbindDevice(s.devices, id);
			removed = res.removed;
			return { ...s, devices: res.devices, paired: res.devices.length === 0 ? false : s.paired };
		});
		return { ok: true, removed, state: getState('desktop') };
	}

	/**
	 * 重新配对（证书与配对页）：清掉配对码 + 断开配对态，让手机端重新走验证码。
	 * 不清工作区 / 隐藏 / 配置 —— 那些是长期设置，重配对不该动。
	 *
	 * @returns {{ok: true, state: object}}
	 */
	function resetPairing() {
		storage.update((s) => ({ ...s, paired: false }));
		return { ok: true, state: getState('desktop') };
	}

	/** 完成首次配置（弹窗「确认」）：落 `configuredAt`。 */
	function finishSetup() {
		storage.update((s) => ({ ...s, configuredAt: s.configuredAt ?? now() }));
		return { ok: true, state: getState('desktop') };
	}

	/**
	 * 记「已经自动弹过一次」。
	 *
	 * 口径（用户定版）：**装好后的第一次**直接打开配置页；此后再没配置好，
	 * 就只问一句「是否打开配置页面」，不再整页糊脸。所以这个时间戳是
	 * 「下次该改成询问」的唯一依据，写一次就够（`??` 幂等）。
	 *
	 * @returns {{ok: true, state: object}}
	 */
	function markPrompted() {
		storage.update((s) => ({ ...s, promptedAt: s.promptedAt ?? now() }));
		return { ok: true, state: getState('desktop') };
	}

	/**
	 * 用户点了「否」：**以后不再自动打开、也不再询问**（插件等于静默），
	 * 直到在设置里「重新启用向导」。仅记在配置里，不删任何数据。
	 */
	function declinePrompt() {
		storage.update((s) => ({ ...s, autoOpen: false, declinedAt: now() }));
		return { ok: true, state: getState('desktop') };
	}

	/** 设置页「重新启用向导」：恢复自动打开（下次进页面按首启逻辑走）。 */
	function setAutoOpen(on) {
		storage.update((s) => ({
			...s,
			autoOpen: on !== false,
			declinedAt: on === false ? (s.declinedAt ?? now()) : null,
		}));
		return { ok: true, state: getState('desktop') };
	}

	/**
	 * 手机端连接成功后的收尾（电脑端已完成配对码校验）。
	 *
	 * 手机端**没有**本机验证码可校验（码在电脑端生成、电脑端校验），所以不能
	 * 这里只落「已连上」这件事：配对态、设备记录、
	 * 配置完成时刻、连接代号自增（让「仅这次」隐藏失效）。
	 *
	 * @param {{deviceId?: string, name?: string, fingerprint?: string, host?: string, port?: number}} info
	 * @returns {{ok: true, state: object}}
	 */
	function markConnected(info = {}) {
		storage.update((s) => {
			const id = String(info.deviceId ?? '').trim() || `dev-${now()}`;
			const devices = s.devices.some((d) => d.id === id)
				? s.devices.map((d) => (d.id === id ? { ...d, pairedAt: now(), fingerprint: info.fingerprint ?? d.fingerprint, name: info.name ?? d.name } : d))
				: [...s.devices, { id, name: info.name ?? '', fingerprint: info.fingerprint ?? '', pairedAt: now() }];
			return {
				...s,
				paired: true,
				epoch: s.epoch + 1,
				devices,
				configuredAt: s.configuredAt ?? now(),
				host: typeof info.host === 'string' && info.host !== '' ? info.host : s.host,
				port: Number.isInteger(info.port) ? info.port : s.port,
				addressReady: true,
				};
		});
		return { ok: true, state: getState('mobile') };
	}

	/**
	 * 手机端把「电脑地址」落进状态（真正的持久化由传输层的 config 负责，
	 * 这里只保证状态接口与界面看到的是同一个值）。
	 *
	 * @param {{family?: string, host?: string, port?: number|string}} input
	 * @returns {{ok: true, state: object}}
	 */
	function applyAddressInfo(input = {}) {
		const checked = validateSetupAddress({ family: input.family, host: input.host, port: input.port });
		if (checked.ok !== true) return { ok: false, field: checked.field, reason: checked.reason };
		storage.update((s) => ({
			...s,
			family: checked.family,
			host: checked.host,
			port: checked.port,
			addressReady: true,
		}));
		return { ok: true, state: getState('mobile') };
	}

	return {
		getState, claimInfo, submitAddress,
		applyWorkspaceOp: applyWorkspaceOpApi, mergeSync, setHide, clearHide,
		getConfig, setConfig, unbind, resetPairing, finishSetup,
		markPrompted, declinePrompt, setAutoOpen, markConnected, applyAddressInfo,
		/** 暴露底层 store（测试 / 高级接入用）。 */
		store: storage,
	};
}

/** 仅保留白名单字段，过滤掉乱传的未知字段（防配置被污染）。 */
function pick(obj, keys) {
	const out = {};
	if (obj && typeof obj === 'object') for (const k of keys) if (k in obj) out[k] = obj[k];
	return out;
}

/** 会话同步配置收敛：只接受规则层声明过的取值，其余落默认。 */
function clampSessionSync(patch = {}) {
	const out = {};
	if ('scope' in patch) out.scope = patch.scope === 'workspace' ? 'workspace' : DEFAULT_SESSION_SYNC.scope;
	if ('newSync' in patch) out.newSync = patch.newSync === true;
	if ('delSync' in patch) out.delSync = patch.delSync === true;
	if ('keepDays' in patch) {
		const days = Number(patch.keepDays);
		out.keepDays = KEEP_DAYS_CHOICES.includes(days) ? days : DEFAULT_SESSION_SYNC.keepDays;
	}
	return out;
}

/** 通知配置收敛：同上。 */
function clampNotify(patch = {}) {
	const out = {};
	if ('on' in patch) out.on = patch.on === true;
	if ('when' in patch) out.when = ['all', 'error', 'long'].includes(patch.when) ? patch.when : DEFAULT_NOTIFY.when;
	if ('longMin' in patch) {
		const minutes = Number(patch.longMin);
		out.longMin = LONG_MIN_CHOICES.includes(minutes) ? minutes : DEFAULT_NOTIFY.longMin;
	}
	return out;
}

export default createSetupService;
