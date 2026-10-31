/**
 * gateway-core —— 两端网关（电脑 / 手机）共用的那一半。
 *
 * ## 为什么要抽它
 *
 * 加 IPv6 之前，`lib/desktop/link-gateway.js` 与 `lib/mobile/link-gateway.js`
 * 是两份**几乎逐字相同**的拷贝：ASN.1/DER 原语、自签证书生成与复用、反代、
 * 配置归一化、响应头过滤，全部写了两遍。
 *
 * 复制的代价不是「代码变多」，而是**演进会漂移**——只要还是两份：
 *
 * ```
 *   P0-1 手机端零鉴权    ← 桌面端演进到 v3 设备白名单 + HMAC 时，手机端没跟上
 *   P0-2 端口默认值错的  ← 从桌面端复制 DEFAULT_CONFIG 时没人记得改
 * ```
 *
 * 这两个是真实发生过的事故，不是假想的。抽出共享内核后，「分别修」变成
 * 「顺带解决」：鉴权做成策略注入，配置归一化共用一份。
 *
 * ## 边界（什么该进、什么不该进）
 *
 * 进这里的是**两端逐字相同的部分**；下面这些刻意留在外层：
 *
 * | 留在外层 | 为什么 |
 * |---|---|
 * | 协议版本 `LINK_VERSION` | 两端各自演进，本来就不一样 |
 * | 鉴权具体实现 | 电脑=device 白名单 + HMAC；手机=共享 key + 时间戳。做成策略注入 |
 * | 特有端点 | 电脑=claim/revoke；手机=agent-message/plugin-install |
 * | 配置/证书路径 | 电脑支持 `dir` 注入（自测隔离）；手机用模块常量 |
 *
 * 判断标准是**能不能单测**：进这里的都能脱离 DSH 直接 import 跑。
 *
 * 只依赖 node 内置模块与同目录的 `net.js`（地址单一事实来源）。
 *
 * @module dsh-link/gateway-core
 */
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign, timingSafeEqual, X509Certificate } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Agent, request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { dirname } from 'node:path';

import {
	certificateAddressesDrifted,
	normalizeRemoteIp,
	selectCertificateAddresses,
} from './net.js';
import { normalizeDdnsConfig } from './ddns.js';
import { DISCOVERY_PORT } from './discovery.js';

// ───────────────────────────────── 常量 ─────────────────────────────────

/** 上游一律本机：网关只做「加密 + 转发」，不做跨机路由。 */
export const UPSTREAM_HOST = '127.0.0.1';
/** 匿名探测端点（两端同名，手机据此判断地址通不通）。 */
export const PING_PATH = '/link/ping';
/** 自签证书有效期（天）。十年是为了避免频繁重签 —— 重签会改指纹，手机端要重新配对。 */
export const CERT_DAYS = 3650;

/**
 * hop-by-hop 头：请求/响应都不转发（length/编码交给 Node 自己算）。
 *
 * ⚠️ 少了 `transfer-encoding` 这一条，SSE 会被 Node 二次分块，手机端收到的是
 * 乱码；而少了 `connection`，keep-alive 会被错误透传导致连接提前关闭。
 */
export const HOP_BY_HOP = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

// ---- ASN.1 / DER 小工具（只够拼一张自签证书用，不追求通用） ----

function derLength(length) {
	if (length < 0x80) return Buffer.from([length]);
	const bytes = [];
	for (let value = length; value > 0; value = Math.floor(value / 256)) bytes.unshift(value & 0xff);
	return Buffer.from([0x80 | bytes.length, ...bytes]);
}
function der(tag, value) {
	return Buffer.concat([Buffer.from([tag]), derLength(value.length), value]);
}
function derSequence(...items) {
	return der(0x30, Buffer.concat(items));
}
function derSet(...items) {
	return der(0x31, Buffer.concat(items));
}
function derBoolean(value) {
	return der(0x01, Buffer.from([value ? 0xff : 0x00]));
}
function derOctetString(value) {
	return der(0x04, value);
}
function derUtf8(value) {
	return der(0x0c, Buffer.from(value, 'utf8'));
}
function derBitString(value, unused = 0) {
	return der(0x03, Buffer.concat([Buffer.from([unused]), value]));
}
function derExplicit(number, value) {
	return der(0xa0 + number, value);
}
function derDnsName(value) {
	return der(0x82, Buffer.from(value, 'ascii'));
}
/**
 * SAN 的 IP 条目。
 *
 * ⚠️ IPv4 与 IPv6 **共用 tag 0x87**，区别只在字节数（4 vs 16）—— 所以直接吃
 * `bytes` 就能同时支持两种，这也是当初加 IPv6 唯一需要改的编码细节。
 *
 * @param {Buffer} bytes - 4 字节（IPv4）或 16 字节（IPv6）。
 */
