/**
 * dsh-link —— 单包外壳（host half）。
 *
 * ## 这个文件只做一件事
 *
 * 决定这台机器是「电脑」还是「手机」，然后**只加载对应的那一半实现**：
 *
 * ```
 *   role 来源（优先级从高到低）
 *     ① apply(ctx, { role })        插件配置（cordis.patch.yml 的 config / profile）
 *     ② ctx.config.role            测试与嵌入方的假 ctx
 *     ③ process.env.DSH_LINK_ROLE  部署脚本
 *     ④ <DSH_HOME>/dsh-remote/role.json  { "role": "desktop" | "mobile" }
 *     ⑤ 平台推断（Windows / macOS → desktop，其余 → mobile）
 *
 *   role=desktop → await import('./desktop/index.js') → apply(ctx, config)
 *   role=mobile  → await import('./mobile/index.js')  → apply(ctx, config)
 * ```
 *
 * 两边的 `index.js` 除了包名/日志前缀外逻辑不动（它们本来就有
 * `export function apply(ctx)`），这里只负责「选谁」。所以同一个 npm 包可以
 * 两边都装，配置不同、加载的代码不同。
 *
 * ## ⚠️ 为什么配置目录仍是 `dsh-remote/`
 *
 * 旧两包版把 `link.json` / `link-peer.json` / `link-client.json` / 证书指纹 /
 * `pairKey` / 镜像工作区都放在 `<DSH_HOME>/dsh-remote/` 下。改名只改**包名**，
 * **不改数据目录** —— 否则两端证书、密钥、pairKey 全部对不上，用户等于要重配。
 * 所以 role 也放进同一个目录（`role.json`），不新建 `dsh-link/` 目录。
 *
 * ## 为什么 role 不写在 package.json 里
 *
 * 同一个 tgz 要能装到电脑（Windows/macOS）和手机（Android）上，包内文件必须
 * 完全相同。role 是**部署事实**，只能落在机器本地；配置文件带默认值（按平台
 * 预填）并且写在 `$DSH_HOME` 里，用户改一行、重启即可换角色。
 *
 * ## 失败策略
 *
 * **只记日志，绝不外抛**：DSH 的 loader 会把 apply 的异常记成插件 FAILED，
 * 而插件失败不应该带走整个界面（历史教训见手机端 client 的兜底注释）。
 * 加载失败时本插件等于不存在，其余插件照常。
 *
 * @module dsh-link/host
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { resolveDshHome } from './shared/home.js';

/** 插件名（loader 的 entry name，与 package.json 一致）。 */
export const name = 'dsh-link';

/**
 * ⚠️ 走 `shared/home.js`（P1-5）：从前这里只判 `!== ''`，漏了**纯空白**
 * （`"   "`）—— 引擎把纯空白也当未设置，两端不一致时读的是另一个目录。
 */
const DSH_HOME = resolveDshHome();

/**
 * role 配置文件。
 *
 * ⚠️ 目录名**故意**沿用旧版 `dsh-remote`：同目录里还有 link.json / 证书指纹 /
 * pairKey 等，改目录会让现有安装全部失效。见文件头注释。
 */
export const CONFIG_PATH = join(DSH_HOME, 'dsh-remote', 'role.json');

/** 合法的 role 取值。 */
export const ROLES = ['desktop', 'mobile'];

/**
 * 按平台推断默认角色：Windows / macOS 视为电脑，其余（Android / Linux）视为手机。
 *
 * @returns {'desktop' | 'mobile'} 默认角色。
 */
export function platformRole() {
	return process.platform === 'win32' || process.platform === 'darwin' ? 'desktop' : 'mobile';
}

/** 把任意输入规整成合法 role；不合法返回 `undefined`。 */
function normalizeRole(value) {
	if (typeof value !== 'string') return undefined;
	const role = value.trim().toLowerCase();
	return ROLES.includes(role) ? role : undefined;
}

/**
 * 读配置里的 role（不写文件、不抛错）。
 *
 * @returns {{ role?: string, reason: string }} 读到的角色与来源（missing / invalid / config / error）。
 */
export function readRole() {
	try {
		if (!existsSync(CONFIG_PATH)) return { role: undefined, reason: 'missing' };
		const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
		const role = normalizeRole(raw !== null && typeof raw === 'object' ? raw.role : undefined);
		if (role !== undefined) return { role: role, reason: 'config' };
		return { role: undefined, reason: 'invalid' };
	} catch (error) {
		return { role: undefined, reason: 'error: ' + String((error && error.message) || error) };
	}
}

/**
 * 解析本机角色（纯读，不写盘）：按优先级返回第一个合法值。
 *
 * ## ⚠️ 为什么读 `ctx.config` 要包 try/catch（2026-10-25 装机实测的坑）
 *
 * cordis 的 ctx 是**带服务的 Proxy**：未在 `inject` 里声明的服务，读属性会直接抛
 * `cannot get property "config" without inject`（不是返回 undefined）。
 * 第一版写成 `ctx.config ? ctx.config.role : undefined`，结果插件在 `apply` 第一行
 * 就抛错、被 loader 记成 FAILED —— 表现是「装上了、日志里什么都没有、中继没起」，
 * 而假 ctx（普通对象）测试永远测不出来。
 *
 * 所以这里**只把 ctx.config 当可选能力**：读不到（或抛错）就继续走下一级。
 *
 * @param ctx - Cordis 上下文（可选读 `ctx.config.role`，兼容测试用假 ctx）。
 * @param config - 插件配置（`apply` 的第二个参数）。
 * @returns {{ role: 'desktop' | 'mobile', source: string }} 角色与来源标签。
 */
