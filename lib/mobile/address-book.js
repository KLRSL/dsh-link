/**
 * 地址簿 —— 记住**连通过**的地址，下次直接试。
 *
 * ## 为什么需要它（这是为了替代外部服务）
 *
 * 跨网络时最麻烦的是「电脑地址变了」。标准解法是 DDNS：把地址发布到一个
 * **外部服务**上，对端查那个服务拿到新地址。但那要求用户去注册账号、
 * 把自己的网络位置交给第三方 —— 违背本插件「零外部依赖」的原则。
 *
 * 换一条路：**家庭宽带 / IPv6 地址往往能稳定几周甚至几个月**。
 * 所以把每次连通过的地址记下来，下次按「最近成功」依次试 ——
 * 绝大多数时候直接命中，且**不需要任何第三方服务、不用注册账号、
 * 也不用配防火墙**（这些都是局域网 / ULA 场景，本来就有 NAT 或路由器挡着）。
 *
 * ## 边界（做不到什么，先说清楚）
 *
 * 地址**真的变了**、且手机与电脑**不在同一网段**时，谁也不知道新地址是多少 ——
 * 没有一个双方都够得着的会合点，这在信息层面就无法解决，不是实现偷懒。
 * 那种情况只能：① 等回到同一网段时用广播发现；② 手动重新填一次地址。
 *
 * 之所以把它单独成一个文件而不是塞进 `index.js`：这段是**纯函数**，
 * 抽出来就能直接单测。`index.js` 里有宿主依赖，import 它会拖上整个插件。
 *
 * @module dsh-link/mobile/address-book
 */

/**
 * 地址簿上限。
 *
 * 不是随便定的：家庭 + 公司 + 手机热点通常不超过三四个常去的网络，
 * 8 条足够覆盖，且探测时能并发打完而不至于超时。（每条探测 2.5s、并发 4，
 * 全打完一轮的耗时是可控的。）
 */
export const KNOWN_HOSTS_MAX = 8;

/**
 * host 里允许的字符：IPv4 / IPv6 / 主机名 / mDNS 名。
 *
 * ⚠️ 刻意用**白名单**而不是「挡掉几个坏字符」：host 会被拼进 URL，
 * 黑名单永远有漏网的（`/`、`?`、`#`、`\`、`@` 都能改变 URL 语义）。
 */
const HOST_PATTERN = /^[A-Za-z0-9._:%-]{1,253}$/;

/**
 * host 是否合法。
 *
 * 抽出来是因为**两处**要用：写地址簿时验一遍，解析链这边验各方塞进来的地址
 * （广播应答、自定义源返回）时也要验。两边各写一遍正则一定会漂。
 *
 * @param {unknown} value - 待验值。
 * @returns {boolean} 是否合法。
 */
export function isValidHost(value) {
	return typeof value === 'string' && HOST_PATTERN.test(value);
}

/**
 * port 是否合法（1~65535 的整数）。
 *
 * @param {unknown} value - 待验值。
 * @returns {boolean} 是否合法。
 */
export function isValidPort(value) {
	const port = Number(value);
	return Number.isInteger(port) && port >= 1 && port <= 65535;
}

/**
 * 归一化地址簿。
 *
 * 做四件事：丢非法项 → 去重 → 按最近成功排序 → 截断到上限。
 *
 * ⚠️ **每条都要单独验收**，不能「整体 try 一下」：一条坏数据不该让整个
 * 地址簿失效（那样用户以前能连的地址全没了，症状是「明明连过却连不上」）。
 *
 * @param {unknown} raw - `mobile.json` 里的 `knownHosts`。
 * @returns {Array<{host: string, port: number, lastOkAt: number, name: string}>} 归一化结果（已排序）。
 */
export function normalizeKnownHosts(raw) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (item === null || typeof item !== 'object') continue;
		const host = typeof item.host === 'string' ? item.host.trim() : '';
		const port = Number(item.port);
		if (host === '' || !HOST_PATTERN.test(host)) continue;
		if (!Number.isInteger(port) || port < 1 || port > 65535) continue;

		const key = `${host}:${port}`;
		if (seen.has(key)) continue;
		seen.add(key);

		const lastOkAtValue = Number(item.lastOkAt);
		out.push({
			host,
			port,
			lastOkAt: Number.isFinite(lastOkAtValue) && lastOkAtValue > 0 ? Math.round(lastOkAtValue) : 0,
			name: typeof item.name === 'string' ? item.name.slice(0, 64) : '',
		});
	}
	out.sort((left, right) => right.lastOkAt - left.lastOkAt);
	return out.slice(0, KNOWN_HOSTS_MAX);
}

/**
 * 把一个「刚连成功」的地址记进地址簿。
 *
 * 同条目更新 `lastOkAt`（不新增重复项）；满了淘汰**最久没成功**的那条 ——
 * 而不是淘汰最早加入的，因为「最近还在用」比「来得早」更能预测下一次。
 *
 * @param {Array} list - 现有地址簿（会被先归一化，所以传什么都安全）。
 * @param {object} entry - 本次成功的地址。
 * @param {string} entry.host - 主机。
 * @param {number} entry.port - 端口。
 * @param {string} [entry.name] - 备注名。
 * @param {number} [entry.now] - 当前时间戳（可注入便于单测）。
 * @returns {Array} 新的地址簿（不改动入参）。
 */
export function rememberKnownHost(list, { host, port, name = '', now = Date.now() } = {}) {
	const cleanHost = typeof host === 'string' ? host.trim() : '';
	const cleanPort = Number(port);
	if (cleanHost === '' || !HOST_PATTERN.test(cleanHost)) return normalizeKnownHosts(list);
	if (!Number.isInteger(cleanPort) || cleanPort < 1 || cleanPort > 65535) return normalizeKnownHosts(list);

	const current = normalizeKnownHosts(list);
	const at = Number.isFinite(Number(now)) && Number(now) > 0 ? Math.round(Number(now)) : 0;
	const key = `${cleanHost}:${cleanPort}`;
	const kept = current.filter((item) => `${item.host}:${item.port}` !== key);
	kept.unshift({ host: cleanHost, port: cleanPort, lastOkAt: at, name: typeof name === 'string' ? name.slice(0, 64) : '' });
	return kept.slice(0, KNOWN_HOSTS_MAX);
}

/**
 * 挑出本次要探测的目标（按最近成功优先）。
 *
 * @param {Array} list - 地址簿。
 * @param {number} [limit] - 最多几个。
 * @returns {Array} 待探测目标。
 */
export function probeTargets(list, limit = 4) {
	const normalized = normalizeKnownHosts(list);
	const max = Number.isInteger(limit) && limit > 0 ? Math.min(limit, KNOWN_HOSTS_MAX) : 4;
	return normalized.slice(0, max);
}
