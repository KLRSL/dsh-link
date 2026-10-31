/**
 * relay-token —— 「中继令牌」的唯一事实来源。
 *
 * ## 这个模块为什么存在（0.1.1 修的真实故障）
 *
 * 17890 上的中继**本身**是 dsh-link 的 `startRelay`，它校验的令牌由
 * `desktop/index.js` 的 `ensureToken()` 决定，优先级是：
 *
 * ```
 *   ① pair.json 的 accessToken   （配对成功后服务器下发的那把）
 *   ② <配置目录>/token.txt        （本机生成 / 手工指定）
 *   ③ 本机随机生成并写入 token.txt
 * ```
 *
 * 而网关（`link-gateway.js`）早期**只读 ②**，并在转发时**无条件覆盖**
 * `x-dsh-remote-token`。于是当 ① 存在（本机 = `pair.json.accessToken`）时：
 *
 * ```
 *   手机带着 <pair 令牌> 来 → 网关换成 <token.txt 旧值> → 中继校验 ①
 *   → 401 unauthorized          ← 手机看到的「两把令牌都被拒」
 * ```
 *
 * 用户侧的症状极具误导性：设备白名单是通的（`/link/ping` 200）、配对码是对的，
 * 但**所有 RPC 都 401**，且把手机里的令牌换成哪一把都没用 —— 因为网关每次都替换。
 *
 * ## 修法（单一事实来源 + 双向同步）
 *
 * - 中继与网关**调用同一个** `resolveRelayToken()`：谁也不再自己猜；
 * - 启动时把解析出的有效值**回写 `token.txt`**（`syncRelayTokenFile`），
 *   这样「手机端读 token.txt 同步」这条老通道拿到的也是同一把；
 * - 网关解析不出令牌时**不覆盖**，直接把客户端带来的头透传（旧手机兼容）。
 *
 * 只依赖 node 内置模块，可单独 import 自测。
 *
 * @module dsh-link/relay-token
 */

import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { stateDirOf as sharedStateDirOf } from '../shared/home.js';

/** 令牌最短长度：短于此值一律视为「没有令牌」。 */
export const MIN_TOKEN_LENGTH = 16;

/**
 * 配置目录：`$DSH_HOME/dsh-remote`（本机 = `%USERPROFILE%\.dsh\dsh-remote`）。
 *
 * ⚠️ 与 `desktop/index.js` 的 `STATE_DIR`、`device-auth.js` 的 `defaultDir()`
 * **必须一致**：0.1.0 起配置目录就是 `<DSH_HOME>/dsh-remote/`，不回退。
 *
 * @param {NodeJS.ProcessEnv} [env] - 环境变量（自测注入用）。
 * @returns {string} 绝对路径。
 */
export function stateDirOf(env = process.env) {
	// ⚠️ 默认（读真实 `process.env`）走 `shared/home.js` —— 那是唯一事实来源（P1-5）。
	// 只有自测注入 `env` 时才走下面这份等价实现：因为它要的是「按传入的 env 求值」，
	// 而 shared 那份每次读的是真实环境变量。
	//
	// 两条路径的语义必须**逐字等价**（空串/纯空白当未设置、相对路径解析成绝对），
	// 否则「自测过的行为」与「线上的行为」会是两个东西 —— 那正是要修的这类漂移。
	if (env === process.env) return sharedStateDirOf();
	const home = String(env?.DSH_HOME ?? '').trim();
	return join(home === '' ? join(homedir(), '.dsh') : resolve(home), 'dsh-remote');
}

/**
 * 一个配置目录下的两个令牌落点。
 *
 * @param {string} dir - 配置目录。
 * @returns {{pair: string, token: string}} 路径。
 */
export function tokenPathsOf(dir) {
	return {
		pair: join(dir, 'pair.json'),
		token: join(dir, 'token.txt'),
	};
}

/**
 * 令牌的短指纹，**只用来打日志**（日志里绝不出现令牌本身）。
 *
 * @param {unknown} token - 令牌。
 * @returns {string} 8 位十六进制。
 */
export function tokenFingerprint(token) {
	return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex').slice(0, 8);
}

