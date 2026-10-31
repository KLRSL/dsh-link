/**
 * 局域网直连网关 · v3：TLS 流式直通 + 设备白名单（配对码 claim）。
 *
 * 作用：手机（同局域网）用 node:https 直连 `listen:port`（默认 0.0.0.0:8899），
 * TLS 由本模块的自签证书保证；HTTP 请求原样 pipe 到本机中继
 * http://127.0.0.1:17890（固定中继端口，配置项 `upstreamPort`），响应也原样
 * pipe 回去 —— 不解密、不缓冲，所以 SSE / chunked 能逐块到达手机。
 *
 * 证书：`<配置目录>/link-cert.pem` + `link-key.pem`。首次启动（或证书不可用）
 * 用 node:crypto 现场生成 ECDSA P-256 自签证书（纯 Node ASN.1/DER 编码，
 * 不调用 openssl、不新增依赖），私钥权限 0600（POSIX）/ 仅本机可读。
 * 启动日志打印证书 SHA-256 指纹（与 Node tls 的 fingerprint256 同一格式），手机端 pin 它。
 *
 * 鉴权（v3 起网关自己先挡一层，见 `device-auth.js`）：
 *  - `GET /link/ping` 允许匿名（只回版本/指纹，绝不带设备列表）；带了
 *    `x-link-device` 头就走签名校验，通过回 200、失败 403。
 *  - `POST /link/claim` 用 5 分钟有效的 6 位配对码换设备授权，**不转发上游**。
 *  - `POST /link/revoke` 验签后撤销当前设备，**不转发上游**。
 *  - 其余任何请求：验签失败一律 403 且**绝不转发**；通过后删掉
 *    `x-link-device` / `x-link-ts` / `x-link-key` 三个头（密钥不进中继日志），
 *    再给 `x-dsh-remote-token` 补上**中继此刻真正校验的那把令牌**。
 *
 * ## ⚠️ 令牌：0.1.1 修的 401（不要改回「只读 token.txt」）
 *
 * 中继（`desktop/index.js` 的 `startRelay`）校验的令牌由 `ensureToken()` 决定，
 * 优先级是 `pair.json.accessToken` → `token.txt`。0.1.0 的网关**只读 token.txt**
 * 而且**无条件覆盖**请求头，于是当 `pair.json.accessToken` 存在时（本机就是这样）：
 * 手机带哪把来都被换成 token.txt 里的旧值 → 中继 401，症状是「所有 RPC 都 401、
 * 两把令牌都被拒」。现在改走 `relay-token.js` 的 `resolveRelayToken()`：
 * 与中继**同一个事实来源**、每请求重新解析（配对成功立刻生效）；
 * 解析不出时**不覆盖**，直接透传客户端带来的头（兼容只带令牌的老手机）。
 *
 * 日志：只记 IP / 路径（去 query）/ 状态码 / 耗时 / 设备 id 前 8 位与失败原因；
 * 不记 token、不记 deviceKey、不记正文。
 *
 * ## 共用部分在 `lib/shared/gateway-core.js`
 *
 * ASN.1/DER 编码、证书生成与复用、反代、HTTP 辅助、共有配置归一化都搬到了
 * 共享内核，两端共用同一份。留在本文件的是电脑端特有的：设备白名单鉴权、
 * 中继令牌注入、claim/revoke 端点、以及支持 `dir` 注入的路径。
 *
 * 只依赖 node 内置模块，可单独 import 自测（不需要启动 DSH）。
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';

import { CLAIM_GUARD, createDeviceAuth } from './device-auth.js';
import { resolveRelayToken, syncRelayTokenFile, tokenFingerprint } from './relay-token.js';
import { createDdnsClient, ddnsReadiness } from '../shared/ddns.js';
import { createDiscoveryResponder } from '../shared/discovery.js';
import { stateDirOf } from '../shared/home.js';
import { AddressFamily, resolveListenHost } from '../shared/net.js';
import {
	createUpstreamAgent,
	loadOrCreateCertificate,
	normalizeConfigBase,
	pingBody,
	PING_PATH,
	proxyToUpstream,
	readBody,
	remoteIpOf,
	sendJson,
	UPSTREAM_HOST,
} from '../shared/gateway-core.js';

const CLAIM_PATH = '/link/claim';
const CERT_PATH = '/link/cert';
const PAIRING_PATH = '/link/pairing';
const REVOKE_PATH = '/link/revoke';
/** claim 体上限 8 KiB：一个配对请求连 1 KiB 都用不到，超了就是有人在投毒。 */
const CLAIM_MAX_BYTES = 8 * 1024;
/** 鉴权头：验完必须从转发头里删掉，不能进中继日志。 */
const AUTH_HEADERS = ['x-link-device', 'x-link-ts', 'x-link-key'];
const TOKEN_HEADER = 'x-dsh-remote-token';
export const LINK_VERSION = '0.3.0';
/**
 * 默认配置。
 *
 * ⚠️ `addressFamily` 默认 `ipv4` 是**安全决策**，不是保守：IPv4 有 NAT，
 * `0.0.0.0` 实际只暴露在局域网；IPv6 通常没有 NAT，一旦监听 `::` 就是公网暴露。
 * 所以要 IPv6 必须显式改这一项（见 `lib/shared/net.js` 文件头的「安全前提」）。
 *
 * 共有的归一化（port / listen / upstreamPort / addressFamily…）走
 * `gateway-core` 的 `normalizeConfigBase`，两端只有一份判断。
 */
