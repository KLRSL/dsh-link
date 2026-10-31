/**
 * setup-wizard —— 「安装后一次性配置弹窗」+「设置页」的**规则层**。
 *
 * ## 这个文件管什么
 *
 * UI（弹窗三段 / 设置页六组）只负责画，所有**判定**都收在这里，理由是：
 * UI 改一版不会把规则改歪，而且规则能脱离 DOM 单测（见 `tests/setup-wizard.mjs`）。
 *
 * 覆盖八件事：
 *
 * | 段 | 函数族 | 说明 |
 * |---|---|---|
 * | ① 地址 | `validateSetupAddress` / `selectAutoAddress` | IPv4 自动填、IPv6 手填或域名、端口 |
 * | ② 配对 | 手机发起 → 电脑弹窗确认（v1 起不再有验证码） |
 * | ③ 工作区 | `applyWorkspaceOp` / `syncWorkspaceLists` | 增删双向同步，LWW 合并 |
 * | ④ 隐藏 | `parseHideMode` / `visibleWorkspaces` / `exportableHides` | 仅这次/永久 × 两端/本机 |
 * | ⑤ 会话同步 | `shouldSyncSession` / `tombstoneExpiry` | 新建与删除互见 |
 * | ⑥ 通知 | `shouldNotify` | 每轮/仅出错/仅长任务 |
 * | ⑦ 设备 | `unbindDevice` | 解绑 |
 * | ⑧ 配置 | `normalizeSetupConfig` | 宽容读盘 + 缺省值 |
 *
 * ## ⚠️ 三条容易做错的口径（都是和产品口径对齐过的，别顺手改）
 *
 * 1. **配对不再需要验证码**（v1 起）：手机发起、电脑弹窗确认。
 *    先看地址是否已就绪；地址一变（改地址、切地址族）码立即作废重来 ——
 *    否则会出现「拿着旧地址生成的码去连新地址」。
 * 2. **工作区清单的冲突按 LWW 合并，删除也算一次写入**。不是「删除优先」也不是
 *    「新增优先」：谁后发生谁生效，时刻相同则删除胜（删除是更强的意图）。
 *    用「删除优先」会导致电脑端刚删、手机端一次旧同步就把僵尸目录加回来。
 * 3. **`仅本机` 的隐藏不上报**。同步给对端前必须过 `exportableHides()`，
 *    否则「我手机上不想看见」会变成「电脑上也没了」——那是数据丢失，不是显示偏好。
 *
 * 只依赖 node 内置模块，不新增依赖，可单独 import 自测。
 * @module dsh-link/shared/setup-wizard
 */

// ─────────────────────────── ① 连接地址 ───────────────────────────

/** 配置弹窗里能选的地址族（只有二选一；`dual` 是监听侧的口径，不属于用户选项）。 */
export const SETUP_FAMILIES = Object.freeze(['ipv4', 'ipv6']);
/** 电脑网关端口。 */
export const DEFAULT_PORT = 8899;
/** 端口合法区间（含）。 */
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

const IPV4_RE = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^\[?[0-9A-Fa-f:]{2,}\]?$/;
const HOST_RE = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)(\.(?!-)[A-Za-z0-9-]{1,63}(?<!-))+$/;

/**
 * 判定一个主机名的类型。
 *
 * @param {string} text
 * @returns {'ipv4'|'ipv6'|'host'|'empty'|'bad'}
 */
export function classifySetupHost(text) {
	const value = String(text ?? '').trim();
	if (value === '') return 'empty';
	if (IPV4_RE.test(value)) return 'ipv4';
	// 只剩数字和点，却不是合法 IPv4（`192.168.1.256` 这种）：它不是域名，
	// 放过去会被当成主机名拿去连，报错还难查 —— 直接判坏。
	if (/^[0-9.]+$/.test(value)) return 'bad';
	// IPv6 必须含冒号，且允许 `[2408::1]` 这种带方括号的写法（URL authority 口径）。
	if (value.includes(':') && IPV6_RE.test(value)) return 'ipv6';
	if (HOST_RE.test(value)) return 'host';
	return 'bad';
}

