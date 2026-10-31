/**
 * net —— 局域网直连的「地址」单一事实来源。
 *
 * ## 这个模块为什么存在
 *
 * 加 IPv6 支持之前，地址相关的逻辑散落在四个地方，且各自只处理 IPv4：
 *
 * ```
 *   link-gateway.js ×2   subjectAltNames()  只收 family==='IPv4'，IPv6 需要 16 字节 DER
 *   link-gateway.js ×2   DEFAULT_CONFIG     listen='0.0.0.0'，IPv6 需要 '::'
 *   mobile/index.js:576  `https://${lanHost}:${lanPort}`   IPv6 裸拼是非法 URL
 *   link-notify.js:151   targetOf()         见下面「方括号」那条
 * ```
 *
 * 分散的后果不是「重复代码」，而是**协议事实出现了四份互相不一致的版本**：
 * 改一处漏三处，且每一处漏掉的表现都不同（证书不匹配的 TLS 握手失败、
 * 解析不了的 URL、连不上的 socket），排查成本极高。所以把所有地址知识
 * 收敛到一个纯函数模块，上层只调用、不再自己判断。
 *
 * ## ⚠️ 三个必须记住的 IPv6 事实（踩过的坑都写在这）
 *
 * ### 1. 裸拼 IPv6 到 URL 是**语法错误**，必须加方括号
 *
 * ```
 *   https://2001:db8::1:8899    ← 非法：冒号被当成端口分隔符，端口解析成 "db8::1:8899"
 *   https://[2001:db8::1]:8899  ← 正确（RFC 3986 §3.2.2）
 * ```
 *
 * 所以**任何**字符串拼接地址的地方都必须走 {@link formatEndpoint}，
 * 不允许再写 `` `https://${host}:${port}` ``。
 *
 * ### 2. `new URL()` 的 `hostname` 对 IPv6 **保留方括号**
 *
 * 实测（Node 20）：
 *
 * ```
 *   new URL('https://[2001:db8::1]:8899').hostname  === '[2001:db8::1]'   ← 带括号！
 *   new URL('https://192.168.1.5:8899').hostname    === '192.168.1.5'
 * ```
 *
 * 而 `tls.connect({ host })` / `https.request({ hostname })` **不接受带方括号的主机名**
 * （会当成 DNS 名去解析，必然失败）。所以从 URL 取出来的 hostname 必须先过
 * {@link unwrapHost} 才能交给 socket 层。这是一个静默失败点：连不上、日志只有
 * 一行 ENOTFOUND，看不出来是方括号的问题。
 *
 * ### 3. IPv6 的 loopback / 回环映射有额外形态
 *
 * ```
 *   ::1                  IPv6 回环
 *   ::ffff:192.168.1.5   IPv4-mapped IPv6（Node 的 socket.remoteAddress 常见格式）
 *   fe80::1%eth0         链路本地地址带 zone id（scope），跨平台差异大
 * ```
 *
 * Node 在双栈监听时 `remoteAddress` 会给 `::ffff:` 前缀的串，直接当 IPv6 处理会误判，
 * 必须先归一（{@link normalizeRemoteIp}）。
 *
 * ## 安全前提：IPv6 会击穿「局域网直连」的假设
 *
 * 现在的默认监听 `0.0.0.0` 之所以安全，是因为 **IPv4 有 NAT** —— 家用路由器天然
 * 挡住了外网。IPv6 通常**没有 NAT**：一旦监听 `::`，若系统防火墙放行，这台机器
 * 就是直接暴露在公网上，不再是「局域网」。
 *
 * 所以本模块把地址按**作用域**分级，并让监听策略强制显式选择：
 *
 * | 作用域 | 例子 | 默认是否监听 |
 * |---|---|---|
 * | `private`（IPv4 私网 / IPv6 ULA `fc00::/7`） | `192.168.1.5` / `fd00::1` | ✅ |
 * | `link-local` | `169.254.x` / `fe80::1` | ⚠️ 可开，但 zone id 跨平台麻烦 |
 * | `global` | `203.0.113.5` / `2001:db8::1` | ❌ **默认不监听**，需显式 `allowGlobal` |
 *
 * 默认 `addressFamily = 'ipv4'`，行为与加 IPv6 之前**逐字节相同**。
 *
 * 只依赖 node 内置模块，全部是纯函数，可单独 import 自测。
 *
 * @module dsh-link/net
 */
