/**
 * 局域网直连网关 · v2：TLS 流式直通（整份替换第一块的信封版，不再保留 AES 信封逻辑）。
 *
 * 作用：电脑（同局域网）用 node:https 直连 `listen:port`（默认 0.0.0.0:8898），
 * TLS 由本模块的自签证书保证；HTTP 请求原样 pipe 到本机 DSH
 * http://127.0.0.1:3120（配置项 `upstreamPort`），响应也原样
 * pipe 回去 —— 不解密、不缓冲，所以 SSE / chunked 能逐块到达。
 *
 * 证书：`<配置目录>/link-cert.pem` + `link-key.pem`。首次启动（或证书不可用）
 * 用 node:crypto 现场生成 ECDSA P-256 自签证书（纯 Node ASN.1/DER 编码，
 * 不调用 openssl、不新增依赖），私钥权限 0600（POSIX）/ 仅本机可读。
 * 启动日志打印证书 SHA-256 指纹（与 Node tls 的 fingerprint256 同一格式），电脑端 pin 它。
 *
 * ## 鉴权（P0-1：反代路径必须鉴权）
 *
 * 0.1.5 之前反代路径是**零鉴权**的（见下）：同网段任何人都能无凭据访问手机上的 DSH。
 * 桌面端早就演进到「设备白名单 + HMAC、验签失败一律 403 且绝不转发」，
 * 而这份拷贝没跟上 —— 这正是两文件复制粘贴的代价。
 *
 * 现在按来源分两档：
 *  - **回环**（`127.0.0.1` / `::1`）→ 放行：本机访问本机不构成外泄；
 *  - **非回环**（局域网 / 公网）→ 必须 `x-link-key` 与 `pairKey` 一致，
 *    且 `x-link-ts` 在 ±5 分钟内（防重放）。
 *
 * 另有两条专用通道，各自鉴权（都是 `x-link-key` + 时间戳）：
 *  - `POST /link/agent-message`：电脑投消息唤醒本机 agent；
 *  - `POST /link/plugin-install`：电脑推插件包（会弹卡片让用户确认）。
 *
 * ## 共用部分在 `lib/shared/gateway-core.js`
 *
 * ASN.1/DER 编码、证书生成与复用、反代、HTTP 辅助、共有配置归一化都搬到了
 * 共享内核。留在本文件的是手机端特有的：pairKey 共享密钥鉴权、
 * agent-message / plugin-install 端点。
 *
 * 日志：只记 IP / 路径（去 query）/ 状态码 / 耗时；不记 token、不记正文。
 *
 * 只依赖 node 内置模块，可单独 import 自测（不需要启动 DSH）。
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:https';
import { dirname, join } from 'node:path';

import { stateDirOf } from '../shared/home.js';
import { AddressFamily, isLoopbackAddress, resolveListenHost } from '../shared/net.js';
import {
	createNonceCache,
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
	verifySharedKey,
} from '../shared/gateway-core.js';

/** 反向通道：对端（电脑）投一条消息给本机 agent，唤醒它继续干活。 */
const AGENT_MESSAGE_PATH = '/link/agent-message';
/**
 * 电脑推一个插件包过来、本机装上（0.1.2 新增）。
 * 鉴权 = `x-link-key`（静态 `pairKey`）+ `x-link-ts`（±5 分钟），比消息通道多一道时间戳。
 */