const DEFAULT_CONFIG = {
	enabled: true,
	port: 8899,
	listen: '0.0.0.0',
	upstreamPort: 17890,
	/** 地址族：`ipv4`（默认）/ `dual` / `ipv6`。 */
	addressFamily: AddressFamily.IPV4,
	/** 是否把**全局可路由**地址写进证书 SAN 并监听。默认 false —— 开了等于公网暴露。 */
	allowGlobal: false,
	/** 是否纳入链路本地地址（`169.254.x` / `fe80::`）。默认 false —— zone id 跨平台不可靠。 */
	includeLinkLocal: false,
};

/**
 * 配置目录：`$DSH_HOME/dsh-remote`（本机 = `%USERPROFILE%\.dsh\dsh-remote`）。
 *
 * ⚠️ 走 `shared/home.js`（P1-5）：不在本文件里再拼一遍，免得与另外三处
 * 各写一份的副本再次漂移。完整记录见 `lib/shared/home.js` 文件头。
 */
const CONFIG_DIR = stateDirOf();
export const LINK_CONFIG_PATH = join(CONFIG_DIR, 'link.json');
export const LINK_CERT_PATH = join(CONFIG_DIR, 'link-cert.pem');
export const LINK_KEY_PATH = join(CONFIG_DIR, 'link-key.pem');

/**
 * 一个配置目录下的全部落点。默认就是 `CONFIG_DIR`；自测用 `config.dir`
 * 指到临时目录，**绝不会**碰到真实 `~/.dsh`（证书/配置/令牌/设备白名单一起换）。
 */
function pathsOf(dir) {
	return {
		config: join(dir, 'link.json'),
		cert: join(dir, 'link-cert.pem'),
		key: join(dir, 'link-key.pem'),
		token: join(dir, 'token.txt'),
	};
}

function writeConfig(config, log, dir) {
	const file = pathsOf(dir).config;
	try {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
		return true;
	} catch (error) {
		log(`写配置失败 ${file}: ${String(error?.message ?? error)}`, 'warn');
		return false;
	}
}

/**
 * 读配置并归一化。`overrides` 只给自测/调试用（生产由 index.js 直接读文件）。
 * `password` / `salt` 是 v1 残留字段：读到就忽略，不再参与任何判断。
 */