import { networkInterfaces } from 'node:os';

/**
 * 地址族策略（`link.json` 的 `addressFamily`）。
 *
 * - `ipv4`：只监听 IPv4（默认，与历史行为一致）
 * - `dual`：监听 `::` 并接受 IPv4 映射（双栈）
 * - `ipv6`：监听 `::` 且只接受 IPv6
 */
export const AddressFamily = Object.freeze({
	IPV4: 'ipv4',
	DUAL: 'dual',
	IPV6: 'ipv6',
});

/** 合法取值列表（配置校验用）。 */
export const ADDRESS_FAMILIES = Object.freeze(['ipv4', 'dual', 'ipv6']);

/**
 * 地址作用域。
 *
 * 分级的目的不是学术正确，而是为了**决定能不能监听 / 能不能写进证书 SAN**。
 * 见文件头「安全前提」那张表。
 */
export const AddressScope = Object.freeze({
	/** 回环：`127.0.0.0/8` / `::1` */
	LOOPBACK: 'loopback',
	/** 私网：`10/8`、`172.16/12`、`192.168/16` / IPv6 ULA `fc00::/7` */
	PRIVATE: 'private',
	/** 链路本地：`169.254/16` / `fe80::/10`（不可路由，常带 zone id） */
	LINK_LOCAL: 'link-local',
	/** 全局可路由：公网地址，**默认不监听** */
	GLOBAL: 'global',
	/** 未指定：`0.0.0.0` / `::`（只作监听通配符，不该出现在 SAN 里） */
	UNSPECIFIED: 'unspecified',
	/** 解析不出来 */
	UNKNOWN: 'unknown',
});

/** 证书 SAN 里 IP 条目数的上限（IPv6 隐私地址会让地址数量暴涨）。 */
export const MAX_SAN_ADDRESSES = 16;

// ───────────────────────────────── 解析 ─────────────────────────────────

/** IPv4 点分十进制 → 4 字节；格式不对返回 null。 */
function parseIpv4ToBytes(text) {
	const parts = String(text ?? '').split('.');
	if (parts.length !== 4) return null;
	const bytes = new Array(4);
	for (let index = 0; index < 4; index += 1) {
		const part = parts[index];
		// 拒绝前导零（`01.2.3.4` 有歧义）、空段、非数字、越界。
		if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
		const value = Number(part);
		if (!Number.isInteger(value) || value < 0 || value > 255) return null;
		bytes[index] = value;
	}
	return Buffer.from(bytes);
}

/**
 * IPv6 文本 → 16 字节；格式不对返回 null。
 *
 * 支持三段形态：完整/`::` 压缩、嵌入 IPv4（`::ffff:192.168.1.5`）、zone id（`%eth0`）。
 *
 * ⚠️ 严格按 RFC 4291：`::` 必须代表**至少一组** 0，所以 `1:2:3:4:5:6:7:8::` 判为非法。
 * 宽松解析会接受它并静默产生错误字节，进而把错误的 IP 写进证书 SAN —— 那种问题
 * 现场几乎查不出来，宁可早期拒绝。
 *
 * @param {string} text - 地址文本。
 * @returns {{bytes: Buffer, zone: string}|null} 解析结果（zone 可能为空串）。
 */
