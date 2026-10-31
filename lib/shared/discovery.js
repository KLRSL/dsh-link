/**
 * discovery —— 局域网内找到对端（不用手填 IP）。
 *
 * ## 解决什么问题
 *
 * 配对时手机要知道电脑的地址。现在得手填 `lanHost`，换网络就失效。
 * 本模块用 **UDP 广播**让电脑自己应答：「我在这儿，端口是这个」。
 *
 * ## 为什么是 UDP 广播，而不是 mDNS
 *
 * mDNS（`.local` 域名）是这件事的标准答案，但 Node 标准库**没有** mDNS，
 * 要引第三方依赖（multicast-dns / bonjour）。对一个插件来说，为「偶尔找一次对端」
 * 引入一个常驻的多播栈不划算 —— 而且 mDNS 在 Android 上常被系统限制。
 * 广播只需要 `node:dgram`，零依赖，且在**同一网段**内可靠。
 *
 * ## 边界（做不到什么，先说清楚）
 *
 * **广播不过路由器**。手机和电脑必须在同一网段（同一 Wi-Fi、同一交换机）。
 * 跨网段 / 跨 VPN / 手机在外的场景，要靠 DDNS（见 `ddns.js`），本模块帮不上。
 *
 * ## 安全约束（改这个文件时别破坏）
 *
 * - **响应里不含任何凭据**。只有 `name` / `port` / `ver` / `fp`（证书指纹本来就是要
 *   给对端 pin 的公开值）。绝不能放 token、pairKey、配对码。
 * - **限速**。响应方对每个源 IP 限流：否则一个伪造源 IP 的广播包就能让网关
 *   疯狂回包（反射型放大，虽然这里放大倍数很低，但没有理由不设防）。
 * - **只认协议版本 1**。收到看不懂的包一律丢弃，不回错误详情（回详情等于帮人探测）。
 * - **不留常驻 socket**：发现方用完即关，响应方随网关生命周期启停。
 *
 * @module dsh-link/shared/discovery
 */

import { networkInterfaces } from 'node:os';
import * as nodeDgram from 'node:dgram';

/** 发现用的 UDP 端口。与 TCP 网关端口（8898/8899）分开，互不干扰。 */
export const DISCOVERY_PORT = 8897;

/** 协议版本。对端版本不一致就当没看见。 */
export const DISCOVERY_VERSION = 1;

/** 单次发现的默认超时。广播在局域网内通常几十毫秒就有回应。 */
export const DISCOVERY_TIMEOUT_MS = 2000;

/** 响应方限速窗口。 */
export const RATE_WINDOW_MS = 10_000;

/** 响应方在窗口内最多回多少个包（单源 IP）。 */
export const RATE_MAX_PER_WINDOW = 20;

/** 单个发现包的最大字节数。超过就是异常流量，直接丢。 */
export const MAX_PACKET_BYTES = 512;

// ───────────────────────────────── 协议 ─────────────────────────────────

/**
 * 编码一个查询包。
 *
 * @returns {Buffer} 待发送的字节。
 */
export function encodeQuery() {
	return Buffer.from(JSON.stringify({ v: DISCOVERY_VERSION, t: 'q' }), 'utf8');
}

/**
 * 编码一个响应包。
 *
 * ⚠️ 这里能放的字段是**刻意收敛过的**：`fp` 是证书指纹（对端本来就要 pin），
 * 其余都是「连过来必需」的地址信息。**任何凭据都不许进这个对象。**
 *
 * @param {{name: string, port: number, ver: string, fp: string}} info - 自身信息。
 * @returns {Buffer} 待发送的字节。
 */
export function encodeResponse(info) {
	return Buffer.from(
		JSON.stringify({
			v: DISCOVERY_VERSION,
			t: 'r',
			name: String(info?.name ?? ''),
			port: Number(info?.port ?? 0),
			ver: String(info?.ver ?? ''),
			fp: String(info?.fp ?? ''),
		}),
		'utf8',
	);
}

/**
 * 解析并校验一个收到的包。
 *
 * @param {Buffer} bytes - 收到的字节。
 * @param {'q'|'r'} want - 期望的类型。
 * @returns {object|null} 解析成功返回对象，否则 null（**不抛**，网络输入一律当不可信）。
 */