function derIpAddress(bytes) {
	return der(0x87, bytes);
}
function derInteger(bytes) {
	let value = bytes;
	while (value.length > 1 && value[0] === 0) value = value.subarray(1);
	if ((value[0] & 0x80) !== 0) value = Buffer.concat([Buffer.from([0]), value]);
	return der(0x02, value);
}
function derOid(dotted) {
	const parts = dotted.split('.').map(Number);
	const bytes = [parts[0] * 40 + parts[1]];
	for (const part of parts.slice(2)) {
		const chunks = [part & 0x7f];
		for (let value = Math.floor(part / 128); value > 0; value = Math.floor(value / 128)) chunks.unshift((value & 0x7f) | 0x80);
		bytes.push(...chunks);
	}
	return der(0x06, Buffer.from(bytes));
}
function derUtcTime(date) {
	const iso = date.toISOString();
	return der(0x17, Buffer.from(`${iso.slice(2, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}Z`, 'ascii'));
}
function toPem(label, derBytes) {
	const lines = derBytes.toString('base64').match(/.{1,64}/g) ?? [];
	return `-----BEGIN ${label}-----\n${lines.join('\n')}\n-----END ${label}-----\n`;
}

/** SHA-256 指纹，格式与 Node tls 的 `fingerprint256` 一致（大写、冒号分隔）。 */
export function fingerprint256(derBytes) {
	return createHash('sha256').update(derBytes).digest('hex').toUpperCase().match(/.{2}/g).join(':');
}

// ───────────────────────────────── 证书 ─────────────────────────────────

/**
 * 证书 SAN：localhost + 本机局域网地址（按地址族策略）+ 主机名。
 *
 * 地址挑选交给 `net.js`，这里只负责 DER 编码。
 *
 * @param {{addressFamily: string, allowGlobal: boolean, includeLinkLocal: boolean}} netOptions - 地址策略。
 * @returns {{entries: Buffer[], addresses: string[]}} SAN 条目与覆盖的地址（供诊断）。
 */
function subjectAltNames(netOptions) {
	const entries = [derDnsName('localhost')];
	const picked = selectCertificateAddresses({
		family: netOptions.addressFamily,
		allowGlobal: netOptions.allowGlobal,
		includeLinkLocal: netOptions.includeLinkLocal,
	});
	for (const item of picked) entries.push(derIpAddress(item.bytes));
	// 主机名也写进去：对端可能按主机名（或 mDNS 的 xxx.local）连过来，
	// 少了这条就只能按 IP 连。名字过不了 DNS 名字符集校验就跳过（Windows 中文主机名会出现）。
	const machine = hostname();
	if (machine !== '' && machine !== 'localhost' && /^[A-Za-z0-9.-]+$/.test(machine)) entries.push(derDnsName(machine));
	return { entries, addresses: picked.map((item) => item.address) };
}

/**
 * 现场生成一张自签证书（ECDSA P-256 / SHA-256）。
 *
 * 用 node:crypto 手写 DER 而不是调用 openssl：
 *   - 不新增依赖、不需要目标机器有 openssl（Windows 上真没有）；
 *   - 纯 Node 实现，单测可以直接跑，不用开进程。
 *
 * TBSCertificate 手写：v3 + 随机序列号 + 自签 issuer=subject + SAN + keyUsage 等。
 *
 * @param {{addressFamily: string, allowGlobal: boolean, includeLinkLocal: boolean}} netOptions - 地址策略。
 * @returns {{keyPem: string, certPem: string, certDer: Buffer, addresses: string[]}}
 */
