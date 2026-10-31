/**
 * resolver —— 「这台电脑现在在哪」的四级降级链。
 *
 * ## 这个文件解决什么问题
 *
 * 局域网直连的第一步是「知道对端的地址」。麻烦在于地址会变：
 * 换 Wi-Fi 换了网段 IPv4 会变；走公网 IPv6 则**每次拨号都可能变前缀**。
 *
 * 标准解法叫 DDNS：把当前地址发布到一个**外部服务**，对端去那里查。
 * 但那要求用户注册第三方账号、把自己的网络位置交给别人 —— 本项目
 * 「只用代码解决、零外部依赖」的原则不接受这条路。
 *
 * 所以改成一条**降级链**：先试最省事、最接近、成本最低的办法，
 * 不行就往上一级。**每一层失败都必须给出人能看懂的原因**，
 * 绝不能静默往下掉 —— 静默降级最典型的后果是「明明连不上，界面却转半天圈」。
 *
 * ## 四级，按「先近后远」排
 *
 * ```
 * ① manual     用户手填            —— 优先级最高，且**独占**
 * ② discovery  局域网广播          —— 同网段才有用，约 0.1~2 秒
 * ③ book       地址簿（连过的）     —— 并发探测，覆盖「换过几次地址」
 * ④ source     自己的服务器/域名    —— 可选，配了才跑
 * ```
 *
 * ## ⚠️ 三条不能破坏的纪律
 *
 * **1. ① manual 这一层是独占的，不是「优先」**
 * 用户显式填了地址，那就**只用**这个地址；失败就报失败，**不往下降级**。
 * 理由不是偷懒：降级到 ②③④ 意味着可能连上**另一台**电脑 —— 哪怕后面还有
 * 配对码把关，让用户「填了 A 却连到 B」也是不可接受的。宁可直接报错。
 *
 * **2. 找到 ≠ 信任**
 * 广播任何人都能应答，地址簿里也可能是旧的错地址。所以本模块只负责
 * **给出候选地址**，信任仍由 `lanConnect` 走配对码 + 指纹 pin。这一点如果
 * 被绕过（比如找到就自动连），发现功能就从便利变成了攻击面。
 *
 * **3. 每层都要能单独测**
 * `probe` / `discover` / `fetchImpl` 全部是可注入的 —— 单测里不需要真起
 * socket、真的等 2 秒广播，就能把「第 2 层失败、第 3 层成功」这类
 * 组合全覆盖。这也是这个文件为什么要从 `index.js` 里抽出来：那里有宿主依赖。
 *
 * @module dsh-link/mobile/resolver
 */

import { DISCOVERY_TIMEOUT_MS } from '../shared/discovery.js';
import { redact } from '../shared/ddns.js';
import { unwrapHost } from '../shared/net.js';
import { isValidHost, isValidPort, normalizeKnownHosts, probeTargets } from './address-book.js';

/**
 * 把用户/源给的地址洗一遍：去空白、**剥 IPv6 的方括号**。
 *
 * ⚠️ 方括号这一条不是洁癖：用户常直接复制 `[fd00::1]:8899` 里的那一段，
 * 而 `[` `]` 不在合法主机名字符集里 —— 不剥的话会一路走到「地址不合法」，
 * 用户完全不知道自己哪里错了（看着就是个正常的 IPv6 地址）。
 *
 * @param {unknown} value - 原始值。
 * @returns {string} 洗好的主机（不合法时返回原样，交给 `isValidHost` 判）。
 */
function cleanHost(value) {
	return typeof value === 'string' ? unwrapHost(value.trim()) : '';
}

/** 单个地址簿条目的探测超时。挂住的 socket 会拖住整条链。 */
export const PROBE_TIMEOUT_MS = 2500;

/** 拉自定义源的超时。它是外网请求，可能慢，但也不能无限等。 */
export const SOURCE_TIMEOUT_MS = 4000;

/** 自定义源返回体的最大长度。防止配错 URL 拉回整个网页然后被当成 host。 */
export const SOURCE_MAX_BYTES = 4096;

/** 地址簿这一层最多并发探测几条。`probeTargets` 内部还会按 `KNOWN_HOSTS_MAX` 夹一层。 */
export const PROBE_CONCURRENCY = 4;

/** 整条链的软上限。只在**层与层之间**检查，不中断已开始的单层操作。 */
export const RESOLVE_TOTAL_BUDGET_MS = DISCOVERY_TIMEOUT_MS + PROBE_TIMEOUT_MS + SOURCE_TIMEOUT_MS + 1000;

// ───────────────────────────────── 配置 ─────────────────────────────────