export function resolveRole(ctx, config = {}) {
	const fromConfig = normalizeRole(config !== null && typeof config === 'object' ? config.role : undefined);
	if (fromConfig !== undefined) return { role: fromConfig, source: 'config' };

	let fromCtx;
	try {
		const ctxConfig = ctx !== null && typeof ctx === 'object' ? ctx.config : undefined;
		fromCtx = normalizeRole(ctxConfig ? ctxConfig.role : undefined);
	} catch {
		// cordis：`config` 是需要 inject 的服务，未声明时裸读会抛；按「没有」处理。
		fromCtx = undefined;
	}
	if (fromCtx !== undefined) return { role: fromCtx, source: 'ctx.config' };

	const fromEnv = normalizeRole(process.env.DSH_LINK_ROLE);
	if (fromEnv !== undefined) return { role: fromEnv, source: 'env' };

	const fromFile = readRole();
	if (fromFile.role !== undefined) return { role: fromFile.role, source: 'file' };

	return { role: platformRole(), source: 'platform' };
}

/**
 * 确保 role 已落盘：显式来源（config/env）不写文件；只有走到平台推断时，
 * 才预填 role.json 并日志提示可改（写盘失败不致命）。
 *
 * @param logger - 可选日志器（`ctx.logger`）。
 * @param resolved - `resolveRole()` 的返回值（可省略，省略时自己解析）。
 * @returns {{ role: string, created: boolean, source: string }} 解析结果。
 */
export function ensureRole(logger, resolved) {
	const found = resolved === undefined ? resolveRole({}, {}) : resolved;
	if (found.source !== 'platform') return { role: found.role, created: false, source: found.source };

	let created = false;
	try {
		mkdirSync(dirname(CONFIG_PATH), { recursive: true });
		writeFileSync(CONFIG_PATH, JSON.stringify({ role: found.role }, null, 2) + '\n', 'utf8');
		created = true;
	} catch (error) {
		logger?.warn?.(
			`[dsh-link] 写 role 配置失败（这次按 "${found.role}" 跑，下次启动重试）: ${String((error && error.message) || error)}`,
		);
	}
	if (created) {
		logger?.info?.(
			`[dsh-link] 未找到 role，已按平台预填 "${found.role}" → ${CONFIG_PATH}（要换角色就改这个文件后重启）`,
		);
	}
	return { role: found.role, created: created, source: found.source };
}

/**
 * 两边实现所需的服务并集（主机侧）。
 *
 * desktop 那一半声明的是
 * `['sessionController','sessions','webServer','workspaceRegistry']`，
 * mobile 那一半是同一组 + 可选的 `userQuestions`。外壳在加载实现之前就要给出
 * `inject`（loader 在 import 时读），所以这里用并集——两边都不会缺服务，
 * 手机端也不再要求 userQuestions 必须存在。
 */
export const inject = {
	sessions: { required: true },
	sessionController: { required: true },
	webServer: { required: true },
	workspaceRegistry: { required: true },
	userQuestions: { required: false },
};

/**
 * 角色 → 实现入口（用 `lib/host.js` 的相对路径）。
 *
 * @param role - `'desktop' | 'mobile'`。
 * @returns 相对模块说明符。
 */
export function implPath(role) {
	return role === 'desktop' ? './desktop/index.js' : './mobile/index.js';
}

/**
 * 按角色 import 对应实现（只 import 一个；这是「只加载一半」的唯一入口）。
 *
 * @param role - `'desktop' | 'mobile'`。
 * @returns 实现的模块命名空间。
 */
export async function loadImplementation(role) {
	return import(implPath(role));
}

/**
 * 插件入口：定角色 → 只 import 对应实现 → 把 (ctx, config) 原样透传。
 *
 * @param ctx - Cordis 宿主上下文。
 * @param config - 插件配置（`{ role, … }`）。
 *
 * ⚠️ 旧的 `tunnelToken` / `autoTunnel` 两个配置项已随公网隧道链路删除（P0-3）。
 * 老配置里如果还留着它们，这里是**忽略**而不是报错 —— 插件配置往往由安装器
 * 或从前的版本写死，用户升级后看不见它；为了两个已无人读取的字段把一个能用的
 * 插件卡住，从用户的角度看纯属无妄之灾。局域网直连的所有参数都在
 * `$DSH_HOME/dsh-remote/link.json` 里，与插件配置无关。
 */
export async function apply(ctx, config = {}) {
	const resolved = resolveRole(ctx, config);
	const role = ensureRole(ctx && ctx.logger, resolved).role;

	ctx?.logger?.info?.(`[dsh-link] 角色=${role}（来源 ${resolved.source}）→ 只加载 ${role} 实现`);

	try {
		const impl = await loadImplementation(role);
		await impl.apply(ctx, config);
	} catch (error) {
		ctx?.logger?.error?.(
			`[dsh-link] role="${role}" 的实现在加载/启动时失败（只记日志，不影响其它插件）: ` +
				String((error && error.stack) || error),
		);
	}
}