function parseIpv6ToBytes(text) {
	let body = String(text ?? '').trim();
	if (body === '') return null;
	let zone = '';
	const percent = body.indexOf('%');
	if (percent >= 0) {
		zone = body.slice(percent + 1);
		body = body.slice(0, percent);
		if (zone === '') return null; // `fe80::1%` 后面必须有东西
	}
	if (body === '' || /[^0-9a-fA-F:.]/.test(body)) return null;

	const halves = body.split('::');
	if (halves.length > 2) return null;

	/** 一段冒号分隔的串 → 16 位组数组；末尾允许嵌入 IPv4。 */
	const expand = (segment) => {
		if (segment === '') return [];
		const parts = segment.split(':');
		const groups = [];
		for (let index = 0; index < parts.length; index += 1) {
			const part = parts[index];
			if (part === '') return null; // 空段只可能出现在 `::` 两侧，这里不该有
			if (part.includes('.')) {
				// 嵌入 IPv4 只允许出现在末尾，且占两组。
				if (index !== parts.length - 1) return null;
				const v4 = parseIpv4ToBytes(part);
				if (v4 === null) return null;
				groups.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
				continue;
			}
			if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
			groups.push(Number.parseInt(part, 16));
		}
		return groups;
	};

	const head = expand(halves[0]);
	if (head === null) return null;
	let tail = [];
	if (halves.length === 2) {
		tail = expand(halves[1]);
		if (tail === null) return null;
	}

	let groups;
	if (halves.length === 1) {
		if (head.length !== 8) return null;
		groups = head;
	} else {
		const fill = 8 - head.length - tail.length;
		if (fill < 1) return null; // `::` 至少代表一组 0
		groups = [...head, ...new Array(fill).fill(0), ...tail];
	}
	if (groups.length !== 8) return null;

	const bytes = Buffer.alloc(16);
	for (let index = 0; index < 8; index += 1) {
		bytes[index * 2] = groups[index] >> 8;
		bytes[index * 2 + 1] = groups[index] & 0xff;
	}
	return { bytes, zone };
}

/**
 * 判断一个地址文本是不是 IP 字面量（而不是域名）。
 *
 * 注意这里**不**做完整合法性校验，只回答「它长得像不像 IP」——
 * 调用方（如 `assertTrustedHost`）用它来分流，真正的校验交给
 * {@link classifyAddress}。分开是因为「像 IP」和「是合法 IP」在错误提示上
 * 该给不同的信息。
 *
 * @param {unknown} text - 待判断文本。
 * @returns {boolean} 是否像 IP 字面量。
 */
export function isIpLiteral(text) {
	const raw = String(text ?? '').trim();
	if (raw === '') return false;
	if (raw.startsWith('[') && raw.endsWith(']')) return isIpLiteral(raw.slice(1, -1));
	if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(raw)) return true;
	if (!raw.includes(':')) return false;
	// IPv6：主体只由十六进制/冒号/点组成。
	// ⚠️ zone id 要先切掉再校验 —— `fe80::1%eth0` 的 `eth0` 是网卡名，
	// 可以是任意字符串（Windows 上甚至是 `fe80::1%12`），把它放进字符集
	// 校验会把链路本地地址误判成域名。
	const body = raw.split('%')[0];
	return body.includes(':') && /^[0-9a-fA-F:.]+$/.test(body);
}

/**
 * 把地址归类：版本 + 作用域。
 *
 * 这是本模块对外最核心的函数，其余判断都建立在它之上。
 *
 * @param {unknown} text - 地址文本（允许 `[]` 包裹、允许 `::ffff:` 映射、允许 `%zone`）。
 * @returns {{version: 4|6|0, scope: string, bytes: Buffer|null, zone: string, raw: string}} 解析结果。
 *   `version === 0` 表示解析不出来，此时 `scope` 为 {@link AddressScope.UNKNOWN}。
 */
export function classifyAddress(text) {
	const trimmed = String(text ?? '').trim();
	const raw = trimmed.startsWith('[') && trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed;

	// IPv4-mapped IPv6（`::ffff:192.168.1.5`）：本质就是那个 IPv4，按 v4 归类。
	// Node 在双栈监听下 `socket.remoteAddress` 就是这个形态，不归一会把
	// 192.168.1.5 误判成 IPv6 全局地址，进而错误地拒绝或放行。
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(raw);
	if (mapped !== null) {
		const v4 = parseIpv4ToBytes(mapped[1]);
		if (v4 !== null) {
			return { version: 4, scope: scopeOfIpv4(v4), bytes: v4, zone: '', raw };
		}
	}

	if (raw.includes(':')) {
		const parsed = parseIpv6ToBytes(raw);
		if (parsed === null) return { version: 0, scope: AddressScope.UNKNOWN, bytes: null, zone: '', raw };
		return { version: 6, scope: scopeOfIpv6(parsed.bytes), bytes: parsed.bytes, zone: parsed.zone, raw };
	}

	const v4 = parseIpv4ToBytes(raw);
	if (v4 === null) return { version: 0, scope: AddressScope.UNKNOWN, bytes: null, zone: '', raw };
	return { version: 4, scope: scopeOfIpv4(v4), bytes: v4, zone: '', raw };
}