export function createSelfSignedCertificate(netOptions) {
	const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const spki = publicKey.export({ type: 'spki', format: 'der' });

	let serial = randomBytes(16);
	serial[0] &= 0x7f;
	while (serial.length > 1 && serial[0] === 0) serial = serial.subarray(1);
	if (serial.every((byte) => byte === 0)) serial = Buffer.from([1]);

	// RDNSequence 里 SET OF 按 DER 字节序排序：CN(2.5.4.3) 在 O(2.5.4.10) 之前。
	const name = derSequence(
		derSet(derSequence(derOid('2.5.4.3'), derUtf8('dsh-link'))),
		derSet(derSequence(derOid('2.5.4.10'), derUtf8('dsh-link'))),
	);
	const notBefore = new Date(Date.now() - 86_400_000);
	const notAfter = new Date(Date.now() + CERT_DAYS * 86_400_000);
	const signatureAlgorithm = derSequence(derOid('1.2.840.10045.4.3.2')); // ecdsa-with-SHA256
	const san = subjectAltNames(netOptions);
	const extensions = derSequence(
		derSequence(derOid('2.5.29.19'), derBoolean(true), derOctetString(derSequence())), // basicConstraints: CA=false
		derSequence(derOid('2.5.29.15'), derBoolean(true), derOctetString(derBitString(Buffer.from([0x80]), 7))), // keyUsage: digitalSignature
		derSequence(derOid('2.5.29.37'), derOctetString(derSequence(derOid('1.3.6.1.5.5.7.3.1')))), // extKeyUsage: serverAuth
		derSequence(derOid('2.5.29.17'), derOctetString(derSequence(...san.entries))), // subjectAltName
	);
	const tbs = derSequence(
		derExplicit(0, derInteger(Buffer.from([2]))), // version: v3
		derInteger(serial),
		signatureAlgorithm,
		name, // issuer
		derSequence(derUtcTime(notBefore), derUtcTime(notAfter)),
		name, // subject（自签）
		spki,
		derExplicit(3, extensions),
	);
	const signatureValue = sign('sha256', tbs, { key: privateKey, dsaEncoding: 'der' });
	const certDer = derSequence(tbs, signatureAlgorithm, derBitString(signatureValue));
	return {
		keyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
		certPem: toPem('CERTIFICATE', certDer),
		certDer,
		addresses: san.addresses,
	};
}

/** 已有证书可用就复用（私钥匹配 + 未过期），否则返回 undefined 让调用方重生成。 */
function readExistingCertificate(log, certPath, keyPath) {
	let certPem;
	try {
		certPem = readFileSync(certPath, 'utf8');
	} catch {
		return undefined;
	}
	let keyPem;
	try {
		keyPem = readFileSync(keyPath, 'utf8');
	} catch {
		log(`证书存在但私钥缺失（${keyPath}），重新生成`, 'warn');
		return undefined;
	}
	try {
		const cert = new X509Certificate(certPem);
		if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
			log('已有证书与私钥不匹配，重新生成', 'warn');
			return undefined;
		}
		if (Date.parse(cert.validTo) <= Date.now()) {
			log('已有证书已过期，重新生成', 'warn');
			return undefined;
		}
		log(`复用已有自签证书 ${certPath}（到期 ${cert.validTo}）`);
		return { keyPem, certPem, fp: fingerprint256(cert.raw), cert };
	} catch (error) {
		log(`已有证书无法解析（${String(error?.message ?? error)}），重新生成`, 'warn');
		return undefined;
	}
}

/** 私钥权限收紧：POSIX 0600；Windows 再用 icacls 去掉继承、只留当前用户可读（失败就保留默认）。 */
export function restrictKeyFile(file, log) {
	try {
		chmodSync(file, 0o600);
	} catch {
		/* Windows 上 chmod 只影响只读位；失败不影响启动 */
	}
	if (process.platform !== 'win32') return;
	const user = (process.env.USERNAME ?? '').trim();
	if (user === '') return;
	try {
		const result = spawnSync('icacls', [file, '/inheritance:r', '/grant:r', `${user}:R`], { windowsHide: true, stdio: 'ignore' });
		if (result.error !== undefined || result.status !== 0) log(`收紧私钥 ACL 失败（保留用户目录默认 ACL）: ${file}`, 'warn');
	} catch (error) {
		log(`收紧私钥 ACL 异常: ${String(error?.message ?? error)}`, 'warn');
	}
}