const PLUGIN_INSTALL_PATH = '/link/plugin-install';
/** 插件包上限 20MB（与 `lib/mobile/plugin-install.js` 的同一口径）。 */
export const MAX_PLUGIN_TGZ_BYTES = 20 * 1024 * 1024;
/** 请求体上限：base64 膨胀 4/3，再留 16KB 给 JSON 外壳。 */
export const PLUGIN_INSTALL_BODY_LIMIT = Math.ceil((MAX_PLUGIN_TGZ_BYTES * 4) / 3) + 16 * 1024;
/** `x-link-ts` 允许的时间偏移（±5 分钟，防重放）。 */
const TS_TOLERANCE_MS = 5 * 60 * 1000;
/** 本地端点的请求体上限（消息而已，不需要很大）。 */
const MAX_LOCAL_BYTES = 256 * 1024;
export const LINK_VERSION = '0.2.0';
/**
 * 默认配置。
 *
 * ⚠️ 与桌面端同一口径：`addressFamily` 默认 `ipv4` 是安全决策（IPv4 有 NAT，
 * IPv6 没有）。详见 `lib/shared/net.js` 文件头的「安全前提」。
 *
 * ⚠️ 端口是从桌面端复制过来时没改的（P0-2）：电脑 8899 / 中继 17890，
 * 手机必须是 **8898 / 本机 DSH 3120**。之前默认值错成 8899/17890，会和电脑撞端口、
 * 上游又指向电脑上才有的中继端口，表现全是 502，且 README 从没提过要手改。
 *
 * 共有的归一化（port / listen / upstreamPort / addressFamily…）走
 * `gateway-core` 的 `normalizeConfigBase`，两端只有一份判断。
 */
const DEFAULT_CONFIG = {
	enabled: true,
	port: 8898,
	listen: '0.0.0.0',
	upstreamPort: 3120,
	pairKey: '',
	/** 地址族：`ipv4`（默认）/ `dual` / `ipv6`。 */
	addressFamily: AddressFamily.IPV4,
	/** 是否纳入全局可路由地址。默认 false —— 开了等于公网暴露。 */
	allowGlobal: false,
	/** 是否纳入链路本地地址。默认 false —— zone id 跨平台不可靠。 */
	includeLinkLocal: false,
};

/** 配置目录：`$DSH_HOME/dsh-remote`（本机 = `%USERPROFILE%\.dsh\dsh-remote`）。 */
const CONFIG_DIR = stateDirOf();
export const LINK_CONFIG_PATH = join(CONFIG_DIR, 'link.json');
export const LINK_CERT_PATH = join(CONFIG_DIR, 'link-cert.pem');
export const LINK_KEY_PATH = join(CONFIG_DIR, 'link-key.pem');

function writeConfig(config, log) {
	try {
		mkdirSync(dirname(LINK_CONFIG_PATH), { recursive: true });
		writeFileSync(LINK_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
		return true;
	} catch (error) {
		log(`写配置失败 ${LINK_CONFIG_PATH}: ${String(error?.message ?? error)}`, 'warn');
		return false;
	}
}

/**
 * 读配置并归一化。`overrides` 只给自测/调试用（生产由 index.js 直接读文件）。
 * `password` / `salt` 是 v1 残留字段：读到就忽略，不再参与任何判断。
 */
function loadConfig(log, overrides) {
	let raw;
	try {
		raw = JSON.parse(readFileSync(LINK_CONFIG_PATH, 'utf8'));
	} catch (error) {
		if (error?.code !== 'ENOENT') {
			log('link-gateway 未启用：配置文件读不了或不是合法 JSON', 'warn');
			return undefined;
		}
		raw = undefined;
	}
	if (raw === undefined) {
		const fresh = { ...DEFAULT_CONFIG };
		writeConfig(fresh, log);
		log(`没有配置文件，已生成默认 ${LINK_CONFIG_PATH}`);
		raw = fresh;
	}
	if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
		log('link-gateway 未启用：配置文件顶层不是对象', 'warn');
		return undefined;
	}
	return normalizeConfig({ ...raw, ...(overrides ?? {}) }, log);
}

function normalizeConfig(raw, log) {
	const config = normalizeConfigBase(raw, DEFAULT_CONFIG, log);
	// ⚠️ 必须原样保留 pairKey：漏了它每次启动都会重新生成，电脑侧的 key 立刻失效（401）。
	// pairKey 是手机端特有的（反向通道鉴权），所以留在本文件而不是共享内核。
	const pairKey = typeof raw.pairKey === 'string' ? raw.pairKey.trim() : '';
	if (pairKey !== '') config.pairKey = pairKey;
	return config;
}