/** 读 `pair.json` 里的 `accessToken`；读不到/不合法 → undefined。 */
function readPairAccessToken(dir) {
	let raw;
	try {
		raw = readFileSync(tokenPathsOf(dir).pair, 'utf8');
	} catch {
		return undefined; // 还没配对
	}
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return undefined; // 半截 JSON：按未配对处理，不能让中继起不来
	}
	const value = typeof parsed?.accessToken === 'string' ? parsed.accessToken.trim() : '';
	return value.length >= MIN_TOKEN_LENGTH ? value : undefined;
}

/** 读 `token.txt`；空文件/读不到 → undefined。 */
function readTokenFile(dir) {
	try {
		const value = readFileSync(tokenPathsOf(dir).token, 'utf8').trim();
		return value.length >= MIN_TOKEN_LENGTH ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * 解析当前**有效**的中继令牌（不写盘）。
 *
 * 优先级与中继的 `ensureToken()` 一致：`pair.json.accessToken` → `token.txt`。
 * 两者都没有时返回 `{ token: undefined, source: 'none' }` ——
 * 调用方（中继）负责随机生成并落盘，调用方（网关）负责透传客户端令牌。
 *
 * ⚠️ **每次请求都重新解析**：配对是运行中发生的，`/register` 成功后
 * `pair.json` 立刻出现新令牌，网关必须下一次请求就跟上。
 *
 * @param {{dir?: string}} [options] - `dir` 缺省用 `$DSH_HOME/dsh-remote`。
 * @returns {{token?: string, source: 'pair'|'file'|'none'}} 解析结果。
 */
export function resolveRelayToken({ dir = stateDirOf() } = {}) {
	const fromPair = readPairAccessToken(dir);
	if (fromPair !== undefined) return { token: fromPair, source: 'pair' };
	const fromFile = readTokenFile(dir);
	if (fromFile !== undefined) return { token: fromFile, source: 'file' };
	return { source: 'none' };
}

/**
 * 原子写令牌文件（0600；先写 tmp 再 rename，避免半截文件被网关读到）。
 *
 * @param {string} dir - 配置目录。
 * @param {string} token - 令牌。
 * @returns {boolean} 是否写成功。
 */
export function writeRelayTokenFile(dir, token) {
	const file = tokenPathsOf(dir).token;
	const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(tmp, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
		try {
			chmodSync(tmp, 0o600);
		} catch {
			/* Windows 上 chmod 只影响只读位；失败不影响内容 */
		}
		renameSync(tmp, file);
		return true;
	} catch {
		try {
			writeFileSync(file, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
			return true;
		} catch {
			return false;
		}
	}
}

/**
 * 把「有效令牌」同步进 `token.txt`（内容已经一样就一个字节都不写）。
 *
 * 用途：启动时调用一次，保证手机端按老办法读 `token.txt` 拿到的也是中继
 * 真正校验的那把 —— 这正是 0.1.0 里 `token.txt=<旧值>` 与
 * `pair.json.accessToken=<有效值>` 不一致的根治点。
 *
 * @param {{dir?: string, log?: Function}} [options] - 配置目录与日志。
 * @returns {{token?: string, source: string, wrote: boolean}} 结果。
 */
export function syncRelayTokenFile({ dir = stateDirOf(), log = () => {} } = {}) {
	const resolved = resolveRelayToken({ dir });
	if (resolved.token === undefined) return { source: 'none', wrote: false };
	const current = readTokenFile(dir);
	if (current === resolved.token) return { token: resolved.token, source: resolved.source, wrote: false };
	const wrote = writeRelayTokenFile(dir, resolved.token);
	try {
		if (wrote) {
			log(
				`令牌文件已对齐有效令牌（来源 ${resolved.source}，指纹 ${tokenFingerprint(resolved.token)}）`,
			);
		} else {
			log('令牌文件对齐失败（写盘错误；中继仍用有效令牌）', 'warn');
		}
	} catch {
		/* 日志失败不影响令牌 */
	}
	return { token: resolved.token, source: resolved.source, wrote };
}

/** 生成一把新令牌（32 字节随机 → 64 位十六进制）。 */
export function generateRelayToken() {
	return randomBytes(32).toString('hex');
}