function loadConfig(log, overrides, dir) {
	const file = pathsOf(dir).config;
	let raw;
	try {
		raw = JSON.parse(readFileSync(file, 'utf8'));
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			log('link-gateway 未启用：配置文件读不了或不是合法 JSON', 'warn');
			return undefined;
		}
		raw = undefined;
	}
	if (raw === undefined) {
		const fresh = { ...DEFAULT_CONFIG };
		writeConfig(fresh, log, dir);
		log(`没有配置文件，已生成默认 ${file}`);
		raw = fresh;
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		log('link-gateway 未启用：配置文件顶层不是对象', 'warn');
		return undefined;
	}
	return normalizeConfig({ ...raw, ...(overrides ?? {}) }, log);
}

/** 共用归一化（`gateway-core`）+ 电脑端自己没有额外字段，直接转过去。 */
function normalizeConfig(raw, log) {
	return normalizeConfigBase(raw, DEFAULT_CONFIG, log);
}

/**
 * 读「中继此刻真正校验的令牌」（每请求重新解析，配对成功立刻生效）。
 *
 * 与中继共用 `relay-token.js` 的解析器：`pair.json.accessToken` → `token.txt`。
 * 解析不出（两者都没有）→ `undefined`，调用方**不覆盖**请求头、原样透传。
 *
 * ⚠️ 这里**不许**再写回「只读 token.txt」：那正是 401 的根因（见文件头注释）。
 *
 * @param {object} state - 网关运行态（`dir`）。
 * @returns {string|undefined} 有效令牌。
 */
function readRelayToken(state) {
	const resolved = resolveRelayToken({ dir: state.dir });
	if (resolved.token !== undefined) return resolved.token;
	if (!state.tokenWarned) {
		state.tokenWarned = true;
		state.log(
			`解析不到中继令牌（${state.dir} 下既无 pair.json.accessToken 也无 token.txt），` +
				`按原样透传客户端的 ${TOKEN_HEADER} 头`,
			'warn',
		);
	}
	return undefined;
}

/** 验签失败统一出口：403 + 一行 `403 METHOD path ip= reason` 日志（不含密钥/完整 id）。 */
function rejectUnauthorized(state, res, req, meta, reason) {
	state.log(`403 ${req.method ?? '?'} ${meta.pathOnly} ip=${meta.ip} ${reason}`);
	sendJson(res, 403, { ok: false, error: 'unauthorized' });
}

