/**
 * link-notify —— 电脑端「一轮结束」自动通知手机（子代理式投递）。
 * 协议复用 `scripts/link-install.mjs（同一套投递协议）`：POST {url}/link/agent-message，
 * 头 `content-type` + `x-link-key`，体 `{text, sessionId, from:"desktop"}`。
 * 配置：`%USERPROFILE%\.dsh\dsh-remote\link-peer.json` 加 `"notify": true` 才发，缺省不发
 * （只留一行「notify 跳过（未启用）」）；自检可用 `LINK_PEER_CONFIG` 换配置。
 *
 * 对端选择（v0.3 起支持多台手机）：
 *  - 配置新增 `"devices": [{ deviceId, url, key, certFp? }]`；
 *  - 传了 `deviceId` → 必须命中某条（命中不了 skip `device-not-found`）；
 *  - 没传 `deviceId` → 旧单 `url`+`key` **优先**（旧配置行为完全不变）；
 *  - 没有旧单 → `devices` 恰好 1 条就用它；多条又没指定 → skip `device-ambiguous`。
 *
 * 约定：`rejectUnauthorized:false`（自签）+ `certFp` 非空时先预检指纹。
 * **单次超时 = 20s**（0.1.2 起；配置里有 `timeoutMs` 就用它，上限 {@link NOTIFY_TIMEOUT_MAX_MS} 30s），
 * 预检与 POST 共用同一个值（「整体阈值」就是它）。
 *
 * 0.1.2 修的是「手机刚启动那 ~25 秒」通知发不出去：
 *  1. 预检超时 10s → 20s：手机端 8898 启动期「端口在、TLS 握手不回」时要等得过那一段；
 *  2. 可重试失败补 {@link RETRY_TIMES} 次（间隔 {@link RETRY_DELAYS_MS} 5s / 15s），
 *     总容忍从 23s 拉到 ~80s（20+5+20+15+20），跨得过手机 45s 级静默；
 *  3. 指纹预检缓存 `Map<url, {fp, at}>`：同一 url 预检通过后 5 分钟内跳过预检直接 POST
 *     （手机启动期只有握手回不来、HTTP 是通的，省掉这一次握手就把最大延迟砍掉一半）。
 *     预检失败不写缓存；缓存只在内存，不落盘。
 *
 * 失败分类：
 *  - 可重试 = 网络/TLS 超时类：ETIMEDOUT / ECONNRESET / ECONNREFUSED，
 *    以及它们引起的「TLS 握手超时」「请求超时」（同一类错误，只是发生在预检/请求阶段）。
 *    重试 {@link RETRY_TIMES} 次、间隔 {@link RETRY_DELAYS_MS}；用完仍失败记 `notify 放弃`。
 *  - 不重试 = 证书指纹不符、HTTP 非 200（含 401/403）、配置错、文本为空。
 * 日志里带 `device=<deviceId 前 8 位>`，**绝不记 key**。
 * **从不抛错、从不阻塞会话**（调用方是 `void notifyLink(...)`，重试等待不占会话）。
 * @module dsh-link/link-notify
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { statePathOf } from '../shared/home.js';
import { unwrapHost } from '../shared/net.js';

/** 投递端点（与 link-send.mjs 同路径）。 */
export const ENDPOINT = '/link/agent-message';
/** 默认单次超时 20s（0.1.2 从 10s 放宽：手机启动期 TLS 握手要等 ~22s 才有回应）。 */
export const NOTIFY_TIMEOUT_MS = 20_000;
/** 配置 `timeoutMs` 的硬上限 30s（用户可以调大，但不能无限等）。 */
export const NOTIFY_TIMEOUT_MAX_MS = 30_000;
/** 出站 UA（单包统一身份；旧两包版没有显式头）。 */
export const LINK_UA = 'dsh-link/1.0.0';
/** 补偿重试：2 次，间隔 5s / 15s（0.1.1 是 1 次 / 3s，跨不过手机 45s 静默）。 */
export const RETRY_TIMES = 2;
export const RETRY_DELAYS_MS = Object.freeze([5_000, 15_000]);
/** 兼容旧引用：第一次重试的间隔（= 5s）。新代码请用 {@link RETRY_DELAYS_MS}。 */
export const RETRY_DELAY_MS = RETRY_DELAYS_MS[0];
/** 指纹预检结果的有效期：同一 url 5 分钟内只握手一次。 */
export const FINGERPRINT_TTL_MS = 5 * 60_000;
/** 可重试的错误码（网络/TLS 超时类）。 */
const RETRYABLE_CODES = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED']);
/**
 * 配置文件路径（与 link-send.mjs 同一份）。
 *
 * ⚠️ 曾经写死 `join(homedir(), '.dsh', 'dsh-remote', ...)`（P1-5）：那样
 * **完全忽略 `$DSH_HOME`**，用户一设环境变量就永远读不到 `link-peer.json`，
 * 通知一路打「notify 跳过（配置缺 key）」—— 用户只会以为通知功能没做好，
 * 不会想到是路径读错了地方。现在统一走 `shared/home.js`。
 */