/**
 * 反向通道：对端投一条消息给本机 agent。
 *
 * ## 鉴权（与 `plugin-install` 同一口径 —— P1-4）
 *
 * 从前这里**只比静态 `x-link-key`**，而隔壁 `plugin-install` 却多一道
 * `x-link-ts`（±5 分钟）。同一个网关两种口径，松的那边就是攻击面：
 * 局域网内抓到一次合法通知包即可**无限重放**，反复向手机 agent 注入消息。
 *
 * 现在三道：
 *
 * 1. `x-link-key` = 静态 `pairKey`（定长比较）；
 * 2. `x-link-ts` 在 ±5 分钟内（让旧包过期）；
 * 3. `x-link-nonce` 只能用一次（让**没过期**的包也只能用一次）。
 *
 * 第 3 条是新增的：光有时间戳，5 分钟窗口内同一份包仍然可以生效无数次。
 *
 * 投递由插件注入的 `onAgentMessage` 完成（它会 resolveAgent 再 followup 唤醒）。
 */
async function handleAgentMessage(state, req, res) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
		return;
	}
	if (typeof state.onAgentMessage !== 'function') {
		sendJson(res, 501, { ok: false, error: 'not_supported' });
		return;
	}
	const auth = verifySharedKey(req, state.pairKey, { toleranceMs: TS_TOLERANCE_MS });
	if (!auth.ok) {
		sendJson(res, 401, { ok: false, error: auth.reason === 'stale-timestamp' ? 'stale_timestamp' : 'unauthorized' });
		return;
	}
	const nonce = typeof req.headers['x-link-nonce'] === 'string' ? req.headers['x-link-nonce'] : '';
	if (nonce === '' || state.nonces.seen(nonce)) {
		sendJson(res, 401, { ok: false, error: nonce === '' ? 'missing_nonce' : 'replay' });
		return;
	}
	let body;
	try {
		body = await readBody(req, MAX_LOCAL_BYTES);
	} catch (error) {
		sendJson(res, 413, { ok: false, error: 'too_large', detail: String(error?.message ?? error) });
		return;
	}
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		sendJson(res, 400, { ok: false, error: 'bad_json' });
		return;
	}
	const text = typeof payload?.text === 'string' ? payload.text : '';
	if (text.trim() === '') {
		sendJson(res, 400, { ok: false, error: 'empty_text' });
		return;
	}
	const result = await state.onAgentMessage({
		text,
		sessionId: typeof payload?.sessionId === 'string' ? payload.sessionId : '',
		from: typeof payload?.from === 'string' ? payload.from : '',
	});
	sendJson(res, 200, { ok: true, ...(result ?? {}) });
}

/**
 * 电脑推插件包：`POST /link/plugin-install`。
 *
 * 鉴权三道，与 `agent-message` **同一口径**（P1-4 之前是两道，缺 nonce）：
 *
 * 1. `x-link-key` = 静态 `pairKey`；
 * 2. `x-link-ts` 在 ±5 分钟内；
 * 3. `x-link-nonce` 只能用一次。
 *
 * 体 `{ name, version, tgzBase64, sha256 }`（tgzBase64 解出来 ≤ 20MB，超了 413）。
 *
 * 真正「装不装」交给插件注入的 `onPluginInstall`（它会去问用户、校验、落盘）；
 * 本函数只做协议层：方法/鉴权/长度/JSON/base64，然后把它的错误状态码原样回给对方。
 */
