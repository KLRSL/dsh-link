/**
 * device-auth —— 桌面端 link 网关的「设备白名单 + 首次配网配对码」。
 *
 * 背景：网关一开始只做 TLS 直通，鉴权全交给本机中继（`x-dsh-remote-token`）。
 * 但令牌一旦外带就等于这台电脑的完全控制权，而手机端只保存一份；
 * 所以网关自己再加一层「设备白名单」：手机首次用 6 位配对码 claim 一次，
 * 之后每个请求都要带 `x-link-device` / `x-link-ts` / `x-link-key` 三个头，
 * key = HMAC-SHA256(deviceKey, pathOnly + tsHeader)，配时间戳窗口 + 重放判定。
 *
 * 注意：与协议的一处**有意偏离**（已在评审记录里说明）：`devices.json` 除了规格要求的
 * `keyHash = sha256(deviceKey)`，还额外存了 deviceKey 原文（字段名 `key`）。
 * 原因：白名单要在网关侧**验 HMAC**，而 HMAC 需要 deviceKey 原文；只存 sha256
 * 只能证明「你报的 key 与存的一致」，算不出期望值，等于没法验签。
 * 风险控制：文件 0600（POSIX）+ 原子写（tmp + rename），且 `keyHash` 仍按规格
 * 写入，用于对账/审计（怀疑明文泄漏时可拿它和手机端保存的 key 比对）。
 * 这个取舍与「中继令牌 token.txt 本来就明文落盘」同一风险等级：能读
 * `~/.dsh/dsh-remote/` 的人本来就拿得到中继令牌。
 *
 * 只依赖 node 内置模块，可单独 import 自测（不需要启动 DSH）。
 *
 * @module dsh-link/device-auth
 */
import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { stateDirOf } from '../shared/home.js';

/** 时间戳窗口：±5 分钟。 */
export const TS_WINDOW_MS = 5 * 60 * 1000;
/** 重放判定记录的保留时长：2× 窗口（窗口外的请求本来就过不了 stale-ts）。 */
const REPLAY_TTL_MS = TS_WINDOW_MS * 2;
/** lastSeen/lastIp 落盘节流：同一设备 ≥60s 才写一次。 */
const LAST_SEEN_WRITE_MS = 60_000;
/** 设备 id 形状（手机端生成，URL 安全）。 */
const DEVICE_ID_RE = /^[A-Za-z0-9._-]{6,64}$/;
/** deviceKey 长度与字符约束（不许空白，避免头/JSON 往返时被改写）。 */
const DEVICE_KEY_MIN = 16;
const DEVICE_KEY_MAX = 200;
const DEVICE_NAME_MAX = 64;

/**
 * 配对码**爆破**限速（P1-7）。
 *
 * ## 为什么必须有这一条
 *
 * 码是 6 位数字（10^6 种）、有效 10 分钟、用完即删，而 `/link/claim` 之前
 * **不限次数**。于是局域网里任何人都能这么干：
 *
 * ```
 * 一个请求试一个码 → 10 分钟内发出几十万个请求 → 覆盖掉大半个码空间
 * → 命中一次即取得设备身份 → 拿到这台电脑的控制权
 * ```
 *
 * 码短是为了「从电脑上抄到手机上」这个真实场景，不能靠加长解决；
 * 所以只能压住**尝试次数** —— 猜中概率直接等于「尝试次数 / 10^6」，
 * 把次数压到几十，概率就到 0.005% 量级。
 *
 * ## 为什么是两档（按来源 + 全局）
 *
 * 只按 IP 挡不住换 IP：局域网里改个地址成本极低。只拦全局又会让一个来源
 * 的连续尝试把别人也牵连进来。所以：
 *
 * - `perIpMax`：挡**同一个来源**连续快速试（正常用户手输错几次远达不到）；
 * - `globalMax`：挡**换 IP / 多来源**分摊着试。换 IP 也要从头累计。
 *
 * 全局这一档是真正压住总量的一条。
 *
 * ## 为什么超限是「锁定一段时间」而不是「让码作废」
 *
 * 作废要用户回电脑上重新生成一次，等于把「攻击者刷够次数」变成了
 * 「正常用户被反复骚扰」—— 攻击者发满预算就能让用户永远配不上，那是个 DoS。
 * 锁定则是**计时自动恢复**：用户等一等就能继续，攻击者每刷一轮都要等同样久，
 * 单位时间内的尝试次数被硬性压住。
 *
 * ## ⚠️ 只对「码不对」记账
 *
 * 字段校验失败（`bad-request`）与「当前没有码」（`no-code`）都**不算猜码**：
 * 前者是客户端写错参数，后者是码本来就过期了。把它们计进预算，
 * 会让一个写错字段的手机 App 在几秒内耗光整台电脑的配对额度。
 */