/**
 * 校验「地址族 + 主机 + 端口」这一组输入。
 *
 * - IPv4 只接受 IPv4 字面量（局域网场景，填域名没有意义且容易误导）；
 * - IPv6 接受 IPv6 字面量**或域名**（DDNS 场景：有的人只有域名）；
 * - 端口缺省 {@link DEFAULT_PORT}，越界即拒（不静默收敛，避免用户以为生效了）。
 *
 * @param {object} input
 * @param {'ipv4'|'ipv6'} [input.family] - 缺省 ipv4。
 * @param {string} [input.host]
 * @param {string|number} [input.port]
 * @returns {{ok: true, family: string, host: string, port: number, kind: string}
 *   | {ok: false, reason: string, field: 'family'|'host'|'port'}}
 */
export function validateSetupAddress({ family = 'ipv4', host = '', port = DEFAULT_PORT } = {}) {
	if (!SETUP_FAMILIES.includes(family)) return { ok: false, field: 'family', reason: `地址族必须是 ${SETUP_FAMILIES.join(' / ')}` };
	const kind = classifySetupHost(host);
	if (kind === 'empty') return { ok: false, field: 'host', reason: '地址不能为空' };
	if (family === 'ipv4' && kind !== 'ipv4') return { ok: false, field: 'host', reason: '选了 IPv4 就填 IPv4 地址（域名请切到 IPv6）' };
	if (family === 'ipv6' && kind !== 'ipv6' && kind !== 'host') return { ok: false, field: 'host', reason: '选了 IPv6 就填 IPv6 地址或域名' };
	const portNumber = Number(port);
	if (!Number.isInteger(portNumber) || portNumber < PORT_MIN || portNumber > PORT_MAX) {
		return { ok: false, field: 'port', reason: `端口必须是 ${PORT_MIN}-${PORT_MAX} 的整数` };
	}
	return { ok: true, family, host: String(host).trim().replace(/^\[|\]$/g, ''), port: portNumber, kind };
}

/**
 * 从候选地址里挑一个自动填的值（电脑端「自动获取」/ 手机端「自动查找」共用）。
 *
 * ⚠️ 纯函数：候选由调用方采集（电脑端读网卡、手机端收广播），本函数只负责挑，
 * 这样规则可测、且不把「采集」和「选择」耦在一起。
 *
 * 优先：IPv4 取私网段（192.168/10/172.16-31），其次其它非回环；
 * IPv6 取 ULA（`fc00::/7`）优先，其次全局地址 —— 全局地址要暴露到公网，
 * 只有在没有 ULA 时才选，且调用方仍需 `allowGlobal` 显式放行。
 *
 * @param {Array<{address: string, family?: string}>} candidates
 * @param {'ipv4'|'ipv6'} family
 * @returns {string} 选中的地址；没有合适的返回 `''`。
 */
export function selectAutoAddress(candidates, family = 'ipv4') {
	const list = Array.isArray(candidates) ? candidates : [];
	const texts = list.map((item) => String(item?.address ?? item ?? '').trim()).filter((text) => text !== '');
	if (family === 'ipv4') {
		const priv = texts.find((t) => /^192\.168\./.test(t)) ?? texts.find((t) => /^10\./.test(t))
			?? texts.find((t) => /^172\.(1[6-9]|2\d|3[01])\./.test(t));
		if (priv !== undefined) return priv;
		return texts.find((t) => IPV4_RE.test(t) && !t.startsWith('127.')) ?? '';
	}
	const ula = texts.find((t) => /^f[cd][0-9a-f]{2}:/i.test(t));
	if (ula !== undefined) return ula;
	return texts.find((t) => t.includes(':') && !t.startsWith('::1')) ?? '';
}

// ─────────────────────────── ③ 工作区清单（双向同步） ───────────────────────────

/**
 * 往清单里加/删一个工作区。
 *
 * 删除是**记一条 deleted 记录**（墓碑），不是直接抹掉 —— 否则对端一次全量同步
 * 就会把它当作「本地没有、对端有」给加回来。
 *
 * @param {Array<{path: string, updatedAt?: number, deleted?: boolean}>} list
 * @param {{kind: 'add'|'remove', path: string, at?: number}} op
 * @param {number} [now]
 * @returns {Array<{path: string, updatedAt: number, deleted: boolean}>} 新数组（不改原数组）。
 */
export function applyWorkspaceOp(list, op, now = Date.now()) {
	const source = Array.isArray(list) ? list : [];
	const path = String(op?.path ?? '').trim();
	if (path === '' || (op?.kind !== 'add' && op?.kind !== 'remove')) return source.map(normalizeWorkspaceEntry);
	const at = Number(op.at ?? now);
	const next = source.map(normalizeWorkspaceEntry).filter((item) => item.path !== path);
	next.push({ path, updatedAt: at, deleted: op.kind === 'remove' });
	return next;
}