async function handlePluginInstall(state, req, res) {
	if (req.method !== 'POST') {
		sendJson(res, 405, { ok: false, error: 'method_not_allowed' });
		return;
	}
	if (typeof state.onPluginInstall !== 'function') {
		sendJson(res, 501, { ok: false, error: 'not_supported' });
		return;
	}
	const auth = verifySharedKey(req, state.pairKey, { toleranceMs: TS_TOLERANCE_MS });
	if (!auth.ok) {
		sendJson(res, 401, { ok: false, error: auth.reason === 'stale-timestamp' ? 'stale_timestamp' : 'unauthorized' });
		return;
	}
	const nonce = typeof req.headers['x-link-nonce'] === 'string' ? req.headers['x-link-nonce'] : '';
	if (nonce === '' || state.nonces.seen(nonce)) {
		sendJson(res, 401, { ok: false, error: nonce === '' ? 'missing_nonce' : 'replay' });
		return;
	}
	let body;
	try {
		body = await readBody(req, PLUGIN_INSTALL_BODY_LIMIT);
	} catch (error) {
		sendJson(res, 413, { ok: false, error: 'too_large', detail: String(error?.message ?? error) });
		return;
	}
	let payload;
	try {
		payload = JSON.parse(body);
	} catch {
		sendJson(res, 400, { ok: false, error: 'bad_json' });
		return;
	}
	const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
	const version = typeof payload?.version === 'string' ? payload.version.trim() : '';
	const sha256 = typeof payload?.sha256 === 'string' ? payload.sha256.trim() : '';
	const encoded = typeof payload?.tgzBase64 === 'string' ? payload.tgzBase64 : '';
	if (name === '' || version === '' || sha256 === '' || encoded === '') {
		sendJson(res, 400, { ok: false, error: 'bad_request', detail: '需要 name / version / sha256 / tgzBase64' });
		return;
	}
	// base64 只认标准字母表 + 正确补位：Node 的 Buffer.from(x,'base64') 会**静默截断**脏输入，
	// 截断后再算 sha256 就永远是「不符」，所以这里先严格校验一遍。
	if (encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
		sendJson(res, 400, { ok: false, error: 'bad_base64' });
		return;
	}
	const tgz = Buffer.from(encoded, 'base64');
	if (tgz.length > MAX_PLUGIN_TGZ_BYTES) {
		sendJson(res, 413, { ok: false, error: 'too_large', detail: `包头 ${tgz.length} 字节，上限 ${MAX_PLUGIN_TGZ_BYTES}` });
		return;
	}
	let result;
	try {
		result = await state.onPluginInstall({ name, version, sha256, tgz, ip: remoteIpOf(req) });
	} catch (error) {
		const status = Number(error?.status);
		const code = typeof error?.code === 'string' && error.code !== '' ? error.code : 'internal';
		state.log(`plugin-install 失败 ${name}@${version} status=${Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500} ${code}`, 'warn');
		sendJson(res, Number.isInteger(status) && status >= 400 && status <= 599 ? status : 500, { ok: false, error: code, detail: String(error?.detail ?? error?.message ?? '') });
		return;
	}
	state.log(`plugin-install 成功 ${name}@${version} ip=${remoteIpOf(req)} ${tgz.length}B`);
	sendJson(res, 200, { ok: true, ...(result ?? {}) });
}

function handleRequest(state, req, res) {
	const started = Date.now();
	const ip = remoteIpOf(req);
	const pathOnly = (req.url ?? '/').split('?')[0];
	// 只记路径（去 query）—— EventSource 可能把 token 放 query 里，不能落日志。
	res.on('close', () => state.log(`${res.statusCode ?? 0} ${req.method ?? '?'} ${pathOnly} ip=${ip} ${Date.now() - started}ms`));
	req.socket?.setNoDelay?.(true);
	const meta = { ip, pathOnly, started };
	if (req.method === 'GET' && pathOnly === PING_PATH) {
		// 暴露在公网时匿名连版本号都不给 —— 判据与理由见 `pingBody`。
		sendJson(res, 200, pingBody({ exposed: state.exposed === true, fp: state.fp, ver: LINK_VERSION }));
		return;
	}
	if (pathOnly === AGENT_MESSAGE_PATH) {
		handleAgentMessage(state, req, res).catch((error) => {
			state.log(`agent-message 处理失败: ${String(error?.message ?? error)}`, 'warn');
			if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
		});
		return;
	}
	if (pathOnly === PLUGIN_INSTALL_PATH) {
		handlePluginInstall(state, req, res).catch((error) => {
			state.log(`plugin-install 处理失败: ${String(error?.message ?? error)}`, 'warn');
			if (!res.headersSent) sendJson(res, 500, { ok: false, error: 'internal' });
		});
		return;
	}
	// ---- 反代路径：鉴权（见文件头「反代路径必须鉴权」）----
	// 之前这一条路径是零鉴权的：同网段任何人都能无凭据反代到本机 DSH（P0-1）。
	// 现在按来源分两档：
	//   回环（127.0.0.1 / ::1）→ 放行：本机访问本机，不构成外泄，也不打断本机自用；
	//   非回环（局域网/公网）→ 必须有正确的 x-link-key + 未过期的 x-link-ts。
	// 与桌面端「验签失败一律 403 且绝不转发」同一口径。
	if (!isLoopbackAddress(ip)) {
		const auth = verifySharedKey(req, state.pairKey, { toleranceMs: TS_TOLERANCE_MS });
		if (!auth.ok) {
			state.log(`403 ${req.method ?? '?'} ${pathOnly} ip=${ip} ${auth.reason}（反代路径未通过鉴权，已拒绝）`, 'warn');
			sendJson(res, 403, { ok: false, error: 'unauthorized' });
			return;
		}
	}
	proxyToUpstream(state, req, res, meta);
}