export const CLAIM_GUARD = {
	/** 计失败的窗口，与码的 TTL 同量级。 */
	windowMs: 10 * 60 * 1000,
	/** 单个来源在窗口内允许的失败次数。 */
	perIpMax: 5,
	/** 全局在窗口内允许的失败次数（换 IP 也累计）。 */
	globalMax: 50,
};

/**
 * 默认配置目录：`$DSH_HOME/dsh-remote`（本机 = `%USERPROFILE%\.dsh\dsh-remote`）。
 *
 * ⚠️ 走 `shared/home.js`，不在本文件里再拼一遍 `process.env.DSH_HOME`（P1-5）：
 * 曾经桌面端 index.js 的调试日志、link-notify.js、link-install.mjs 各写了一份，
 * 其中两份**完全忽略环境变量**，症状是「功能静默失效、日志看不出原因」。
 */
function defaultDir() {
	return stateDirOf();
}

/** 默认落点（只作诊断/文档参考；createDeviceAuth 可用 `dir` 覆盖）。 */
export const DEVICES_PATH = join(defaultDir(), 'devices.json');

const sha256Hex = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

/** 日志里只出现 deviceId 前 8 位（完整 id 也不落日志是刻意保守）。 */
function shortId(id) {
	const text = typeof id === 'string' ? id : '';
	return text === '' ? '-' : text.slice(0, 8);
}

/** 取一个头（Node 会把头名小写；顺手兼容数组形式与手写的对象）。 */
function headerOf(headers, name) {
	const raw = headers?.[name];
	if (raw === undefined) return '';
	if (Array.isArray(raw)) return String(raw[0] ?? '').trim();
	return String(raw).trim();
}

/** 远端地址归一化（去掉 IPv6 映射前缀）。 */
function normalizeRemoteIp(remote) {
	const raw = typeof remote === 'string' ? remote : '';
	return raw.startsWith('::ffff:') ? raw.slice(7) : raw;
}

/** 配对码比较前的归一化：去空格/连字符、转大写。 */
function normalizePairCode(value) {
	return String(value ?? '').replace(/[\s-]/g, '').toUpperCase();
}

/**
 * 时间戳头 → 毫秒。长度 ≤10 视为秒（10 位秒到 2286 年，够用），否则视为毫秒。
 * 非十进制整数 / 超安全整数范围 → undefined（调用方按 stale-ts 处理）。
 */
function parseTimestamp(value) {
	if (!/^\d+$/.test(value)) return undefined;
	const number = Number(value);
	if (!Number.isSafeInteger(number)) return undefined;
	return value.length <= 10 ? number * 1000 : number;
}