export function decodePacket(bytes, want) {
	if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > MAX_PACKET_BYTES) return null;
	let parsed;
	try {
		parsed = JSON.parse(bytes.toString('utf8'));
	} catch {
		return null;
	}
	if (parsed === null || typeof parsed !== 'object') return null;
	if (parsed.v !== DISCOVERY_VERSION) return null;
	if (parsed.t !== want) return null;
	return parsed;
}

// ───────────────────────────────── 广播地址 ─────────────────────────────────

/**
 * 算出本机各网卡的子网广播地址（IPv4）。
 *
 * 为什么不用 `255.255.255.255` 一发了事：多网卡机器（有线 + 无线 + 虚拟机网卡）
 * 的全局广播通常只走默认路由那一张，其它网段收不到。逐个网卡算广播地址才覆盖得全。
 *
 * @param {object} [interfaces] - 可注入网卡表（自测用）。
 * @returns {string[]} 广播地址列表（去重）。
 */
export function broadcastAddresses(interfaces) {
	const table = interfaces ?? networkInterfaces();
	const out = new Set();
	for (const list of Object.values(table ?? {})) {
		for (const item of list ?? []) {
			if (item?.family !== 'IPv4' || item.internal === true) continue;
			const ip = toLong(item.address);
			const mask = toLong(item.netmask);
			if (ip === null || mask === null || mask === 0) continue;
			// 广播地址 = (ip & mask) | ~mask
			out.add(fromLong((ip & mask) | (~mask & 0xffffffff)));
		}
	}
	return [...out];
}

/**
 * 点分十进制 → 32 位无符号整数（网络字节序的数值表示）。
 *
 * @param {string} text - IPv4 地址。
 * @returns {number|null} 数值，非法返回 null。
 */
function toLong(text) {
	const parts = String(text ?? '').split('.');
	if (parts.length !== 4) return null;
	let value = 0;
	for (const part of parts) {
		const n = Number(part);
		if (!Number.isInteger(n) || n < 0 || n > 255) return null;
		value = (value << 8) | n;
	}
	return value >>> 0;
}

/**
 * 32 位无符号整数 → 点分十进制。
 *
 * @param {number} value - 数值。
 * @returns {string} IPv4 地址。
 */
function fromLong(value) {
	return [value >>> 24, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff].join('.');
}

// ───────────────────────────────── 响应方 ─────────────────────────────────

/**
 * 建一个「被发现」的响应方（跑在**电脑端**）。
 *
 * 收到查询就回一段自身信息。带单源 IP 限速：防止被伪造源地址的广播包打成回包放大器。
 *
 * @param {object} options
 * @param {number} [options.port] - 监听的 UDP 端口。
 * @param {Function} options.info - 返回自身信息的函数（每次调用时取，保证端口/指纹是最新的）。
 * @param {Function} [options.log] - 日志。
 * @param {object} [options.dgramImpl] - 注入 `node:dgram`。
 * @param {Function} [options.now] - 注入时间源。
 * @returns {{start: Function, stop: Function}} 响应方。
 */