/**
 * 归一化「自定义源」列表。
 *
 * 这一层是**可选增强**：多数人没有自己的服务器，配出来就是空数组，
 * 那第 ④ 层等于不存在 —— 链的行为必须和没配完全一样，不能多等几秒。
 *
 * @param {unknown} raw - `mobile.json` 里的 `resolveSources`。
 * @param {Function} [log] - 日志函数。
 * @returns {Array<{url: string, name: string}>} 归一化结果。
 */
export function normalizeResolveSources(raw, log = () => {}) {
	if (!Array.isArray(raw)) return [];
	const out = [];
	const seen = new Set();
	for (const item of raw) {
		if (item === null || typeof item !== 'object') continue;
		const url = typeof item.url === 'string' ? item.url.trim() : '';
		if (url === '') continue;

		// ⚠️ 只认 https：http 的响应能被同网段任何人改掉，等于把「连到哪台电脑」
		// 的决定权交给了链路上的旁人。这一层虽然通常只是取个 IP，但它决定
		// 后续所有请求的去向，不能被明文挟持。
		if (/^https:\/\//i.test(url) !== true) {
			log(`忽略自定义源（必须是 https 开头）：${redact(url)}`, 'warn');
			continue;
		}
		if (seen.has(url)) continue;
		seen.add(url);

		out.push({ url, name: typeof item.name === 'string' ? item.name.slice(0, 64) : '' });
		if (out.length >= 4) break;
	}
	return out;
}

// ───────────────────────────── 内部工具 ─────────────────────────────

/**
 * 给一个 promise 套超时。
 *
 * ⚠️ 这里**不能**真的 abort 底层操作（我们的 `probe` 形态不统一，有的是
 * https 请求、有的是注入的桩），只是不再等它。调用方必须保证自己会超时，
 * 这里是兜底的第二道防线 —— 一道都不设的话，一个挂死的 socket 能让
 * 整个「自动查找」永远转圈。
 *
 * @param {Promise} promise - 待等的 promise。
 * @param {number} ms - 超时毫秒。
 * @returns {Promise<{timedOut: boolean, failed: boolean, value: unknown}>} 结果。
 */
async function withTimeout(promise, ms) {
	let timer = null;
	const guard = new Promise((resolve) => {
		timer = setTimeout(() => resolve({ timedOut: true, failed: false, value: undefined }), ms);
	});
	try {
		return await Promise.race([
			Promise.resolve(promise).then(
				(value) => ({ timedOut: false, failed: false, value }),
				// ⚠️ 失败与超时**必须分开**：两者给用户看的提示完全不同 ——
				// 「对方拒绝了」是拿得到答案，而「超时」说明连不上。
				// 合并成一个「没成功」会让用户不知道该重试还是该改配置。
				() => ({ timedOut: false, failed: true, value: undefined }),
			),
			guard,
		]);
	} finally {
		if (timer !== null) clearTimeout(timer);
	}
}

/**
 * 并发探测一组目标，返回**第一个成功**的。
 *
 * 为什么并发而不是逐个排队：地址簿可能 8 条，每条 2.5s，串行最坏要 20 秒 ——
 * 用户在那之前就以为插件死了。并发后最坏情况是一条的超时。
 *
 * 为什么「第一个成功」而不是「全部结果里挑」：目标是尽快给出**一个能用**的地址，
 * 其余的探测在后台结束即可。注意所有 promise 都要有兜底 reject，
 * 否则 `unhandledRejection` 会把宿主进程带崩。
 *
 * @param {Array<{host: string, port: number, name?: string}>} targets - 待探测目标。
 * @param {Function} probe - `async ({host, port}) => boolean`。
 * @param {number} timeoutMs - 单条超时。
 * @returns {Promise<object|null>} 第一个探测成功的目标，全失败为 null。
 */
async function probeUntilFirstOk(targets, probe, timeoutMs) {
	if (!Array.isArray(targets) || targets.length === 0 || typeof probe !== 'function') return null;

	let settled = false;
	let pending = targets.length;
	return new Promise((resolve) => {
		const done = (value) => {
			if (settled) return;
			settled = true;
			resolve(value);
		};
		const failOne = () => {
			pending -= 1;
			if (pending <= 0) done(null);
		};
		for (const target of targets) {
			Promise.resolve()
				.then(() => withTimeout(probe({ host: target.host, port: target.port }), timeoutMs))
				.then((result) => {
					if (settled) return;
					if (result.timedOut !== true && result.value === true) done(target);
					else failOne();
				})
				.catch(failOne);
		}
	});
}

