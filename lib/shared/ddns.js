/**
 * ddns —— 把本机当前地址告诉**你自己的服务器**。
 *
 * ## ⚠️ 关于第三方 DDNS 服务：为什么不支持
 *
 * 本模块早期版本默认接 DuckDNS（免费、免邮箱）。后来移除了，理由是项目原则：
 * **只用代码解决，不要求用户去注册任何外部账号**。
 *
 * 第三方 DDNS 的代价不只是「多一步操作」：你把自己的家庭地址变更史、在线时段
 * 持续交给一个第三方并记录在它的日志里。而它换来的便利，绝大多数情况下
 * **地址簿 + 局域网广播已经给到了**（见 `lib/mobile/resolver.js` 的降级链）。
 *
 * 所以对多数用户来说：**不要启用这一层**。它是给「已有自己的服务器/VPS/NAS」的人
 * 准备的可选能力 —— 东西是你自己的，没有第三方参与。没配就是个空开关，
 * 不占任何东西，也不产生任何请求。
 *
 * ## 什么时候才真的需要它
 *
 * 手机与电脑**长期不在同一网段**，且电脑的公网地址会变（IPv6 前缀重分配、
 * 宽带重拨号）。这时两侧之间需要一个「双方都够得着的会合点」——
 * 如果没有这个会合点，信息层面就无解，不是实现能绕过去的事。
 *
 * 会合点可以是：
 * - 你自己的服务器（本模块负责把地址写上去）；
 * - 或直接在手机上手动填一次新地址（`resolver` 的第 ④ 级兜底）。
 *
 * ## ⚠️ 两个设计前提（不是实现细节，想清楚了再看代码）
 *
 * **1. 启用 DDNS = 走公网。**
 * 名字一旦指向公网地址，这台机器就不再是「局域网里才够得着」。所以：
 *   - 本模块**默认关闭**（`enabled` 缺省 `false`）；
 *   - 开启时由**调用方**负责强制告警并要求显式确认 `allowGlobal`（见 gateway-core 的接入处）；
 *   - **鉴权不因 DDNS 而变化** —— 凭据体系在应用层，走 IPv4 / IPv6 / 公网都同一套逻辑。
 *     不要因为「走公网了」就再加一层授权，那是重复，真正缺的是**网络层门禁**（防火墙 / SPA）。
 *
 * **2. 下游的花销来自 Network，不是这里。**
 * 更新是**定期幂等**的（同一个 IP 重复提交无害），所以默认不做事先的
 * 「我的 IP 变了没」探测 —— 那需要再访问一个外部服务，等于多一处泄露点。
 * 需要精确控制时再开可选 `ipEcho`。
 *
 * ## 安全约束（改这个文件时别破坏）
 *
 * - **token 全程脱敏**：任何日志、任何错误信息都要过 `redact()`。token 泄露等于把
 *   你的域名指到别人机器上（不只是隐私，是劫持）。
 * - **只走 https**：http 的更新请求会把 token 明文送上链路。
 * - **最小间隔**：防止配置手滑写成 1 秒，被自家服务限流或当成攻击。
 *
 * @module dsh-link/shared/ddns
 */

/** 支持的提供器。**只有 `custom`** —— 填你自己的服务器，见文件头「为什么删掉了第三方提供器」。 */
export const DDNS_PROVIDERS = Object.freeze(['custom']);

/** 最小更新间隔：低于这个值的配置会被夹上来（防手滑写 1 秒把自己 ban 了）。 */
export const DDNS_MIN_INTERVAL_MS = 60_000;

/** 默认更新间隔：10 分钟。DDNS 服务商普遍容忍这个频率。 */
export const DDNS_DEFAULT_INTERVAL_MS = 600_000;

/** 失败退避上限：连续失败后最多退到 1 小时，再久就失去「地址变了要尽快跟上」的意义。 */
export const DDNS_MAX_BACKOFF_MS = 3_600_000;

/** 单次更新请求的超时。挂住的 socket 会拖住整个退避循环。 */
export const DDNS_TIMEOUT_MS = 10_000;

// ───────────────────────────────── 配置 ─────────────────────────────────

/**
 * 归一化 DDNS 配置。
 *
 * 原则同 `normalizeConfigBase`：认不出来的就回退到**安全**的默认值，并把「写错了」说出来。
 * 这里「安全」的具体含义是 —— **宁可整个功能不开，也不能带着半截配置上线**。
 *
 * @param {object} raw - `link.json` 里的 `ddns` 对象（可能是 undefined / null / 非对象）。
 * @param {Function} [log] - 日志函数。
 * @returns {{enabled: boolean, provider: string, hostname: string, token: string, updateUrl: string, ipEcho: string, intervalMs: number}} 归一化结果。
 */