/** 单条记录归一化（缺字段按「很早以前存在」处理）。 */
function normalizeWorkspaceEntry(item) {
	return {
		path: String(item?.path ?? '').trim(),
		updatedAt: Number(item?.updatedAt ?? 0),
		deleted: item?.deleted === true,
	};
}

/**
 * 合并两端的工作区清单（双向同步的核心）。
 *
 * ## 规则：按 path 逐条 LWW（Last-Write-Wins）
 *
 * - `updatedAt` 大的那条生效；
 * - **时刻相同则 `deleted` 胜** —— 同刻一个加一个删，删除是更强的意图；
 * - 只有一端有的 path，直接保留（不因为「对端没有」就删掉，那是没同步过）。
 *
 * ⚠️ 为什么不是「删除优先」：手机端离线一天后再同步，会带着昨天的「新增」
 * 去覆盖电脑端今天的「删除」，僵尸目录复活。LWW 用时刻决定，旧写入永远赢不了新写入。
 *
 * @param {Array} local
 * @param {Array} remote
 * @returns {{list: Array<{path: string, updatedAt: number, deleted: boolean}>, added: string[], removed: string[]}}
 *   合并结果，以及相对 local 的净变化（给 UI 提示用）。
 */
export function syncWorkspaceLists(local, remote) {
	const a = (Array.isArray(local) ? local : []).map(normalizeWorkspaceEntry).filter((item) => item.path !== '');
	const b = (Array.isArray(remote) ? remote : []).map(normalizeWorkspaceEntry).filter((item) => item.path !== '');
	const merged = new Map();
	for (const item of a) merged.set(item.path, item);
	for (const item of b) {
		const mine = merged.get(item.path);
		if (mine === undefined) { merged.set(item.path, item); continue; }
		if (item.updatedAt > mine.updatedAt || (item.updatedAt === mine.updatedAt && item.deleted && !mine.deleted)) {
			merged.set(item.path, item);
		}
	}
	const list = [...merged.values()].sort((x, y) => x.path.localeCompare(y.path));
	const before = new Set(a.filter((item) => !item.deleted).map((item) => item.path));
	const after = new Set(list.filter((item) => !item.deleted).map((item) => item.path));
	return {
		list,
		added: [...after].filter((p) => !before.has(p)),
		removed: [...before].filter((p) => !after.has(p)),
	};
}

/** 清单里「当前可见」的工作区路径（去掉墓碑）。 */
export function activeWorkspaces(list) {
	return (Array.isArray(list) ? list : []).map(normalizeWorkspaceEntry)
		.filter((item) => item.path !== '' && !item.deleted)
		.map((item) => item.path);
}

// ─────────────────────────── ④ 隐藏（时效 × 范围） ───────────────────────────

/** 时效：`once` = 仅这次（连接断开即恢复）；`forever` = 永久（手动恢复前一直隐藏）。 */
export const HIDE_TTLS = Object.freeze(['once', 'forever']);
/** 范围：`both` = 两端同步；`local` = 仅本机（不上报）。 */
export const HIDE_SCOPES = Object.freeze(['both', 'local']);

/**
 * 解析隐藏方式键（`'once:both'`）。
 *
 * @param {string} key
 * @returns {{ttl: string, scope: string}|null} 非法返回 null（调用方按「不隐藏」处理，fail-closed 到可见）。
 */
export function parseHideMode(key) {
	const text = String(key ?? '').trim();
	const [ttl, scope] = text.split(':');
	if (!HIDE_TTLS.includes(ttl) || !HIDE_SCOPES.includes(scope)) return null;
	return { ttl, scope };
}

/**
 * 某一时刻、某台设备上，这个工作区是不是隐藏的。
 *
 * - `forever` → 恒隐藏；
 * - `once` → 只在**记下时的那一次连接**（`epoch` 相同）内隐藏；换一次连接自动恢复；
 * - `local` → 只影响记下它的那台设备（`deviceId` 相同）。
 *
 * @param {{ttl?: string, scope?: string, epoch?: string|number, deviceId?: string}} [entry]
 * @param {object} ctx
 * @param {string|number} [ctx.epoch] - 当前连接代号（每次连接/重启换一个）。
 * @param {string} [ctx.deviceId] - 当前设备 id。
 * @returns {boolean}
 */