/** 4 字节 → 作用域。 */
function scopeOfIpv4(bytes) {
	if (bytes[0] === 127) return AddressScope.LOOPBACK;
	if (bytes[0] === 10) return AddressScope.PRIVATE;
	if (bytes[0] === 172 && bytes[1] >= 16 && bytes[1] <= 31) return AddressScope.PRIVATE;
	if (bytes[0] === 192 && bytes[1] === 168) return AddressScope.PRIVATE;
	if (bytes[0] === 169 && bytes[1] === 254) return AddressScope.LINK_LOCAL;
	if (bytes.every((byte) => byte === 0)) return AddressScope.UNSPECIFIED;
	return AddressScope.GLOBAL;
}

/** 16 字节 → 作用域。 */
function scopeOfIpv6(bytes) {
	if (bytes.every((byte) => byte === 0)) return AddressScope.UNSPECIFIED;
	// ::1
	if (bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1) return AddressScope.LOOPBACK;
	// fc00::/7 —— ULA（唯一本地地址），等同 IPv4 私网，是我们默认敢用的那一类。
	if ((bytes[0] & 0xfe) === 0xfc) return AddressScope.PRIVATE;
	// fe80::/10 —— 链路本地。RFC 4291 定义的前 10 位：1111111010。
	if (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) return AddressScope.LINK_LOCAL;
	return AddressScope.GLOBAL;
}

/**
 * 是不是回环地址（含 `::1` 与 `::ffff:127.x`）。
 *
 * 之前 `isLoopbackRequest` 里写成 `address === '127.0.0.1' || address === '::1'`
 * 的字符串比较，漏掉了 `::ffff:127.0.0.1` 这种形态 —— 双栈下 Node 真会给这个。
 *
 * @param {unknown} text - 地址文本。
 * @returns {boolean} 是否回环。
 */
export function isLoopbackAddress(text) {
	return classifyAddress(text).scope === AddressScope.LOOPBACK;
}

/**
 * 归一化远端地址：剥掉 IPv4-mapped 前缀与 zone id，得到可比较/可记录的形式。
 *
 * 用途是**日志与白名单比对**，不是连接 —— 连接要用 {@link unwrapHost}。
 *
 * @param {unknown} remote - `socket.remoteAddress` 之类的原始值。
 * @returns {string} 归一化后的地址；空值返回 `'unknown'`。
 */
export function normalizeRemoteIp(remote) {
	const raw = String(remote ?? '').trim();
	if (raw === '') return 'unknown';
	const percent = raw.indexOf('%');
	const stripped = percent >= 0 ? raw.slice(0, percent) : raw;
	const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(stripped);
	return mapped !== null ? mapped[1] : stripped;
}

// ───────────────────────────────── 格式化 ─────────────────────────────────

/**
 * 去掉 IPv6 的方括号（`[2001:db8::1]` → `2001:db8::1`）。
 *
 * ⚠️ **交给 socket 之前必须过这一道**：`new URL()` 的 `hostname` 对 IPv6 保留方括号，
 * 而 `tls.connect({host})` / `https.request({hostname})` 不接受它（见文件头事实 2）。
 *
 * 非 IPv6 原样返回，且**不校验**合法性 —— 因为调用方拿到的可能已是合法主机名。
 *
 * @param {unknown} host - 主机名（可能带方括号）。
 * @returns {string} 去掉方括号的主机名。
 */
export function unwrapHost(host) {
	const raw = String(host ?? '').trim();
	if (raw.length >= 2 && raw.startsWith('[') && raw.endsWith(']')) return raw.slice(1, -1);
	return raw;
}

/**
 * 给 IPv6 加方括号（已带则不动），IPv4 与域名原样返回。
 *
 * @param {unknown} host - 主机名。
 * @returns {string} 可用于 URL authority 的主机名。
 */
export function bracketHost(host) {
	const raw = String(host ?? '').trim();
	if (raw === '') return '';
	if (raw.startsWith('[') && raw.endsWith(']')) return raw;
	// 只给「真的是 IPv6」的加括号：域名里不会出现冒号（端口已在别处分离）。
	return isIpLiteral(raw) && raw.includes(':') ? `[${raw}]` : raw;
}