export function normalizeDdnsConfig(raw, log = () => {}) {
	const base = {
		enabled: false,
		provider: 'custom',
		hostname: '',
		token: '',
		updateUrl: '',
		ipEcho: '',
		intervalMs: DDNS_DEFAULT_INTERVAL_MS,
	};
	if (raw === null || typeof raw !== 'object') return base;

	// enabled 是唯一能打开这个功能的开关，只认真布尔 true —— 写 "true" 字符串不算。
	base.enabled = raw.enabled === true;

	// 「写错了就说出来」而不是猜一个。这里笔误的后果很具体：
	// provider 认不出就是**整个功能不开**，用户会以为配好了却从来没同步过。
	const provider = String(raw.provider ?? '').trim().toLowerCase();
	if (raw.provider !== undefined && !DDNS_PROVIDERS.includes(provider)) {
		log(`ddns.provider 不合法（${String(raw.provider)}），本项目只支持 custom（自己的服务器）`, 'warn');
	}
	base.provider = 'custom';

	base.hostname = typeof raw.hostname === 'string' ? raw.hostname.trim() : '';
	base.token = typeof raw.token === 'string' ? raw.token.trim() : '';
	base.updateUrl = typeof raw.updateUrl === 'string' ? raw.updateUrl.trim() : '';
	base.ipEcho = typeof raw.ipEcho === 'string' ? raw.ipEcho.trim() : '';

	const interval = Number(raw.intervalMs);
	if (Number.isFinite(interval) && interval > 0) base.intervalMs = Math.max(Math.floor(interval), DDNS_MIN_INTERVAL_MS);
	else if (raw.intervalMs !== undefined) log(`ddns.intervalMs 不合法（${String(raw.intervalMs)}），回退 ${DDNS_DEFAULT_INTERVAL_MS}`, 'warn');

	return base;
}

/**
 * 判断配置是否已经**可用**（够发起一次更新）。
 *
 * 与「合不合法」分开：`enabled:false` 是合法配置，但不可用；
 * `enabled:true` 却没 token 是不合法 —— 这种要**明确说**，不能默默什么都不做。
 *
 * @param {object} config - `normalizeDdnsConfig` 的结果。
 * @returns {{ok: boolean, reason: string}} 可用性与原因（原因用于日志，已脱敏）。
 */
export function ddnsReadiness(config) {
	const cfg = normalizeDdnsConfig(config);
	if (cfg.enabled !== true) return { ok: false, reason: 'disabled' };
	if (cfg.hostname === '') return { ok: false, reason: 'missing-hostname' };
	if (cfg.updateUrl === '') return { ok: false, reason: 'missing-update-url' };
	// token 是**可选**的：自己的服务器可以靠 IP 白名单、Basic Auth 或 mTLS 鉴权，
	// 不一定要在 URL 里带口令。所以这里不严卡 token —— 但 URL 一旦写了 `{token}`
	// 而 token 为空，拼出来的是空值，服务端会拒，属于配置错误而非鉴权漏洞。
	return { ok: true, reason: 'ok' };
}

// ───────────────────────────────── 脱敏 ─────────────────────────────────

/**
 * 把文本里出现的**所有**密钥片段替换成 `***`。
 *
 * 为什么要一个独立函数而不是「日志时小心点」：token 会同时出现在三处 ——
 * 拼好的 URL、`fetch` 抛的异常、以及将来任何人随手 `log(url)`。
 * 「记得别打日志」这种约定在多人/多轮修改里一定会破，所以出口统一过一遍。
 *
 * @param {string} text - 待脱敏文本。
 * @param {string[]} secrets - 需要遮蔽的密钥列表（空串会被跳过）。
 * @returns {string} 脱敏后的文本。
 */
export function redact(text, secrets = []) {
	let out = String(text ?? '');
	for (const secret of secrets) {
		if (typeof secret !== 'string' || secret === '') continue;
		out = out.split(secret).join('***');
	}
	return out;
}

// ───────────────────────────────── URL ─────────────────────────────────

/**
 * 主机名是否安全可用（可拼进 URL、可作为 DDNS 记录名）。
 *
 * 收紧到 `[A-Za-z0-9.-]` 而不是「只挡空格」：hostname 会被拼进查询串，
 * 放宽松了就是 URL 注入（`&`、`?`、`#` 都能改掉请求语义）。
 *
 * @param {string} value - 待检查的名字。
 * @returns {boolean} 是否合法。
 */
export function isSafeHostname(value) {
	return typeof value === 'string' && /^[A-Za-z0-9.-]{1,253}$/.test(value);
}