/**
 * 启动 TLS 网关。`log` 由插件注入（同时写 ctx.logger 与 desktop-debug.log），
 * 本模块不直连 DSH。返回停止函数；不满足启动条件时是空函数（只记一行日志）。
 * `config` 参数是给自测用的覆盖项，生产调用不传（直接读 link.json）。
 */
export function startLinkGateway({ log = () => {}, config: overrides, agentMessage, pluginInstall } = {}) {
	let config;
	try {
		config = loadConfig(log, overrides);
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
		certificate = loadOrCreateCertificate({ log, certPath: LINK_CERT_PATH, keyPath: LINK_KEY_PATH, netOptions });
	} catch (error) {
		log(`证书准备失败：${String(error?.message ?? error)}`, 'warn');
		return () => {};
	}

	// 反向通道鉴权：`pairKey` 两端共享（本机生成、写回配置，对端抄同一串）。
	if (typeof config.pairKey !== 'string' || config.pairKey.trim() === '') {
		config.pairKey = randomBytes(24).toString('hex');
		writeConfig(config, log);
		log('已生成 pairKey 并写回配置（反向通道鉴权用）');
	}
	const state = {
		fp: certificate.fp,
		// 是否暴露在公网（决定匿名 ping 给多少信息，见 `pingBody`）。
		exposed: config.allowGlobal === true,
		pairKey: config.pairKey,
		onAgentMessage: agentMessage,
		onPluginInstall: pluginInstall,
		upstream: { host: UPSTREAM_HOST, port: config.upstreamPort },
		agent: createUpstreamAgent(),
		// 一次性 nonce 记账：两条写通道共用一本账（同一时刻的 nonce 不该在两个
		// 端点各生效一次）。保留时长取时间戳窗口的 2 倍 —— 窗口内的包必须都还在账上。
		nonces: createNonceCache({ ttlMs: TS_TOLERANCE_MS * 2 }),
		log,
	};

	let server;
	try {
		server = createServer({ key: certificate.keyPem, cert: certificate.certPem, minVersion: 'TLSv1.2' }, (req, res) => handleRequest(state, req, res));
	} catch (error) {
		log(`TLS 服务创建失败：${String(error?.message ?? error)}`, 'warn');
		state.agent.destroy();
		return () => {};
	}
	// ⚠️⚠️ 监听失败必须 **error 级别 + 带可行动提示**（P2-6）：与电脑端同一口径，
	// 理由写在 `lib/desktop/link-gateway.js` 的同一处注释里 —— 两端共用这套语义，
	// 一端静默就等于「有一半的故障用户看不到原因」。
	server.on('error', (error) => {
		const code = String(error?.code ?? '');
		const hint =
			code === 'EADDRINUSE'
				? `（端口 ${config.port} 被占用：改 link.json 的 port，或停掉占用它的程序）`
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

	return () => {
		try {
			server.closeAllConnections?.();
			server.close();
			state.agent.destroy();
			log('link-gateway 已停止');
		} catch (error) {
			log(`link-gateway 停止异常: ${String(error?.message ?? error)}`, 'warn');
		}
	};
}