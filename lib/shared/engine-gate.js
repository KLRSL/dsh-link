/**
 * engine-gate —— 本机 Web 路由上那道「引擎判据」的门。
 *
 * ## 这道门挡的是谁
 *
 * 只判「请求来自 127.0.0.1」挡不住同机的**其它进程 / 其它用户**：它们打
 * `127.0.0.1` 时 Host 同样是 loopback，而原生 App 根本不带 `sec-fetch-site`
 * 这类浏览器专属的 fetch metadata。于是「本机」这个条件本身不构成边界。
 *
 * 引擎的 `connection` 服务暴露了 `requestRejection(request)`，它内部是：
 *
 * 1. `isTrustedApiRequest`（Host 必须 loopback 或受信 + `sec-fetch-site !== 'cross-site'`
 *    + Origin 与 Host 同源）；
 * 2. `browserAuth.isAuthenticated`（**浏览器会话 cookie**）。
 *
 * 第 2 条才是关键：WebView 页面世界的请求天然带引擎签发的会话 cookie，
 * 原生 App 拿不到。所以这道门**对页面透明、对其它 App 关闭**。
 *
 * ## ⚠️ 为什么两端共用这一份，而不是各写一遍
 *
 * 手机端（桥路由）与电脑端（link 路由）都要这道门，语义必须**逐字一致**：
 * 判据若在一端悄悄松了，另一端再严也没用 —— 攻击面只挑软的那边。
 * 而且 ⚠️ **不照抄引擎的实现**：引擎升级判据时（比如加一条新的 fetch metadata
 * 检查），复用它就自动跟上；照抄的副本会悄悄过期，那才是真正的隐患。
 *
 * ## ⚠️ 取不到 `connection` 一律 **503 fail-closed**，绝不降级（外部审计 5.1）
 *
 * 曾经有一版在这里回退到「Host + Origin + sec-fetch-site」的弱判据 —— 那是
 * **fail-open**：弱判据里没有 cookie 这一条，而非浏览器客户端天然不带
 * `sec-fetch-site`，于是全过。等于把刚关上的门又打开。
 *
 * 更糟的是它有一个**必然出现**的窗口：cordis 的 `ctx.get(name, strict)` 对
 * 尚未 ACTIVE 的提供者返回 `undefined`（`cordis/lib/index.js:770`），而
 * client-connection 的 `apply` 里 `await BrowserAuth.create(...)` 排在
 * `provide('connection')` **之前** ⇒ 引擎启动 / 插件重载 / `cordis.patch.yml`
 * HMR 期间，插件同步注册的路由已经在收请求，而 `connection` 还没就绪。
 * 这个窗口内若降级，探针就全放行了。
 *
 * 所以这里只有两种结局：**能拿到服务 → 用引擎的判据**；**拿不到 → 503**。
 * 「服务缺失」是暂时不可用，「降级」是一直不安全 —— 后者严重得多，
 * 不能拿可用性去换。`requestRejection` 自己抛错同理：判据没跑成就等于没有判据。
 *
 * @module dsh-link/shared/engine-gate
 */

/**
 * 造一道门。每端一个实例（各自的「已告警」标志互不干扰）。
 *
 * @param {{ log?: Function }} [options] - `log(line, level)` 由宿主注入。
 * @returns {(ctx: object, req: object) => number|undefined} 拒绝时返回状态码，放行时 `undefined`。
 */
export function createEngineGate({ log = () => {} } = {}) {
	/** 「服务还没就绪」这种话只说一次：窗口期可能每秒来很多请求，刷屏没意义。 */
	let degradedWarned = false;

	const write = (line, level = 'warn') => {
		try {
			log(line, level);
		} catch {
			/* 日志失败不影响判据 */
		}
	};

	return function engineGate(ctx, req) {
		const connection = ctx?.get?.('connection');
		if (connection === undefined || typeof connection.requestRejection !== 'function') {
			if (!degradedWarned) {
				degradedWarned = true;
				write('connection 服务尚未就绪，相关路由一律 503（fail-closed，不降级到弱判据）');
			}
			return 503;
		}
		try {
			return connection.requestRejection(req);
		} catch (error) {
			// 抛错的判据 = 没跑成的判据，不能默认放行。
			write(`connection.requestRejection 抛错，相关路由一律 503（fail-closed）: ${String(error?.message ?? error)}`);
			return 503;
		}
	};
}