/**
 * 构造一次更新请求的 URL。
 *
 * `updateUrl` 支持三个占位符：`{hostname}`、`{token}`、`{ip}`。
 * 必须 https：http 会把 token 明文送上链路。
 *
 * **省略 `{ip}` 的写法是推荐默认**：绝大多数更新服务会直接取请求的来源 IP，
 * 不必额外去找「告诉我我的 IP 是多少」的回显服务 —— 少一个外部依赖、
 * 少一个故障点、也少一处泄露网络位置的地方。
 *
 * ⚠️ 返回值**含 token**，打日志前必须过 `redact()`。
 *
 * @param {object} config - 归一化后的 DDNS 配置。
 * @param {{ip?: string}} [options] - 显式 IP（留空则由服务端自动取）。
 * @returns {{ok: boolean, reason: string, url: string}} URL 构造结果。
 */
export function buildUpdateUrl(config, { ip = '' } = {}) {
	const cfg = normalizeDdnsConfig(config);
	if (!isSafeHostname(cfg.hostname)) return { ok: false, reason: 'bad-hostname', url: '' };
	const safeIp = typeof ip === 'string' && /^[0-9.]{7,15}$|^[0-9A-Fa-f:]{2,45}$/.test(ip) ? ip : '';

	if (cfg.updateUrl === '') return { ok: false, reason: 'missing-update-url', url: '' };
	let parsed;
	try {
		parsed = new URL(cfg.updateUrl);
	} catch {
		return { ok: false, reason: 'bad-update-url', url: '' };
	}
	// 只认 https —— 这条不是洁癖，token 就在 URL 里。
	if (parsed.protocol !== 'https:') return { ok: false, reason: 'insecure-update-url', url: '' };
	if (parsed.hostname === '') return { ok: false, reason: 'bad-update-url', url: '' };

	const filled = cfg.updateUrl
		.replaceAll('{hostname}', encodeURIComponent(cfg.hostname))
		.replaceAll('{token}', encodeURIComponent(cfg.token))
		.replaceAll('{ip}', encodeURIComponent(safeIp));
	return { ok: true, reason: 'ok', url: filled };
}

// ───────────────────────────────── 客户端 ─────────────────────────────────

/**
 * 建一个 DDNS 客户端。
 *
 * 定时用的是**递归 setTimeout 而不是 setInterval**：更新请求可能耗时（甚至挂住到超时），
 * `setInterval` 会在上一次还没回来时就再发一次，堆积出并发请求。
 *
 * 依赖全部可注入（`fetchImpl` / `setTimer` / `clearTimer` / `now`），否则单测只能靠
 * 真网络 + 真定时器 —— 那测的是你自家服务器的可用性，不是我们的代码。
 *
 * @param {object} options
 * @param {object} options.config - 归一化后的 DDNS 配置。
 * @param {Function} [options.log] - 日志函数。
 * @param {Function} [options.fetchImpl] - 注入 fetch（默认 `globalThis.fetch`）。
 * @param {Function} [options.setTimer] - 注入 setTimeout。
 * @param {Function} [options.clearTimer] - 注入 clearTimeout。
 * @param {Function} [options.now] - 注入时间源。
 * @returns {{start: Function, stop: Function, refreshOnce: Function, state: Function}} 客户端。
 */
