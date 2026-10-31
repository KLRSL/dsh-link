/**
 * home —— `$DSH_HOME` 的**唯一**解析入口。
 *
 * ## 为什么要单独一个文件
 *
 * 曾经有四个地方各写了一遍：
 *
 * | 位置 | 当时的写法 | 后果 |
 * |---|---|---|
 * | `desktop/index.js` 调试日志 | `process.env.DSH_HOME ?? join(homedir(),'.dsh')` | 空串 → 相对路径 → 日志落进 CWD |
 * | `desktop/link-notify.js` | `join(homedir(),'.dsh',...)` | **完全忽略 `DSH_HOME`** → 设了就永远读不到 `link-peer.json`，通知静默失效 |
 * | `scripts/link-install.mjs` | 同上 | 同上，装插件静默失败 |
 * | `desktop/device-auth.js` | `(env ?? '').trim() \|\| homedir()` | ✅ 对，但少了 `/.dsh` 兜底细节 |
 *
 * 前三条是同一个 bug 的三种变体：**「本机默认路径」被当成常量写死，环境变量被绕过**。
 * 它的隐蔽之处在于**不报错**：通知只是「不发」，用户只会以为功能没做好，
 * 永远不会想到是路径读错了地方。
 *
 * 所以判断标准不是「能不能解析」，而是「**有没有第二个地方能自己拼这条路径**」——
 * 只要还有，就会再次漂移。
 *
 * ## ⚠️ 空串必须当「未设置」，不能用 `??`
 *
 * `process.env.DSH_HOME ?? x` 只挡 `null` / `undefined`，**空串会一路进 `join`**，
 * 于是 `STATE_DIR` 变成相对路径 `dsh-remote`，`dirname` 得到 `.`，解析成**进程 CWD**。
 * 工作区围栏的「禁区根」从真实 `$DSH_HOME` 悄悄换成 CWD，真正的 `$DSH_HOME`
 * 反而落在禁区之外 —— 围栏等于没画。
 *
 * 引擎自己明确把空值当未设置（`dsh-home-paths` 注释原文："An empty or
 * whitespace-only `$DSH_HOME` is treated as unset"）。两端理解必须一致。
 *
 * @module dsh-link/shared/home
 */
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * 解析 `$DSH_HOME`。
 *
 * - 未设置 / 空串 / 纯空白 → `~/.dsh`；
 * - 相对路径 → `resolve()` 成绝对路径（否则 `join` 出来的目录随 CWD 漂移）；
 * - 尾部分隔符去掉（`DSH_HOME=/home/u/` 不该产出 `/home/u//dsh-remote`）。
 *
 * @returns 绝对路径形式的 DSH 家目录。
 */
export function resolveDshHome() {
	const raw = process.env.DSH_HOME;
	const trimmed = typeof raw === 'string' ? raw.trim() : '';
	if (trimmed === '') return join(homedir(), '.dsh');
	return resolvePath(trimmed);
}

/**
 * `$DSH_HOME` 下的插件状态目录（`$DSH_HOME/dsh-remote`）。
 *
 * 两端所有「配置 / 令牌 / 设备表 / 配对码 / 缓存」都落在这里。
 *
 * @returns 绝对路径。
 */
export function stateDirOf() {
	return join(resolveDshHome(), 'dsh-remote');
}

/**
 * 状态目录下的一个文件。
 *
 * @param {...string} parts - 相对 `dsh-remote` 的路径段。
 * @returns 绝对路径。
 */
export function statePathOf(...parts) {
	return join(stateDirOf(), ...parts);
}

/** 相对路径 → 绝对路径（CWD 不参与结果漂移）；尾部分隔符去掉。 */
function resolvePath(value) {
	const abs = resolve(value);
	return abs.length > 1 && (abs.endsWith('/') || abs.endsWith(sep)) ? abs.slice(0, -1) : abs;
}