/** `/link/claim`：配对码换设备授权；只认 POST + application/json，**不转发上游**。 */
async function handleClaim(state, req, res, meta) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
		return;
	}
	const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
	if (!contentType.includes('application/json')) {
		req.resume(); // 不看 body 也要排空，避免残留数据被当成下一个请求
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	let raw;
	try {
		raw = await readBody(req, CLAIM_MAX_BYTES);
	} catch (error) {
		if (error?.code === 'BODY_TOO_LARGE') {
			sendJson(res, 400, { ok: false, error: 'bad-request' });
			// 已经不再读流：这行响应发出去后断开连接，别让对端继续灌数据。
			res.once('finish', () => req.destroy());
			return;
		}
		if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body)) {
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	if (typeof body.deviceId !== 'string' || typeof body.deviceKey !== 'string') {
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	// 两段式配对：电脑弹卡片，卡上就是这组 6 位数字，手机端显示同一组。
	// 不再接受手输码（v1 定案）：请求体里的 code 一律忽略。
	const requested = state.devices.requestPairing({
		deviceId: body.deviceId,
		deviceName: typeof body.deviceName === 'string' ? body.deviceName : undefined,
		deviceKey: body.deviceKey,
		ip: meta.ip,
	});
	if (requested.ok) {
		sendJson(res, 200, {
			ok: true,
			pending: true,
			pendingId: requested.pendingId,
			code: requested.code,
			expiresAt: requested.expiresAt,
		});
		return;
	}
	if (requested.error === 'too-many-pending') {
		sendJson(res, 429, { ok: false, error: 'too-many-pending' });
		return;
	}
	sendJson(res, 400, { ok: false, error: 'bad-request' });
}

/**
 * 回环地址判定：approve/reject 只许本机（电脑自己的授权浮层）调用。
 * 局域网里的手机只能来查 status，不能替人点「允许」。
 */
function isLoopbackIp(ip) {
	const text = typeof ip === 'string' ? ip : '';
	return text === '127.0.0.1' || text === '::1' || text === '::ffff:127.0.0.1';
}

/**
 * `/link/pairing`：两段式配对的「查结果 / 允许 / 拒绝」。
 *
 * body:
 * - `{action:'status', pendingId, deviceKey}` —— 手机查结果；
 * - `{action:'approve', pendingId}` / `{action:'reject', pendingId}` —— 电脑授权浮层，
 *   只接受回环来源。
 */
async function handlePairing(state, req, res, meta) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
		return;
	}
	const contentType = String(req.headers['content-type'] ?? '').toLowerCase();
	if (!contentType.includes('application/json')) {
		req.resume();
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	let raw;
	try {
		raw = await readBody(req, CLAIM_MAX_BYTES);
	} catch {
		if (!res.headersSent) sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	let body;
	try {
		body = JSON.parse(raw);
	} catch {
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	if (body === null || typeof body !== 'object' || Array.isArray(body) || typeof body.action !== 'string') {
		sendJson(res, 400, { ok: false, error: 'bad-request' });
		return;
	}
	const pendingId = typeof body.pendingId === 'string' ? body.pendingId : '';
	if (body.action === 'status') {
		if (typeof body.deviceKey !== 'string') {
			sendJson(res, 400, { ok: false, error: 'bad-request' });
			return;
		}
		const result = state.devices.pairingStatus({ pendingId, deviceKey: body.deviceKey });
		if (!result.ok) {
			sendJson(res, result.error === 'forbidden' ? 403 : 404, { ok: false, error: result.error });
			return;
		}
		sendJson(res, 200, result);
		return;
	}
	if (body.action === 'approve' || body.action === 'reject') {
		if (!isLoopbackIp(meta.ip)) {
			state.log(`403 POST ${meta.pathOnly} ip=${meta.ip} pairing-action-not-local`);
			sendJson(res, 403, { ok: false, error: 'forbidden' });
			return;
		}
		const result = body.action === 'approve'
			? state.devices.approvePairing({ pendingId })
			: state.devices.rejectPairing({ pendingId });
		sendJson(res, result.ok ? 200 : 404, result.ok ? { ok: true } : { ok: false, error: result.error });
		return;
	}
	sendJson(res, 400, { ok: false, error: 'bad-request' });
}

/** `/link/revoke`：验签后撤销当前设备；只认 POST，不转发上游。 */
function handleRevoke(state, req, res, meta) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
		return;
	}
	req.resume(); // 不看 body，但要排空
	const auth = state.devices.verify(req, meta.pathOnly);
	if (!auth.ok) {
		rejectUnauthorized(state, res, req, meta, auth.reason);
		return;
	}
	state.devices.revoke(auth.device.id);
	sendJson(res, 200, { ok: true });
}