/**
 * 地址漂移只告警、**绝不自动重签**（理由见 `net.js` 的 `certificateAddressesDrifted`）。
 *
 * 重签会改变证书指纹，而手机端是 pin 指纹的 → 下次连接直接掐断、用户得重新配对。
 * 一个「让它更 correct」的自动化反而会制造一次断连事故，所以这里只做诊断。
 */
function warnIfSanDrifted(log, cert, netOptions) {
	try {
		const current = selectCertificateAddresses(netOptions).map((item) => item.address);
		const pinned = String(cert?.subjectAltName ?? '')
			.split(',')
			.map((part) => part.trim())
			.filter((part) => part.startsWith('IP Address:'))
			.map((part) => part.slice('IP Address:'.length).trim());
		if (!certificateAddressesDrifted(current, pinned)) return;
		log(
			`证书 SAN 地址已变化（当前：${current.join('、') || '无'}；证书内：${pinned.join('、') || '无'}）。` +
				'IPv6 地址随隐私扩展变化是正常现象；如需让证书覆盖新地址，删除 link-cert.pem 后重启（需重新配对）',
			'warn',
		);
	} catch {
		/* 纯诊断，失败不影响启动 */
	}
}

/**
 * 载入或生成证书。
 *
 * 路径由调用方给（电脑端支持 `dir` 注入做自测隔离，手机端用模块常量）。
 *
 * @param {{log?: Function, certPath: string, keyPath: string, netOptions: object}} options
 * @returns {{keyPem: string, certPem: string, fp: string}}
 */
export function loadOrCreateCertificate({ log = () => {}, certPath, keyPath, netOptions }) {
	const existing = readExistingCertificate(log, certPath, keyPath);
	if (existing !== undefined) {
		warnIfSanDrifted(log, existing.cert, netOptions);
		return { keyPem: existing.keyPem, certPem: existing.certPem, fp: existing.fp };
	}
	const generated = createSelfSignedCertificate(netOptions);
	mkdirSync(dirname(certPath), { recursive: true, mode: 0o700 });
	writeFileSync(keyPath, generated.keyPem, { encoding: 'utf8', mode: 0o600 });
	restrictKeyFile(keyPath, log);
	writeFileSync(certPath, generated.certPem, { encoding: 'utf8', mode: 0o644 });
	const fp = fingerprint256(generated.certDer);
	log(`已生成自签证书 ${certPath}（ECDSA P-256，有效期 ${CERT_DAYS} 天；私钥 ${keyPath}）`);
	// 把 SAN 里的地址说出来：IPv6 场景下「证书里到底是哪个地址」是排障第一手信息。
	if (generated.addresses.length > 0) log(`证书 SAN 覆盖地址（${netOptions.addressFamily}）：${generated.addresses.join('、')}`);
	else log(`证书 SAN 未覆盖任何局域网地址（${netOptions.addressFamily}）；对端请改用主机名或检查 allowGlobal`, 'warn');
	return { keyPem: generated.keyPem, certPem: generated.certPem, fp };
}

/**
 * `GET /link/ping` 的响应体。
 *
 * ## 为什么匿名且暴露在公网时不给版本号
 *
 * 版本号是**给攻击者定位已知漏洞的索引**。局域网内无所谓（能连到这个端口的人
 * 本来就在同一网段），但一旦 `allowGlobal`（公网可达），匿名再回版本就是白送。
 * 所以判据是：**暴露面越大，匿名响应给得越少**。
 *
 * ## 为什么 `fp`（证书指纹）匿名也要给
 *
 * 它是 pin 的依据 —— 对端必须拿得到它才能完成首次配对（`lanConnect` 里
 * 「拿不到指纹就中止」正是靠它）。而且它本来就不是秘密：任何人 TLS 握手一次
 * 都能自己算出来，藏着没有意义，还会把「测试连接」这个功能搞坏。
 *
 * ## 为什么 `name` 留着
 *
 * 它是常量 `'dsh-link'`，不是主机名 —— 不含任何本机信息，留着无害且便于对端识别。
 *
 * @param {object} options
 * @param {boolean} [options.signed] - 请求是否带了有效签名（已授权设备）。
 * @param {boolean} [options.exposed] - 本机是否暴露在公网（`allowGlobal`）。
 * @param {string} [options.fp] - 证书指纹。
 * @param {string} [options.ver] - 版本号。
 * @returns {object} 响应体。
 */