/**
 * 从一个自定义源把「电脑当前地址」读出来。
 *
 * 响应体支持两种形态，因为自己搭的服务通常只会吐一个纯 IP：
 * - 纯文本：`2408:xxxx::1` 或 `2408:xxxx::1 8899`（空格后是端口）
 * - JSON：`{ "host": "...", "port": 8899 }`（也认 `ip` / `address` 三个别名之一）
 *
 * @param {object} source - `{url, name}`。
 * @param {object} io - `{fetchImpl, timeoutMs, log}`。
 * @returns {Promise<{ok: boolean, reason: string, host: string, port: number|null}>} 结果。
 */
async function readOneSource(source, { fetchImpl, timeoutMs = SOURCE_TIMEOUT_MS, log = () => {} } = {}) {
	if (typeof fetchImpl !== 'function') return { ok: false, reason: 'no-fetch', host: '', port: null };

	const started = await withTimeout(
		Promise.resolve().then(() => fetchImpl(source.url, { redirect: 'follow' })),
		timeoutMs,
	);
	if (started.timedOut === true) return { ok: false, reason: 'timeout', host: '', port: null };

	const response = started.value;
	if (started.failed === true) return { ok: false, reason: 'request-failed', host: '', port: null };
	if (response === null || response === undefined) return { ok: false, reason: 'empty-response', host: '', port: null };
	if (response.ok !== true) return { ok: false, reason: `http-${response.status ?? 'error'}`, host: '', port: null };

	const body = await withTimeout(Promise.resolve().then(() => response.text?.()), timeoutMs);
	if (body.timedOut === true) return { ok: false, reason: 'read-timeout', host: '', port: null };
	if (body.failed === true) return { ok: false, reason: 'read-failed', host: '', port: null };

	const text = String(body.value ?? '').trim();
	if (text === '' || text.length > SOURCE_MAX_BYTES) return { ok: false, reason: 'bad-body', host: '', port: null };

	let host = '';
	let port = null;
	if (text.startsWith('{')) {
		try {
			const parsed = JSON.parse(text);
			if (parsed !== null && typeof parsed === 'object') {
				host = String(parsed.host ?? parsed.ip ?? parsed.address ?? '').trim();
				const candidate = Number(parsed.port);
				if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
			}
		} catch {
			return { ok: false, reason: 'bad-json', host: '', port: null };
		}
	} else {
		// 纯文本：第一段是 host，可选的第二段是端口。换行也当分隔。
		const parts = text.split(/[\s]+/).filter((piece) => piece !== '');
		host = parts[0] ?? '';
		const candidate = Number(parts[1]);
		if (Number.isInteger(candidate) && candidate >= 1 && candidate <= 65535) port = candidate;
	}

	if (isValidHost(host) !== true) {
		log(`自定义源返回的不是合法主机，忽略：${redact(String(host).slice(0, 64))}`, 'warn');
		return { ok: false, reason: 'bad-host', host: '', port: null };
	}
	return { ok: true, reason: 'ok', host: cleanHost(host), port };
}

// ───────────────────────────────── 主流程 ─────────────────────────────────

/**
 * 沿降级链找出「电脑现在在哪」。
 *
 * 返回值里带完整的 `steps`，调用方（前端）要把它显示出来 —— 用户看到
 * 「广播没找到（需同一 Wi-Fi）→ 试了 3 个历史地址都不通 → 手动填一下吧」
 * 会立刻知道怎么办；只看到「查找失败」就只能瞎猜。
 *
 * @param {object} [options] - 选项。
 * @param {string} [options.explicitHost] - 用户手填的地址（非空则**独占**，不再降级）。
 * @param {number} [options.explicitPort] - 用户手填的端口。
 * @param {number} [options.defaultPort] - 源没给端口时用它（通常是配置里的端口）。
 * @param {Array} [options.knownHosts] - 地址簿（见 `address-book.js`）。
 * @param {Array} [options.sources] - 自定义源（`normalizeResolveSources` 的结果）。
 * @param {Function} [options.probe] - `async ({host, port}) => boolean`，探测某地址是否在线。
 * @param {Function} [options.discover] - `async () => Array<{ip, port, name, fp}>`，局域网广播。
 * @param {Function} [options.fetchImpl] - 第 ④ 层用的 fetch（可选）。
 * @param {number} [options.discoveryTimeoutMs] - 第 ② 层超时。
 * @param {number} [options.probeTimeoutMs] - 单条探测超时。
 * @param {number} [options.sourceTimeoutMs] - 第 ④ 层超时。
 * @param {number} [options.totalBudgetMs] - 整条链的软上限（只在层间检查）。
 * @param {Function} [options.log] - 日志函数。
 * @param {Function} [options.now] - 取时间函数（便于单测）。
 * @returns {Promise<{
 *   ok: boolean, host: string, port: number, name: string, via: string,
 *   candidates: Array<object>, steps: Array<object>, message: string
 * }>} 解析结果。`ok:false` 时 `host` 为空串。
 */