function handleRequest(state, req, res) {
	const started = Date.now();
	const ip = remoteIpOf(req);
	const pathOnly = (req.url ?? '/').split('?')[0];
	// 只记路径（去 query）—— EventSource 可能把 token 放 query 里，不能落日志。
	res.on('close', () => state.log(`${res.statusCode ?? 0} ${req.method ?? '?'} ${pathOnly} ip=${ip} ${Date.now() - started}ms`));
	req.socket?.setNoDelay?.(true);
	const meta = { ip, pathOnly, started };

	/**
	 * `/link/cert`：把网关自己的证书 PEM 交出去，供手机在配对时取回、之后以 `ca` 校验。
	 *
	 * 未认证、只读：配对前手机必然还没有凭据；这一份是自签证书本身，不是秘密。
	 * 手机拿到后应 pin 住（存进 link-client.json），此后用 `ca: [pem]` 真校验证书链，
	 * 不再依赖 `getPeerCertificate`（那台运行时读不到）。
	 */
	if (pathOnly === CERT_PATH && req.method === 'GET') {
		try {
			const pem = readFileSync(join(stateDirOf(), 'link-cert.pem'), 'utf8');
			sendJson(res, 200, { ok: true, pem });
		} catch {
			sendJson(res, 500, { ok: false, error: 'no-cert' });
		}
		return;
	}

	if (pathOnly === CLAIM_PATH) {
		void handleClaim(state, req, res, meta);
		return;
	}
	if (pathOnly === PAIRING_PATH) {
		void handlePairing(state, req, res, meta);
		return;
	}
	if (pathOnly === REVOKE_PATH) {
		handleRevoke(state, req, res, meta);
		return;
	}
	if (pathOnly === PING_PATH && req.method === 'GET') {
		// 匿名探测放行（手机据此判断地址通不通）；带了设备头就必须验签：
		// 签过的 200 等于「这台手机已被授权」。
		const signed = String(req.headers['x-link-device'] ?? '').trim() !== '';
		if (signed) {
			const auth = state.devices.verify(req, pathOnly);
			if (!auth.ok) {
				rejectUnauthorized(state, res, req, meta, auth.reason);
				return;
			}
		}
		// 只回版本/指纹，**绝不**暴露设备列表。
		// 暴露在公网时匿名连版本号都不给 —— 判据与理由见 `pingBody`。
		sendJson(res, 200, pingBody({ signed, exposed: state.exposed === true, fp: state.fp, ver: LINK_VERSION }));
		return;
	}
	// 其余请求：先验签，失败**绝不转发**。
	const auth = state.devices.verify(req, pathOnly);
	if (!auth.ok) {
		rejectUnauthorized(state, res, req, meta, auth.reason);
		return;
	}
	// 密钥不能进中继日志：转发前删掉三个鉴权头。
	for (const name of AUTH_HEADERS) delete req.headers[name];
	// 中继自己的鉴权：补上「中继真正校验的那把令牌」。
	// 三种情况：① 解析不出 → 一个字节都不改，透传客户端带来的头；
	// ② 客户端带的已经就是有效令牌 → 也不改（少一次无意义改写）；
	// ③ 客户端带的是旧值/没带 → 覆盖成有效令牌。
	const token = readRelayToken(state);
	const provided = String(req.headers[TOKEN_HEADER] ?? '').trim();
	const inject = token === undefined || provided === token ? undefined : { [TOKEN_HEADER]: token };
	if (token !== undefined && provided !== token) {
		// 只在真的换了令牌时记一行（打指纹，不落令牌本身），排查 401 时就是这一行。
		state.log(
			`中继令牌已改写为有效值（有效=${tokenFingerprint(token)}，客户端=${provided === '' ? '未带' : tokenFingerprint(provided)}）`,
		);
	}
	proxyToUpstream(state, req, res, meta, inject);
}

/**
 * 启动 TLS 网关。`log` 由插件注入（同时写 ctx.logger 与 desktop-debug.log），
 * 本模块不直连 DSH。返回停止函数；不满足启动条件时是空函数（只记一行日志）。
 * `config` 参数是给自测用的覆盖项，生产调用不传（直接读 link.json）；
 * `config.dir` 可把配置/证书/令牌/设备白名单整体换到临时目录（自测必须用）。
 */
/**
 * 本机名（只用于让对端在候选列表里**人肉认出**是哪台电脑）。
 *
 * 取不到就退回常量 —— 名字是给人看的，不该因为它拿不到而让发现功能失效。
 *
 * @returns {string} 主机名或兜底名。
 */
function machineName() {
	try {
		const value = hostname();
		return typeof value === 'string' && value !== '' ? value : 'dsh-desktop';
	} catch {
		return 'dsh-desktop';
	}
}