export function createDiscoveryResponder({ port = DISCOVERY_PORT, info, log = () => {}, dgramImpl, now = () => Date.now() } = {}) {
	const dgram = dgramImpl ?? nodeDgram;
	let socket = null;
	const hits = new Map();

	if (typeof info !== 'function') throw new Error('info must be a function');

	/**
	 * 该不该回这个源 IP。
	 *
	 * 限速用 Map + 窗口淘汰，而不是「记一个时间戳」：后者在多源场景下会互相覆盖。
	 * Map 也会随源 IP 增多而增长，所以顺手清理过期项（防止长期运行内存只涨不降）。
	 *
	 * @param {string} ip - 源 IP。
	 * @returns {boolean} 是否允许回应。
	 */
	function allow(ip) {
		const current = now();
		for (const [key, record] of hits) {
			if (record.resetAt <= current) hits.delete(key);
		}
		const record = hits.get(ip);
		if (record === undefined) {
			hits.set(ip, { count: 1, resetAt: current + RATE_WINDOW_MS });
			return true;
		}
		if (record.count >= RATE_MAX_PER_WINDOW) return false;
		record.count += 1;
		return true;
	}

	return {
		start() {
			if (socket !== null) return;
			socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
			socket.on('message', (bytes, rinfo) => {
				const query = decodePacket(bytes, 'q');
				if (query === null) return; // 看不懂的一律不回，也不回错误详情
				const ip = String(rinfo?.address ?? '');
				if (ip === '' || allow(ip) !== true) return;
				try {
					const payload = encodeResponse(info());
					socket.send(payload, 0, payload.length, Number(rinfo.port), ip, (error) => {
						if (error) log(`发现响应发送失败: ${String(error?.message ?? error)}`, 'warn');
					});
				} catch (error) {
					log(`发现响应构造失败: ${String(error?.message ?? error)}`, 'warn');
				}
			});
			socket.on('error', (error) => log(`发现监听出错: ${String(error?.message ?? error)}`, 'warn'));
			socket.bind(port, () => {
				try {
					socket.setBroadcast(true);
				} catch {
					/* 某些平台不支持，广播接收能力降级但不影响被单播查询 */
				}
				log(`局域网发现已开启（UDP ${port}）`);
			});
		},
		stop() {
			if (socket === null) return;
			try {
				socket.close();
			} catch {
				/* 关闭失败无需处理 */
			}
			socket = null;
			hits.clear();
		},
	};
}

// ───────────────────────────────── 发现方 ─────────────────────────────────

/**
 * 主动找一次对端（跑在**手机端**）。
 *
 * 往各网卡的子网广播地址发查询，收集响应，超时后统一返回。
 *
 * @param {object} [options]
 * @param {number} [options.port] - 目标 UDP 端口。
 * @param {number} [options.timeoutMs] - 超时。
 * @param {object} [options.interfaces] - 注入网卡表（自测用）。
 * @param {object} [options.dgramImpl] - 注入 `node:dgram`。
 * @param {Function} [options.log] - 日志。
 * @returns {Promise<Array<{ip: string, port: number, name: string, ver: string, fp: string}>>} 候选列表（去重，不含无效项）。
 */
export function discoverPeers({
	port = DISCOVERY_PORT,
	timeoutMs = DISCOVERY_TIMEOUT_MS,
	interfaces,
	dgramImpl,
	log = () => {},
} = {}) {
	const dgram = dgramImpl ?? nodeDgram;
	const query = encodeQuery();
	const targets = broadcastAddresses(interfaces);
	if (targets.length === 0) return Promise.resolve([]);

	return new Promise((resolve) => {
		const found = new Map();
		let socket = null;
		let settled = false;

		const finish = () => {
			if (settled === true) return;
			settled = true;
			if (timer !== null) clearTimeout(timer);
			try {
				socket?.close();
			} catch {
				/* 忽略 */
			}
			resolve([...found.values()]);
		};

		const timer = setTimeout(finish, timeoutMs);

		try {
			socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
		} catch (error) {
			log(`发现失败（无法创建 socket）: ${String(error?.message ?? error)}`, 'warn');
			finish();
			return;
		}

		socket.on('message', (bytes, rinfo) => {
			const res = decodePacket(bytes, 'r');
			if (res === null) return;
			const ip = String(rinfo?.address ?? '');
			const portValue = Number(res.port);
			// 端口必须合法，否则「发现」出来的地址反而把用户带沟里。
			if (ip === '' || !Number.isInteger(portValue) || portValue < 1 || portValue > 65535) return;
			if (found.has(ip) !== true) found.set(ip, { ip, port: portValue, name: String(res.name ?? ''), ver: String(res.ver ?? ''), fp: String(res.fp ?? '') });
		});

		socket.on('error', (error) => {
			log(`发现出错: ${String(error?.message ?? error)}`, 'warn');
			finish();
		});

		socket.bind(0, () => {
			try {
				socket.setBroadcast(true);
			} catch {
				/* 不支持广播就只发单播，仍可能命中同网段 */
			}
			for (const target of targets) {
				socket.send(query, 0, query.length, port, target, (error) => {
					if (error) log(`发现查询发往 ${target} 失败: ${String(error?.message ?? error)}`, 'debug');
				});
			}
		});
	});
}