export async function resolvePeerHost({
	explicitHost = '',
	explicitPort = 0,
	defaultPort = 0,
	knownHosts = [],
	sources = [],
	probe,
	discover,
	fetchImpl,
	discoveryTimeoutMs = DISCOVERY_TIMEOUT_MS,
	probeTimeoutMs = PROBE_TIMEOUT_MS,
	sourceTimeoutMs = SOURCE_TIMEOUT_MS,
	totalBudgetMs = RESOLVE_TOTAL_BUDGET_MS,
	log = () => {},
	now = () => Date.now(),
} = {}) {
	const steps = [];
	const startedAt = now();
	const spentEnough = () => now() - startedAt >= totalBudgetMs;

	const finish = (payload) => {
		const ok = payload != null && payload.via != null && payload.via !== '';
		return {
			ok,
			host: payload?.host ?? '',
			port: payload?.port ?? 0,
			name: payload?.name ?? '',
			via: payload?.via ?? '',
			candidates: Array.isArray(payload?.candidates) ? payload.candidates : [],
			steps,
			message: payload?.message ?? (ok ? '' : '没有找到电脑，请在上面手动填写地址'),
		};
	};
	const record = (layer, ok, reason, extra = {}) => {
		steps.push({ layer, ok, reason, ...extra });
	};

	// ── ① manual：手填优先，且独占 ────────────────────────────────────
	//
	// 这里**故意不降级**（理由见文件头纪律 1）。手填失败就直接告诉用户哪个地址不通，
	// 而不是悄悄换一台电脑去连 —— 「填了 A 连到 B」是最难排查的一类问题。
	const manualHost = cleanHost(explicitHost);
	const manualPort = Number(explicitPort);
	if (manualHost !== '') {
		if (isValidHost(manualHost) !== true) {
			record('manual', false, 'bad-host', { host: manualHost });
			return finish({ via: '', message: `地址「${manualHost}」不是一个合法的主机名或 IP` });
		}
		if (typeof probe !== 'function') {
			// 没有探测能力时也要尊重手填 —— 手填本身就是用户的显式决定，
			// 不该因为「没法预检」就被丢掉。交给后面的连接流程去试。
			record('manual', true, 'no-probe-skip');
			return finish({ via: 'manual', host: manualHost, port: isValidPort(manualPort) ? manualPort : 0, message: '' });
		}
		const reached = await withTimeout(probe({ host: manualHost, port: manualPort }), probeTimeoutMs);
		if (reached.timedOut === true) {
			record('manual', false, 'timeout', { host: manualHost, port: manualPort });
			return finish({ via: '', message: `连接「${manualHost}」超时 —— 请确认电脑端 DSH 正在运行` });
		}
		if (reached.value !== true) {
			record('manual', false, 'unreachable', { host: manualHost, port: manualPort });
			return finish({ via: '', message: `连不上「${manualHost}」—— 请确认电脑端 DSH 正在运行、地址没写错` });
		}
		record('manual', true, 'ok', { host: manualHost, port: manualPort });
		return finish({ via: 'manual', host: manualHost, port: manualPort, message: '' });
	}

	// ── ② discovery：局域网广播 ──────────────────────────────────────
	if (typeof discover === 'function') {
		const round = await withTimeout(Promise.resolve().then(() => discover()), discoveryTimeoutMs);
		if (round.timedOut === true) {
			record('discovery', false, 'timeout');
		} else {
			const peers = Array.isArray(round.value) ? round.value : [];
			if (peers.length === 0) {
				record('discovery', false, 'no-peers');
			} else {
				const candidates = peers
					.map((peer) => ({
						host: cleanHost(peer?.ip),
						port: Number(peer?.port),
						name: typeof peer?.name === 'string' ? peer.name : '',
					}))
					.filter((peer) => isValidHost(peer.host) === true && isValidPort(peer.port) === true);

				if (candidates.length === 0) {
					// 收到了应答但全是坏的 —— 这不是「没人回应」，别共用同一句提示。
					record('discovery', false, 'bad-peers', { count: peers.length });
				} else {
					// 多台时**不能静默任选一台**（纪律 2 的延伸）：里面可能有一台是
					// 同事的电脑。所以先 **probe 挑能连的**，再按「之前连过」优先，
					// 最后把其余候选一并返回，让界面告诉用户还有别的。
					let picked = null;
					if (typeof probe === 'function') {
						picked = await probeUntilFirstOk(candidates, probe, probeTimeoutMs);
					} else {
						picked = candidates[0];
					}
					if (picked !== null) {
						record('discovery', true, 'ok', { count: candidates.length, host: picked.host, port: picked.port });
						const message = candidates.length === 1
							? `找到电脑：${picked.host}`
							: `找到 ${candidates.length} 台，已选可用的一台：${picked.host}`;
						return finish({
							via: 'discovery',
							host: picked.host,
							port: picked.port,
							name: picked.name ?? '',
							candidates,
							message,
						});
					}
					record('discovery', false, 'unreachable', { count: candidates.length });
				}
			}
		}
	} else {
		record('discovery', false, 'disabled');
	}

	if (spentEnough() === true) {
		record('book', false, 'budget-exhausted');
		return finish({ via: '', message: '查找超时 —— 请稍后重试，或直接手动填写地址' });
	}

	// ── ③ book：地址簿（以前连过的地址） ───────────────────────────────
	const book = normalizeKnownHosts(knownHosts);
	if (book.length === 0) {
		record('book', false, 'empty');
	} else if (typeof probe !== 'function') {
		// 没有探测能力时按「最近成功过」直接给第一条 —— 比空手而归有用，
		// 但要按 note 记清楚这不是验证过的。
		record('book', true, 'no-probe-take-recent', { host: book[0].host, port: book[0].port });
		return finish({ via: 'book', host: book[0].host, port: book[0].port, name: book[0].name, message: '用上次连过的地址' });
	} else {
		const targets = probeTargets(book, PROBE_CONCURRENCY);
		const picked = await probeUntilFirstOk(targets, probe, probeTimeoutMs);
		if (picked !== null) {
			record('book', true, 'ok', { host: picked.host, port: picked.port, count: targets.length });
			return finish({
				via: 'book',
				host: picked.host,
				port: picked.port,
				name: picked.name ?? '',
				message: `连上了以前用过的地址：${picked.host}`,
			});
		}
		record('book', false, 'unreachable', { count: targets.length });
	}

	if (spentEnough() === true) {
		record('source', false, 'budget-exhausted');
		return finish({ via: '', message: '查找超时 —— 请稍后重试，或直接手动填写地址' });
	}

	// ── ④ source：自己的服务器/域名（可选） ────────────────────────────
	const cleanSources = normalizeResolveSources(sources, log);
	if (cleanSources.length === 0) {
		record('source', false, 'not-configured');
	} else if (typeof fetchImpl !== 'function') {
		record('source', false, 'no-fetch', { count: cleanSources.length });
	} else {
		for (const source of cleanSources) {
			// 逐个试：源一般只有一个，且它要的是「确定答案」，
			// 并发多个源意味着把你的行踪同时告诉好几台机器。
			const read = await readOneSource(source, { fetchImpl, timeoutMs: sourceTimeoutMs, log });
			if (read.ok !== true) {
				record('source', false, read.reason, { url: source.url });
				continue;
			}
			// ⚠️ 端口要 fallback 两次（源里的 → 手填的 → 配置里的默认值）：
			// 自己搭的源通常只吐一个裸 IP，没有端口。退到 0 的话探测会打向
			// `host:0`，永远不通 —— 表现为「源明明配对了，就是连不上」。
			const port = read.port ?? (isValidPort(explicitPort) === true ? explicitPort : defaultPort);
			if (typeof probe === 'function') {
				const reached = await withTimeout(probe({ host: read.host, port }), probeTimeoutMs);
				if (reached.timedOut === true) {
					record('source', false, 'timeout', { host: read.host });
					continue;
				}
				if (reached.value !== true) {
					record('source', false, 'unreachable', { host: read.host });
					continue;
				}
			}
			record('source', true, 'ok', { host: read.host, port });
			return finish({ via: 'source', host: read.host, port: Number(port) || 0, name: source.name, message: `从自定义源拿到地址：${read.host}` });
		}
	}

	// ── 兜底：告诉用户现在该怎么办 ────────────────────────────────────
	//
	// 这句提示要**具体**。四级全都试过了，说明不是简单的「忘开电脑」，
	// 大概率是地址真的变了（跨网络场景）。把这个判断说给用户听，
	// 他才知道下一步该干什么是去电脑上看一眼新地址。
	return finish({
		via: '',
		message:
			'自动查找没找到电脑：广播要求同一 Wi-Fi，历史地址也可能已失效。'
			+ '请在电脑端 DSH 上看一眼当前地址，直接填到上面（IPv6 公网地址也可以直接填）',
	});
}