export function pingBody({ signed = false, exposed = false, fp = '', ver = '' } = {}) {
	if (signed !== true && exposed === true) return { ok: true, fp };
	return { ok: true, name: 'dsh-link', ver, fp };
}

// ───────────────────────────────── HTTP ─────────────────────────────────

/**
 * 发一个 JSON 响应。
 *
 * ⚠️ 一律 `no-store`：网关会回配相关的信息，被中间层缓存住会出奇怪的旧数据。
 *
 * @param {object} res - HTTP 响应对象。
 * @param {number} status - 状态码。
 * @param {object} value - 响应体（会被 JSON 序列化）。
 * @param {object} [headers] - 附加响应头（如 429 的 `Retry-After`）。
 *
 * ⚠️ 附加头**覆盖不了**上面那三条：安全相关的头不允许调用方改掉，
 * 写同名的键会被这三个值顶掉（`{...headers, ...固定头}` 的顺序保证这一点）。
 */
export function sendJson(res, status, value, headers) {
	const body = Buffer.from(JSON.stringify(value), 'utf8');
	res.writeHead(status, {
		...(headers ?? {}),
		'content-type': 'application/json; charset=utf-8',
		'content-length': String(body.length),
		'cache-control': 'no-store',
	});
	res.end(body);
}

/** 响应头过滤：只去 hop-by-hop；content-length / content-encoding / SSE 头都原样保留。 */
export function filterResponseHeaders(headers) {
	const filtered = {};
	for (const [name, value] of Object.entries(headers)) {
		if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue;
		filtered[name.toLowerCase()] = value;
	}
	return filtered;
}

/**
 * 读请求体，超过 `limit` 抛 `code=BODY_TOO_LARGE`（调用方负责响应与断开）。
 *
 * ⚠️ 超限后必须 `req.destroy()`：不排空的话对端继续灌数据会一直吃内存，
 * 而且残留数据会被当成下一个请求（HTTP pipelining 的经典坑）。
 *
 * @param {object} req - HTTP 请求对象。
 * @param {number} limit - 字节上限。
 * @returns {Promise<string>} 请求体文本。
 */