export function configPath() {
	return process.env.LINK_PEER_CONFIG || statePathOf('link-peer.json');
}

/** 指纹预检缓存：`url → { fp, at }`。只在内存（不落盘），进程一退就没了。 */
const fingerprintCache = new Map();

/** 清空预检缓存（自检要逐个场景重算时用；业务代码不需要）。 */
export function clearFingerprintCache() {
	fingerprintCache.clear();
}

/** 看一眼预检缓存（自检/诊断用，返回副本，改不动内部状态）。 */
export function fingerprintCacheSnapshot() {
	return new Map([...fingerprintCache].map(([url, entry]) => [url, { ...entry }]));
}

let sink;

/** 换日志落点（插件传自己的 debugLog，自检传捕获函数；传空恢复默认文件）。 */
export function setLogSink(fn) {
	sink = typeof fn === 'function' ? fn : undefined;
}

/** 写一行日志：有 sink 走 sink，否则追加插件同款 desktop-debug.log。绝不抛、绝不 await。 */
function log(line) {
	try {
		if (sink !== undefined) return void sink(line);
	} catch {
		return;
	}
	void (async () => {
		try {
			const { appendFile, mkdir } = await import('node:fs/promises');
			const { stateDirOf } = await import('../shared/home.js');
			const dir = stateDirOf();
			await mkdir(dir, { recursive: true });
			await appendFile(join(dir, 'desktop-debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
		} catch {
			/* 诊断日志不影响业务 */
		}
	})();
}

/** 指纹统一成大写十六进制（去冒号/空格）。 */
const normalizeFp = (value) => String(value ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();

/** 日志里的指纹只露前 8 个十六进制字符（够认人，不刷屏）。 */
const shortFp = (value) => String(value ?? '').slice(0, 8);

/** 错误 → `"CODE 说明"` 一行文本（日志/重试原因共用）。 */
const describe = (error) => `${String(error?.code ?? '')} ${String(error?.message ?? error)}`.replace(/\s+/g, ' ').trim();

/**
 * 单次超时：配置 `timeoutMs` 优先（正整数，上限 30s），否则默认 20s。
 * 预检与 POST 共用这个值 —— 所谓「整体阈值同步」就是它们不分家。
 */
export function resolveTimeoutMs(config) {
	const raw = Number(config?.timeoutMs);
	if (Number.isFinite(raw) && raw > 0) return Math.min(Math.round(raw), NOTIFY_TIMEOUT_MAX_MS);
	return NOTIFY_TIMEOUT_MS;
}

/**
 * 这个错误算不算「网络/TLS 超时类」——只有这类才重试。
 * ETIMEDOUT 同时覆盖 `tlsConnect` 的「TLS 握手超时」和 `post` 的「请求超时」；
 * 指纹预检阶段的连接失败也是同一个 code，因此一并落在可重试里。
 */
export function isRetryableNetworkError(error) {
	const code = String(error?.code ?? '').toUpperCase();
	if (RETRYABLE_CODES.has(code)) return true;
	// 兜底：少数环境只给中文说明、不带 code。
	return /TLS 握手超时|请求超时/.test(String(error?.message ?? ''));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 读配置：返回 `{ config }` 或 `{ reason }`，不抛。 */
function loadConfig() {
	const path = configPath();
	try {
		const config = JSON.parse(readFileSync(path, 'utf8'));
		if (config && typeof config === 'object' && !Array.isArray(config)) return { config };
		return { reason: '配置不是 JSON 对象' };
	} catch (error) {
		return { reason: `读取/解析配置失败 ${path}: ${String(error?.message ?? error)}` };
	}
}

/**
 * url → 请求目标（必须 https）；不合法时抛，由 notifyLink 统一兜。
 * `url` 字段是规范化后的地址，同时给指纹缓存当 key（同一 url 共用一条缓存）。
 */
function targetOf(url) {
	const base = new URL(String(url ?? '').trim());
	if (base.protocol !== 'https:') throw new Error(`url 必须是 https://: ${base.href}`);
	// ⚠️ new URL 对 IPv6 的 hostname 保留方括号，但 tlsConnect/https 的 hostname 选项
	// 不接受方括号（会当 DNS 名去解析）。交给 socket 前必须 unwrap（见 net.js 文件头事实 2）。
	return { hostname: unwrapHost(base.hostname), port: Number(base.port || 443), path: `${base.pathname.replace(/\/+$/, '')}${ENDPOINT}`, url: base.href };
}

/** 只握手不请求，拿对端证书 fingerprint256（pin 预检）。 */
function peerFingerprint(target, timeoutMs) {
	return new Promise((resolve, reject) => {
		const socket = tlsConnect({ host: target.hostname, port: target.port, rejectUnauthorized: false, timeout: timeoutMs });
		let done = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			socket.destroy();
			if (error) reject(error); else resolve(value);
		};
		socket.on('secureConnect', () => {
			try {
				finish(null, socket.getPeerCertificate()?.fingerprint256 ?? '');
			} catch (error) {
				finish(error);
			}
		});
		socket.on('timeout', () => finish(Object.assign(new Error('TLS 握手超时'), { code: 'ETIMEDOUT' })));
		socket.on('error', finish);
	});
}

/** POST 一条消息，返回 `{ status, body }`。 */
function post(target, key, payload, timeoutMs) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	const options = {
		method: 'POST',
		hostname: target.hostname,
		port: target.port,
		path: target.path,
		rejectUnauthorized: false, // 自签：链不校，要 pin 靠 certFp 预检
		agent: false,
		timeout: timeoutMs,
		headers: {
			'content-type': 'application/json',
			'content-length': body.length,
			'x-link-key': key,
			// ⚠️ 手机网关的写通道要求 ts + nonce（P1-4）。从前这里只带 key，
			// 而网关也只校 key —— 于是**任何一个抓到的包都能无限重放**。
			// 现在两端一起收紧：ts 让旧包过期，nonce 让没过期的包也只能用一次。
			'x-link-ts': String(Date.now()),
			'x-link-nonce': randomUUID(),
			// D 项：电脑→手机同样带单包 UA。
			'user-agent': LINK_UA,
		},
	};
	return new Promise((resolve, reject) => {
		const req = httpsRequest(options, (res) => {
			const chunks = [];
			res.on('data', (chunk) => chunks.push(chunk));
			res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
			res.on('error', reject);
		});
		req.on('timeout', () => req.destroy(Object.assign(new Error('请求超时'), { code: 'ETIMEDOUT' })));
		req.on('error', reject);
		req.end(body);
	});
}

/** 日志用的 device 标签：只露前 8 位；没有就 `-`（绝不记 key）。 */
function deviceTag(value) {
	const text = typeof value === 'string' ? value.trim() : '';
	return text === '' ? '-' : text.slice(0, 8);
}

/** 一条 `devices` 条目 → 请求参数；url/key 缺失返回 skip。 */
function peerOf(entry) {
	const url = typeof entry?.url === 'string' ? entry.url.trim() : '';
	const key = typeof entry?.key === 'string' ? entry.key.trim() : '';
	if (url === '' || key === '') {
		return { skip: { note: `notify 跳过（device=${deviceTag(entry?.deviceId)} 的 devices 条目缺 url/key）`, reason: 'device-config', label: deviceTag(entry?.deviceId) } };
	}
	// targetOf 对非 https 会抛，交给 notifyLink 的 try/catch 统一兜（与旧单配置一致）。
	return { target: targetOf(url), key, certFp: entry?.certFp, label: deviceTag(entry.deviceId) };
}

/**
 * 选对端。返回 `{ target, key, certFp, label }` 或 `{ skip: { note, reason, label } }`。
 *
 * 优先级（顺序不能乱）：
 *  1. 显式 `deviceId` → 必须在 `devices` 里命中，找不到直接跳过（不猜、不乱发）；
 *  2. 旧单 `url`+`key` → 旧配置行为完全不变（单机对端时代的所有用户走这条）；
 *  3. `devices` 恰好 1 条 → 用它；
 *  4. `devices` 多条且未指定 → 跳过（发错手机比不发更糟）。
 */
function resolvePeer(config, deviceId) {
	const devices = Array.isArray(config.devices) ? config.devices : [];
	const wanted = typeof deviceId === 'string' ? deviceId.trim() : '';
	const legacyUrl = typeof config.url === 'string' ? config.url.trim() : '';
	const legacyKey = typeof config.key === 'string' ? config.key.trim() : '';

	if (wanted !== '') {
		const hit = devices.find((item) => item !== null && typeof item === 'object' && !Array.isArray(item) && typeof item.deviceId === 'string' && item.deviceId === wanted);
		if (hit === undefined) {
			return { skip: { note: `notify 跳过（device=${deviceTag(wanted)} 不在 devices 里）`, reason: 'device-not-found', label: deviceTag(wanted) } };
		}
		return peerOf(hit);
	}

	if (legacyUrl !== '' && legacyKey !== '') {
		return { target: targetOf(legacyUrl), key: legacyKey, certFp: config.certFp, label: '-' };
	}
	if (devices.length === 0) {
		// 与旧行为一致：没有 url+key 时按「配置缺 key」跳过。
		if (legacyKey === '' && legacyUrl === '') return { skip: { note: 'notify 跳过（配置缺 key，也没有 devices）', reason: 'key', label: '-' } };
		return { target: targetOf(legacyUrl), key: legacyKey, certFp: config.certFp, label: '-' };
	}
	if (devices.length > 1) {
		return { skip: { note: `notify 跳过（devices 有 ${devices.length} 台且未指定 deviceId）`, reason: 'device-ambiguous', label: '-' } };
	}
	return peerOf(devices[0]);
}

/**
 * 单次尝试。返回三种结局之一，**不抛**业务性失败（抛出来的都是意外，由调用方分类）：
 *  - `{ kind: 'sent', device }`                 发成功（HTTP 200）
 *  - `{ kind: 'skip', note, reason, device }`   终结性失败，note 就是那行日志
 *  - `{ kind: 'retry', reason, device }`        可重试的网络/TLS 超时类失败
 */
async function attemptOnce({ text, from, deviceId, sessionId }) {
	const skip = (note, reason, device = '-') => ({ kind: 'skip', note, reason, device });
	if (typeof text !== 'string' || text === '') return skip('notify 跳过（文本为空）', 'empty-text');
	const { config, reason } = loadConfig();
	if (config === undefined) return skip(`notify 跳过（${reason}）`, 'config');
	if (config.notify !== true) return skip('notify 跳过（未启用）', 'disabled');
	const peer = resolvePeer(config, deviceId);
	if (peer.skip !== undefined) return skip(peer.skip.note, peer.skip.reason, peer.skip.label);
	const timeoutMs = resolveTimeoutMs(config);
	const expected = normalizeFp(peer.certFp);
	// ⚠️⚠️ **没有 pin 就不发**（P1-3）。
	//
	// 从前这里写的是 `if (expected !== '') { …预检… }` —— 没配指纹就**整个跳过
	// 预检直接发**。而 `post()` 带的是 `rejectUnauthorized: false`，也就是
	// 系统 CA 不参与校验：于是「没配 certFp」= 「把 `key` 与整段 AI 输出发给
	// 局域网里任何自称是这台手机的对端」。
	//
	// 改成 fail-closed：没 pin ⇒ 放弃这次通知，并把要做什么写清楚。静默不发
	// 比发错人好，但**必须说清楚为什么不发**，否则运维只会以为「通知功能坏了」。
	if (expected === '') {
		return skip(
			`notify 放弃（device=${peer.label} 未 pin 证书指纹：拒绝向未校验的对端发送 key。` +
				`请在 ${configPath()} 里给这台设备填上 certFp）`,
			'no-pin',
			peer.label,
		);
	}
	{
		const cached = fingerprintCache.get(peer.target.url);
		const fresh = cached !== undefined && cached.fp === expected && Date.now() - cached.at < FINGERPRINT_TTL_MS;
		if (fresh) {
			log(`notify 跳过预检（5 分钟内已校验）device=${peer.label} fp=${shortFp(expected)}`);
		} else {
			let actual;
			try {
				actual = normalizeFp(await peerFingerprint(peer.target, timeoutMs));
			} catch (error) {
				// 预检阶段的网络/TLS 超时（含「TLS 握手超时」）算可重试；其它预检错误不重试。
				const detail = `证书预检失败 ${describe(error)}`;
				if (isRetryableNetworkError(error)) return { kind: 'retry', reason: detail, device: peer.label };
				return skip(`notify 放弃（device=${peer.label} ${detail}）`, 'fingerprint-error', peer.label);
			}
			// ⚠️ 取不到对端证书 = 无法校验，按「不符」处理（曾经这里会因为
			// `actual === ''` 而走到 `actual !== expected` 分支，那是对的，
			// 但显式写出来，免得以后有人把它改成「空就算通过」）。
			if (actual === '' || actual !== expected) {
				// 指纹不符是「配置/安全」问题，不重试、也不写缓存（下次仍会重新校）。
				return skip(`notify 放弃（device=${peer.label} 证书指纹不符 期望=${expected} 实际=${actual || '(空)'}，不重试）`, 'fingerprint', peer.label);
			}
			// 只有预检「通过」才写缓存；失败/不符都写不进来。
			fingerprintCache.set(peer.target.url, { fp: actual, at: Date.now() });
		}
	}
	// 落点固定空串：空 = 让手机端按「最近活跃的非镜像会话」投递；
	// 带电脑会话 id 会落到手机上的镜像副本，叫不醒手机自己的 agent。
	// ⚠️ 0.18.25：允许调用方指定**手机端会话 id**（`sessionId`）。以前这里写死空串，
	// 于是所有通知都落到手机的「通知收口」会话，没法回到发起它的那条对话。
	const response = await post(peer.target, peer.key, { text, sessionId: typeof sessionId === 'string' ? sessionId : '', from }, timeoutMs);
	if (response.status === 200) return { kind: 'sent', device: peer.label };
	// 非 200（401/403 等鉴权失败、网关 5xx）不重试：重发只会再撞一次同样的墙。
	return skip(`notify 发送失败 device=${peer.label} session=(空) HTTP ${response.status} ${response.body.slice(0, 120)}`, 'http', peer.label);
}

/**
 * 把一条文本投给手机 link agent。**从不抛错**，失败只写一行日志；
 * 返回值 `{ sent, reason?, status?, attempts?, device? }` 只给自检/诊断用。
 *
 * 落点（wire 上的 `sessionId`）：0.18.25 起**允许调用方指定**（`sessionId` 参数，
 * 通常是发起这一轮的那个手机会话 id）；不传/传空串时仍固定 `''`——
 * 空 = 让手机端按「最近活跃的非镜像会话」投递；
 * 带电脑会话 id 会落到手机上的镜像副本，叫不醒手机自己的 agent。
 * 所以只在该轮确实是「手机发起、并明确要回投给某个手机会话」时才传；否则留空。
 *
 * `deviceId` 指定发给哪台手机（见 {@link resolvePeer} 的选择优先级）；不传就沿用旧单 url+key。
 *
 * 网络/TLS 超时类失败会按 {@link RETRY_TIMES}/{@link RETRY_DELAYS_MS} 补偿重试 2 次（5s、15s），
 * 途中日志 `notify 重试 1/2（原因）`/`notify 重试 2/2（原因）`，结束后必有一条最终结果日志；
 * 用完仍失败记 `notify 放弃（重试 2/2 后仍失败 原因）`。
 */
export async function notifyLink({ text, from = 'desktop', deviceId, sessionId } = {}) {
	let attempts = 0;
	for (;;) {
		attempts += 1;
		let outcome;
		try {
			outcome = await attemptOnce({ text, from, deviceId, sessionId });
		} catch (error) {
			outcome = isRetryableNetworkError(error)
				? { kind: 'retry', reason: describe(error), device: '-' }
				: { kind: 'skip', note: `notify 异常 ${describe(error)}`, reason: 'error', device: '-' };
		}
		if (outcome.kind === 'sent') {
			log(`notify 发送成功 device=${outcome.device} session=${typeof sessionId === 'string' && sessionId !== '' ? sessionId.slice(0, 21) : '(空)'} HTTP 200`);
			return { sent: true, status: 200, attempts, device: outcome.device };
		}
		if (outcome.kind === 'skip') {
			log(outcome.note);
			return { sent: false, reason: outcome.reason, attempts, device: outcome.device };
		}
		if (attempts <= RETRY_TIMES) {
			log(`notify 重试 ${attempts}/${RETRY_TIMES}（device=${outcome.device} ${outcome.reason}）`);
			await sleep(RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1));
			continue;
		}
		log(`notify 放弃（重试 ${RETRY_TIMES}/${RETRY_TIMES} 后仍失败 device=${outcome.device} ${outcome.reason}）`);
		return { sent: false, reason: 'retry-exhausted', attempts, device: outcome.device };
	}
}