/** HMAC 期望值 vs 上报值（常量时间比较；长度不是秘密，先挡长度）。 */
function keyMatches(deviceKey, pathOnly, tsHeader, providedKey) {
	const expected = createHmac('sha256', deviceKey).update(`${pathOnly}${tsHeader}`, 'utf8').digest('hex');
	const provided = providedKey.toLowerCase();
	const left = Buffer.from(expected, 'utf8');
	const right = Buffer.from(provided, 'utf8');
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/** 原子写：先写 tmp（0600）再 rename，避免半截 JSON。 */
function writeFileAtomic(file, content, mode) {
	mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
	const tmp = `${file}.tmp-${process.pid}-${randomInt(0, 1_000_000)}`;
	writeFileSync(tmp, content, { encoding: 'utf8', mode });
	try {
		chmodSync(tmp, mode);
	} catch {
		/* Windows 上 chmod 只影响只读位；失败不影响内容 */
	}
	renameSync(tmp, file);
}

/** 单条设备记录归一化；不合法返回 undefined（读取时丢弃）。 */
function normalizeDevice(raw) {
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
	const id = typeof raw.id === 'string' ? raw.id.trim() : '';
	if (!DEVICE_ID_RE.test(id)) return undefined;
	const key = typeof raw.key === 'string' ? raw.key : '';
	if (key.length < DEVICE_KEY_MIN || key.length > DEVICE_KEY_MAX || /\s/.test(key)) return undefined;
	const keyHash = typeof raw.keyHash === 'string' ? raw.keyHash.trim() : '';
	if (keyHash === '') return undefined;
	const text = (value, fallback) => (typeof value === 'string' && value !== '' ? value : fallback);
	const addedAt = text(raw.addedAt, new Date(0).toISOString());
	return {
		id,
		name: text(raw.name, '手机').slice(0, DEVICE_NAME_MAX),
		keyHash,
		key,
		addedAt,
		lastSeen: text(raw.lastSeen, addedAt),
		lastIp: text(raw.lastIp, ''),
	};
}

let sharedDeviceAuth = null;

/** 登记共享实例（由 createDeviceAuth 在创建时调用）。 */
export function setSharedDeviceAuth(instance) {
	sharedDeviceAuth = instance;
}

/** 取共享实例；还没创建时返回 null。 */
export function getSharedDeviceAuth() {
	return sharedDeviceAuth;
}

/**
 * 建一个设备鉴权对象。`dir` 缺省用 `$DSH_HOME/dsh-remote`，自测**必须**传临时目录
 * （不允许碰真实 `~/.dsh`）；`now` 可注入，便于放大/缩小时间验证过期逻辑。
 *
 * @param {{ log?: Function, dir?: string, now?: Function }} [options]
 */
export function createDeviceAuth({ log = () => {}, dir, now = Date.now } = {}) {
	const clock = typeof now === 'function' ? now : () => Date.now();
	const baseDir = typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : defaultDir();
	const devicesPath = join(baseDir, 'devices.json');

	/** 内存即权威：白名单。落盘只在 claim/revoke/节流后的 lastSeen 时发生。 */
	let devices = [];
	/** 重放判定：`${deviceId}|${ts}` → 保留到哪个时刻。 */
	const replaySeen = new Map();
	/** lastSeen 落盘节流：deviceId → 上次写盘时刻。 */
	const lastSeenWrittenAt = new Map();
	/**
	 * 配对码爆破限速的状态（P1-7）。
	 * `global` 记整个实例的失败；`perIp` 按来源记。两者都是「窗口起点 + 计数」，
	 * 窗口过期即整体重置 —— 不需要滑动窗口，锁定粒度就是这么粗也够用。
	 */
	const claimGuard = { global: { start: 0, count: 0 }, perIp: new Map() };

	const info = (line) => {
		try {
			log(line);
		} catch {
			/* 日志失败不影响鉴权 */
		}
	};
	const warn = (line) => {
		try {
			log(line, 'warn');
		} catch {
			/* 同上 */
		}
	};

	function readFromDisk() {
		let raw;
		try {
			raw = readFileSync(devicesPath, 'utf8');
		} catch {
			return []; // 文件不存在/读不了 → 空白名单
		}
		let parsed;
		try {
			parsed = JSON.parse(raw);
		} catch (error) {
			warn(`设备白名单不是合法 JSON，按空处理 ${devicesPath}: ${String(error?.message ?? error)}`);
			return [];
		}
		if (!Array.isArray(parsed)) {
			warn(`设备白名单顶层不是数组，按空处理 ${devicesPath}`);
			return [];
		}
		const list = [];
		for (const item of parsed) {
			const device = normalizeDevice(item);
			if (device !== undefined) list.push(device);
		}
		if (list.length !== parsed.length) warn(`设备白名单丢弃 ${parsed.length - list.length} 条非法条目（${devicesPath}）`);
		return list;
	}

	function writeToDisk() {
		try {
			writeFileAtomic(devicesPath, `${JSON.stringify(devices, null, 2)}\n`, 0o600);
			return true;
		} catch (error) {
			warn(`写设备白名单失败 ${devicesPath}: ${String(error?.message ?? error)}`);
			return false;
		}
	}





	/**
	 * 电脑端授权码弹窗要的状态快照。
	 *
	 * @returns {{needsClaim: boolean, code: string|null, expiresAt: number|null, devices: Array<object>}}
	 */
	function claimInfo() {
		return {
			needsClaim: devices.length === 0,
			pendings: pendingList(clock()),
			devices: devices.map((device) => ({
				id: shortId(device.id),
				name: device.name,
				addedAt: device.addedAt,
				lastSeen: device.lastSeen,
			})),
		};
	}

	function deny(reason, deviceId) {
		warn(`设备鉴权失败 device=${shortId(deviceId)} reason=${reason}`);
		return { ok: false, reason };
	}

	/** 懒清理重放表：只在表变大时扫一遍，避免每请求 O(n)。 */
	function cleanupReplay(current) {
		if (replaySeen.size < 256) return;
		for (const [key, until] of replaySeen) if (until <= current) replaySeen.delete(key);
	}

	/** 成功时更新 lastSeen/lastIp；落盘节流（首次立刻写，之后 ≥60s 一次）。 */
	function touch(device, req) {
		const current = clock();
		device.lastSeen = new Date(current).toISOString();
		device.lastIp = normalizeRemoteIp(req?.socket?.remoteAddress);
		const writtenAt = lastSeenWrittenAt.get(device.id);
		if (writtenAt !== undefined && current - writtenAt < LAST_SEEN_WRITE_MS) return;
		lastSeenWrittenAt.set(device.id, current);
		writeToDisk();
	}

	/**
	 * 验一个请求。`pathOnly` 是 `req.url` 去掉 query 的部分（不含 query）。
	 * 返回 `{ ok: true, device }` 或 `{ ok: false, reason }`；
	 * reason ∈ missing-headers / stale-ts / unknown-device / bad-key / replay。
	 */
	function verify(req, pathOnly) {
		const headers = req?.headers ?? {};
		const deviceId = headerOf(headers, 'x-link-device');
		const tsHeader = headerOf(headers, 'x-link-ts');
		const keyHeader = headerOf(headers, 'x-link-key');
		if (deviceId === '' || tsHeader === '' || keyHeader === '') return deny('missing-headers', deviceId);
		const tsMs = parseTimestamp(tsHeader);
		const current = clock();
		if (tsMs === undefined || Math.abs(current - tsMs) > TS_WINDOW_MS) return deny('stale-ts', deviceId);
		const device = devices.find((item) => item.id === deviceId);
		if (device === undefined) return deny('unknown-device', deviceId);
		if (!keyMatches(device.key, pathOnly, tsHeader, keyHeader)) return deny('bad-key', deviceId);
		// 重放：同一 (device, ts) 只认第一次；记录保留 2× 窗口，过期请求本就过不了 stale-ts。
		const replayKey = `${deviceId}|${tsHeader}`;
		const until = replaySeen.get(replayKey);
		if (until !== undefined && until > current) return deny('replay', deviceId);
		replaySeen.set(replayKey, current + REPLAY_TTL_MS);
		cleanupReplay(current);
		touch(device, req);
		return { ok: true, device: { id: device.id, name: device.name } };
	}

	/**
	 * 爆破限速：这个来源现在**还能不能**试配对码。
	 *
	 * @param {number} current - 当前时刻。
	 * @param {string} ip - 来源地址（空串按「未知来源」处理，仍计入全局）。
	 * @returns {{ locked: boolean, retryAfterMs?: number }} 锁定时给剩余毫秒。
	 */
	function guardCheck(current, ip) {
		const retryAfterMs = (start) => Math.max(0, start + CLAIM_GUARD.windowMs - current);
		const source = typeof ip === 'string' && ip !== '' ? ip : '(unknown)';

		const global = claimGuard.global;
		if (global.start > 0 && current - global.start < CLAIM_GUARD.windowMs && global.count >= CLAIM_GUARD.globalMax) {
			return { locked: true, retryAfterMs: retryAfterMs(global.start) };
		}
		const perIp = claimGuard.perIp.get(source);
		if (perIp !== undefined && current - perIp.start < CLAIM_GUARD.windowMs && perIp.count >= CLAIM_GUARD.perIpMax) {
			return { locked: true, retryAfterMs: retryAfterMs(perIp.start) };
		}
		return { locked: false };
	}

	/** 爆破限速：记一次**猜错**（只应在码确实不对时调用）。 */
	function guardFail(current, ip) {
		const source = typeof ip === 'string' && ip !== '' ? ip : '(unknown)';

		const global = claimGuard.global;
		if (global.start === 0 || current - global.start >= CLAIM_GUARD.windowMs) {
			claimGuard.global = { start: current, count: 1 };
		} else {
			global.count += 1;
		}

		const perIp = claimGuard.perIp.get(source);
		if (perIp === undefined || current - perIp.start >= CLAIM_GUARD.windowMs) {
			claimGuard.perIp.set(source, { start: current, count: 1 });
		} else {
			perIp.count += 1;
		}

		// 顺手清掉已过期的来源，避免长跑后 Map 里堆满只试过一次的 IP。
		for (const [key, value] of claimGuard.perIp) {
			if (current - value.start >= CLAIM_GUARD.windowMs) claimGuard.perIp.delete(key);
		}

		if (global.count === CLAIM_GUARD.globalMax || claimGuard.perIp.get(source)?.count === CLAIM_GUARD.perIpMax) {
			warn(`配对码连续猜错已达上限（本次来自 ${source}，全局第 ${global.count} 次），已临时锁定`);
		}
	}

	/** 爆破限速：配对成功（或码被重置）后清零，别让正常用户背着历史失败数。 */
	function guardReset() {
		claimGuard.global = { start: 0, count: 0 };
		claimGuard.perIp.clear();
	}


	// ── 两段式配对（v1「电脑弹卡片」） ──────────────────────────────────────
	const PAIRING_TTL_MS = 60_000;
	const MAX_PENDING = 3;
	const pendings = new Map();

	function prunePendings(current) {
		for (const [id, item] of pendings) {
			if (item.status === 'pending' && item.expiresAt <= current) item.status = 'expired';
			if (item.status !== 'pending' && current - item.expiresAt > 5 * 60_000) pendings.delete(id);
		}
	}

	function pendingList(current) {
		prunePendings(current);
		return [...pendings.values()]
			.filter((item) => item.status === 'pending')
			.map((item) => ({ id: item.id, deviceId: shortId(item.deviceId), name: item.name, code: item.code, ip: item.ip, expiresAt: item.expiresAt, state: item.status }));
	}

	function checkPairingInput({ deviceId, deviceKey }) {
		const id = typeof deviceId === 'string' ? deviceId.trim() : '';
		if (!DEVICE_ID_RE.test(id)) return { ok: false, error: 'bad-request' };
		if (typeof deviceKey !== 'string' || deviceKey.length < DEVICE_KEY_MIN || deviceKey.length > DEVICE_KEY_MAX) return { ok: false, error: 'bad-request' };
		if (/\s/.test(deviceKey)) return { ok: false, error: 'bad-request' };
		return { ok: true, id };
	}

	function requestPairing({ deviceId, deviceName, deviceKey, ip } = {}) {
		const checked = checkPairingInput({ deviceId, deviceKey });
		if (!checked.ok) return checked;
		const id = checked.id;
		const name = (typeof deviceName === 'string' ? deviceName.trim() : '').slice(0, DEVICE_NAME_MAX) || '手机';
		const current = clock();
		prunePendings(current);
		for (const item of pendings.values()) {
			if (item.status === 'pending' && item.deviceId === id) {
				item.name = name;
				item.key = deviceKey;
				item.keyHash = sha256Hex(deviceKey);
				item.ip = typeof ip === 'string' ? ip : item.ip;
				item.expiresAt = current + PAIRING_TTL_MS;
				return { ok: true, pendingId: item.id, code: item.code, expiresAt: item.expiresAt, reused: true };
			}
		}
		const alive = [...pendings.values()].filter((item) => item.status === 'pending').length;
		if (alive >= MAX_PENDING) return { ok: false, error: 'too-many-pending' };
		const pendingId = randomBytes(8).toString('hex');
		const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
		pendings.set(pendingId, { id: pendingId, deviceId: id, name, key: deviceKey, keyHash: sha256Hex(deviceKey), code, ip: typeof ip === 'string' ? ip : '', createdAt: current, expiresAt: current + PAIRING_TTL_MS, status: 'pending' });
		info(`收到配对请求 device=${shortId(id)}，等待电脑确认`);
		return { ok: true, pendingId, code, expiresAt: current + PAIRING_TTL_MS, reused: false };
	}

	function pairingStatus({ pendingId, deviceKey } = {}) {
		const current = clock();
		prunePendings(current);
		const item = pendings.get(String(pendingId));
		if (item === undefined) return { ok: false, error: 'not-found' };
		if (typeof deviceKey !== 'string' || sha256Hex(deviceKey) !== item.keyHash) return { ok: false, error: 'forbidden' };
		if (item.status === 'approved') return { ok: true, state: 'approved', deviceId: item.deviceId };
		return { ok: true, state: item.status, code: item.code, expiresAt: item.expiresAt };
	}

	function approvePairing({ pendingId } = {}) {
		const current = clock();
		prunePendings(current);
		const item = pendings.get(String(pendingId));
		if (item === undefined) return { ok: false, error: 'not-found' };
		if (item.status !== 'pending') return { ok: false, error: item.status };
		const nowIso = new Date(current).toISOString();
		const existing = devices.find((entry) => entry.id === item.deviceId);
		if (existing !== undefined) {
			existing.keyHash = item.keyHash;
			existing.key = item.key;
			existing.name = item.name;
			existing.lastSeen = nowIso;
			if (item.ip !== '') existing.lastIp = item.ip;
		} else {
			devices.push({ id: item.deviceId, name: item.name, keyHash: item.keyHash, key: item.key, addedAt: nowIso, lastSeen: nowIso, lastIp: item.ip });
		}
		writeToDisk();
		lastSeenWrittenAt.set(item.deviceId, current);
		item.status = 'approved';
		info(`已允许设备 ${shortId(item.deviceId)}（${item.name}）`);
		return { ok: true, deviceId: item.deviceId };
	}

	function rejectPairing({ pendingId } = {}) {
		prunePendings(clock());
		const item = pendings.get(String(pendingId));
		if (item === undefined) return { ok: false, error: 'not-found' };
		if (item.status !== 'pending') return { ok: false, error: item.status };
		item.status = 'rejected';
		info(`已拒绝配对请求 device=${shortId(item.deviceId)}`);
		return { ok: true };
	}

	/** 撤销一台设备并落盘。 */
	function revoke(deviceId) {
		const id = typeof deviceId === 'string' ? deviceId.trim() : '';
		if (id === '') return { ok: false };
		const before = devices.length;
		devices = devices.filter((item) => item.id !== id);
		if (devices.length === before) return { ok: false };
		writeToDisk();
		lastSeenWrittenAt.delete(id);
		for (const key of replaySeen.keys()) if (key.startsWith(`${id}|`)) replaySeen.delete(key);
		info(`已撤销设备 ${shortId(id)}`);
		return { ok: true };
	}

	devices = readFromDisk();

	const api = {
		get devices() {
			return devices;
		},
		claimInfo,
		verify,
		requestPairing,
		pairingStatus,
		approvePairing,
		rejectPairing,
		revoke,
	};

	setSharedDeviceAuth(api);
	return api;
}

/**
 * 从磁盘读一份「授权码弹窗」状态快照 —— **不依赖任何运行中的实例**。
 *
 * 用途：`desktop/index.js` 把 `GET /api/dsh-remote/link/claim-info` 挂在 DSH 自己的
 * Web 端口上，而设备白名单与配对码是网关（`link-gateway.js` 里的
 * `createDeviceAuth`）在维护的。两边读同一批文件即可，不必把实例传出来。
 *
 * 语义与实例的 `claimInfo()` 完全一致：
 * - `needsClaim` = 白名单里合法设备数 = 0；
 * - `code`/`expiresAt` = 文件里**还没过期**的码，过期或没有 → `null`；
 * - `devices` 只给展示用的四个字段（id 取前 8 位），**绝不含 deviceKey / keyHash**。
 *
 * @param {string} [dir] - 配置目录；缺省 `$DSH_HOME/dsh-remote`。
 * @param {() => number} [now] - 时钟（自测注入）。
 * @returns {{needsClaim: boolean, code: string|null, expiresAt: number|null, devices: Array<object>}}
 */
export function readClaimInfo(dir, now = Date.now) {
	const baseDir = typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : defaultDir();
	const devicesPath = join(baseDir, 'devices.json');
	const clock = typeof now === 'function' ? now : () => Number(now) || Date.now();

	let devices = [];
	try {
		const parsed = JSON.parse(readFileSync(devicesPath, 'utf8'));
		if (Array.isArray(parsed)) {
			devices = parsed
				.map((item) => normalizeDevice(item))
				.filter((item) => item !== undefined)
				.map((device) => ({
					id: shortId(device.id),
					name: device.name,
					addedAt: device.addedAt,
					lastSeen: device.lastSeen,
				}));
		}
	} catch {
		/* 文件不存在 / 坏 JSON → 空白名单（弹窗照常显示配对码） */
	}

	return { needsClaim: devices.length === 0, devices };
}