export function readBody(req, limit) {
	return (async () => {
		const chunks = [];
		let total = 0;
		for await (const chunk of req) {
			total += chunk.length;
			if (total > limit) {
				req.destroy();
				throw Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' });
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString('utf8');
	})();
}

/** 定长安全比较（长度不同直接 false，不抛）。 */
export function safeEqual(a, b) {
	const left = Buffer.from(String(a ?? ''), 'utf8');
	const right = Buffer.from(String(b ?? ''), 'utf8');
	return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * 一次性 nonce 记账（防重放）。
 *
 * ## 为什么光有时间戳不够（P1-4）
 *
 * 时间戳（±5 分钟）只把重放窗口压到 5 分钟，窗口内**同一份请求可以无数次
 * 生效**。手机端的 `/link/agent-message` 尤其危险：局域网内抓到一次合法
 * 通知包，就能反复向手机 agent 注入消息。
 *
 * 所以时间戳与 nonce 是**两件事**，不是二选一：
 *
 * - 时间戳：让旧包过期；
 * - nonce：让**没过期**的包也只能用一次。
 *
 * @param {{ ttlMs?: number, max?: number, now?: Function }} [options] -
 *   `ttlMs` 记账保留时长（应 ≥ 时间戳窗口的 2 倍，见下）；`max` 条目上限，
 *   防止对方用海量 nonce 把内存撑爆。
 * @returns {{ seen: (nonce: string) => boolean, size: () => number }}
 *   `seen` 返回「这个 nonce **之前是否出现过**」（出现过 ⇒ 应当按重放拒绝）。
 */
export function createNonceCache({ ttlMs = 600_000, max = 10_000, now = Date.now } = {}) {
	/** @type {Map<string, number>} nonce → 过期时刻 */
	const seen = new Map();
	return {
		seen(nonce) {
			const current = now();
			// 顺手清过期的：长跑下不清会一直涨。
			for (const [key, until] of seen) {
				if (until <= current) seen.delete(key);
			}
			if (typeof nonce !== 'string' || nonce === '' || nonce.length > 256) return false;
			const until = seen.get(nonce);
			if (until !== undefined && until > current) return true;
			// ⚠️ 满了不记账 = 不设防。宁可淘汰最旧的一条，也不能静默放行。
			if (seen.size >= max) {
				const oldest = seen.keys().next();
				if (oldest.done !== true) seen.delete(oldest.value);
			}
			seen.set(nonce, current + ttlMs);
			return false;
		},
		size() {
			return seen.size;
		},
	};
}

/**
 * 反代：请求体 `req.pipe(upstream)`，响应 `upstreamRes.pipe(res)`。
 *
 * 全程不 collect、不加密、不改 body —— 这是 SSE / chunked 能逐块到达的关键。
 * 头里把 Host 改写成上游地址；`injectHeaders` 非空时再覆盖/追加
 * （电脑端用它注入中继令牌）。
 *
 * @param {object} state - 网关运行态（含 `upstream`、`agent`、`log`）。
 * @param {object} req - 入站请求。
 * @param {object} res - 出站响应。
 * @param {{ip: string, pathOnly: string, started: number}} meta - 日志元信息。
 * @param {object} [injectHeaders] - 要覆盖/追加的请求头。
 */
export function proxyToUpstream(state, req, res, meta, injectHeaders) {
	const headers = {};
	for (const [name, value] of Object.entries(req.headers)) {
		if (value === undefined) continue;
		const lower = name.toLowerCase();
		if (HOP_BY_HOP.has(lower)) continue;
		headers[lower] = value;
	}
	headers.host = `${state.upstream.host}:${state.upstream.port}`;
	if (injectHeaders !== undefined) Object.assign(headers, injectHeaders);

	const upstream = httpRequest({
		host: state.upstream.host,
		port: state.upstream.port,
		method: req.method,
		path: req.url ?? '/',
		headers,
		agent: state.agent,
	});
	upstream.on('socket', (socket) => socket.setNoDelay(true));
	upstream.on('response', (upstreamRes) => {
		// 立刻把上游状态/头写回去，再逐块 pipe —— SSE 的第一块不会被攒住。
		res.writeHead(upstreamRes.statusCode ?? 502, filterResponseHeaders(upstreamRes.headers));
		res.flushHeaders?.();
		upstreamRes.on('error', () => res.destroy());
		upstreamRes.pipe(res);
	});
	upstream.on('error', (error) => {
		const code = String(error?.code ?? error?.message ?? 'upstream_error');
		if (res.headersSent) {
			res.destroy();
			return;
		}
		sendJson(res, 502, { ok: false, error: 'upstream_failed' });
		state.log(`502 ${req.method ?? '?'} ${meta.pathOnly} ip=${meta.ip} ${Date.now() - meta.started}ms upstream=${code}`, 'warn');
	});
	res.on('close', () => {
		if (!upstream.writableEnded) upstream.destroy();
	});
	req.on('error', () => upstream.destroy());
	req.pipe(upstream);
}

/** 上游长连接池：keep-alive 常驻，不限制并发（远端就本机一个）。 */
export function createUpstreamAgent() {
	return new Agent({ keepAlive: true, maxSockets: Infinity });
}

// ───────────────────────────────── 配置 ─────────────────────────────────

/**
 * 归一化两端共有的配置项。
 *
 * 原则：**坏值一律回退默认值并说清楚**（静默降级会让用户以为配置生效了）。
 * `raw.xxx !== undefined` 的判断是为了区分「没写」和「写错了」——
 * 没写不该刷一堆 warn。
 *
 * @param {object} raw - 原始配置对象。
 * @param {object} defaults - 默认值（含 `port`/`listen`/`upstreamPort`）。
 * @param {Function} [log] - 日志函数。
 * @returns {object} 归一化后的配置。
 */
export function normalizeConfigBase(raw, defaults, log = () => {}) {
	const config = { ...defaults };
	config.enabled = raw.enabled !== false;

	const port = Number(raw.port);
	if (Number.isInteger(port) && port >= 1 && port <= 65535) config.port = port;
	else if (raw.port !== undefined) log(`port 不合法（${String(raw.port)}），回退 ${defaults.port}`, 'warn');

	if (typeof raw.listen === 'string' && raw.listen.trim() !== '') config.listen = raw.listen.trim();
	else if (raw.listen !== undefined) log(`listen 不合法（${String(raw.listen)}），回退 ${defaults.listen}`, 'warn');

	const upstreamPort = Number(raw.upstreamPort);
	if (Number.isInteger(upstreamPort) && upstreamPort >= 1 && upstreamPort <= 65535) config.upstreamPort = upstreamPort;
	else if (raw.upstreamPort !== undefined) log(`upstreamPort 不合法（${String(raw.upstreamPort)}），回退 ${defaults.upstreamPort}`, 'warn');

	// 地址族：认不出来退回 ipv4，并把「写错了」说出来（静默降级会让用户以为开了 IPv6）。
	const addressFamily = String(raw.addressFamily ?? '').trim().toLowerCase();
	if (raw.addressFamily !== undefined && !['ipv4', 'dual', 'ipv6'].includes(addressFamily)) {
		log(`addressFamily 不合法（${String(raw.addressFamily)}），回退 ipv4`, 'warn');
	}
	config.addressFamily = ['ipv4', 'dual', 'ipv6'].includes(addressFamily) ? addressFamily : 'ipv4';
	config.allowGlobal = raw.allowGlobal === true;
	config.includeLinkLocal = raw.includeLinkLocal === true;

	// 局域网发现：默认**开**。它只在同网段内响应，且回应里不含任何凭据，
	// 开着换来的便利（不用手填 IP）明显大于代价。
	config.discovery = normalizeDiscoveryConfig(raw.discovery, log);
	// DDNS：默认**关**。它一旦启用就等于走公网，由调用方再强制确认 allowGlobal。
	// 且它只支持「自己的服务器」（见 ddns.js 文件头）—— 不需要的人完全感知不到这一层。
	config.ddns = normalizeDdnsConfig(raw.ddns, log);
	return config;
}

/**
 * 归一化「局域网发现」配置。
 *
 * @param {object} raw - `link.json` 里的 `discovery` 对象。
 * @param {Function} [log] - 日志函数。
 * @returns {{enabled: boolean, port: number}} 归一化结果。
 */
export function normalizeDiscoveryConfig(raw, log = () => {}) {
	const base = { enabled: true, port: DISCOVERY_PORT };
	if (raw === null || typeof raw !== 'object') return base;
	base.enabled = raw.enabled !== false;

	const port = Number(raw.port);
	if (Number.isInteger(port) && port >= 1 && port <= 65535) base.port = port;
	else if (raw.port !== undefined) log(`discovery.port 不合法（${String(raw.port)}），回退 ${DISCOVERY_PORT}`, 'warn');
	return base;
}

// ───────────────────────────────── 鉴权原语 ─────────────────────────────────

/**
 * 校验「共享密钥 + 时间戳」这两道（手机端用的信任模型）。
 *
 * 与电脑端的「设备白名单 + HMAC」是两套模型，不要混：
 *   - 电脑端：多个手机，每台有 id + key，请求逐个签名（能吊销单个设备）；
 *   - 手机端：只信任一台电脑（共享 pairKey），一对一。
 *
 * 时间戳是防重放的：静态 key 只做定长比较的话，局域网内抓到一个包就能无限重放。
 *
 * @param {object} req - HTTP 请求。
 * @param {string} key - 期望的共享密钥。
 * @param {{toleranceMs?: number, now?: number}} [options] - 容忍偏移与「当前时间」（可注入便于单测）。
 * @returns {{ok: boolean, reason: string}} 校验结果。
 */
export function verifySharedKey(req, key, { toleranceMs = 0, now = Date.now() } = {}) {
	if (typeof key !== 'string' || key === '') return { ok: false, reason: 'no-key-configured' };
	const provided = typeof req.headers['x-link-key'] === 'string' ? req.headers['x-link-key'] : '';
	if (provided === '' || !safeEqual(provided, key)) return { ok: false, reason: 'bad-key' };
	if (toleranceMs > 0) {
		const stamp = Number(req.headers['x-link-ts']);
		if (!Number.isFinite(stamp) || Math.abs(now - stamp) > toleranceMs) return { ok: false, reason: 'stale-timestamp' };
	}
	return { ok: true, reason: '' };
}

/** 日志/诊断用的远端 IP（剥 `::ffff:` 与 zone id）。 */
export function remoteIpOf(req) {
	return normalizeRemoteIp(req?.socket?.remoteAddress);
}