/**
 * 拼 `host:port`（RFC 3986 的 authority）。
 *
 * 这是**唯一**允许拼地址端口的地方 —— 见文件头事实 1，IPv6 裸拼是语法错误。
 *
 * @param {unknown} host - 主机名或 IP。
 * @param {number|string} [port] - 端口；省略或非法则只回 host。
 * @returns {string} 如 `192.168.1.5:8899` / `[2001:db8::1]:8899`。
 */
export function formatAuthority(host, port) {
	const bracketed = bracketHost(host);
	if (bracketed === '') return '';
	const numeric = Number(port);
	if (!Number.isInteger(numeric) || numeric < 1 || numeric > 65535) return bracketed;
	return `${bracketed}:${numeric}`;
}

/**
 * 拼完整端点 URL。
 *
 * @param {unknown} host - 主机名或 IP（允许已带方括号）。
 * @param {number|string} [port] - 端口；省略则用协议默认端口。
 * @param {{protocol?: string, path?: string}} [options] - 协议（默认 https）与路径前缀。
 * @returns {string} 如 `https://[2001:db8::1]:8899`。
 */
export function formatEndpoint(host, port, { protocol = 'https', path = '' } = {}) {
	const authority = formatAuthority(host, port);
	if (authority === '') return '';
	const scheme = String(protocol ?? 'https').replace(/:+$/, '') || 'https';
	const suffix = typeof path === 'string' && path !== '' && !path.startsWith('/') ? `/${path}` : String(path ?? '');
	return `${scheme}://${authority}${suffix}`;
}

// ───────────────────────────────── 监听策略 ─────────────────────────────────

/**
 * 地址族 → 监听参数。
 *
 * ⚠️ `ipv6Only` 必须**显式**传：Node 在 `::` 上默认就是双栈，靠默认值区分
 * `dual` 与 `ipv6` 会让两个策略静默变成同一个行为。
 *
 * @param {string} [family] - {@link AddressFamily} 之一；认不出来按 `ipv4` 处理。
 * @returns {{host: string, ipv6Only: boolean, family: string}} 监听参数。
 */
export function resolveListenHost(family) {
	switch (String(family ?? '').trim().toLowerCase()) {
		case AddressFamily.DUAL:
			return { host: '::', ipv6Only: false, family: AddressFamily.DUAL };
		case AddressFamily.IPV6:
			return { host: '::', ipv6Only: true, family: AddressFamily.IPV6 };
		case AddressFamily.IPV4:
			return { host: '0.0.0.0', ipv6Only: false, family: AddressFamily.IPV4 };
		default:
			// 未识别的策略一律退回 IPv4 —— 不能因为配置写错就把机器暴露到公网。
			return { host: '0.0.0.0', ipv6Only: false, family: AddressFamily.IPV4 };
	}
}

/** 归一化配置里的地址族；非法值返回默认 `ipv4`。 */
export function normalizeAddressFamily(value) {
	const text = String(value ?? '').trim().toLowerCase();
	return ADDRESS_FAMILIES.includes(text) ? text : AddressFamily.IPV4;
}

// ───────────────────────────────── 地址枚举 ─────────────────────────────────

/**
 * 枚举本机地址（带分类）。
 *
 * @param {{interfaces?: object}} [options] - 可注入网卡表（自测用；缺省读 `os.networkInterfaces()`）。
 * @returns {Array<{address: string, version: 4|6, scope: string, internal: boolean, interface: string}>} 地址列表。
 */
export function listHostAddresses({ interfaces } = {}) {
	const table = interfaces ?? networkInterfaces();
	const result = [];
	for (const [name, list] of Object.entries(table ?? {})) {
		for (const item of list ?? []) {
			const info = classifyAddress(item?.address);
			if (info.version === 0) continue;
			result.push({
				address: normalizeRemoteIp(item.address),
				version: info.version,
				scope: info.scope,
				internal: Boolean(item?.internal),
				interface: name,
			});
		}
	}
	return result;
}