export function startLinkGateway({ log = () => {}, config: overrides } = {}) {
	// 状态目录：默认 `$DSH_HOME/dsh-remote`；`config.dir` 只给自测用，生产不会传。
	const dir = typeof overrides?.dir === 'string' && overrides.dir.trim() !== '' ? overrides.dir.trim() : CONFIG_DIR;
	let config;
	try {
		config = loadConfig(log, overrides, dir);
	} catch (error) {
		log(`读取配置失败：${String(error?.message ?? error)}`, 'warn');
		return () => {};
	}
	if (config === undefined) return () => {};
	if (config.enabled === false) {
		log('link-gateway 未启用：配置里 enabled=false');
		return () => {};
	}

	// 地址策略：证书 SAN 与监听地址必须**同一套判断**，否则会出现
	// 「证书里有这个 IP、但没在它上面监听」这类半通状态。
	const netOptions = {
		addressFamily: config.addressFamily,
		allowGlobal: config.allowGlobal,
		includeLinkLocal: config.includeLinkLocal,
	};
	const listenInfo = resolveListenHost(config.addressFamily);
	// 默认 ipv4 时沿用配置里的 listen（可能是指定的单网卡地址，向后兼容）；
	// 一旦显式选了 dual / ipv6，监听地址必须由策略决定，避免配成 '0.0.0.0' 却以为开了 IPv6。
	const listenHost = config.addressFamily === AddressFamily.IPV4 ? config.listen : listenInfo.host;

	let certificate;
	try {
		const { cert: certPath, key: keyPath } = pathsOf(dir);
		certificate = loadOrCreateCertificate({ log, certPath, keyPath, netOptions });
	} catch (error) {
		log(`证书准备失败：${String(error?.message ?? error)}`, 'warn');
		return () => {};
	}

	const state = {
		fp: certificate.fp,
		dir,
		upstream: { host: UPSTREAM_HOST, port: config.upstreamPort },
		agent: createUpstreamAgent(),
		devices: createDeviceAuth({ log, dir }),
		tokenPath: pathsOf(dir).token,
		tokenWarned: false,
		log,
	};
	// 先把「有效令牌」对齐进 token.txt（与中继同一个解析器），
	// 这样手机端按老办法读 token.txt 拿到的也是中继真正校验的那把。
	try {
		const synced = syncRelayTokenFile({ dir, log });
		if (synced.token !== undefined) {
			log(`中继令牌来源=${synced.source} 指纹=${tokenFingerprint(synced.token)}（token.txt 已对齐=${synced.wrote}）`);
		}
	} catch (error) {
		log(`令牌文件对齐失败（不影响启动）: ${String(error?.message ?? error)}`, 'warn');
	}
	// 配对码不再在启动时预生成：现在是「手机发起 → 电脑弹卡片确认」的两段式配对，
	// 6 位数字由 `requestPairing()` 在收到请求时生成（见 device-auth.js）。

	let server;
	try {
		server = createServer({ key: certificate.keyPem, cert: certificate.certPem, minVersion: 'TLSv1.2' }, (req, res) => handleRequest(state, req, res));
	} catch (error) {
		log(`TLS 服务创建失败：${String(error?.message ?? error)}`, 'warn');
		state.agent.destroy();
		return () => {};
	}
	// ⚠️⚠️ 监听失败必须 **error 级别 + 带可行动提示**（P2-6）。
	//
	// 从前这里是 `'warn'`：端口被占用（EADDRINUSE）时只留一行不起眼的警告，
	// 不重试、不上报，插件看起来「装上了但连不上」—— 用户能观察到的只有
	// 「手机连不上电脑」，而那有十几种可能原因，排障无从下手。
	//
	// 网关是**本插件唯一对外提供服务的东西**，它起不来等于插件没装。
	// 所以：级别提到 error（宿主会把它摆到用户眼前），并把「下一步做什么」
	// 直接写进这一行 —— 「端口被占用」和「换端口」必须出现在同一句话里。
	server.on('error', (error) => {
		const code = String(error?.code ?? '');
		const hint =
			code === 'EADDRINUSE'
				? `（端口 ${config.port} 被占用：改 $DSH_HOME/dsh-remote/link.json 的 port，或停掉占用它的程序）`
				: code === 'EAFNOSUPPORT'
					? '（本机不支持该地址族：把 link.json 的 addressFamily 改回 ipv4）'
					: code === 'EACCES'
						? '（权限不足：1024 以下端口需要管理员/root）'
						: '';
		log(`link-gateway 监听失败 ${listenHost}:${config.port}：${String(error?.message ?? error)}${hint}`, 'error');
	});
	server.on('tlsClientError', (error, socket) => {
		log(`TLS 握手失败 ip=${remoteIpOf(socket)}: ${String(error?.code ?? error?.message ?? error)}`, 'warn');
	});
	server.on('listening', () => {
		log(`已监听 ${listenHost}:${config.port}（${config.addressFamily}；TLS 流式直通 → http://${UPSTREAM_HOST}:${config.upstreamPort}）`);
	});
	log(`证书 SHA-256 指纹 ${certificate.fp}（手机端 pin 用）`);
	if (config.allowGlobal === true) {
		log('allowGlobal=true：全局可路由地址已纳入，本机会暴露在公网 —— 请确认防火墙与设备白名单已就位', 'warn');
	}
	server.listen({ host: listenHost, port: config.port, ipv6Only: listenInfo.ipv6Only });

	// ── 局域网发现：本机是「被找」的一方 ──
	// 手机广播一句「谁在」，这里回一句「我在这儿（端口是这个）」。
	// 响应只有 name/port/ver/fp —— 指纹本来就是给对端 pin 的公开值，
	// **任何凭据都不进响应**（理由见 discovery.js 文件头）。
	let discovery = null;
	if (config.discovery.enabled === true) {
		discovery = createDiscoveryResponder({
			port: config.discovery.port,
			info: () => ({ name: machineName(), port: config.port, ver: LINK_VERSION, fp: certificate.fp }),
			log,
		});
		try {
			discovery.start();
		} catch (error) {
			log(`局域网发现启动失败（不影响网关本身）: ${String(error?.message ?? error)}`, 'warn');
			discovery = null;
		}
	}

	// ── DDNS：只在「确要走公网」时才真正生效 ──
	let ddns = null;
	if (config.ddns.enabled === true) {
		const readiness = ddnsReadiness(config.ddns);
		if (readiness.ok !== true) {
			log(`DDNS 已启用但配置不全（${readiness.reason}），未启动`, 'warn');
		} else if (config.allowGlobal !== true) {
			// DDNS 把名字解析到公网地址，但 allowGlobal=false 时本机**根本不监听**全局地址 ——
			// 结果就是「名字指到了路由器，路由器后面没人应答」，表现为连不上且极难排查。
			// 所以这里必须说清楚，而不是默默启动一个永远不生效的客户端。
			log('DDNS 已启用但 allowGlobal=false：名字会解析到公网地址，本机却不监听全局地址，对端仍然连不上。要走公网请把 allowGlobal 设为 true', 'warn');
		} else {
			// 两个开关都开了 = 真的暴露在公网。这是本插件安全模型的**分界线**，必须留下显式告警。
			log('DDNS + allowGlobal 均已开启：本机将暴露在公网。网络层门禁（防火墙 / 单包授权）需自行配置 —— 应用层凭据挡得住伪造，挡不住扫描', 'warn');
			ddns = createDdnsClient({ config: config.ddns, log });
			ddns.start();
		}
	}

	const stopGateway = () => {
		try {
			discovery?.stop();
			ddns?.stop();
			server.closeAllConnections?.();
			server.close();
			state.agent.destroy();
			log('link-gateway 已停止');
		} catch (error) {
			log(`link-gateway 停止异常: ${String(error?.message ?? error)}`, 'warn');
		}
	};
	// 把设备白名单控制器挂到返回值上（函数带属性，调用方 `stop()` 用法不变）。
	// 理由：配置页的「解绑 / 断开全部配对」必须真的改 `devices.json` 并同步内存，
	// 否则手机下次仍能直接连进来 —— 一个只改 setup.json 的假按钮比没有按钮更糟。
	stopGateway.devices = state.devices;
	stopGateway.state = state;
	return stopGateway;
}