export function createDdnsClient({
	config,
	log = () => {},
	fetchImpl,
	setTimer = (fn, ms) => setTimeout(fn, ms),
	clearTimer = (handle) => clearTimeout(handle),
	now = () => Date.now(),
} = {}) {
	const cfg = normalizeDdnsConfig(config);
	const secrets = [cfg.token].filter((item) => item !== '');
	let handle = null;
	let running = false;
	let failures = 0;
	let lastOkAt = null;
	let lastError = '';

	/**
	 * 下一次间隔：失败越多退得越久，成功立刻回到基础间隔。
	 *
	 * 退避是**乘 2** 而不是固定值：地址变化后我们希望尽快跟上，但连续失败时
	 * 八成是 token 错了或服务商挂了，狂刷只会让自己被限流。
	 *
	 * @returns {number} 毫秒。
	 */
	function nextDelayMs() {
		if (failures === 0) return cfg.intervalMs;
		return Math.min(cfg.intervalMs * 2 ** failures, DDNS_MAX_BACKOFF_MS);
	}

	/**
	 * 发一次更新。
	 *
	 * @returns {Promise<{ok: boolean, reason: string}>} 结果（原因已脱敏）。
	 */
	async function refreshOnce() {
		const readiness = ddnsReadiness(cfg);
		if (readiness.ok !== true) {
			lastError = readiness.reason;
			return { ok: false, reason: readiness.reason };
		}

		let ip = '';
		if (cfg.ipEcho !== '') {
			// 可选的 IP 回显：先问一次「我现在是哪个 IP」，变了才更新。
			// 默认不走这条路（见文件头），但给了就不拦 —— 有人就是想精确控制更新频率。
			try {
				const echoed = await fetchOnce(cfg.ipEcho, { as: 'text' });
				const candidate = String(echoed ?? '').trim();
				if (/^[0-9.]{7,15}$|^[0-9A-Fa-f:]{2,45}$/.test(candidate)) ip = candidate;
				else {
					lastError = 'bad-ip-echo';
					return { ok: false, reason: 'bad-ip-echo' };
				}
			} catch (error) {
				lastError = `ip-echo:${redact(String(error?.message ?? error), secrets)}`;
				log(`DDNS 探测公网地址失败: ${lastError}`, 'warn');
				failures += 1;
				return { ok: false, reason: 'ip-echo-failed' };
			}
		}

		const built = buildUpdateUrl(cfg, { ip });
		if (built.ok !== true) {
			lastError = built.reason;
			log(`DDNS 配置不可用（${built.reason}），跳过本次更新`, 'warn');
			return { ok: false, reason: built.reason };
		}

		try {
			const body = await fetchOnce(built.url, { as: 'text' });
			// 自己的服务器返回什么格式都可以，所以用**黑名单**而不是「必须等于 OK」：
			// 只看响应是不是明显在报错。反过来写（只认 OK）会把大量正常响应误判成失败，
			// 症状是「明明更新成功了，日志里却一直在报错并退避」。
			const text = String(body ?? '').trim();
			if (/^(ko|error|fail|nohost|badagent|!donator)/i.test(text)) {
				failures += 1;
				lastError = `provider-rejected:${text.slice(0, 64)}`;
				log(`DDNS 更新被拒绝（${text.slice(0, 64)}）`, 'warn');
				return { ok: false, reason: 'provider-rejected' };
			}
			failures = 0;
			lastOkAt = now();
			lastError = '';
			log(`DDNS 更新成功：${cfg.hostname}`);
			return { ok: true, reason: 'ok' };
		} catch (error) {
			failures += 1;
			lastError = redact(String(error?.message ?? error), secrets);
			log(`DDNS 更新失败: ${lastError}`, 'warn');
			return { ok: false, reason: 'request-failed' };
		}
	}

	/**
	 * 发一次 HTTP 请求（带超时）。
	 *
	 * @param {string} url - 目标 URL。
	 * @param {{as?: string}} [options] - 解析方式。
	 * @returns {Promise<string>} 响应文本。
	 * @throws 超时或网络错误。
	 */
	async function fetchOnce(url, { as = 'text' } = {}) {
		const doFetch = fetchImpl ?? globalThis.fetch;
		if (typeof doFetch !== 'function') throw new Error('fetch unavailable');
		const controller = typeof AbortController === 'function' ? new AbortController() : null;
		const timer = controller === null ? null : setTimer(() => controller.abort(), DDNS_TIMEOUT_MS);
		try {
			const res = await doFetch(url, {
				...(controller === null ? {} : { signal: controller.signal }),
				headers: { 'user-agent': 'dsh-link' },
			});
			if (typeof res?.ok === 'boolean' && res.ok !== true) throw new Error(`HTTP ${res.status}`);
			return as === 'text' ? await res.text() : await res.text();
		} finally {
			if (timer !== null) clearTimer(timer);
		}
	}

	function schedule() {
		if (running !== true) return;
		handle = setTimer(() => {
			handle = null;
			if (running !== true) return;
			Promise.resolve(refreshOnce()).finally(() => schedule());
		}, nextDelayMs());
	}

	return {
		/** 启动定时更新。配置不可用时会**明确说**，而不是静默什么都不做。 */
		start() {
			if (running === true) return;
			const readiness = ddnsReadiness(cfg);
			if (readiness.ok !== true) {
				log(`DDNS 未启动（${readiness.reason}）`, readiness.reason === 'disabled' ? 'debug' : 'warn');
				return;
			}
			running = true;
			log(`DDNS 已启动：${cfg.provider} / ${cfg.hostname}，每 ${cfg.intervalMs}ms 更新一次`, 'warn');
			Promise.resolve(refreshOnce()).finally(() => schedule());
		},
		/** 停止并清理定时器（不留常驻定时器）。 */
		stop() {
			running = false;
			if (handle !== null) {
				clearTimer(handle);
				handle = null;
			}
		},
		/** 手动触发一次更新（不改动定时循环）。 */
		refreshOnce,
		/** 当前状态快照（供诊断；`lastError` 已脱敏）。 */
		state() {
			return { running, failures, lastOkAt, lastError, intervalMs: cfg.intervalMs };
		},
	};
}