export function isHidden(entry, { epoch, deviceId } = {}) {
	if (!entry || typeof entry !== 'object') return false;
	if (entry.scope === 'local' && entry.deviceId !== undefined && deviceId !== undefined && entry.deviceId !== deviceId) return false;
	if (entry.ttl === 'once' && String(entry.epoch ?? '') !== String(epoch ?? '')) return false;
	return true;
}

/**
 * 过滤出当前可见的工作区。
 *
 * @param {string[]} paths
 * @param {Record<string, object>} hideMap - path → 隐藏记录。
 * @param {object} ctx - 同 {@link isHidden}。
 * @returns {string[]}
 */
export function visibleWorkspaces(paths, hideMap = {}, ctx = {}) {
	return (Array.isArray(paths) ? paths : []).filter((path) => !isHidden(hideMap[path], ctx));
}

/**
 * 同步给对端时要带上的隐藏记录：**剔掉 `local`**。
 *
 * ⚠️ 这一步是「显示偏好」与「数据」的分界线。少了它，手机上「我不想看」
 * 会变成电脑上「这个工作区没了」。
 *
 * @param {Record<string, object>} hideMap
 * @returns {Record<string, object>}
 */
export function exportableHides(hideMap = {}) {
	const out = {};
	for (const [path, entry] of Object.entries(hideMap ?? {})) {
		if (entry?.scope === 'local') continue;
		out[path] = entry;
	}
	return out;
}

// ─────────────────────────── ⑤ 会话同步 ───────────────────────────

/** 会话同步缺省值：全部会话、新建与删除都互见、删除保留 30 天。 */
export const DEFAULT_SESSION_SYNC = Object.freeze({ scope: 'all', newSync: true, delSync: true, keepDays: 30 });
/** 「不限」档：保留期永不到期（同步时不按 `updatedAt` 拦任何会话，墓碑也不过期）。 */
export const KEEP_DAYS_FOREVER = -1;
/** 允许的保留天数（0 = 不保留，即硬删除；-1 = 不限）。 */
export const KEEP_DAYS_CHOICES = Object.freeze([0, 7, 30, 90, KEEP_DAYS_FOREVER]);

/**
 * 这个会话要不要同步到对端。
 *
 * @param {object} [cfg]
 * @param {{inWorkspace?: boolean}} [session]
 * @returns {boolean}
 */
export function shouldSyncSession(cfg = DEFAULT_SESSION_SYNC, session = {}) {
	const scope = cfg?.scope === 'workspace' ? 'workspace' : 'all';
	if (scope === 'workspace' && session?.inWorkspace !== true) return false;
	return true;
}

/**
 * 删除的墓碑什么时候彻底消失。
 *
 * @param {object} [cfg]
 * @param {number} [deletedAt]
 * @returns {number} 到期时刻；`keepDays=0` 时等于 `deletedAt`（即硬删除、立即可回收）；
 *   `keepDays=-1`（不限）时是 `Infinity`（永不过期）。
 */
export function tombstoneExpiry(cfg = DEFAULT_SESSION_SYNC, deletedAt = Date.now()) {
	const days = Number(cfg?.keepDays ?? DEFAULT_SESSION_SYNC.keepDays);
	const keep = KEEP_DAYS_CHOICES.includes(days) ? days : DEFAULT_SESSION_SYNC.keepDays;
	if (keep === KEEP_DAYS_FOREVER) return Number.POSITIVE_INFINITY;
	return deletedAt + keep * 24 * 60 * 60 * 1000;
}

// ─────────────────────────── ⑥ 通知推送 ───────────────────────────

/** 通知缺省值：开、每轮完成都推。 */
export const DEFAULT_NOTIFY = Object.freeze({ on: true, when: 'all', longMin: 5 });
/** 长任务阈值档位（分钟）。 */
export const LONG_MIN_CHOICES = Object.freeze([2, 5, 15]);

/**
 * 这一轮跑完要不要推送。
 *
 * @param {object} [cfg]
 * @param {object} turn
 * @param {boolean} [turn.error] - 这一轮是否出错。
 * @param {number} [turn.durationMs] - 这一轮耗时。
 * @returns {boolean}
 */
export function shouldNotify(cfg = DEFAULT_NOTIFY, turn = {}) {
	if (cfg?.on !== true) return false;
	const when = cfg?.when === 'error' ? 'error' : cfg?.when === 'long' ? 'long' : 'all';
	if (when === 'error') return turn?.error === true;
	if (when === 'long') {
		const minutes = Number(cfg?.longMin ?? DEFAULT_NOTIFY.longMin);
		const threshold = (LONG_MIN_CHOICES.includes(minutes) ? minutes : DEFAULT_NOTIFY.longMin) * 60_000;
		return Number(turn?.durationMs ?? 0) >= threshold;
	}
	return true;
}