/**
 * 挑出**该写进证书 SAN** 的地址。
 *
 * 规则（顺序即优先级）：
 *  1. 排除回环与未指定地址 —— 它们对对端没有意义，写进去只会让 SAN 变长；
 *  2. 按 `family` 过滤版本；
 *  3. **全局地址默认排除**，必须 `allowGlobal: true` 才纳入（见文件头「安全前提」）；
 *  4. 链路本地默认排除（zone id 跨平台不可靠，且不可路由）；
 *  5. 去重 + 排序 + 截断到 {@link MAX_SAN_ADDRESSES}。
 *
 * ⚠️ 第 5 步的截断不是随便做的：IPv6 隐私扩展（RFC 4941）会让一台机器同时持有
 * 多个临时全局地址，不截断的话证书可能带几十个 SAN 条目，且地址一变就失配。
 *
 * @param {{family?: string, allowGlobal?: boolean, includeLinkLocal?: boolean, interfaces?: object}} [options]
 * @returns {Array<{address: string, version: 4|6, bytes: Buffer}>} 用于 SAN 的地址（含 DER 所需字节）。
 */
export function selectCertificateAddresses({
	family = AddressFamily.IPV4,
	allowGlobal = false,
	includeLinkLocal = false,
	interfaces,
} = {}) {
	const wanted = normalizeAddressFamily(family);
	const all = listHostAddresses({ interfaces });

	const picked = [];
	const seen = new Set();
	for (const item of all) {
		if (item.internal) continue;
		if (item.scope === AddressScope.LOOPBACK || item.scope === AddressScope.UNSPECIFIED) continue;
		if (wanted === AddressFamily.IPV4 && item.version !== 4) continue;
		if (wanted === AddressFamily.IPV6 && item.version !== 6) continue;
		if (item.scope === AddressScope.GLOBAL && allowGlobal !== true) continue;
		if (item.scope === AddressScope.LINK_LOCAL && includeLinkLocal !== true) continue;
		if (seen.has(item.address)) continue;
		seen.add(item.address);
		const info = classifyAddress(item.address);
		if (info.bytes === null) continue;
		picked.push({ address: item.address, version: item.version, bytes: info.bytes });
	}

	// 稳定排序：私网优先、再按地址字节序。顺序稳定才能让「证书是否需要重生成」
	// 的判断不会因为 Object.entries 的顺序抖动而误判。
	picked.sort((left, right) => {
		if (left.version !== right.version) return left.version - right.version;
		return Buffer.compare(left.bytes, right.bytes);
	});
	return picked.slice(0, MAX_SAN_ADDRESSES);
}

/**
 * SAN 地址集合是否发生了变化。
 *
 * IPv6 地址会随隐私扩展（RFC 4941）/ 运营商前缀重分配而变，靠「证书存在且没过期」
 * 判断复用是不够的 —— 证书还在，里面的 IP 却已经不是这台机器的了。
 *
 * ## ⚠️ 检测到漂移**不要**自动重生成证书
 *
 * 这一点反直觉，但很重要：手机端是 **pin 证书指纹**的（`link-client.json` 的
 * `certFp`）。一旦因为「IP 变了」就重签证书，指纹随之改变，手机端下次连接会
 * **指纹不匹配直接掐断**，用户得重新配对 —— 一个「让它更 correct」的自动化
 * 反而制造了一次断连事故。
 *
 * 而且实际影响很小：手机端走的是 `rejectUnauthorized: false` + 指纹 pin，
 * 并不依赖 SAN 做名称校验（SAN 只服务于将来打开严格校验的场景）。
 *
 * 所以漂移的正确用途是**诊断与提示**，不是自动修复：
 *   - 记一行 warn，让 `link-doctor` 之类的自检能看到；
 *   - 提示「如需让证书 SAN 覆盖新地址，删除 link-cert.pem 后重启（需重新配对）」。
 *
 * @param {Array<{address: string}>} current - 当前地址集合。
 * @param {Array<string>} pinned - 证书里已有的地址集合。
 * @returns {boolean} 是否发生了漂移。
 */
export function certificateAddressesDrifted(current, pinned) {
	const now = (current ?? []).map((item) => item.address).sort();
	const before = [...(pinned ?? [])].sort();
	if (now.length !== before.length) return true;
	return now.some((address, index) => address !== before[index]);
}