// ─────────────────────────── ⑦ 设备 ───────────────────────────

/**
 * 解绑一台设备（从白名单里摘掉）。
 *
 * @param {Array<{id?: string}>} devices
 * @param {string} id
 * @returns {{devices: Array, removed: boolean}}
 */
export function unbindDevice(devices, id) {
	const list = Array.isArray(devices) ? devices : [];
	const target = String(id ?? '').trim();
	if (target === '') return { devices: list, removed: false };
	const next = list.filter((item) => String(item?.id ?? '') !== target);
	return { devices: next, removed: next.length !== list.length };
}

// ─────────────────────────── ⑧ 配置归一化 ───────────────────────────

/**
 * 宽容读盘 + 补缺省值：坏字段**退回缺省**而不是抛错（配置写坏了也要能开得起来，
 * 看得见问题在哪，比直接崩掉好排查）。
 *
 * @param {object} [raw]
 * @param {number} [now]
 * @returns {{
 *   role: 'desktop'|'mobile', family: 'ipv4'|'ipv6', host: string, port: number,
 *   ddns: boolean, addressReady: boolean, workspaces: Array, hides: Object,
 *   sessionSync: object, notify: object, configuredAt: number|null
 * }}
 */
export function normalizeSetupConfig(raw = {}, now = Date.now()) {
	const input = raw !== null && typeof raw === 'object' ? raw : {};
	const family = SETUP_FAMILIES.includes(input.family) ? input.family : 'ipv4';
	const port = Number(input.port);
	const workspaces = Array.isArray(input.workspaces) ? input.workspaces.map(normalizeWorkspaceEntry).filter((item) => item.path !== '') : [];
	const hides = {};
	for (const [path, entry] of Object.entries(input.hides ?? {})) {
		if (parseHideMode(`${entry?.ttl}:${entry?.scope}`) === null) continue;
		hides[path] = { ttl: entry.ttl, scope: entry.scope, epoch: entry.epoch, deviceId: entry.deviceId };
	}
	const sync = input.sessionSync ?? {};
	const notify = input.notify ?? {};
	return {
		role: input.role === 'mobile' ? 'mobile' : 'desktop',
		family,
		host: typeof input.host === 'string' ? input.host.trim() : '',
		port: Number.isInteger(port) && port >= PORT_MIN && port <= PORT_MAX ? port : DEFAULT_PORT,
		ddns: input.ddns === true,
		addressReady: input.addressReady === true,
		workspaces,
		hides,
		sessionSync: {
			scope: sync.scope === 'workspace' ? 'workspace' : 'all',
			newSync: sync.newSync !== false,
			delSync: sync.delSync !== false,
			keepDays: KEEP_DAYS_CHOICES.includes(Number(sync.keepDays)) ? Number(sync.keepDays) : DEFAULT_SESSION_SYNC.keepDays,
		},
		notify: {
			on: notify.on !== false,
			when: notify.when === 'error' ? 'error' : notify.when === 'long' ? 'long' : 'all',
			longMin: LONG_MIN_CHOICES.includes(Number(notify.longMin)) ? Number(notify.longMin) : DEFAULT_NOTIFY.longMin,
		},
		configuredAt: (input.configuredAt !== null && input.configuredAt !== undefined && Number.isFinite(Number(input.configuredAt)))
			? Number(input.configuredAt) : null,
	};
}

/**
 * 弹窗三段是否全部就绪（决定「确认」能不能点）。
 *
 * @param {object} setup - {@link normalizeSetupConfig} 的结果。
 * @param {object} [extra]
 * @param {boolean} [extra.workspaceSynced] - 手机端工作区是否已同步到。
 * @returns {{ready: boolean, pending: 'address'|'workspace'|null}}
 */
export function setupProgress(setup, { workspaceSynced = false } = {}) {
	const address = validateSetupAddress({ family: setup?.family, host: setup?.host, port: setup?.port });
	if (address.ok !== true || setup?.addressReady !== true) return { ready: false, pending: 'address' };
	if (setup.role === 'desktop') {
		if (activeWorkspaces(setup.workspaces).length === 0) return { ready: false, pending: 'workspace' };
	} else if (workspaceSynced !== true || activeWorkspaces(setup.workspaces).length === 0) {
		return { ready: false, pending: 'workspace' };
	}
	return { ready: true, pending: null };
}
