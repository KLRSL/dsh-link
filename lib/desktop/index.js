/**
 * dsh-link —— 电脑端（host half，装在客户电脑的 DSH 里）。
 *
 * ## 这个插件做什么
 *
 * 把本机 DSH 的会话事件流**经局域网直连**（IPv4 / IPv6·域名，可自行挂 DDNS）
 * 搬到手机，让手机能「进入电脑目录、在电脑上发起对话」。只传文本（用户几串字 +
 * AI 回复 + 事件 JSON），不映射桌面、不映射 Web UI。
 *
 * ## 架构（路 B：电脑跑 agent loop，手机搬事件流）
 *
 * ```
 *   手机 WebView ──HTTPS（局域网 / 已开放的 IPv6·域名）──> 本机 :17890
 *                                                              │
 *                                                      本插件的中继服务
 *                                                              │
 *                                              ctx.sessionController（官方命令层）
 * ```
 *
 * ⚠️ 旧版走 Cloudflare 隧道 + 激活码（代码里残留的注释是那段历史的说明），
 * 隧道与激活码在 0.15.x 已删除，别再按它们理解现在的链路。
 * 为什么不是「手机跑 loop、电脑当文件后端」：那样每个文件内容都要在公网来回滚，
 * 带宽与延迟都不可接受。路 B 下电脑是唯一真源，手机只搬事件。
 *
 * ## ⚠️ 关键设计：复用官方 `sessionController`，不自己造 agent
 *
 * 本插件**不**手工拼 `ctx.agents.create(...)`。官方 `SessionCommandController.create()`
 * 内部会 `agents.ensureSession(sessionId, cwd, ...)` —— 那会走 agent factory 建出
 * 一个**真 agent**（带 preset、带模型选择、带工具），这是手搓很难对齐的。
 *
 * 所以：
 * - 建会话 → `ctx.sessionController.create({ sessionId, cwd })`
 * - 发消息 → `ctx.sessionController.prompt({ sessionId, content, requestId })`
 * - 中断   → `ctx.sessionController.cancel({ sessionId })`
 *
 * ⚠️ **`prompt` 必须带唯一的 `requestId`**：官方用 `hasPromptRequest(agent, requestId)`
 * 做幂等去重，而它判的是 `source.rpcId === requestId`。若两边都是 `undefined`，
 * 第二次发消息会被**误判为重复**而静默返回 `{accepted:true}` —— 消息根本没进 agent。
 *
 * ## ⚠️ cwd 绝不跨端传（实测硬约束）
 *
 * Android 是 posix 语义，`path.posix.isAbsolute('C:/Users/...') === false`，
 * 而 `validateSessionHeader` 要求 `cwd` 是绝对路径。更危险的是官方
 * `createOrAdopt()` 里有 `await mkdir(cwd, { recursive: true })` ——
 * 手机端拿电脑路径去建会话会**真去建目录**。
 * 所以两端会话靠 **sessionId** 映射，电脑路径只作纯展示文字。
 * 本插件收到 `cwd` 参数时**只认电脑自己的绝对路径**（手机端不会传电脑路径过来）。
 *
 * ## 中继协议
 *
 * - `POST /api/dsh-remote/rpc`：`{ id, method, params }` → `{ id, ok, result }`
 * - `GET  /api/dsh-remote/stream?session=<id>`：SSE，`event:` 是 durable 事件、
 *   `frame:` 是流式帧
 *
 * 选 SSE 而不是 WebSocket：手机 WebView 里 EventSource 是原生 API，断线自动重连
 * 是浏览器内建的；WS 要自己写心跳与退避。Cloudflare 隧道对 SSE 的支持与普通
 * HTTP 一致。
 *
 * ## ⚠️ 丢帧是安全的（实测结论）
 *
 * 手机端 `ClientAssistantStream.acceptFrame()` 遇到不连续的帧返回
 * `{ type: 'rebaseline' }`，消费点是 `events.restart()` —— 即重连重拉基线。
 * 而 **host 侧的帧永不丢**（进程内事件），重连后从 baseline 能补齐全部已生成内容。
 * 所以这条通道可以做成 best-effort，不必自己设计序号补洞。
 *
 * @module dsh-link
 */

import { createServer } from 'node:http';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, dirname, join, resolve, sep } from 'node:path';
import { startLinkGateway } from './link-gateway.js';
import { notifyEnabled, patchLinkConfig, patchLinkPeer, readLinkConfig } from './link-config.js';
import { notifyLink } from './link-notify.js';
import { getSharedDeviceAuth, readClaimInfo } from './device-auth.js';
import { readPairingInfo } from './pairing-info.js';
import { pluginVersion, receivePlugin } from './plugin-receive.js';
import { resolveRelayToken, syncRelayTokenFile } from './relay-token.js';
import { createEngineGate } from '../shared/engine-gate.js';
import { stateDirOf, statePathOf } from '../shared/home.js';
import { createSetupController } from '../setup/setup-routes.js';
import { DEFAULT_NOTIFY, DEFAULT_SESSION_SYNC, shouldNotify } from '../setup/setup-wizard.js';

/**
 * 本机 `link/*` 路由的引擎判据门（P1-1）。
 *
 * 与手机端 `bridgeRejection` 共用 `createEngineGate` 的实现 —— 两端判据必须
 * 逐字一致，否则攻击面会挑软的那一边。
 *
 * ⚠️ 这里只写插件调试日志：门本身在模块级，拿不到 `ctx.logger`。
 * 「被拒」这件事由 `handleLinkRoute` 在用 `ctx` 的那一层补记。
 */
const linkGate = createEngineGate({
	log: (line) => {
		void debugLog(`link-gate ${line}`);
	},
});

export const name = 'dsh-link';

/**
 * `sessionController` 提供官方的建会话/发消息/中断命令层；`sessions` 用于
 * SSE 开场补发历史；中继 HTTP 服务由本插件自建（不用 `webServer`，因为
 * `webServer` 挂在 DSH 自己的 Web 端口上，而局域网网关监听独立端口 8899）。
 *
 * `webServer` 是给**配置页**用的：客户端半边要能填电脑地址、生成/输入 6 位
 * 配对码、看已配对设备，那条路走的是 DSH 自己的 Web 端口（与网关端口无关）。
 */
export const inject = {
	sessionController: { required: true },
	sessions: { required: true },
	webServer: { required: true },
	workspaceRegistry: { required: true },
	// 会话标题/记录投影：不声明 inject 时 ctx.sessionProjections 会抛
	// "cannot get property ... without inject"，手机只能看到标题、看不到内容。
	sessionProjections: { required: false },
};

/** 中继监听端口。局域网直连（含 IPv6·域名 + DDNS）与手机端填的就是这个端口。 */
const RELAY_PORT = 17890;

/**
 * 授权码弹窗的状态接口前缀（同样挂在 DSH 自己的 Web 端口上，**仅 loopback**）。
 *
 * 电脑端页面（`lib/client.js`）用它判断「要不要弹授权码浮层」：
 * `GET /api/dsh-remote/link/claim-info` → `{ needsClaim, code, expiresAt, devices }`。
 * 同一前缀下还有 `GET /api/dsh-remote/link/role` —— 前端拿来判「这台是电脑吗」。
 */
const LINK_ROUTE = '/api/dsh-remote/link';

/**
 * 安装向导控制器（首次配置弹窗 + 设置页）。在 `apply` 里用本机配置目录初始化；
 * `handleLinkRoute` 在通过回环门与引擎判据门之后，把 `/setup*` 交给它处理。
 */
let setupController = null;

/**
 * 局域网网关的句柄（`startLinkGateway` 的返回值，函数上挂了 `devices`）。
 *
 * 配置页的「解绑设备 / 断开全部配对」必须走网关的 `devices.revoke()` ——
 * 只改 `setup.json` 里的副本是假动作，手机下次仍能连进来。
 */
let desktopGateway = null;

/** 读 `link.json`（网关真实监听配置）；坏了/不存在返回 `null`。 */
/**
 * 冷会话补洞的**事件条数上限**。
 *
 * `readEventRange` 对冷会话必须物化整份日志（`observation.events` 是惰性
 * getter，一碰就快照全量）。实测本机最大的会话 29638 条 / 155 MB 明文，
 * 为补一两条缺口读它不可接受。
 *
 * 2000 条的明文量级约 10 MB，是「能接受的一次性兜底成本」的上界；
 * 超过它的会话走「放弃补洞 ⇒ 手机端断流重连」那条路，代价是重连一次
 * （SSE handler 那边该付的补齐成本照付，但那是必须的）。
 */
const COLD_RANGE_LIMIT = 2000;

/**
 * `$DSH_HOME` 与状态目录：**唯一**来源是 `shared/home.js`（P1-5）。
 *
 * ## ⚠️ 为什么不能在本文件里再写一遍 `process.env.DSH_HOME ?? ...`
 *
 * `??` 只挡 `null`/`undefined`，**空串会一路进 `join`**，于是 `STATE_DIR`
 * 变成相对路径 `dsh-remote`，`dirname` 得到 `.`，解析成**进程 CWD** ——
 * 工作区围栏的「禁区根」从真实 `$DSH_HOME` 悄悄换成 CWD，真正的 `$DSH_HOME`
 * 反而落在禁区之外。后果是 `createSession {cwd:"C:\\Users\\<user>\\.dsh"}`
 * 被放行，再 `fileRead {path:"dsh-remote/token.txt"}` 就把中继令牌读走了 ——
 * 那把令牌等于这台电脑上 agent 的完整控制权。
 *
 * 引擎自己明确把空值当未设置（`dsh-home-paths`："An empty or whitespace-only
 * `$DSH_HOME` is treated as unset"）。两端理解必须一致，否则围栏判的是另一个目录。
 *
 * 完整的决策记录（含历史上四处各写一遍的事故）在 `lib/shared/home.js` 文件头。
 */
const STATE_DIR = stateDirOf();

/** 访问令牌文件。手机端要用同一个令牌才能连上。 */
const TOKEN_PATH = join(STATE_DIR, 'token.txt');

/**
 * 远程调用**不许**当成工作区的目录名（相对路径的最后一段，大小写不敏感）。
 *
 * ## 为什么需要这张表（2026-10-20 现场）
 *
 * `assertWorkspaceAllowed` 原来只排 `$DSH_HOME` 自己/祖先/后代，于是下面这些
 * **全都**是合法工作区，而文件围栏是「以工作区为界」的 —— 工作区一旦是
 * `.ssh`，`fileRead('id_ed25519')` 就是完全合规的请求：
 *
 * | 目录 | 里面是什么 |
 * |---|---|
 * | `~/.ssh` | 私钥（`id_ed25519`）、`known_hosts`、`config` |
 * | `~/.gnupg` | GPG 私钥环 |
 * | `~/.aws` / `~/.kube` / `~/.config/gcloud` | 云凭据 |
 * | `~/.docker` | `config.json` 里常有 registry 凭据 |
 * | `AppData` | 浏览器 profile（Cookie / 已存密码）、`Local/Programs` |
 * | `*.keystore` / `keystore` | 安卓签名密钥 |
 *
 * ⚠️ **现场证据**：2026-10-20 19:50~20:21 有 14 个这样的目录被
 * `ensureWorkspaceId` 自动登记成了永久工作区（`.ssh` 3 个会话、
 * `.docker` 1 个、`keystore` 1 个…），全部留存于 `storages/workspace.json`。
 * 调用方不是外人 —— 是本机一个 AI 会话的探针脚本，它**读到了明文令牌**。
 * 令牌泄漏是另一件事（见 `token.txt` 那段的注释），但「读到令牌 ⇒ 能读私钥」
 * 这一跳**必须**在本函数里掐断。
 *
 * ⚠️ 判的是**路径里的任意一段**，不是只看最后一段：`~/.ssh` 和
 * `~/.ssh/anything` 一样敏感，而 `~/.ssh-backup` 这种**不是**目录名精确匹配，
 * 不受影响（用 `===` 比整段，不做前缀匹配）。
 */
const FORBIDDEN_DIR_NAMES = new Set([
	'.ssh',
	'.gnupg',
	'.aws',
	'.azure',
	'.kube',
	'.docker',
	'.config',
	'.password-store',
	'.terraform.d',
	'appdata',
	'keystore',
	'keystores',
]);

/**
 * 自动建工作区的**速率上限**（每小时）。
 *
 * ## 为什么必须有（2026-10-20 现场）
 *
 * `ensureWorkspaceId` 在 `resolveByPath` 未命中时会 `registry.create(cwd)`，
 * 而 `create` 是**持久化副作用**：写进 `storages/workspace.json`，重启还在，
 * 侧边栏永久多一项。一个循环 25 次的探针脚本在 31 分钟里造出了
 * **14 个工作区 + 25 个空会话**，全部留存至今。
 *
 * 正常用户一小时里最多新建一两个工作区；20 是「明显不是人手动点的」的门槛，
 * 同时留足余量给重装/重配的批量场景。超限后**报错**而不是静默降级 ——
 * 静默降级会让调用方以为成功，继续循环下去。
 */
const WORKSPACE_CREATE_LIMIT = 20;
const WORKSPACE_CREATE_WINDOW_MS = 60 * 60 * 1000;

/**
 * 最近一小时内**新建**工作区的时间戳（滑动窗口，见 `ensureWorkspaceId`）。
 *
 * ⚠️ 放在模块作用域是有意的：它必须跨 RPC 调用累积，而 `apply()` 的闭包
 * 每会话只建一次。这里没有「看不到闭包变量」的坑 —— 它不被 `apply()` 里的
 * 东西引用，只被模块级函数 `ensureWorkspaceId` 读写。
 */
const workspaceCreateStamps = [];

/**
 * 令牌落盘时的随机源 —— **不要再往包里写死任何凭据**。
 *
 * ## 为什么这里必须随机生成（这是一次真实漏洞的修复，别改回去）
 *
 * 早期版本把访问令牌和 Cloudflare 隧道令牌**硬编码在包内**，让「装完即用」。
 * 但那等于把凭据**公开发布到 npm**：任何人都能 `npm pack` 出这两个值。
 * 实测后果（用包内那个公开令牌打公网隧道）：
 *
 * ```
 * POST https://dsh-remote.example.com/api/dsh-remote/rpc
 * x-dsh-remote-token: <包内公开常量>
 * → HTTP 200，cf-ray a4b1631e9a978bcf-SIN，读到本机 177 个目录条目
 * ```
 *
 * 面向大众分发时这个缺陷是**灾难级**的：每个客户机都拿同一个隧道凭据去连
 * **同一条**隧道（`dsh-remote.example.com`），而访问令牌又是公开常量 ——
 * 于是**任何一个客户都能读其他客户整台电脑的目录、并能以他们的身份发消息**。
 * 客户机还会被挂到别人的域名上，本人毫不知情。
 *
 * 所以凭据一律**本机生成、本机落盘**（`token.txt`），配对成功后由服务器下发的
 * `accessToken` 取代（见 `ensureToken` 的优先级）。包里**不含任何可用凭据**。
 */
function generateToken() {
	return randomBytes(32).toString('hex');
}

/**
 * **已作废**的旧公开令牌 —— 只用于识别，**不是凭据，也永远不要再用它鉴权**。
 *
 * 1.0.11 及更早的版本把它当默认令牌写进 `token.txt`。老用户升级后文件里还留着
 * 这个值，若不识别就会**继续用这个全网公开的令牌**跑中继 —— 等于漏洞没修。
 * 所以 `ensureToken` 见到它就当成「没有令牌」，重新随机生成。
 *
 * 它已经发布到 npm，无法收回，因此**它必须被视为已泄露**：只做识别用。
 *
 * ## ⚠️ 为什么存哈希而不是原值
 *
 * 识别它只需要比对，不需要原值。把已泄露的令牌**再明文写一遍**没有任何好处，
 * 却会让它继续出现在每个新版本里。所以存 `sha256(原值)`。
 */
const LEGACY_PUBLIC_TOKEN_FINGERPRINT =
	'6c04899c20fc7ffab9b2fe7f9cc6e56a8b7ca0c66c96b393f8b93ab1c9784356';

/**
 * 判断一个令牌是不是那个已泄露的旧公开令牌。
 *
 * @param value - `token.txt` 里的内容。
 * @returns 是否应视为「没有令牌」。
 */
function isLegacyPublicToken(value) {
	const text = String(value ?? '');
	return createHash('sha256').update(text, 'utf8').digest('hex') === LEGACY_PUBLIC_TOKEN_FINGERPRINT;
}

/**
 * 决定中继的访问令牌。
 *
 * ## 优先级（`token.txt` → 随机生成）
 *
 * 删掉公网配对（P0-3）之后，中继令牌只有两个来源：
 *
 * 1. `token.txt` —— 已经联动过（LAN 配对同步过 / 手工改过）就沿用；
 * 2. **本机随机生成**并落盘 —— 没有文件时的兜底。
 *
 * ⚠️ 这里**不自作主张地排优先级**，而是直接复用 `relay-token.js` 的
 * `resolveRelayToken()`：中继与网关都调它，**谁也不猜**。0.1.1 那个「两把令牌
 * 都被拒」的故障根因就是两边各有一套解析，必须从根本上杜绝复发。
 *
 * ⚠️ 第 2 条早期是「退回包内硬编码的常量」，那是个真实漏洞：常量随 npm 包公开，
 * 于是任何未配对的客户机都用**同一个公开令牌**跑中继，谁都能连上去读他的电脑。
 * 现在改成随机生成，包里不再含任何可用凭据（详见 `generateToken` 的注释）。
 *
 * ## ⚠️ 为什么还要认识旧的公开令牌
 *
 * 老版本会把包内那个已泄露的常量写进 `token.txt`。升级时必须把它当成
 * **没有令牌**（`isLegacyPublicToken`），否则装上新版仍在用公开令牌，
 * 漏洞等于没修 —— CVE 修完留个「已公开的后门常量」在用户机器上，最容易被忘掉。
 *
 * @param ctx - Cordis 上下文（只用 logger）。
 * @returns 令牌字符串。
 */
function ensureToken(ctx) {
	const log = (line, level) =>
		(level === 'warn' ? ctx.logger?.warn : ctx.logger?.info)?.call(ctx.logger, `[dsh-link] ${line}`);
	/** 把有效令牌同步进 token.txt（内容已一致就不写），供手机端按老办法读取同步。 */
	const sync = (value) => {
		try {
			syncRelayTokenFile({ dir: STATE_DIR, log });
		} catch (error) {
			log(`token.txt 对齐失败（不影响中继）: ${String(error?.message ?? error)}`, 'warn');
		}
		return value;
	};

	// 老用户机器上可能还留着公网配对时代写的 `pair.json`（含 accessToken）。
	// 那份凭据不再被本机关心，但它就躺在同一目录里 —— 「删了代码但用户盘上还在」
	// 是删功能时最容易漏的一环。沿用 resolveRelayToken 的优先级去读它没有害处：
	// 它与 token.txt 早在 0.1.1 起就由 syncRelayTokenFile 对齐成同一把了。
	const resolved = resolveRelayToken({ dir: STATE_DIR });
	if (resolved.token !== undefined && isLegacyPublicToken(resolved.token)) {
		log('检测到旧版内置的公开令牌（已泄露），正在换成本机随机令牌', 'warn');
	} else if (resolved.token !== undefined) {
		return sync(resolved.token);
	}

	const token = generateToken();
	try {
		mkdirSync(STATE_DIR, { recursive: true });
		writeFileSync(TOKEN_PATH, token, { mode: 0o600 });
	} catch (error) {
		// 写不了盘也照用（本机内存里这份仍是随机的）；只是下次启动会换一个，
		// 而手机端要等配对才能知道新值 —— 配对是面向大众的主路径，不受影响。
		log(`写令牌文件失败（本次仍用随机令牌）: ${String(error?.message ?? error)}`, 'warn');
	}
	return token;
}

/** 组一条 SSE 消息。 */
function sse(eventName, payload) {
	return `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * 「这一环不接手」的哨兵。
 *
 * ⚠️ 不能用 `undefined` / `null`：两者都可能是**合法的应答值**，
 * 用它当哨兵会把「手机明确回了空」误判成「手机没在」而重复走下一环。
 */
const NO_TAKEOVER = Symbol('dsh-remote:no-takeover');

/**
 * 诊断日志：写一行到 `~/.dsh/dsh-remote/desktop-debug.log`。
 *
 * 为什么不用 `console.info`：桌面版是 Electron，插件跑在引擎子进程里，
 * stdout 被父进程收走、没有落盘，真机排查时**一条都看不到**。
 * 直接追加文件才能事后取证。
 *
 * ⚠️ 整个函数吞掉所有异常：诊断日志绝不允许影响业务逻辑。
 */
async function debugLog(line) {
	try {
		const { appendFile, mkdir } = await import('node:fs/promises');
		// ⚠️ 不要在这里自己拼 `process.env.DSH_HOME ?? join(homedir(),'.dsh')`：
		// 那样 `DSH_HOME=""` 会落进进程 CWD（P1-5）。统一走 shared/home.js。
		const { stateDirOf } = await import('../shared/home.js');
		const dir = stateDirOf();
		await mkdir(dir, { recursive: true });
		await appendFile(join(dir, 'desktop-debug.log'), `${new Date().toISOString()} ${line}\n`, 'utf8');
	} catch {
		// 故意什么都不做
	}
}

/** `approval/request` 的合法返回词表（与 dsh-user-approval 的 OUTCOMES 一致）。 */
const APPROVAL_OUTCOMES = ['allowed-once', 'rejected', 'cancelled', 'unavailable'];

/**
 * 等手机回答的超时。
 *
 * 为什么要有：手机可能锁屏、隧道断了、用户压根没看。没有超时的话
 * 这一轮会**永久挂住**，而「永久挂住」比「失败」更糟 —— 用户看到的是
 * 界面卡死、连停止按钮都没反应，只能杀应用。
 *
 * 取 5 分钟：比任何合理的人工反应时间都长（用户可能在开会、在走路），
 * 又短到不会让一轮真的永远挂着。超时后走 `next()` 交给官方 GUI，
 * 或由官方兜底 fail closed。
 */
const ASK_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * 「手机优先、电脑那条懒启动」的宽限期（2026-10-25 改）。
 *
 * 手机先答时，电脑端**根本不该弹窗** —— 所以 `approval/request` 与
 * `user-questions/request` 一开始**不调 `next()`**，先等手机这么久；
 * 到点手机还没答，才启动官方链路（电脑端这时才弹窗）。
 *
 * 手机压根没有活着的订阅者时 `askPhone` 会**当场**回 `NO_TAKEOVER`，
 * 调用方据此立刻启动电脑那条，不会白等这 2.5 秒。
 */
const LAZY_GRACE_MS = 2500;

/**
 * 列出本机存在的盘符（仅 Windows）。
 *
 * 没有这一步，用户从主目录一路退到 `C:\` 就**再也出不去**了 —— 驱动器根没有
 * 上级目录，`parent` 为空，「上一级」按钮随即失灵，D 盘永远不会出现在列表里。
 *
 * @returns `['C:\\', 'D:\\', ...]`。
 */
function listDrives() {
	if (process.platform !== 'win32') return [];
	const drives = [];
	for (let code = 65; code <= 90; code += 1) {
		const root = `${String.fromCharCode(code)}:\\`;
		try {
			if (existsSync(root)) drives.push(root);
		} catch {
			/* 无权限探测：忽略该盘符 */
		}
	}
	return drives;
}

/**
 * 不许把 DSH 自己的状态目录（`$DSH_HOME`）当成会话工作区。
 *
 * ## 为什么必须有这一条（公网实测的攻击链）
 *
 * 文件 API 的围栏是**以会话工作区为界**的（见 `resolveWorkspacePath`），
 * 而工作区由手机端在 `createSession` 里自由指定。两者一叠加，围栏就能被绕开：
 *
 * ```
 * ① createSession { cwd: 'C:\\Users\\<user>' }          → ok（工作区 = 整个主目录）
 * ② fileStat      { path: '.dsh\\dsh-remote\\pair.json' } → ok，504 字节
 * ```
 *
 * 第 ② 步走的是**相对路径**，所以 `resolveWorkspacePath` 那道围栏完全拦不住 ——
 * 它判的是「在不在工作区内」，而令牌文件**确实**在工作区内。
 *
 * `$DSH_HOME` 里有 `.credentials.yaml`（模型 API 密钥）、`dsh-remote/pair.json`
 * （访问令牌）、`sessions/`（全部会话历史）。这些都不该经公网可读。
 *
 * ## ⚠️⚠️ 1.0.15 的修法是错的：只排除 `$DSH_HOME` **一个根** 挡不住
 *
 * 原判据是「cwd 落在 `$DSH_HOME` 之内就拒绝」。但攻击链第 ① 步用的是
 * **主目录**（`C:\Users\<user>`）—— 它是 `$DSH_HOME` 的**祖先**，
 * 根本不在 `$DSH_HOME` 之内，于是照旧放行；第 ② 步再去读
 * `.dsh\dsh-remote\pair.json` 是**相对路径**，围栏也拦不住（它判的是
 * 「在不在工作区内」，而令牌文件确实在工作区内）。
 *
 * 外部审计的原话是「用一个排除法思路修一个白名单问题」。实测复现：
 * `_audit/poc_workspace_bypass.mjs` —— 1.0.15 下 3 个方法全部放行。
 *
 * **所以现在是白名单判据**：凡是 `$DSH_HOME` 本身、它的任意**祖先**、
 * 它的任意**子目录**，一律拒绝。理由：把祖先目录当工作区，`$DSH_HOME`
 * 就成了它的子目录，令牌文件立刻落在可读范围里 —— 这正是那条攻击链。
 *
 * ⚠️ **必须走 `realpathSync` 再比**：`C:\Users\X\link` 可以是指向 `.dsh` 的
 * 符号链接，只比字面路径会被绕过。realpath 失败（路径不存在）时退回字面值 ——
 * 那时目录还没建，等官方 `mkdir` 建出来也只是个普通空目录。
 *
 * @param cwd - 手机请求的工作区路径（已确认是绝对路径）。
 * @throws 当它是 `$DSH_HOME`、其祖先或其后代时。
 */
function assertWorkspaceAllowed(cwd) {
	const stateRoot = STATE_DIR; // $DSH_HOME/dsh-remote
	const dshHome = dirname(stateRoot);
	const target = realpathBestEffort(cwd);
	const home = realpathBestEffort(dshHome);
	// ① $DSH_HOME 自己 / 其后代：令牌、凭据、会话历史都在里面。
	// ② $DSH_HOME 的祖先（含盘符根如 C:\）：把它当工作区，$DSH_HOME 就成了
	//    它的子目录 —— 用相对路径 `.dsh\dsh-remote\pair.json` 即可读到令牌。
	if (isInside(home, target) || isInside(target, home)) {
		throw new Error('不能把 DSH 自己的配置目录（或其所在目录）当作工作区，请选一个普通文件夹');
	}
	// ③ 凭据目录：`.ssh` / `.gnupg` / `.aws` / `AppData` / `keystore` …
	//    围栏是「以工作区为界」的，所以把 `.ssh` 当工作区 = 允许读私钥。
	//    判的是**任意一段**目录名（`.ssh` 与 `.ssh/sub` 一样敏感）。
	for (const segment of target.split(/[\\/]+/)) {
		if (FORBIDDEN_DIR_NAMES.has(segment.toLowerCase())) {
			throw new Error(
				`不能把「${segment}」这类存放凭据的目录当作工作区，请选一个普通项目文件夹`,
			);
		}
	}
}

/**
 * 常数时间比较访问令牌。
 *
 * ⚠️ **原来写的是 `provided !== auth.token`**：node 的字符串 `!==` 是短路比较，
 * 第一个不同的字节就返回，比较耗时随「前缀匹配到第几位」变化。理论上攻击者
 * 可以靠测量响应时间**逐字节猜出令牌**（经典时序侧信道）。
 *
 * ⚠️ 实践上这条路很难走通 —— 中间隔着 Cloudflare 隧道和公网抖动，单次比较
 * 纳秒级的差异会被噪声淹没，要打到统计显著需要海量样本。但**成本只有一次
 * 函数调用**，而这是发给大众的组件，没有理由留着。
 *
 * ⚠️ **长度不等必须立刻返回 `false`**：`timingSafeEqual` 在两个 Buffer 长度不同时
 * 会**抛异常**，直接漏出去会把 401 变成 500（拿长度探测的行为差异也算一种泄漏）。
 * 令牌长度（64）本身不是秘密，所以「先比长度」不额外泄漏信息。
 *
 * @param provided - 请求里带来的令牌（可能为空串、可能是数组）。
 * @param expected - 本机当前的有效令牌。
 * @returns 是否匹配。
 */
function tokenMatches(provided, expected) {
	const a = Buffer.from(String(provided ?? ''), 'utf8');
	const b = Buffer.from(String(expected ?? ''), 'utf8');
	if (a.length !== b.length || b.length === 0) return false;
	return timingSafeEqual(a, b);
}

/**
 * 令牌的短指纹，**只用来打日志**。
 *
 * ⚠️ 日志里不能出现令牌本身（见启动处那两行的注释），但排查时又需要能对账
 * 「两端用的是不是同一把」—— 于是打一个**单向**短指纹：够用来比，
 * 不够用来还原。
 *
 * 用 `sha256` 而不是「取前 6 位」：令牌是随机十六进制，前 6 位能直接拿去
 * 当暴力破解的起点（缩小 2^24 倍），哈希后没有这个性质。
 *
 * @param token - 访问令牌。
 * @returns 8 位十六进制指纹。
 */
function tokenFingerprint(token) {
	return createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex').slice(0, 8);
}

/**
 * 「要根」的几种写法：`/`、`\`、`\\`、`//`。
 *
 * 手机端把「根」当成一个可请求的位置（盘符行就是它的产物），所以这里显式认这几种。
 */
const WIN_ROOT_INPUTS = new Set(['/', '\\', '\\\\', '//']);

/**
 * `listDirectory` 的目录禁区（P1-6）。
 *
 * ## 为什么单独一条，而不是复用 `assertWorkspaceAllowed`
 *
 * `listDirectory` 是**唯一**不做工作区约束的路径型 RPC：其余所有涉及路径的
 * RPC 都过 `assertWorkspaceAllowed` / `resolveWorkspacePath`，按「会话工作区」
 * 划界。而它要服务的产品功能是「手机端选电脑目录」—— 那个对话框**本来就得
 * 能浏览全盘**，按工作区划界等于让它只能选当前会话的目录。
 *
 * 于是它曾经是**完全无约束**的：`readdirSync(resolve(target))`，任何已授权
 * 手机可以遍历电脑全盘目录树，含 `C:\Users\x\.dsh\` 的结构（进而知道
 * `dsh-remote/`、`sessions/` 这些落点在哪）。
 *
 * 但这不意味着「全盘都该列」。划界方式得换一种：**不是「只许列工作区」，
 * 而是「不许列这些目录」**：
 *
 * - `$DSH_HOME` 及其后代：里面有 `.credentials.yaml`（模型 API 密钥）、
 *   `dsh-remote/`（令牌、设备表、配对码）、`sessions/`（全部会话历史）；
 * - 凭据类目录（`.ssh` / `.aws` / `AppData` …）：与 `assertWorkspaceAllowed`
 *   的第 ③ 条同一张表，别让两处的敏感目录定义各写一份。
 *
 * ⚠️ **不拦祖先**：`C:\Users\x` 是 `$DSH_HOME` 的祖先，而用户正是从那里
 * 一级级走进自己的项目目录的 —— 拦住祖先会让「选目录」对话框寸步难行。
 * 与 `assertWorkspaceAllowed` 拦祖先的差异是**故意**的：那里防的是「把祖先
 * 当工作区后用相对路径读令牌」，这里只是**列出名字**，不构成读取。
 *
 * ⚠️ 走 `realpathBestEffort` 再比：符号链接指向 `.dsh` 时只比字面路径会被绕过。
 *
 * @param absolute - 已 `resolve` 的绝对路径。
 * @throws 落在禁区时。
 */
function assertListable(absolute) {
	const dshHome = dirname(STATE_DIR);
	const target = realpathBestEffort(absolute);
	const home = realpathBestEffort(dshHome);
	if (isInside(home, target)) {
		throw new Error('不允许列出 DSH 配置目录的内容，请选一个普通文件夹');
	}
	for (const segment of target.split(/[\\/]+/)) {
		if (FORBIDDEN_DIR_NAMES.has(segment.toLowerCase())) {
			throw new Error(`不允许列出「${segment}」这类存放凭据的目录，请选一个普通项目文件夹`);
		}
	}
}

/**
 * 列一个目录下的子目录（跟随符号链接，与官方 browse 后端一致）。
 *
 * 三种入参形态：
 * - 绝对路径（`E:\work\demo`、`E:/DE`）→ 列它下面的子目录；
 * - 纯盘符（`E:`）→ 归一成 `E:\` 再列（手机手输常用）；
 * - 根（`/`、`\`，仅 Windows）→ **回盘符列表**（`C:\`、`D:\`、`E:\`…）。
 *
 * 另外：站在某个盘根时（`parent === ''`）也会把**其它盘符**一并塞进 entries，
 * 否则用户从主目录退到 `C:\` 就再也出不去（盘根没有上级目录）。
 *
 * @param input - 请求的路径；缺省用主目录。
 * @returns `{ path, home, parent, entries }`。
 */
function listDirectory(input) {
	const home = homedir();
	let target = input === undefined || input === '' ? home : String(input).trim();
	if (target === '') target = home;
	// 纯盘符（`E:`）补成 `E:\`：`isAbsolute('E:')` 是 **false**（缺分隔符），
	// 而手机端手输路径时很自然会只打一个 `E:`，这里补一下比让用户重打好。
	if (/^[A-Za-z]:$/.test(target)) target = `${target}\\`;
	// 「根」语义：显式要根时直接回盘符列表（Windows），不给一个假的当前盘根。
	// 手机端「盘符行」就是吃这一份 entries。
	if (process.platform === 'win32' && WIN_ROOT_INPUTS.has(target)) {
		return {
			path: '',
			home,
			parent: '',
			entries: listDrives().map((drive) => ({ name: drive, path: drive, isDirectory: true, enterable: true })),
		};
	}
	if (!isAbsolute(target)) throw new Error('path must be absolute');
	const abs = resolve(target);
	assertListable(abs);
	const entries = [];
	for (const entry of readdirSync(abs, { withFileTypes: true })) {
		let isDir = entry.isDirectory();
		if (entry.isSymbolicLink()) {
			try {
				isDir = statSync(join(abs, entry.name)).isDirectory();
			} catch {
				continue; // 断链：跳过
			}
		}
		if (!isDir) continue;
		entries.push({ name: entry.name, path: join(abs, entry.name), isDirectory: true, enterable: true });
	}
	entries.sort((a, b) => a.name.localeCompare(b.name));
	// ⚠️ 用 dirname 而不是切字符串：手切 `C:\Users` 会得到 `C:`，
	// 而 win32 下 `isAbsolute('C:') === false` ⇒ 点「上一级」直接报错。
	// dirname('C:\Users') = 'C:\'，dirname('C:\') = 'C:\'（等于自身 ⇒ 到顶了）。
	const up = dirname(abs);
	const parent = up === abs ? '' : up;
	// 站在驱动器根上（parent 为空）时，把其它盘符一并列出来当出口。
	if (parent === '') {
		const current = abs.replace(/[\\/]+$/, '').toLowerCase();
		const drives = listDrives()
			.filter((drive) => drive.replace(/[\\/]+$/, '').toLowerCase() !== current)
			.map((drive) => ({ name: drive, path: drive, isDirectory: true, enterable: true }));
		entries.unshift(...drives);
	}
	return {
		path: abs,
		home,
		parent,
		entries,
	};
}

/**
 * 解析出真实路径，**尽量**返回有意义的答案。
 *
 * ⚠️ **不能只对整条路径调 `realpathSync`**：手机读一个**还不存在**的文件时
 * 也没问题（`fileStat` 探存在性是正常用法），那时 `realpathSync` 会抛，
 * 于是「判据」就退化成比字面路径 —— junction 一穿就过。
 *
 * 做法：**从路径本身向上找最长的一段「已存在」的祖先**，对它 realpath，
 * 再把剩下那段（不存在的）拼回去。这样即使叶子还不存在，中间任何一段
 * 是 junction 也会被解析出来。
 *
 * 全程失败才退回原值（那时路径压根不可达，官方自己也会报 ENOENT）。
 *
 * @param value - 绝对路径。
 * @returns 解析后的路径。
 */
function realpathBestEffort(value) {
	let current = resolve(value);
	const tail = [];
	// ⚠️ 上限只是防御性的死循环保险：正常 Windows 路径不会这么深。
	for (let depth = 0; depth < 64; depth += 1) {
		try {
			const real = realpathSync(current);
			return tail.length === 0 ? real : join(real, ...tail.reverse());
		} catch {
			const parent = dirname(current);
			// 到根了（`dirname('C:\\') === 'C:\\'`），没有可解析的前缀。
			if (parent === current) return resolve(value);
			tail.push(basename(current));
			current = parent;
		}
	}
	return resolve(value);
}

/**
 * 判 `absolute` 是否落在 `root` 之内（含 root 自身）。
 *
 * ⚠️ **不能用 `absolute.startsWith(root)`**：假根 `C:\Users\<user>\ws-evil` 也以
 * `C:\Users\<user>\ws` 开头，字符串前缀会把兄弟目录误判成区内。必须比到**分隔符**。
 * ⚠️ **win32 大小写不敏感**：`c:\users\...` 与 `C:\Users\...` 是同一个目录，
 * 不折叠大小写会把合法路径误判成越界。posix 下折叠是无害的（本来就全小写）。
 */
function isInside(root, absolute) {
	const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
	const base = norm(resolve(root));
	const target = norm(resolve(absolute));
	if (target === base) return true;
	const prefix = base.endsWith(sep) ? base : base + sep;
	return target.startsWith(prefix);
}

/**
 * 按绝对路径拿到（必要时**创建**）电脑上的 Workspace，返回它的 id。
 *
 * ## 为什么必须这么做（用户需求二原文：「电脑侧边栏要显示在对应工作区下」）
 *
 * 官方 `SessionCommandController.create()` 有两条互斥入参
 * （`dsh-api-session-controller/lib/index.js:572`）：
 *
 * ```js
 * if (request.workspaceId !== void 0 && request.cwd !== void 0)
 *   throw new RemoteError("gateway/bad-request", "session.create accepts workspaceId or cwd, not both");
 * ```
 *
 * 而**只有** `workspaceId` 那条分支会走到 `workspace.attachSession(sessionId)`
 * （:586-593）。换句话说：
 *
 * | 传参 | 会话落在电脑 DSH 的哪一栏 |
 * |---|---|
 * | `{ cwd }` | **「未分组」**（session 建出来了，但没挂到任何 workspace 下） |
 * | `{ workspaceId }` | 该 workspace 下 ✅ |
 *
 * 这正是「手机发的消息全堆在未分组」的根因 —— 本插件此前一直只传 `cwd`。
 *
 * ## 为什么不直接用 `resolveByPath`（它会返回 undefined）
 *
 * `resolveByPath`（`dsh-workspace/lib/types/index.js:260`）只查**已有**的
 * workspace，用户手机里选的文件夹很可能在电脑 DSH 里从没被加过工作区。
 * 所以先 `resolveByPath` 命中就复用，没命中就 `create(path)` ——
 * `create` 自己也是幂等的（`createCanonical` 先按 canonical 路径查一遍，:269-272）。
 *
 * ⚠️ **`create` 要求路径已存在且是目录**，否则抛
 * `cannot create a workspace at '…': path is not a directory`。
 * 手机传来的目录是刚列出来的，正常都在；真不在了就该报错而不是静默降级。
 *
 * @param ctx - host context（需要 `workspaceRegistry`）。
 * @param cwd - 电脑上的绝对目录路径。
 * @returns workspace id。
 */
async function ensureWorkspaceId(ctx, cwd) {
	const registry = ctx.workspaceRegistry;
	if (registry === undefined) throw new Error('workspaceRegistry 不可用');
	const existing = await registry.resolveByPath(cwd);
	if (existing !== undefined) return existing.id;
	// ⚠️ **限额只拦「新建」，命中已有工作区的路径不受影响** ——
	// 老客户端重发同一条请求、用户反复进同一个文件夹，都必须照常放行。
	// 只有「这台机器上从没有过、现在要凭空造一个」才算一次创建。
	//
	// ⚠️ 计数器是**进程内**的（插件热重载会清零）。这够用：它防的是
	// 「一个循环脚本在几分钟内刷出几十个」这种模式，不是长期配额。
	const now = Date.now();
	while (workspaceCreateStamps.length > 0 && now - workspaceCreateStamps[0] > WORKSPACE_CREATE_WINDOW_MS) {
		workspaceCreateStamps.shift();
	}
	if (workspaceCreateStamps.length >= WORKSPACE_CREATE_LIMIT) {
		throw new Error(
			`一小时内新建工作区已达上限（${WORKSPACE_CREATE_LIMIT} 个），为防止误建已拒绝。「${cwd}」` +
				'如果确实要加，请在电脑上手动把它添加为工作区。',
		);
	}
	workspaceCreateStamps.push(now);
	const created = await registry.create(cwd);
	return created.id;
}

/**
 * 把会话补挂到「`path === cwd`」的工作区上（手机建会话 → 电脑侧边栏可见）。
 *
 * ## 为什么 `ensureWorkspaceId` + `controller.create({workspaceId})` 还不够
 *
 * 那两步只保证**建会话的那一刻**带上了 workspaceId。而界面侧边栏真正读的是
 * 工作区实体自己的持久化账本 `sessionIds`（`$DSH_HOME/storages/workspace.json`
 * 的 `sessionIds`，见 `@deepseek-ai/dsh-workspace/lib/index.js:246`）——
 * 两份数据一旦没同步，手机新建的会话在电脑界面里就「消失」了（用户报的问题）。
 *
 * 官方契约（`@deepseek-ai/dsh-workspace/lib/types/entity.js:58`
 * `attachSession()`）：
 *   - 挂载前会读会话 header，要求 `realpathNormalize(header.cwd) === 工作区 path`；
 *   - 不等就**抛错**（`its cwd resolves to '…'`），所以这里只找归一后相等的那一个；
 *   - 重复挂载是幂等的（`includes` 判断后直接返回）。
 *
 * ## 为什么全程 best-effort、不抛
 *
 * 会话此刻**已经建好了**，挂载只影响「它在侧边栏哪个分组下」。
 * 找不到工作区（用户还没在电脑上加过这个目录）、注册表未就绪、
 * 挂载被官方拒（路径刚被删 / 不是目录），都不该让「建会话」整个失败 ——
 * 只记一行诊断日志，跳过。
 *
 * @param ctx - host context（需要 `workspaceRegistry`）。
 * @param sessionId - 要挂的会话 id。
 * @param cwd - 该会话在电脑上的工作目录。
 */
async function attachSessionToWorkspace(ctx, sessionId, cwd) {
	try {
		const workspaces = ctx.workspaceRegistry?.list?.();
		if (!Array.isArray(workspaces)) return;
		const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
		// 两边都做 realpath 归一：手机传来的是记忆里的路径，电脑上同一目录可能
		// 经符号链接 / 短路径名 / 大小写变体到达（与 `listWorkspaceSessions` 同口径）。
		const want = norm(realpathBestEffort(cwd));
		const entity = workspaces.find(
			(workspace) => typeof workspace?.path === 'string' && norm(realpathBestEffort(workspace.path)) === want,
		);
		if (entity === undefined) return;
		if (typeof entity.attachSession !== 'function') return;
		await entity.attachSession(sessionId);
	} catch (error) {
		// `debugLog` 自己吞所有异常（见其 docstring），这里绝不 rethrow。
		await debugLog(
			`attachSessionToWorkspace ${sessionId} @ ${cwd} 跳过：${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

/**
 * 把手机传来的「工作区相对路径」变成电脑上能直接喂给官方 `workspaceFiles` 的路径，
 * **并把它锁死在会话工作区内**。
 *
 * ⚠️ **两端各算各的**：手机只知道它那边的镜像目录（一个以电脑路径为名的空壳），
 * 它传进来的是**相对于工作区**的一段路径（根目录是空串，posix 分隔符）。
 * 真正的绝对路径由本机拼 —— 本机用什么盘符、什么分隔符只有本机知道，
 * 让手机去拼 `C:\…` 必然出错（见文件头「cwd 绝不跨端传」）。
 *
 * ⚠️⚠️ **官方 `workspaceFiles` 自己【不】做围栏 —— 这里是唯一的防线（实测）**。
 * 它内部只是 `resolve(cwd, path)` 然后干活，`..` 和绝对路径**都能穿出去**。
 * 公网实测（1.0.14，令牌鉴权通过后）：
 *
 *   fileStat  { path: 'C:\\Windows\\win.ini' }                    → ok=true，92 字节
 *   fileReadBytes { path: '..\\..\\..\\..\\..\\..\\Windows\\win.ini' } → ok=true，
 *        data 解出 `; for 16-bit app support`
 *   fileStat  { path: '..\\..\\..\\..\\..\\..\\Users\\<user>\\.dsh\\dsh-remote\\pair.json' }
 *        → ok=true，504 字节 —— **连自己的访问令牌都能被读走**
 *
 * 所以「手机只能看会话工作区」这件事**必须在本函数里保证**，不能指望官方兜底。
 * 不修的后果不是「能列目录」（那是有意为之，见 `listDirectory`），而是
 * **能读走任意文件**，包括令牌文件本身。
 *
 * 对越界的处理是**抛错**而不是「夹回工作区」：静默改写路径会让手机端看到一个
 * 它没请求的文件，把安全事件伪装成正常结果。
 *
 * ⚠️ **返回值保持「相对路径透传」，不要改成绝对路径**：官方 `list()` 拿到相对路径
 * 会自己按 `cwd: workspaceRoot` 解析，而它的 `path` 字段回显的是**相对路径**
 * （手机端 `mapPath` 就是按这个回显做剥前缀匹配的，见 `_test/file-tree.mjs` ⑧）。
 * 这里若换成绝对路径，手机端的前缀匹配会失配 ⇒ 侧边栏根目录空掉。
 * 所以本函数只**校验**，不改写。
 *
 * @param scope - 官方 `workspaceFileScope`（`{sessionId, workspaceRoot}`）。
 * @param path - 手机传来的**工作区相对**路径（posix 分隔符，根目录为空串）。
 * @returns 校验通过的路径，原样透传给官方；根目录换成 `workspaceRoot`。
 */
function resolveWorkspacePath(scope, path) {
	const root = scope.workspaceRoot;
	// 根目录：官方 `inspect()` 拿 `path.length === 0` 会判 `path is required`，
	// 所以这里必须换成根路径本身（不是空串）。
	if (typeof path !== 'string' || path === '' || path === '.') return root;
	// ⚠️ 绝对路径一律拒绝。手机端只需要相对路径，它也没有理由发绝对路径；
	// 放行绝对路径就等于把上面那个 `C:\Windows\win.ini` 的读法重新打开。
	if (isAbsolute(path)) {
		throw new Error('路径必须是工作区内的相对路径');
	}
	// ⚠️ 用 resolve 只做**判据**，返回的仍是原始 `path`（见 docstring）。
	if (!isInside(root, resolve(root, path))) {
		throw new Error('路径越出了会话工作区');
	}
	// ⚠️⚠️ **文本判据不够**（外部审计 D2）：工作区内只要有一个指向区外的
	// junction / 符号链接，`esc\pair.json` 在文本上就落在工作区里，而
	// `resolve` 不会解析链接 —— 上面那道检查形同虚设。
	// Windows 上普通用户即可 `mklink /J`，pnpm 等工具本来就会造链接；
	// 持有令牌的人还能先 `prompt` agent 在工作区内建一个。
	// 所以**再按真实路径判一次**（解析链接后的位置必须仍在工作区内）。
	if (!isInside(realpathBestEffort(root), realpathBestEffort(resolve(root, path)))) {
		throw new Error('路径经符号链接指向了工作区之外');
	}
	return path;
}

/**
 * 不中断的取消信号。
 *
 * ⚠️ 官方 `workspaceFiles` 的每个方法都要求一个 `signal`（内部会交给 fs 后端）。
 * 本插件的 RPC 没有取消通道（中继那边一问一答），所以给一个**永不 abort** 的
 * 信号 —— 传 `undefined` 在部分后端上会直接抛。
 */
function idleSignal() {
	return new AbortController().signal;
}

/** 取官方的 `workspaceFiles` 服务；没就绪时给一句能看懂的错。 */
function workspaceFilesOf(ctx) {
	const files = ctx.get?.('workspaceFiles');
	if (files === undefined || typeof files.list !== 'function') {
		throw new Error('workspaceFiles 不可用（引擎还没就绪？）');
	}
	return files;
}

/**
 * 按 sessionId 拼出官方要的 `workspaceFileScope`（`{sessionId, workspaceRoot}`）。
 *
 * ⚠️ **照抄官方 `dsh-api-workspace-files` 里那个 lookup 的取法**：活会话读
 * `sessions.get(id).header`，已归档的会话退回 `sessionPersistence.stat(id).header`。
 * 只读活会话的话，手机去列一个电脑上「已落盘但当前没跑」的会话就报「工作区不存在」。
 *
 * ## ⚠️ 这里也必须过围栏（外部审计第 5 条）
 *
 * `assertWorkspaceAllowed` 原本**只在建会话时**判（`createSession`），
 * 而本函数读的是**已存在会话**的 cwd —— 于是电脑上任何**先前**以
 * `$DSH_HOME`（或其祖先）为工作区建的会话，手机端只要知道 sessionId
 * 就能直接 `fileList`/`fileRead`/`fileStat`，**永远不经过围栏**。
 *
 * 为什么这是真问题而不是理论问题：官方 `workspaceFiles.read/stat/readBytes`
 * 对工作区外的路径**本来就是放行的**（它内部只是 `resolve(cwd, path)`），
 * 所以 `resolveWorkspacePath` 是唯一防线，而它的界就是这里给的
 * `workspaceRoot`。若这个 root 本身就是 `$DSH_HOME`，那道防线等于画在
 * `$DSH_HOME` 上 —— `.dsh\dsh-remote\pair.json`（含 `accessToken`）就在界内。
 *
 * 所以这里**同样**要求 cwd 通过围栏。合法的普通目录不受任何影响。
 *
 * @param ctx - Cordis 上下文。
 * @param sessionId - 会话 id。
 * @returns 官方的 `workspaceFileScope`。
 */
async function workspaceScopeOf(ctx, sessionId) {
	if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
	const live = ctx.sessions?.get?.(sessionId)?.header;
	let stored;
	if (live === undefined) {
		const persistence = ctx.get?.('sessionPersistence');
		if (typeof persistence?.stat === 'function') {
			stored = await persistence.stat(sessionId).catch(() => undefined);
		}
	}
	const cwd = (live ?? stored?.header)?.cwd;
	if (typeof cwd !== 'string' || cwd === '') {
		throw new Error(`电脑上没有会话 ${sessionId} 的工作目录`);
	}
	// ⚠️ 读已有会话也要过围栏（见 docstring）。
	assertWorkspaceAllowed(cwd);
	return { sessionId, workspaceRoot: cwd };
}

/**
 * 「默认设置」里三个可写字段的名字，也是 `settingsSet` 回传 `applied` 的取值。
 *
 * 顺序即写入顺序：先模型，再默认预设，最后默认权限预设。
 */
const DEFAULT_SETTING_FIELDS = ['model', 'presetId', 'permissionPreset'];

/**
 * 「默认预设」所在的 settings 命名空间（profile 条目 id）。
 *
 * 官方前端写同一个字段用的常量是 `"agent-preset-registry"`
 *（`dsh-client-ui-agent-preset/lib/client.js:1082` 的 `AGENT_PRESET_SETTINGS_NS`），
 * 而条目 id 在 `dsh-web-app/cordis.patch.yml:591` 就是这个名字 —— 两处对得上，
 * 所以这里写死而不是去猜。
 */
const AGENT_PRESET_SETTINGS_NS = 'agent-preset-registry';

/**
 * 「默认权限预设」所在的 settings 命名空间。
 *
 * 同上：官方前端 `dsh-client-ui-permission-presets/lib/client.js:561`
 *（`PERMISSION_SETTINGS_NS`），条目 id 见 `dsh-base/cordis.patch.yml:264`。
 */
const PERMISSION_SETTINGS_NS = 'permission';

/**
 * 默认模型的 settings 命名空间。
 *
 * ⚠️ 本文件**不**用它写模型：模型有一条更直接的官方方法
 * `agentDefaultModel.saveSelection()`（见 `case 'settingsSet'`）。这里保留常量
 * 只给 `settingsGet` 的兜底读用，免得两处字符串各写各的。
 */
const AGENT_DEFAULT_MODEL_SETTINGS_NS = 'agent-default-model';

/**
 * 取官方 `settings` 服务（设置页的写入通路）。
 *
 * 官方契约（`@deepseek-ai/dsh-settings`，`lib/types/index.js:184-404`）：
 * `describe()` 给每个活动条目的脱敏描述符（含 `ns` / `revision` / `value`），
 * `update(ns, patch, expectedRevision)` / `mutate(ns, ops, expectedRevision)`
 * 只改**volatile** 字段并落进 profile 的 cordis patch。
 *
 * 不在 `inject` 里也能读：与 `sessionProjections` 同理走 `ctx.get`。
 *
 * @returns settings 服务，或 undefined（没挂设置页 / 引擎没就绪）。
 */
function settingsOf(ctx) {
	const settings = ctx.get?.('settings');
	if (settings === undefined || settings === null) return undefined;
	if (typeof settings.describe !== 'function') return undefined;
	return settings;
}

/**
 * 从 `settings.describe()` 里取某个命名空间那一行。
 *
 * `describe()` 是同步的、返回数组；任一环节不靠谱都返回 undefined，**不抛** ——
 * 调用方要么给它兜底，要么把它当「这个字段读不到」。
 *
 * @param settings - `settingsOf()` 的结果。
 * @param ns - profile 条目 id。
 * @returns 描述符 `{ns, revision, value, ...}`，或 undefined。
 */
function settingsRowOf(settings, ns) {
	if (settings === undefined) return undefined;
	try {
		const rows = settings.describe();
		if (!Array.isArray(rows)) return undefined;
		return rows.find((row) => row?.ns === ns);
	} catch (error) {
		void debugLog(`settings.describe 失败: ${String(error?.message ?? error)}`);
		return undefined;
	}
}

/**
 * 默认模型选择形状检查。
 *
 * @param value - 手机传来的 `model`。
 * @returns 问题描述；合法时 undefined。
 */
function modelSelectionProblem(value) {
	if (value === null || typeof value !== 'object' || Array.isArray(value)) {
		return 'model 必须是 { provider, model } 对象';
	}
	if (typeof value.provider !== 'string' || value.provider === '') return 'model.provider 必须是非空字符串';
	if (typeof value.model !== 'string' || value.model === '') return 'model.model 必须是非空字符串';
	if (
		value.reasoningEffort !== undefined &&
		value.reasoningEffort !== null &&
		typeof value.reasoningEffort !== 'string'
	) {
		return 'model.reasoningEffort 必须是字符串';
	}
	return undefined;
}

/**
 * 判一个模型选择在不在**官方可路由目录**里。
 *
 * 官方 `saveSelection()` 明确「不验证目录成员资格」（`dsh-agent-default-model/
 * README.zh.md:57`），所以校验必须由调用方做 —— 官方自己也是在
 * `selectModel` / `initializeDefaultModel` 里先过 `buildModelCatalog()` 再保存
 *（`dsh-api-session-controller/lib/types/index.js:379-386`）。
 * 本插件不引那个包，改用同源入口 `controller.modelCatalog()`
 *（它内部就是 `buildModelCatalog(ctx)`，同文件 `:392-394`），形状是
 * `{default, routableProviders, groups:[{id, models:[{id, reasoning?}]}], failures}`。
 *
 * @param controller - `ctx.sessionController`。
 * @param selection - 已过形状检查的选择。
 * @returns 问题描述；可用时 undefined。
 */
async function modelSelectionProblemOrUndefined(controller, selection) {
	if (typeof controller?.modelCatalog !== 'function') return 'modelCatalog 不可用（引擎还没就绪？）';
	let catalog;
	try {
		catalog = await controller.modelCatalog();
	} catch (error) {
		return `读取模型目录失败：${String(error?.message ?? error)}`;
	}
	const groups = Array.isArray(catalog?.groups) ? catalog.groups : [];
	const group = groups.find((row) => row?.id === selection.provider);
	if (group === undefined) {
		const providers = groups
			.map((row) => row?.id)
			.filter((id) => typeof id === 'string' && id !== '')
			.join(', ');
		return `未知提供方 "${selection.provider}"${providers === '' ? '' : `（可用：${providers}）`}`;
	}
	const models = Array.isArray(group.models) ? group.models : [];
	const entry = models.find((row) => row?.id === selection.model);
	if (entry === undefined) {
		const names = models
			.map((row) => row?.id)
			.filter((id) => typeof id === 'string' && id !== '')
			.join(', ');
		return `提供方 ${selection.provider} 下没有模型 "${selection.model}"${names === '' ? '' : `（可用：${names}）`}`;
	}
	// 模型声明了 reasoning efforts 时，挡位必须是其中之一；没声明就放行
	//（有的模型不支持思考挡位，传了也会被 provider 忽略，不值得在这里判死）。
	const efforts = Array.isArray(entry.reasoning?.efforts) ? entry.reasoning.efforts : [];
	if (
		typeof selection.reasoningEffort === 'string' &&
		selection.reasoningEffort !== '' &&
		efforts.length > 0 &&
		!efforts.some((effort) => effort?.id === selection.reasoningEffort)
	) {
		const ids = efforts.map((effort) => effort?.id).filter((id) => typeof id === 'string' && id !== '').join(', ');
		return `模型 ${selection.model} 不支持 reasoningEffort "${selection.reasoningEffort}"（可用：${ids}）`;
	}
	return undefined;
}

/**
 * 判一个默认 agent 预设是否存在且当前可用。
 *
 * 白名单用官方 `agentPresets.list()`（`dsh-agent-preset-registry/lib/index.js:570-581`），
 * 它返回 `{id, name?, description?, order?, broken?}`。`broken` 非空说明这套组合
 * 现在加载不起来 —— 存成默认只会让**以后新建的会话**直接坏掉，所以一并拒绝。
 *
 * @param ctx - Cordis 上下文。
 * @param presetId - 手机传来的预设 id。
 * @returns 问题描述；可用时 undefined。
 */
async function presetProblemOrUndefined(ctx, presetId) {
	const presets = ctx.get?.('agentPresets');
	if (presets === undefined || presets === null || typeof presets.list !== 'function') {
		return 'agentPresets 不可用（引擎还没就绪？）';
	}
	let rows;
	try {
		rows = await presets.list();
	} catch (error) {
		return `读取预设列表失败：${String(error?.message ?? error)}`;
	}
	const list = Array.isArray(rows) ? rows : [];
	const ids = list.map((row) => row?.id).filter((id) => typeof id === 'string' && id !== '');
	if (!ids.includes(presetId)) {
		return `未知预设 "${presetId}"（可用：${ids.length === 0 ? '无' : ids.join(', ')}）`;
	}
	const row = list.find((item) => item?.id === presetId);
	if (typeof row?.broken === 'string' && row.broken !== '') {
		return `预设 "${presetId}" 当前加载失败：${row.broken}`;
	}
	return undefined;
}

/**
 * 判一个默认权限预设是否可配。
 *
 * 白名单用 `permissionPresets.catalog().defaultOptions` 的 `value`
 *（官方前端 `permissionDefaultOf()` 用的正是这个清单，
 * `dsh-client-ui-permission-presets/lib/client.js:567-577`）。
 * **不能用 `catalog().options`**：它多出的 `auto` 是「运行中自动放行」的活挡位，
 * 官方把它排除在 `defaultOptions` 之外；`custom` 是派生状态，根本不是可选目标。
 *
 * @param ctx - Cordis 上下文。
 * @param name - 手机传来的权限预设名。
 * @returns 问题描述；可用时 undefined。
 */
function permissionProblemOrUndefined(ctx, name) {
	const presets = ctx.get?.('permissionPresets');
	if (presets === undefined || presets === null) return 'permissionPresets 不可用（引擎还没就绪？）';
	let ids;
	try {
		const catalog = typeof presets.catalog === 'function' ? presets.catalog() : undefined;
		ids = Array.isArray(catalog?.defaultOptions)
			? catalog.defaultOptions.map((option) => option?.value).filter((value) => typeof value === 'string' && value !== '')
			: undefined;
	} catch (error) {
		return `读取权限预设失败：${String(error?.message ?? error)}`;
	}
	// 老版本没有 `defaultOptions` 时退回 `names`（至少能挡住拼错的名字）。
	if (ids === undefined) ids = Array.isArray(presets.names) ? presets.names : [];
	if (!ids.includes(name)) {
		return `未知权限预设 "${name}"（可用：${ids.length === 0 ? '无' : ids.join(', ')}）`;
	}
	return undefined;
}

/**
 * 读电脑端「默认设置」三件套（`settingsGet` 的实现）。
 *
 * ## 每个字段读哪条官方通路
 *
 * - **默认模型** → `agentDefaultModel.currentSelection()`
 *   （`dsh-agent-default-model/lib/index.js:38-45`；README.zh.md:50 就是这条读法）。
 * - **默认预设** → `agentPresets.defaultId`
 *   （`dsh-agent-preset-registry/lib/index.js:463` = `selectedDefault ?? default`，
 *   正是「新会话用哪个预设」的解析结果）。
 * - **默认权限预设** → `permissionPresets.defaultPreset`
 *   （`dsh-permission-presets/lib/index.js:274`）。
 *
 * 三条读的都是**当前生效值**（组合 + profile 覆盖层），比读原始 patch 更准。
 * 服务没就绪时按约定给 null（`settingsGet` 是只读展示通道，**不抛**）。
 *
 * 兜底：上面任一条拿不到时，再试 `settings.describe()` 里对应命名空间的
 * `value`（官方设置页的数据源，同一份生效值），仍拿不到才给 null。
 *
 * @param ctx - Cordis 上下文。
 * @returns `{model: {provider, model, reasoningEffort?} | null, presetId: string | null, permissionPreset: string | null}`。
 */
function readDefaultSettings(ctx) {
	const out = { model: null, presetId: null, permissionPreset: null };
	// ① 默认模型。
	try {
		const selection = ctx.get?.('agentDefaultModel')?.currentSelection?.();
		if (
			typeof selection?.provider === 'string' &&
			selection.provider !== '' &&
			typeof selection.model === 'string' &&
			selection.model !== ''
		) {
			out.model = { provider: selection.provider, model: selection.model };
			if (typeof selection.reasoningEffort === 'string' && selection.reasoningEffort !== '') {
				out.model.reasoningEffort = selection.reasoningEffort;
			}
		}
	} catch (error) {
		void debugLog(`settingsGet 读默认模型失败: ${String(error?.message ?? error)}`);
	}
	// ② 默认 agent 预设。
	try {
		const id = ctx.get?.('agentPresets')?.defaultId;
		if (typeof id === 'string' && id !== '') out.presetId = id;
	} catch (error) {
		void debugLog(`settingsGet 读默认预设失败: ${String(error?.message ?? error)}`);
	}
	// ③ 默认权限预设。
	try {
		const name = ctx.get?.('permissionPresets')?.defaultPreset;
		if (typeof name === 'string' && name !== '') out.permissionPreset = name;
	} catch (error) {
		void debugLog(`settingsGet 读默认权限预设失败: ${String(error?.message ?? error)}`);
	}
	// ④ 兜底：缺哪块就翻 settings.describe()（官方设置页的同一份生效值）。
	if (out.model === null || out.presetId === null || out.permissionPreset === null) {
		const settings = settingsOf(ctx);
		if (out.model === null) {
			const value = settingsRowOf(settings, AGENT_DEFAULT_MODEL_SETTINGS_NS)?.value;
			if (typeof value?.provider === 'string' && value.provider !== '' && typeof value?.model === 'string' && value.model !== '') {
				out.model = { provider: value.provider, model: value.model };
				if (typeof value.reasoningEffort === 'string' && value.reasoningEffort !== '') {
					out.model.reasoningEffort = value.reasoningEffort;
				}
			}
		}
		if (out.presetId === null) {
			const value = settingsRowOf(settings, AGENT_PRESET_SETTINGS_NS)?.value;
			if (typeof value?.selectedDefault === 'string' && value.selectedDefault !== '') out.presetId = value.selectedDefault;
		}
		if (out.permissionPreset === null) {
			const value = settingsRowOf(settings, PERMISSION_SETTINGS_NS)?.value;
			if (typeof value?.defaultPreset === 'string' && value.defaultPreset !== '') out.permissionPreset = value.defaultPreset;
		}
	}
	return out;
}

/**
 * 改电脑端「默认设置」（`settingsSet` 的实现）——**只改传进来的字段**。
 *
 * ## 走哪条官方写入通路（按装着的 0.2.1-rc.3 实装核实）
 *
 * - **默认模型** → `agentDefaultModel.saveSelection({provider, model, reasoningEffort?})`
 *   （`dsh-agent-default-model/lib/index.js:53-66`，README.zh.md:50）。
 *   它内部走 `configEditor.edit(entry, …)` 落 profile —— 就是官方给「新 agent 用哪个
 *   模型」准备的写入方法，不自己拼 settings 补丁。
 *   ⚠️ 它保存的是**完整选择**：不带 `reasoningEffort` 会把该字段从覆盖层删掉
 *   （README.zh.md:46），所以下面显式沿用当前值，保证「只改传进来的字段」。
 * - **默认预设** → `settings.update('agent-preset-registry', {selectedDefault: id}, revision)`
 *   （官方前端 `writeDefaultPreset()`，`dsh-client-ui-agent-preset/lib/client.js:1094-1097`）。
 * - **默认权限预设** → `settings.mutate('permission', [{op:'set', path:['defaultPreset'], value}], revision)`
 *   （官方前端 `select()`，`dsh-client-ui-permission-presets/lib/client.js:652-656`）。
 *
 * `revision` 取 `settings.describe()` 现读的那一行 —— 官方用同一个乐观锁
 *（`dsh-settings/lib/types/index.js:358-364`，过期写入抛 `SettingsConflictError`），
 * 这里跟着用，避免覆盖电脑上刚发生的改动。
 *
 * ## 返回（业务错不抛）
 *
 * 成功 `{ok:true, applied:[...]}`；**先校验全部再写**，任一非法 ⇒ 一个字都不写、
 * `{ok:false, reason}`；写成功后再回读一遍，读回来的值对不上同样报 `ok:false`
 *（官方 `saveSelection()` 在没有 configEditor 时会**静默不写**，`:55-56`）。
 *
 * @param ctx - Cordis 上下文。
 * @param params - `{model?, presetId?, permissionPreset?}`。
 * @returns `{ok:true, applied}` 或 `{ok:false, reason, applied?}`。
 */
async function writeDefaultSettings(ctx, params) {
	/** 已成功写下的字段（失败时也回传，手机端能说清「改到一半」）。 */
	const applied = [];
	try {
		const input = params ?? {};
		// 只认非空值：undefined / null 一律当「没传这个字段」。
		const wanted = {};
		for (const field of DEFAULT_SETTING_FIELDS) {
			const value = input[field];
			if (value !== undefined && value !== null) wanted[field] = value;
		}
		const fields = DEFAULT_SETTING_FIELDS.filter((field) => wanted[field] !== undefined);
		if (fields.length === 0) return { ok: false, reason: '至少要传 model / presetId / permissionPreset 之一' };

		// ── 第一段：全部校验，任一处不过就一个字都不写 ──
		if (wanted.model !== undefined) {
			const problem = modelSelectionProblem(wanted.model);
			if (problem !== undefined) return { ok: false, reason: problem };
			const unavailable = await modelSelectionProblemOrUndefined(ctx.sessionController, wanted.model);
			if (unavailable !== undefined) return { ok: false, reason: unavailable };
		}
		if (wanted.presetId !== undefined) {
			if (typeof wanted.presetId !== 'string' || wanted.presetId === '') {
				return { ok: false, reason: 'presetId 必须是非空字符串' };
			}
			const problem = await presetProblemOrUndefined(ctx, wanted.presetId);
			if (problem !== undefined) return { ok: false, reason: problem };
		}
		if (wanted.permissionPreset !== undefined) {
			if (typeof wanted.permissionPreset !== 'string' || wanted.permissionPreset === '') {
				return { ok: false, reason: 'permissionPreset 必须是非空字符串' };
			}
			const problem = permissionProblemOrUndefined(ctx, wanted.permissionPreset);
			if (problem !== undefined) return { ok: false, reason: problem };
		}

		// ── 第二段：按固定顺序写 ──
		if (wanted.model !== undefined) {
			const service = ctx.get?.('agentDefaultModel');
			if (service === undefined || service === null || typeof service.saveSelection !== 'function') {
				return { ok: false, reason: 'agentDefaultModel 不可用（引擎还没就绪？）', applied };
			}
			let current;
			try {
				current = service.currentSelection?.();
			} catch (error) {
				void debugLog(`settingsSet 读当前默认模型失败: ${String(error?.message ?? error)}`);
			}
			// 未指定挡位时沿用当前值（见 docstring：不带会把字段删掉）。
			const carried =
				typeof wanted.model.reasoningEffort === 'string' && wanted.model.reasoningEffort !== ''
					? wanted.model.reasoningEffort
					: typeof current?.reasoningEffort === 'string' && current.reasoningEffort !== ''
						? current.reasoningEffort
						: undefined;
			const next = {
				provider: wanted.model.provider,
				model: wanted.model.model,
				...(carried === undefined ? {} : { reasoningEffort: carried }),
			};
			try {
				await service.saveSelection(next);
			} catch (error) {
				return { ok: false, reason: String(error?.message ?? error), applied };
			}
			applied.push('model');
		}

		if (wanted.presetId !== undefined) {
			const settings = settingsOf(ctx);
			const row = settingsRowOf(settings, AGENT_PRESET_SETTINGS_NS);
			if (row === undefined) {
				return { ok: false, reason: `settings 里找不到命名空间 "${AGENT_PRESET_SETTINGS_NS}"（设置页没挂？）`, applied };
			}
			if (typeof settings.update !== 'function') {
				return { ok: false, reason: 'settings.update 不可用（引擎版本不支持）', applied };
			}
			try {
				await settings.update(AGENT_PRESET_SETTINGS_NS, { selectedDefault: wanted.presetId }, row.revision);
			} catch (error) {
				return { ok: false, reason: String(error?.message ?? error), applied };
			}
			applied.push('presetId');
		}

		if (wanted.permissionPreset !== undefined) {
			const settings = settingsOf(ctx);
			const row = settingsRowOf(settings, PERMISSION_SETTINGS_NS);
			if (row === undefined) {
				return { ok: false, reason: `settings 里找不到命名空间 "${PERMISSION_SETTINGS_NS}"（设置页没挂？）`, applied };
			}
			if (typeof settings.mutate !== 'function') {
				return { ok: false, reason: 'settings.mutate 不可用（引擎版本不支持）', applied };
			}
			try {
				await settings.mutate(
					PERMISSION_SETTINGS_NS,
					[{ op: 'set', path: ['defaultPreset'], value: wanted.permissionPreset }],
					row.revision,
				);
			} catch (error) {
				return { ok: false, reason: String(error?.message ?? error), applied };
			}
			applied.push('permissionPreset');
		}

		// ── 第三段：回读校验（挡住「写了个寂寞」的静默成功） ──
		const after = readDefaultSettings(ctx);
		const mismatch = [];
		for (const field of applied) {
			if (field === 'model') {
				if (after.model?.provider !== wanted.model.provider || after.model?.model !== wanted.model.model) {
					mismatch.push('model');
				}
			} else if (field === 'presetId') {
				if (after.presetId !== wanted.presetId) mismatch.push('presetId');
			} else if (field === 'permissionPreset') {
				if (after.permissionPreset !== wanted.permissionPreset) mismatch.push('permissionPreset');
			}
		}
		if (mismatch.length > 0) {
			return { ok: false, reason: `写入没有落到电脑端当前设置（${mismatch.join(', ')}）`, applied };
		}
		return { ok: true, applied };
	} catch (error) {
		return { ok: false, reason: String(error?.message ?? error), applied };
	}
}

/**
 * 挑一个「最近活跃的**非派生**会话」（手机端主动推消息、又没指定 `sessionId` 时用）。
 *
 * 判据全部来自官方 `controller.list()` 的条目（`summaryFor` / `summarizeCold`）：
 * - `origin === 'subagent'` 或带 `parentSessionId` ⇒ 子代理派生会话，跳过
 *   （`session-controller` 的 `resolve` 也明确拒绝 resume 这类会话）；
 * - 在镜像清单（`link-mirror-sessions.json`）里 ⇒ 跳过（那是手机搬过去的副本）；
 * - 其余按 `updatedAt` 取最大者。
 *
 * 任何一步失败（服务未就绪 / list 抛错）都返回空串，由调用方回 `{ok:false}`。
 *
 * @param ctx - Cordis 上下文（只用 `sessionController.list`）。
 * @returns {Promise<string>} 会话 id；没有可用会话时是空串。
 */
export async function pickRecentSessionId(ctx) {
	let items = [];
	try {
		const result = await ctx?.sessionController?.list?.({});
		items = Array.isArray(result?.items) ? result.items : [];
	} catch {
		return '';
	}
	let best = '';
	let bestAt = '';
	for (const item of items) {
		const id = typeof item?.sessionId === 'string' ? item.sessionId : '';
		if (id === '') continue;
		// 派生会话：官方条目上就是这两个字段（见 listFields / list.js 的 summaryFor）。
		if (item?.origin === 'subagent' || item?.parentSessionId !== undefined) continue;
		// 镜像会话：手机端写进 link-mirror-sessions.json 的副本清单。
		if (mirrorSessionIds().has(id)) continue;
		const at = typeof item?.updatedAt === 'string' ? item.updatedAt : '';
		if (best === '' || at > bestAt) {
			best = id;
			bestAt = at;
		}
	}
	return best;
}

/**
 * 把 `getState('desktop')` 折算成手机端要的「会话同步策略」（导出：自检直接喂状态）。
 *
 * 单独抽成纯函数只为可测：这条 RPC 是手机端执行的**唯一策略来源**，
 * 判错了会表现为「同步静默不搬」，只能靠单测钉住默认值/归一口径。
 *
 * @param {object} [state] - `setupController.service.getState('desktop')`。
 * @returns `{ ok, scope, newSync, delSync, keepDays, workspaces }`。
 */
export function buildSyncPolicy(state) {
	const sync = state?.sessionSync !== null && typeof state?.sessionSync === 'object' ? state.sessionSync : {};
	const keepDays = Number(sync.keepDays);
	return {
		ok: true,
		scope: sync.scope === 'workspace' ? 'workspace' : DEFAULT_SESSION_SYNC.scope,
		newSync: sync.newSync !== false,
		delSync: sync.delSync !== false,
		keepDays: Number.isFinite(keepDays) ? keepDays : DEFAULT_SESSION_SYNC.keepDays,
		// `getState('desktop').workspaces` 已经在服务层过了一遍 `activeWorkspaces()`
		//（剔墓碑、只留路径字符串），这里只再挡一次非字符串脏值。
		workspaces: (Array.isArray(state?.workspaces) ? state.workspaces : [])
			.filter((path) => typeof path === 'string' && path !== ''),
	};
}

/**
 * 处理一条 RPC。
 *
 * @param ctx - Cordis 上下文。
 * @param method - 方法名。
 * @param params - 参数。
 * @param io - `startRelay` 闭包里的通道（见其定义）。可选：老调用方不传也能跑，
 *   只有 `answerAsk` 这一个方法依赖它。
 */
async function handleRpc(ctx, method, params, io) {
	// 单包门（2026-10-25 单包收口）：role 不依赖任何服务，必须在 sessionController
	// 检查之前回答 —— 版本探测不该因为会话服务缺失而失败。
	if (method === 'role') return { role: 'desktop' };
	// ⚠️ 0.18.19：插件自身的版本查询与收包换装也**不依赖会话服务**。
	// 手机推包时电脑可能一个会话都没开（sessionController 缺失很常见），
	// 这种时候换装链路不能跟着挂掉（否则「推包」在刚重启的电脑上必然失败）。
	if (method === 'pluginVersion') return pluginVersion();
	// ⚠️ 0.18.23：手机把**当前** pairKey 推过来，写进 `link-peer.json`。
	//
	// 为什么需要：手机端的 `pairKey` 一旦重新生成（配置丢了/重置），电脑手里那份就过期，
	// 之后每条「电脑 → 手机」通知都是 401（真机 14:59~16:58 一直在刷），而手机那边
	// 完全不知道。让手机每次启动主动对齐一次，这类失联就能自愈。
	//
	// 安全：这条 RPC 走设备签名（`x-link-device/ts/key`），能调它的只有已配对的手机；
	// 写的是「对方自己的密钥」，不涉及任何会话数据。
	if (method === 'linkKeySync') {
		const pairKey = typeof params?.pairKey === 'string' ? params.pairKey.trim() : '';
		if (!/^[0-9a-f]{32,128}$/i.test(pairKey)) throw new Error('pairKey 形状不对（应为 32~128 位十六进制）');
		const file = statePathOf('link-peer.json');
		let peer = {};
		try {
			peer = JSON.parse(readFileSync(file, 'utf8'));
		} catch {
			peer = {};
		}
		if (peer === null || typeof peer !== 'object' || Array.isArray(peer)) peer = {};
		const before = typeof peer.key === 'string' ? peer.key : '';
		if (before === pairKey) return { ok: true, updated: false };
		peer.key = pairKey;
		const tmp = `${file}.tmp-${process.pid}`;
		writeFileSync(tmp, `${JSON.stringify(peer, null, 2)}\n`, 'utf8');
		renameSync(tmp, file);
		return { ok: true, updated: true };
	}
	if (method === 'pluginReceive') {
		if (params === null || typeof params !== 'object') throw new Error('pluginReceive 需要 params');
		return await receivePlugin({
			name: params.name,
			version: params.version,
			sha256: params.sha256,
			base64: params.base64,
			dryRun: params.dryRun === true,
			log: (line) => void debugLog(line),
		});
	}
	const controller = ctx.sessionController;
	if (controller === undefined) throw new Error('sessionController 不可用');

	switch (method) {
		/** 探测：手机端「测试连接」用。 */
		case 'ping':
			return { ok: true, platform: process.platform, home: homedir(), pid: process.pid };

		/**
		 * 手机端取「电脑上勾选要给手机开放的工作区」。
		 *
		 * 数据来自配置页维护的 `setup.json`（用户在真实目录选择器里挑的那几个），
		 * 手机端拿到后为每个路径建一个本地镜像工作区 —— 这样电脑上勾选的清单
		 * 才会真的出现在手机侧边栏，而不是只存在电脑的配置文件里。
		 *
		 * 只读、只返回路径；不碰会话、不读文件内容。
		 */
		case 'setupWorkspaces': {
			const state = setupController?.service?.getState?.('desktop');
			const paths = state?.workspaces;
			const hides = state?.hides && typeof state.hides === 'object' ? state.hides : {};
			// 「不同步到手机」= 永久隐藏：手机端建镜像工作区时直接跳过。
			let visible = (Array.isArray(paths) ? paths : []).filter((path) => {
				const hide = hides[path];
				return !(hide && hide.ttl === 'forever');
			});
			let source = 'service';
			// 服务层状态为空时兜底读 setup.json：配置页的勾选若只落到文件、没同步进
			// 控制器实例（实测出现过），这里仍能把清单交给手机，而不是返回空。
			if (visible.length === 0) {
				try {
					const raw = JSON.parse(readFileSync(join(stateDirOf(), 'setup.json'), 'utf8'));
					const list = Array.isArray(raw?.workspaces) ? raw.workspaces : [];
					visible = list
						.filter((entry) => entry && typeof entry.path === 'string' && entry.path !== '' && entry.deleted !== true)
						.map((entry) => entry.path);
					if (visible.length > 0) source = 'setup.json';
				} catch {
					/* 读不到就按空处理 */
				}
			}
			return { ok: true, workspaces: visible, source };
		}

		/**
		 * 手机端「会话同步」执行策略（只读）。
		 *
		 * 设置面板（设置 → 局域互联 → 会话同步）把 `scope / newSync / delSync /
		 * keepDays` 存在**电脑端** `setup.json`，但真正搬会话的是**手机端**
		 * `syncAll` —— 手机读不到电脑的文件，所以由这条只读 RPC 把策略带过去
		 * （与 `setupWorkspaces` 同一个思路：配置只有一份，执行端按它办）。
		 *
		 * `workspaces` 用 `getState('desktop').workspaces`：服务层已经过
		 * `activeWorkspaces()`，就是「已剔墓碑」的路径字符串数组，正好给手机端判
		 * `scope === 'workspace'` 时请求的目录算不算开放。
		 *
		 * 只读、不碰会话、不写任何文件；`keepDays` 缺省按规则层默认值兜底，
		 * 不把 `undefined` 甩给手机端。
		 *
		 * @returns `{ ok, scope, newSync, delSync, keepDays, workspaces }`。
		 */
		case 'syncPolicy': {
			return buildSyncPolicy(setupController?.service?.getState?.('desktop'));
		}

		/**
		 * 手机 → 电脑：让电脑上的 agent 收到一条消息（0.1.4 新增，与手机端
		 * `/link/agent-message` 的方向刚好相反）。
		 *
		 * 入参 `{ sessionId?, text, from? }`：
		 * - `sessionId` 非空 ⇒ 直接投递到该会话；
		 * - 为空 ⇒ 用本机「最近活跃的非派生会话」（见 {@link pickRecentSessionId}）；
		 * - `from` 只写日志，不改正文（正文就是 `text`，手机端要发什么就收到什么）。
		 *
		 * ## ⚠️ `source.kind` 必须是 `agent-message`
		 *
		 * DSH v4 会**拒收** `kind: 'plugin'` 的注入消息（0.1.3 踩过：消息发出去、
		 * 电脑端日志里只有一条拒收，agent 根本没被唤醒）。所以这里与手机端
		 * `lib/mobile/index.js` 的投递逻辑保持**同一个** source 形状。
		 *
		 * 失败一律 `{ok:false, error}`、**不抛**：手机端拿到返回值直接回给调用方，
		 * 不需要再区分「抛了」还是「回了 ok:false」两种形态。
		 */
		case 'agentMessage': {
			try {
				const text = typeof params?.text === 'string' ? params.text : '';
				if (text.trim() === '') return { ok: false, error: 'text 为空' };
				const from = typeof params?.from === 'string' ? params.from.trim() : '';
				let target = typeof params?.sessionId === 'string' ? params.sessionId.trim() : '';
				if (target === '') target = await pickRecentSessionId(ctx);
				if (target === '') {
					return { ok: false, error: '没有可投递的会话（最近活跃的非派生会话为空）' };
				}
				if (typeof controller.resolveAgent !== 'function') return { ok: false, error: 'resolveAgent 不可用' };
				const resolved = await controller.resolveAgent(target);
				const agent = resolved?.agent ?? resolved;
				if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
					return { ok: false, error: `拿不到 agent（${String(resolved?.error?.message ?? resolved?.error ?? '')}）` };
				}
				agent.followup({
					id: randomUUID(),
					role: 'user',
					content: [{ type: 'text', text }],
					source: { kind: 'agent-message', plugin: 'dsh-link' },
				});
				void debugLog(
					`agent-message 已投递电脑会话 ${target}（from=${from === '' ? '-' : from}，${text.length} 字）`,
				);
				return { ok: true, sessionId: target };
			} catch (error) {
				return { ok: false, error: String(error?.message ?? error) };
			}
		}

		/** 列电脑上的会话（只给元数据）。 */
		case 'listSessions': {
			const result = await controller.list({});
			return { sessions: result?.items ?? [] };
		}

		/**
		 * 某个会话在电脑上是否正在跑。
		 *
		 * ## 为什么需要它（手机端运行态的**校正**通道）
		 *
		 * 手机靠 `turn/start` / `turn/end` 派生运行态（见手机端 `deriveRunning`），
		 * 那是零额外流量的正路。但它有个**必然的失效场景**：事件流断了。
		 *
		 * 断流期间电脑把这一轮跑完了 ⇒ `turn/end` 没送到手机 ⇒ 手机停在
		 * `running = true` ⇒ 输入框卡在「停止生成」出不来，只能杀应用。
		 * 而隧道掐空闲连接、手机休眠断网都是**常态**，不是异常。
		 *
		 * 所以手机在**重连成功那一刻**调一次这个方法做校正：一问一答，
		 * 每次断流重连才一次，不轮询、不持续占流量。
		 *
		 * ## 为什么走 `controller.list()` 而不是直接读 `ctx.agents`
		 *
		 * 本插件的 `inject` 只声明了 `sessionController` / `sessions` / `webServer`，
		 * **没有 `agents`** —— 直接 `ctx.agents.get()` 会拿到 `undefined` 而静默
		 * 把一切都判成「没在跑」。官方 `summaryFor`（`dsh-api-session-controller/
		 * lib/types/list.js:87`）内部用的正是 `ctx.agents.get(id)?.status === 'running'`，
		 * 而 `controller.list()` 会为每个会话产出该字段。
		 *
		 * 代价是它顺带算了所有会话的摘要（投影、元数据），比只问一个会话重。
		 * 但这条路**每次断流重连才走一次**，且拿到的是官方判定，不自己猜。
		 */
		case 'sessionStatus': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			const result = await controller.list({});
			const items = result?.items ?? [];
			const found = items.find((item) => item?.sessionId === sessionId);
			// 找不到 = 电脑上没有这个会话（被删了 / 还没建好）。此时**不能**说在跑。
			return { sessionId, running: found?.running === true };
		}

		/**
		 * 批量问「此刻在跑吗」—— 手机端侧边栏一次标出整屏的「运行中」。
		 *
		 * ## 判据与 `sessionStatus` 是**同一套**（不是第二套判据）
		 *
		 * 仍然是 `controller.list({})` 快照里的 `running` 字段（官方 `summaryFor`
		 * 内部判 `ctx.agents.get(id)?.status === 'running'`），也仍然是那个表达式
		 * `found?.running === true`。区别只在**一次快照判一批**：手机侧边栏一屏
		 * 十几条会话，逐条问答会把这十几份摘要各算一遍。
		 *
		 * ## 为什么不整批失败
		 *
		 * 侧边栏的语义是「能亮一条是一条」：某个 id 在电脑上被删了、或正好卡在
		 * list 的竞态里，都只该影响那一条。所以「查不到 ⇒ false」；连快照本身
		 * 都抛错时也按全部 false 兜底（断流重连那一刻的常见形态），让手机停在
		 * 「没在跑」，而不是把整块侧边栏打成错误。
		 *
		 * ## 上限 100
		 *
		 * 超过 100 条只取**前 100 条**，并回 `truncated: true`（不静默截断）。
		 *
		 * @returns `{ running: { [sessionId]: boolean }, truncated?: true }`；
		 *   入参为空数组时是 `{ running: {} }`。
		 */
		case 'sessionStatusMany': {
			const limit = 100;
			const requested = Array.isArray(params?.sessionIds) ? params.sessionIds : [];
			// 空数组：直接回，连一次 list 都不走。
			if (requested.length === 0) return { running: {} };
			const truncated = requested.length > limit;
			// 重复 id 只是同一个键写两次，去重省掉白算的量（仍保持「前 100 条」语义）。
			const ids = [...new Set(requested.slice(0, limit).filter((id) => typeof id === 'string' && id !== ''))];
			let items = [];
			try {
				items = (await controller.list({}))?.items ?? [];
			} catch {
				// 快照都拿不到 ⇒ 不知道谁在跑，一律按「没在跑」兜底；不把整批打成错误。
				items = [];
			}
			const running = {};
			for (const sessionId of ids) {
				const found = items.find((item) => item?.sessionId === sessionId);
				// 与 `sessionStatus` 同一表达式：查不到 / 没在跑，都记 false。
				running[sessionId] = found?.running === true;
			}
			return truncated ? { running, truncated: true } : { running };
		}

		/**
		 * 建会话：手机发起，电脑在**电脑自己的** cwd 下建，并建出真 agent。
		 *
		 * `sessionId` 由手机端生成并传入，两端保持一致，事件才能直接互搬。
		 *
		 * ⚠️ **cwd 必须排除 DSH 自己的状态目录**（见 `assertWorkspaceAllowed`）。
		 * 不排的话，文件围栏可被**绕过** —— 公网实测：
		 *
		 *   1. `createSession { cwd: 'C:\\Users\\<user>' }`   → ok，工作区被设成主目录
		 *   2. `fileStat { path: '.dsh\\dsh-remote\\pair.json' }` → ok，504 字节
		 *
		 * 第 2 步用的是**相对路径**，所以 `resolveWorkspacePath` 那道围栏
		 * 完全拦不住它 —— 工作区本身就是「整个主目录」。围栏是**以工作区为界**的，
		 * 而工作区可被这一步自由指定，两者一叠加，围栏就等于没有。
		 *
		 * 为什么**只**排除状态目录、而不是给 cwd 加白名单：让用户选任意目录当
		 * 工作区是**功能**（「选电脑上的文件夹」），不能一刀切。而 `$DSH_HOME`
		 * 是**程序自己的**目录（凭据、会话库、插件），用户没有理由拿它当工作区，
		 * 拿它当工作区正是上面那条攻击链。
		 */
		case 'createSession': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			const cwd = params.cwd;
			if (typeof cwd !== 'string' || cwd === '' || !isAbsolute(cwd)) {
				throw new Error('cwd must be an absolute path on this machine');
			}
			// ⚠️ **幂等**：会话已存在就原样返回，不重建。
			//
			// 手机端现在把「建会话」合并进了 `prompt`（见那里的 `desktopPath` 分支），
			// 这个方法因此主要服务于旧客户端和排障。但两边都可能因为网络重试而重复
			// 调用 —— 重复 `controller.create` 在官方那边是**接管已有会话**（
			// `agents.ensureSession` 的 adopt 语义），通常不会丢历史，但会白走一遍
			// 建目录/建 agent 的开销，而且 `assertPresetUnchanged` 可能因为预设
			// 已经不同而直接抛错。在这里挡一道最省事、也最不容易出错。
			const existing = ctx.sessions?.get?.(sessionId);
			if (existing !== undefined) {
				// 复用路径也补挂一次（幂等）：旧版本插件建的会话可能还躺在「未分组」，
				// 手机重试这条请求正好把它挂回对应工作区。
				await attachSessionToWorkspace(ctx, sessionId, cwd);
				return { sessionId, cwd, agentPreset: null, reused: true };
			}
			assertWorkspaceAllowed(cwd);
			// ⚠️ **走 workspaceId 而不是 cwd**（见 `ensureWorkspaceId` 的注释）：
			// 只有 workspaceId 分支会让官方 `controller.create` 调
			// `workspace.attachSession()`，会话才会出现在电脑侧边栏的**对应工作区**下。
			// 只传 cwd 的话会话会堆在「未分组」—— 那正是用户报的那个问题。
			const workspaceId = await ensureWorkspaceId(ctx, cwd);
			// 官方命令层：内部走 agents.ensureSession()，会建出真 agent。
			const created = await controller.create({
				sessionId,
				workspaceId,
				...(typeof params.presetId === 'string' && params.presetId !== ''
					? { agentPreset: params.presetId }
					: {}),
			});
			// ⚠️ 建完再**显式挂一次**到「path === cwd」的工作区（手机端建会话 → 电脑
			// 侧边栏可见）。`workspaceId` 只覆盖创建时那一刻，注册表的 `sessionIds`
			// 账本要单独落 —— 见 `attachSessionToWorkspace` 的 docstring。
			// 找不到工作区 / 挂载被拒只记日志，不影响本方法的成功返回。
			const createdId = created?.sessionId ?? sessionId;
			await attachSessionToWorkspace(ctx, createdId, cwd);
			return { sessionId: createdId, cwd, agentPreset: created?.agentPreset ?? null };
		}

		/**
		 * 发消息：驱动电脑上的 agent。
		 *
		 * ## 附件为什么必须原样透传（用户需求原文：「照片就会被吞了 AI 只能看到我的文字」）
		 *
		 * 手机端 composer 里的附件分两种形态（见 `dsh-client-ui-conversation/lib/client.js`
		 * 的 `serializeAttachments`）：
		 *
		 * | 形态 | 结构 | 谁落盘 |
		 * |---|---|---|
		 * | 图片 | `{type:'image', mediaType, data(base64), name?}` | **电脑**（内联字节，没有 receipt） |
		 * | 文件 | `{type:'file', receiptId}` | **手机**（receipt 是本机 `fileUploads` 发的） |
		 *
		 * 所以图片是**自带字节**的，直接转给电脑的 `controller.prompt` 即可，电脑会
		 * 用 `attachments.admitPromptContent` 落成它自己的 content-addressed 对象。
		 *
		 * ⚠️ `{type:'file', receiptId}` **不能**转发：receipt 是**手机本地**
		 * `fileUploads` 服务发的，电脑的 `stagedFiles` 里没有它，转过去必然
		 * `session/attachment-invalid FILE_NOT_STAGED`。所以那种 part 降级成一句
		 * 文本说明 —— 至少让模型知道用户附了个文件，而不是**静默吞掉**。
		 *
		 * @returns `{sessionId, requestId, accepted, forwarded, skipped}`。
		 */
		case 'prompt': {
			const sessionId = params.sessionId;
			const text = typeof params.text === 'string' ? params.text : '';
			// 附件形态的 content（手机端传过来的原始数组）。没有就退回纯文本。
			const incoming = Array.isArray(params.content) ? params.content : null;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			// ⚠️ 判据必须包含附件：用户只发一张图、不打字，是完全正常的用法。
			// 早先只校验 `text.trim() === ''` 会把这种消息直接拒掉。
			const content = [];
			let skipped = 0;
			if (incoming === null) {
				if (text.trim() === '') throw new Error('sessionId and non-empty text required');
				content.push({ type: 'text', text });
			} else {
				for (const part of incoming) {
					if (part?.type === 'text') {
						if (typeof part.text === 'string' && part.text !== '') content.push({ type: 'text', text: part.text });
						continue;
					}
					if (part?.type === 'image') {
						// 只认官方 `imageMediaType()` 放行的四种；其余一律降级成文本，
						// 免得电脑端抛 `UnsupportedImageMediaTypeError` 把整条消息废掉。
						const mediaType = part.mediaType;
						if (
							typeof part.data === 'string' &&
							part.data !== '' &&
							(mediaType === 'image/png' ||
								mediaType === 'image/jpeg' ||
								mediaType === 'image/webp' ||
								mediaType === 'image/gif')
						) {
							content.push({
								type: 'image',
								mediaType,
								data: part.data,
								...(typeof part.name === 'string' && part.name !== '' ? { name: part.name } : {}),
							});
						} else {
							skipped += 1;
						}
						continue;
					}
					// `file` 与任何未知形态：receipt 属于手机，电脑解不开（见上表）。
					skipped += 1;
				}
				if (content.length === 0) {
					if (skipped === 0) throw new Error('prompt content must include text or an image');
					// 只有解不开的附件：给模型一句说明，别让它以为用户什么都没发。
					content.push({
						type: 'text',
						text: `（用户附了 ${skipped} 个文件，但文件传输通道尚未接通，只收到了这条说明。）`,
					});
				}
			}
			// ⚠️ requestId 必须唯一：官方用它做幂等去重，两边都是 undefined 会误判重复。
			const requestId = typeof params.requestId === 'string' && params.requestId !== ''
				? params.requestId
				: randomUUID();
			// ## 按需建会话（用户要求：这几步打包成一个请求发过来）
			//
			// 用户原话：
			//   「我们在电脑上创建一个新对话，顺序是：点击"新对话" → 选择工作区 →
			//    选择预设 → 选择模型 → 发消息。前四步其实它不是一个有效的新建对话，
			//    电脑也是必须发消息之后，它才创建对话的。」
			//   「我觉得新建对话、选择预设、选择模型还有发送消息这么多个步骤，你可以
			//    打包成一个网络请求发过去就可以了，电脑拿到这个请求之后再解析就OK了」
			//
			// 所以手机端**选工作区时不再预先建会话**，而是把 `desktopPath` / `presetId` /
			// `model` 一起塞进这个 `prompt` 请求。这里按官方的真实顺序补做前四步：
			//
			//   create（带 agentPreset） → selectModel → prompt
			//
			// 三个 `await` 都在**同一个 RPC 里**完成，所以对手机来说仍然只过一趟隧道。
			//
			// ⚠️ **幂等**：`params.desktopPath` 只有手机端认定「这个会话在电脑上还没出生」
			// 时才会带。会话已经存在时这里直接跳过（`sessions.get` 有值就不重建），
			// 所以哪怕手机端因为网络抖动重发了同一条带 `desktopPath` 的请求，
			// 也不会把会话推翻重建、丢掉已有历史。
			if (typeof params.desktopPath === 'string' && params.desktopPath !== '') {
				const existing = ctx.sessions?.get?.(sessionId);
				if (existing === undefined) {
					if (!isAbsolute(params.desktopPath)) {
						throw new Error(`desktopPath must be an absolute path on this machine: ${params.desktopPath}`);
					}
					assertWorkspaceAllowed(params.desktopPath);
					// 预设只在**新建**时给得进去（官方 `create` 接受 `agentPreset`；
					// 会话建好之后预设已经固化在 agent 上，不能再改）。
					//
					// ⚠️ **走 workspaceId 而不是 cwd**：只有 workspaceId 分支会触发
					// 官方 `workspace.attachSession()`，会话才会归到电脑侧边栏的
					// **对应工作区**下，而不是「未分组」（详见 `ensureWorkspaceId`）。
					const workspaceId = await ensureWorkspaceId(ctx, params.desktopPath);
					await controller.create({
						sessionId,
						workspaceId,
						...(typeof params.presetId === 'string' && params.presetId !== ''
							? { agentPreset: params.presetId }
							: {}),
					});
					// 模型必须在会话存在之后设（官方 `selectModel` 走 `resolveAgent`）。
					// ⚠️ 失败**不阻断**发送：用户可能选了一个电脑上没有的模型
					//（比如那个模型后来被删了），此时退回电脑默认模型继续回复，
					// 比整条消息发不出去合理。日志留一条便于排查。
					const model = params.model;
					if (
						model !== null &&
						typeof model === 'object' &&
						typeof model.provider === 'string' &&
						model.provider !== '' &&
						typeof model.model === 'string' &&
						model.model !== ''
					) {
						try {
							await controller.selectModel({
								sessionId,
								provider: model.provider,
								model: model.model,
								...(typeof model.reasoningEffort === 'string' && model.reasoningEffort !== ''
									? { reasoningEffort: model.reasoningEffort }
									: {}),
							});
						} catch (error) {
							ctx.logger?.warn?.(
								`[dsh-link] 会话 ${sessionId} 的模型 ${model.provider}/${model.model} 设置失败，改用默认模型: ${String(
									error?.message ?? error,
								)}`,
							);
						}
					}
				}
			}
			// ⚠️ **必须传第二个参数 `signal`**，`undefined` 会直接炸。
			//
			// 官方 `dsh-api-session-controller/lib/index.js:3096`：
			//   prompt(request, signal) { signal.throwIfAborted(); ... }
			// 它**无条件**对 `signal` 调 `throwIfAborted()`，所以漏传就是
			//   `Cannot read properties of undefined (reading 'throwIfAborted')`
			// 报错文案完全看不出是参数漏传，症状是「手机发了消息、电脑毫无反应」。
			//
			// 传一个永不过期的 signal：远端调用的生命周期不由本机的 UI 决定，
			// 真正的中断走 `cancel` 那条 RPC。
			const accepted = await controller.prompt(
				{
					sessionId,
					requestId,
					content,
					...(params.mode === 'steer' ? { mode: 'steer' } : {}),
				},
				new AbortController().signal,
			);
			// ⚠️ 0.18.23：记一笔「这一轮是手机发起的」。`turn/end` 时据此决定要不要回投，
			// 以及回投到手机上的哪个会话（`notifySession`，手机派活时显式给）。
			markPhoneDrivenTurn(sessionId, typeof params.notifySession === 'string' ? params.notifySession : '');
			return { sessionId, requestId, accepted: accepted?.accepted === true, forwarded: content.length, skipped };
		}

		/** 中断当前生成。 */
		case 'cancel': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			const accepted = await controller.cancel({ sessionId });
			return { sessionId, accepted: accepted?.accepted === true };
		}

		/**
		 * 手机回答一条待决的 ask / 授权弹窗。
		 *
		 * 对应 `startRelay` 里 `askPhone()` 推出去的那条 `ask` 事件。
		 * 手机拿到 `requestId` 后连同用户的选择一起回传。
		 *
		 * ⚠️ 三种「答不上」都返回 `ok: false` 而**不抛错**：
		 *   · `expired` —— 超时了（ASK_TIMEOUT_MS）或这一轮已被中断；
		 *   · `no-relay` —— 老版本桌面端没有这条通道；
		 *   · `bad-request` —— 参数形状不对。
		 * 抛错会让手机端弹一个看不懂的红条，而这不是「出错了」，
		 * 是「这个弹窗已经不用答了」—— 手机端应当静默收起卡片。
		 */
		case 'answerAsk': {
			if (io?.answerAsk === undefined) return { ok: false, reason: 'no-relay' };
			const requestId = params.requestId;
			if (typeof requestId !== 'string' || requestId === '') return { ok: false, reason: 'bad-request' };
			return io.answerAsk(requestId, params.answer);
		}

		/** 列电脑上的目录（手机的「电脑」页签用）。 */
		case 'listDirectory':
			return listDirectory(params.path);

		/**
		 * 列电脑上某个会话工作区里的一层目录（**含文件**）。
		 *
		 * ⚠️ **不要拿 `listDirectory` 顶替**：那个是给「选工作区」对话框用的，
		 * 只列子目录（文件被 `continue` 跳过）。而官方侧边栏的文件树要
		 * `{name, type, size?}` 三样齐全，拿不到 `type:'file'` 的条目就等于
		 * 侧边栏里**一个文件都看不见** —— 这正是本方法存在的理由。
		 *
		 * 直接把官方的 `workspaceFiles.list()` 结果原样带回去，客户端就不需要
		 * 任何形状转换（官方 `sidebar-files` 的 `createList` 只挑
		 * `entries` 与 `truncated` 两个字段）。
		 */
		case 'fileList': {
			const files = workspaceFilesOf(ctx);
			const scope = await workspaceScopeOf(ctx, params.sessionId);
			return await files.list(scope, resolveWorkspacePath(scope, params.path), idleSignal());
		}

		/**
		 * 读电脑上一个会话工作区里的文本文件（分页）。
		 *
		 * @returns 官方 `workspaceFiles.read` 的原样结果
		 *   （`{offset, text, lines, eof, absolutePath, version, bytes?}`）。
		 */
		case 'fileRead': {
			const files = workspaceFilesOf(ctx);
			const scope = await workspaceScopeOf(ctx, params.sessionId);
			const range = params.offset === undefined ? {} : { offset: params.offset };
			return await files.read(scope, resolveWorkspacePath(scope, params.path), range, idleSignal());
		}

		/**
		 * 取电脑上一个会话工作区里某个路径的元信息（`{absolutePath, version, bytes?}`）。
		 *
		 * 官方预览面板靠 `version` 判断文件有没有被外部改动过，缺了它就不会刷新。
		 */
		case 'fileStat': {
			const files = workspaceFilesOf(ctx);
			const scope = await workspaceScopeOf(ctx, params.sessionId);
			return await files.stat(scope, resolveWorkspacePath(scope, params.path), idleSignal());
		}

		/**
		 * 读电脑上一个会话工作区里的**字节**（图片等二进制预览用）。
		 *
		 * ⚠️ 两端的 RPC 都是 JSON，`Uint8Array` 过不去 —— 这里过一道 base64。
		 * 手机端收到后还原成 `Uint8Array`，官方预览面板才认。
		 */
		case 'fileReadBytes': {
			const files = workspaceFilesOf(ctx);
			const scope = await workspaceScopeOf(ctx, params.sessionId);
			const options = params.range === undefined ? {} : { range: params.range };
			const result = await files.readBytes(scope, resolveWorkspacePath(scope, params.path), options, idleSignal());
			const { data, ...meta } = result ?? {};
			return { ...meta, data: Buffer.from(data ?? []).toString('base64') };
		}

		/**
		 * 写电脑上一个会话工作区里的文件（手机端保存/新建文本或二进制）。
		 *
		 * ## 围栏（和 `fileRead` 同一条底线）
		 *
		 * 官方 `workspaceFiles` 自己**不做**围栏 —— 写文件更是 `resolve(cwd, path)`
		 * 就直接落盘，`..` 与绝对路径都能穿出工作区。所以这里照 `fileRead` 的做法：
		 * 先过 `resolveWorkspacePath`（拒绝对路径 / `..` / 链接越界），再把
		 * **拼出来的绝对路径**按真实路径再判一次 `isInside` —— 写是破坏性操作，
		 * 宁可多判一道，也不让一次越界写覆盖工作区外的文件。
		 *
		 * ## 参数
		 *
		 * - `sessionId`：要写哪个会话的工作区（必填）；
		 * - `path`：**工作区相对**路径（posix 分隔符），不能为空、不能是绝对路径；
		 * - `content`：要写的内容（字符串必填，可以是空串）；
		 * - `base64`：`true` 表示 `content` 是 base64 编码的**二进制**，
		 *   否则按 UTF-8 文本写。
		 *
		 * 目标文件不存在就新建；父目录不存在**不代建**（照实报 ENOENT，
		 * 免得把「路径打错了」伪装成成功）。
		 *
		 * @returns `{ok: true, bytes}` —— `bytes` 是实际落盘的字节数。
		 */
		case 'fileWrite': {
			const scope = await workspaceScopeOf(ctx, params.sessionId);
			if (typeof params.path !== 'string' || params.path === '') throw new Error('path required');
			// 校验（相对路径 / 不出工作区 / 链接不越界），再把相对路径拼成绝对路径。
			const target = resolve(scope.workspaceRoot, resolveWorkspacePath(scope, params.path));
			// ⚠️ 再按**真实路径**判一次：root 自身也可能经链接到达，拼出来的路径必须仍在其中。
			if (!isInside(realpathBestEffort(scope.workspaceRoot), realpathBestEffort(target))) {
				throw new Error('路径越出了会话工作区');
			}
			if (typeof params.content !== 'string') throw new Error('content required');
			const data = params.base64 === true
				? Buffer.from(params.content, 'base64')
				: Buffer.from(params.content, 'utf8');
			writeFileSync(target, data);
			return { ok: true, bytes: data.length };
		}

		/**
		 * 导出整份记忆库（`$DSH_BIOMEMORY_DIR/biomemory.db`，缺省 `~/.dsh/biomemory/`）。
		 *
		 * ## 为什么直接读 SQLite，而不是调 `memory` 工具
		 *
		 * `memory` 工具返回的是**检索候选**（`Retrieved`），不是存储层；而这里要的
		 * 是「全量快照，含归档与墓碑」—— 那只有数据层（SQLite 单文件）能给。
		 *
		 * ## 字段口径（**实测 `PRAGMA table_info(entries)` 得来，别按旧印象猜**）
		 *
		 * | 返回字段 | 来源列 | 说明 |
		 * |---|---|---|
		 * | `fp` | `fp` | 去重指纹（记忆层 `shared.mjs::fingerprint`） |
		 * | `text` | `text` | 正文 |
		 * | `track` | **没有这一列** | 由 `kind` / `fragment_type` / `memory_class` 反推 |
		 * | `source` | `source_ref` | 库里的列名是 `source_ref`，不是 `source` |
		 * | `weight` / `pinned` | 同名 | `pinned` 库里是 0/1，这里转布尔 |
		 * | `createdAt` | `created_at` | ISO 字符串 |
		 * | `archived` | `status` | 库里是 active / archived / deleted（墓碑）三态 |
		 *
		 * ⚠️ **`track` 不是列**：记忆层写入时把它落成了 `kind`（`知识`=user /
		 * `行为`=agent）与 `fragment_type`（user 轨 `preference`·`fact`，agent 轨
		 * `lesson`），而 `model_inference` / `model_suggestion` 这两类 `memory_class`
		 * 按 `store.mjs::inferMemoryClass` 只可能来自 agent 轨。所以反推规则：
		 * 上述任一命中 ⇒ `agent`，否则 `user`。
		 *
		 * ⚠️ **归档与墓碑都要带上**：这是「快照」而不是「可用条目」。漏掉它们，
		 * 手机端会以为条目消失了，回写时又插一遍，等于把删除又变回来。
		 *
		 * @returns `{items: [{fp,text,track,source,weight,pinned,createdAt,archived}]}`。
		 */
		case 'memoryDump': {
			const { DatabaseSync } = await import('node:sqlite');
			// ⚠️ 路径口径与记忆层 `db.mjs::biomemoryDir` 一致：先认 DSH_BIOMEMORY_DIR，
			// 再退 `~/.dsh/biomemory`。别改成 `$DSH_HOME` —— 记忆层不认它。
			const dir = process.env.DSH_BIOMEMORY_DIR || join(homedir(), '.dsh', 'biomemory');
			const dbFile = join(dir, 'biomemory.db');
			if (!existsSync(dbFile)) throw new Error(`记忆库不存在：${dbFile}`);
			// ⚠️ 只读打开：这是导出通道，不该写回一个字节。
			const db = new DatabaseSync(dbFile, { readOnly: true });
			try {
				const rows = db
					.prepare(
						`SELECT fp, text, kind, fragment_type, memory_class, source_ref,
						        weight, pinned, created_at, status
						   FROM entries
						  ORDER BY pinned DESC, weight DESC, created_at DESC`,
					)
					.all();
				const items = rows.map((row) => ({
					fp: row.fp ?? null,
					text: String(row.text ?? ''),
					track:
						row.kind === '行为' ||
						row.fragment_type === 'lesson' ||
						row.memory_class === 'model_inference' ||
						row.memory_class === 'model_suggestion'
							? 'agent'
							: 'user',
					source: row.source_ref ?? null,
					weight: Number(row.weight ?? 0),
					pinned: Number(row.pinned ?? 0) === 1,
					createdAt: row.created_at ?? null,
					archived: String(row.status ?? 'active') !== 'active',
				}));
				return { items };
			} finally {
				db.close();
			}
		}

		/**
		 * 按 `fp` 合并进电脑的记忆库（手机端回写 / 两机对账用）。
		 *
		 * ## 合并规则（任务口径，语义别改）
		 *
		 * | 情况 | 动作 |
		 * |---|---|
		 * | 带 `fp` 且库里已有 | **UPDATE** 正文/来源，**保留原 `weight` 与 `pinned`** |
		 * | 带 `fp` 但库里没有 | INSERT（就用这个 `fp`） |
		 * | 不带 `fp`，`text` 与库里某条**精确相同** | 视为同一条 ⇒ UPDATE，不重复插入 |
		 * | 不带 `fp`，正文是新的 | INSERT，`fp` 由正文现算 |
		 *
		 * ⚠️ **`fp` 必须用记忆层同一套算法现算**（`shared.mjs::fingerprint`：正文去掉
		 * 所有空白后取前 20 字，`h=((h<<5)-h)+code|0` 的 32 位哈希再取 hex）。换成
		 * sha256 之类，算出来的 `fp` 与库里已有条目**永远对不上**，「按 fp 合并」当场失效。
		 *
		 * ⚠️ **不推断 `memory_class` / `mtype` / `trigger` / `mkey`**：这些是记忆层
		 * `store.mjs` 写入时的语义推断（一堆正则，还带「同键覆盖 ⇒ 把旧条目标墓碑」
		 * 的副作用）。合并通道只搬正文与来源 —— 留空比瞎猜好，而且留空不影响任何
		 * 查询（`mtype` 参与的判断都有 `|| 'fact'` 兜底）。
		 *
		 * ⚠️ **`entry_id` / `created_at` / `weight` / `pinned` / `hits` / `status`
		 * 一律不动**：提权、钉住、删改、复活墓碑都只走 `memory` 工具。合并通道顺手
		 * 改权重或把 `deleted` 拉回 `active`，等于绕过审批把删除撤销。
		 *
		 * ⚠️ **UPDATE 用 `entry_id` 定位，不用 `fp`**：`fp` 列允许 NULL，`WHERE fp = NULL`
		 * 永远不命中，会静默「更新成功 0 行」。主键才是稳的锚。
		 *
		 * ## 参数
		 *
		 * `{items: [{fp?, text, track?, source?}]}` —— `text` 必填（非空）；
		 * `track` 取 `user` / `agent`（缺省 `agent`，与 `memory` 工具一致）；
		 * `source` 落 `source_ref`。
		 *
		 * @returns `{added, updated}`。
		 */
		case 'memoryUpsert': {
			const list = Array.isArray(params?.items) ? params.items : null;
			if (list === null) throw new Error('items must be an array');
			const { DatabaseSync } = await import('node:sqlite');
			const dir = process.env.DSH_BIOMEMORY_DIR || join(homedir(), '.dsh', 'biomemory');
			const dbFile = join(dir, 'biomemory.db');
			if (!existsSync(dbFile)) throw new Error(`记忆库不存在：${dbFile}`);
			/** 与记忆层 `shared.mjs::fingerprint` 逐字一致 —— 算法一变，旧 fp 全部对不上。 */
			const fpOf = (value) => {
				const t = String(value).replace(/\s+/g, '').slice(0, 20);
				let h = 0;
				for (let i = 0; i < t.length; i += 1) h = ((h << 5) - h + t.charCodeAt(i)) | 0;
				return (h >>> 0).toString(16);
			};
			const db = new DatabaseSync(dbFile);
			// ⚠️ 记忆层的活连接也在写这个库（WAL 模式）：撞上写锁要等，不能直接抛。
			db.exec('PRAGMA busy_timeout = 5000');
			let added = 0;
			let updated = 0;
			try {
				const byFp = db.prepare('SELECT * FROM entries WHERE fp = ?');
				const byText = db.prepare('SELECT * FROM entries WHERE text = ? LIMIT 1');
				const updateExisting = db.prepare(
					`UPDATE entries
					    SET text = ?, source_ref = ?,
					        fragment_type = COALESCE(?, fragment_type),
					        kind = COALESCE(?, kind)
					  WHERE entry_id = ?`,
				);
				const insertEntry = db.prepare(
					`INSERT INTO entries
					   (entry_id, fp, layer, fragment_type, kind, mode, text,
					    weight, hits, pinned, created_at, status, source_ref, realm)
					 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
				);
				// 一批走一个事务：中途某条不合法就整批回滚，不留半截状态。
				db.exec('BEGIN');
				try {
					for (const item of list) {
						const text = typeof item?.text === 'string' ? item.text.trim() : '';
						if (text === '') throw new Error('items[].text required（每条都要有非空 text）');
						const trackGiven = item?.track === 'user' || item?.track === 'agent';
						const itemTrack = trackGiven ? item.track : 'agent';
						const source = typeof item?.source === 'string' && item.source !== '' ? item.source : null;
						const given = typeof item?.fp === 'string' && item.fp.trim() !== '' ? item.fp.trim() : null;
						// ① 有 fp ⇒ 按 fp 认；② 没 fp ⇒ 按正文精确认（「按 text 精确去重」）。
						const found = given !== null ? byFp.get(given) : byText.get(text);
						if (found !== undefined) {
							updateExisting.run(
								text,
								source ?? found.source_ref ?? null,
								// `track` 只在调用方**明确给了**时才改派生列；没给就保留旧值（COALESCE 让 null 落回原列）。
								trackGiven ? (itemTrack === 'user' ? 'preference' : 'lesson') : null,
								trackGiven ? (itemTrack === 'user' ? '知识' : '行为') : null,
								found.entry_id,
							);
							updated += 1;
							continue;
						}
						const fp = given ?? fpOf(text);
						const fragmentType = itemTrack === 'user' ? 'preference' : 'lesson';
						const kind = itemTrack === 'user' ? '知识' : '行为';
						try {
							insertEntry.run(
								randomUUID(), fp, 'longterm', fragmentType, kind, '自动', text,
								10, 0, 0, new Date().toISOString(), 'active', source, 'user',
							);
						} catch (error) {
							// ⚠️ 32 位指纹撞车（同 fp、不同正文）：**不覆盖别人**，退回无 fp 插入
							//（`fp` 列允许 NULL 且 UNIQUE 不管 NULL，条目照样落库）。
							if (!String(error?.message ?? error).includes('UNIQUE')) throw error;
							insertEntry.run(
								randomUUID(), null, 'longterm', fragmentType, kind, '自动', text,
								10, 0, 0, new Date().toISOString(), 'active', source, 'user',
							);
						}
						added += 1;
					}
					db.exec('COMMIT');
				} catch (error) {
					db.exec('ROLLBACK');
					throw error;
				}
			} finally {
				db.close();
			}
			return { added, updated };
		}

		/**
		 * 列某个**工作区目录**下的历史会话（只给名称，供手机端勾选同步）。
		 *
		 * ## 为什么必须在电脑端过滤（用户需求一 + 实测数据）
		 *
		 * `controller.list()` 在本机返回 **578 个会话**，每个都带完整
		 * `projections`（标题、模型、用量……），JSON 有几 MB。手机走的是免费
		 * Cloudflare 隧道，全量下发既慢又费流量。
		 *
		 * 所以过滤在电脑侧做完，**过网的只有 `{sessionId, title, updatedAt}`**。
		 * 用户原话：「只要名称」。
		 *
		 * ## 标题从哪来
		 *
		 * `dsh-session-title` 注册了投影键 `title`
		 *（`titleProjectionDefinition.apply: event.type === 'session/title' ? event.data.title : state`），
		 * 所以 `item.projections.values.title` 就是侧边栏显示的那个标题。
		 * 实测本机返回形如 `"全面了解远程插件"`。
		 *
		 * ## `archived` 从哪来（为什么不过滤）
		 *
		 * 归档状态是**本机注册表**的全局集合 `ctx.workspaceRegistry.archivedSessionIds`
		 *（其持久化形态是 `$DSH_HOME/storages/workspace.json` 的
		 * `global.archivedSessionIds`），不在 `controller.list()` 的条目里。
		 * 手机端要自己决定「隐藏还是显示已归档」，所以这里**只打标、不过滤**，
		 * 排序与其它字段一律照旧。
		 *
		 * 拿不到集合（注册表未就绪 / 字段缺失 / 形态不对）时**一律 false**，
		 * 绝不因为归档状态缺失就让整张会话列表失败。
		 *
		 * ## 清单来源：工作区挂载优先，cwd 扫描兜底（2026-10-25）
		 *
		 * 界面上的「工作区」是**实体**（`ctx.workspaceRegistry.list()` 返回的
		 * `{path, title, sessionIds}`），一份工作区挂载了哪些会话由它的
		 * `sessionIds` 决定 —— 与界面侧边栏口径完全一致。
		 * 直接按 `item.cwd === cwd` 扫 `controller.list()` 会多算：同一目录下
		 * 有些会话并未挂到这个工作区实体上（历史遗留 / 别处建的），
		 * 实测 E:\work\demo 扫出 21 条而界面只认 14 条。
		 *
		 * 所以口径改为：
		 *   1. 在注册表里找 `path === cwd`（realpath 归一后）的工作区实体，
		 *      存在就以它的 `sessionIds` 为清单来源（**为空就是空**，不再扫）；
		 *   2. 找不到实体（用户还没在电脑上建过这个工作区）才退回按 cwd 扫描，
		 *      行为与旧版逐字节一致；
		 *   3. 无论哪条路，都**只打 `archived` 标、不过滤**，排序与字段照旧。
		 *
		 * 读注册表失败（未就绪 / 没这个服务 / 形态不对）⇒ 当作「找不到实体」
		 * 退回 cwd 扫描，绝不因此让整张列表失败。
		 *
		 * @returns `{ sessions: [{sessionId, title, updatedAt, archived, blank}] }`。
		 *   `blank` 与界面同源（官方 `sessionListMetadata.blank`：还没有 `turn/start`
		 *   即空会话），供手机端隐藏「未命名」空会话；**不过滤**，只打标。
		 */
		case 'listWorkspaceSessions': {
			const cwd = params.cwd;
			if (typeof cwd !== 'string' || cwd === '') throw new Error('cwd required');
			assertWorkspaceAllowed(cwd);
			// ⚠️ 用 `realpath` 归一后再比：手机传来的是它记忆里的路径，而电脑上
			// 同一个目录可能经符号链接/短路径名到达，直接字符串比会漏。
			let canonical = cwd;
			try {
				canonical = realpathSync(cwd);
			} catch {
				// 目录不在了就按原样比，至少不会抛错让整个列表失败。
			}
			const norm = (value) => (process.platform === 'win32' ? value.toLowerCase() : value);
			const want = norm(canonical);
			const result = await controller.list({});
			const items = result?.items ?? [];
			// 归档 id 集合取自工作区注册表（内存里的权威形态）。任何一步拿不到就退回
			// 空集合 ⇒ 全部 false，不抛错。
			let archivedIds = new Set();
			try {
				// 官方使用处一律 `.map(String)`（见工作区 controller 的 baseline），
				// 这里照同一口径归一，避免 id 形态不同导致 `has` 永远 false。
				const raw = ctx.workspaceRegistry?.archivedSessionIds;
				archivedIds = new Set((Array.isArray(raw) ? raw : []).map((id) => String(id)));
			} catch {
				archivedIds = new Set();
			}
			// 清单来源：先找 `path === cwd` 的工作区实体，用它挂载的 `sessionIds`。
			// `null` = 没找到实体 ⇒ 退回下面的 cwd 扫描（旧行为）。
			let mountedIds = null;
			try {
				const workspaces = ctx.workspaceRegistry?.list?.();
				if (Array.isArray(workspaces)) {
					const entity = workspaces.find(
						(workspace) => typeof workspace?.path === 'string' && norm(workspace.path) === want,
					);
					if (entity !== undefined) {
						const raw = entity.sessionIds;
						if (Array.isArray(raw)) mountedIds = new Set(raw.map((id) => String(id)));
					}
				}
			} catch {
				mountedIds = null;
			}
			const sessions = [];
			for (const item of items) {
				if (typeof item?.cwd !== 'string') continue;
				// 有工作区实体：只认它挂载的 id（归档的**不**过滤，手机端自己决定）；
				// 没实体：老口径 —— cwd 归一后全等。
				if (mountedIds !== null) {
					if (!mountedIds.has(String(item.sessionId))) continue;
				} else if (norm(item.cwd) !== want) continue;
				const title = item?.projections?.values?.title;
				// `blank` 判据 = 界面的判据，不是另发明一套：
				// 界面侧栏读官方 `sessionListMetadata` 投影（`dsh-api-session-controller/
				// lib/index.js:1907-1920` 注册，init 即 `{blank:true}`；`:1873` 的 apply
				// 只在收到 `turn/start` 时把它转 false），列表条目本身已由它算出
				// （`:1949` 活会话 `metadata?.blank ?? session.seq === 0`、`:1999` 冷会话
				// `metadata?.blank ?? false`），客户端也是直接透传（`.../sessions/
				// manager.js:706`）。所以这里优先原样透传，不自己再判一遍事件数。
				// 万一条目形态里没有这个字段（老引擎），退回「标题为空」当判据 ——
				// 没有任何事件的会话必然没有标题，两种判据在空会话上等价。
				const blank =
					typeof item?.blank === 'boolean'
						? item.blank
						: !(typeof title === 'string' && title.trim() !== '');
				sessions.push({
					sessionId: item.sessionId,
					title: typeof title === 'string' && title !== '' ? title : '（未命名对话）',
					updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : null,
					archived: archivedIds.has(item.sessionId),
					blank,
				});
			}
			// 新的排前面 —— 用户要同步的多半是最近聊过的。
			sessions.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
			return { sessions };
		}

		/**
		 * 归档 / 取消归档一个会话（手机按钮 → 电脑侧权威状态）。
		 *
		 * 归档状态是**电脑侧**的全局集合
		 *（`ctx.workspaceRegistry.archivedSessionIds`，持久化在
		 * `$DSH_HOME/storages/workspace.json` 的 `global.archivedSessionIds`），
		 * 手机本地没有这份数据，所以必须由这条 RPC 改电脑的状态，两边才一致。
		 *
		 * 官方契约（`@deepseek-ai/dsh-workspace/lib/index.js:527` / `:554`）：
		 *   - `archiveSession(sessionId)`：会话必须存在（活会话或已落盘），否则抛
		 *     `WorkspaceUnknownSessionError`；**不带 `stopActivity` 时**会话若有
		 *     进行中的工作会抛 `WorkspaceActiveSessionError`（界面此时弹的也是
		 *     「停止并归档」确认框）。这里**不**替用户停工作 —— 停工作是破坏性的，
		 *     要停请在电脑上确认；被拒就原样回 `{ok:false}`，让手机端提示。
		 *   - `unarchiveSession(sessionId)`：只从集合里删，不校验会话是否存在，
		 *     重复调用幂等。
		 *
		 * ## 为什么一律 `{ok:false, reason}` 而不抛
		 *
		 * 失败原因（会话不存在 / 注册表没就绪 / 方法缺失 / 会话仍在跑）在手机端
		 * 都是「弹一句提示」级别的信息，抛错会让整条 RPC 变成传输层错误，
		 * 手机拿不到可读原因。所以这里全部兜成结构化结果。
		 *
		 * @param params.sessionId - 目标会话 id（必需的字符串）。
		 * @param params.archived - `true` 归档、`false` 取消归档（必需的布尔）。
		 * @returns `{ok:true, archived}`；任何失败 ⇒ `{ok:false, reason}`（从不抛）。
		 */
		case 'archiveSet': {
			const sessionId = params?.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') {
				return { ok: false, reason: 'sessionId required' };
			}
			const archived = params?.archived;
			if (typeof archived !== 'boolean') {
				return { ok: false, reason: 'archived must be a boolean' };
			}
			const registry = ctx.workspaceRegistry;
			const method = archived ? 'archiveSession' : 'unarchiveSession';
			if (registry === undefined || typeof registry?.[method] !== 'function') {
				return { ok: false, reason: `${method} 不可用（workspaceRegistry 未就绪或缺少该方法）` };
			}
			try {
				await registry[method](sessionId);
				return { ok: true, archived };
			} catch (error) {
				return {
					ok: false,
					reason: error instanceof Error ? error.message : String(error),
				};
			}
		}

		/**
		 * 把若干**已归档**的会话移进回收站（0.18.2）。
		 *
		 * ## 为什么是「移到回收站」而不是 `rm -rf`
		 *
		 * DSH 本身**没有**删除会话的 API：`SessionCommandController` 只有 create /
		 * prompt / cancel / fork / rename / archive，客户端的会话右键菜单也只有
		 * 「归档 / 取消归档」（`dsh-client-ui-workspace` 里根本没有删除会话的菜单项）。
		 * 所以真要删只能动落盘目录 —— 那是**不可逆**的，路径算错就把用户历史毁了。
		 *
		 * 因此这里三道闸：
		 * ① 调用方必须显式列出 id，服务端再拿 `archivedSessionIds` 校验一遍
		 *   —— **只删已归档的**，手滑传了活跃会话会被拒；
		 * ② 不 `rm`，只把 `sessions/<工作区>/<sessionId>/` 整个 `rename` 到
		 *   `<DSH_HOME>/dsh-remote/trash-<时间戳>/` —— 后悔了直接搬回去；
		 * ③ 支持 `dryRun: true`，先看会删哪些、再真删。
		 *
		 * @param params.ids - 要删的会话 id 数组（必须都是已归档的）。
		 * @param [params.dryRun] - 只报告，不动文件。
		 * @returns `{ ok, deleted, skipped, trashDir, dryRun }`。
		 */
		case 'sessionDelete': {
			const ids = Array.isArray(params?.ids)
				? params.ids.filter((id) => typeof id === 'string' && id !== '')
				: [];
			if (ids.length === 0) return { ok: false, reason: 'ids required' };
			if (ctx.workspaceRegistry === undefined) return { ok: false, reason: 'workspaceRegistry 未就绪' };
			const archived = new Set(ctx.workspaceRegistry.archivedSessionIds ?? []);
			const sessionsRoot = join(dirname(stateDirOf()), 'sessions');
			const stamp = new Date().toISOString().replace(/[:.]/g, '-');
			const trashDir = join(stateDirOf(), `trash-${stamp}`);
			const dryRun = params?.dryRun === true;
			const deleted = [];
			const skipped = [];
			for (const id of ids) {
				if (!archived.has(id)) {
					skipped.push({ id, reason: 'not-archived' });
					continue;
				}
				// 会话目录名 = sessionId，它挂在「按 cwd 编码」的工作区目录下；
				// 不猜编码规则，直接在 sessions 下逐层找（通常只有几个工作区目录）。
				let found = '';
				try {
					for (const entry of readdirSync(sessionsRoot, { withFileTypes: true })) {
						if (entry.isDirectory() !== true) continue;
						const candidate = join(sessionsRoot, entry.name, id);
						if (existsSync(candidate)) {
							found = candidate;
							break;
						}
					}
				} catch (error) {
					skipped.push({ id, reason: `read: ${String(error?.message ?? error)}` });
					continue;
				}
				if (found === '') {
					skipped.push({ id, reason: 'dir-not-found' });
					continue;
				}
				if (dryRun) {
					deleted.push(id);
					continue;
				}
				try {
					mkdirSync(trashDir, { recursive: true });
					renameSync(found, join(trashDir, id));
					deleted.push(id);
				} catch (error) {
					skipped.push({ id, reason: String(error?.message ?? error) });
				}
			}
			if (dryRun !== true && deleted.length > 0) {
				void debugLog(`sessionDelete：${deleted.length} 个归档会话已移入回收站 ${trashDir}`);
			}
			return { ok: true, deleted, skipped, trashDir, dryRun };
		}

		/**
		 * 读一段历史（按需、分页，供手机端「点进去才加载」）。
		 *
		 * 直接转发官方 `controller.page()`
		 *（`dsh-api-session-controller/lib/index.js:2954` → `history.page()`），
		 * 它返回 `{ records, hasMore }`，是纯 JSON，正好能过隧道。
		 *
		 * ## 为什么这条路径是对的（而不是把历史全搬到手机）
		 *
		 * 手机本地 session 的 seq 是**连续从 0 开始**的
		 *（`dsh-session/lib/index.js:1195` 的 `get seq() { return this.log.length }`，
		 * `append()` 里 `seq: SessionSeq(this.log.length)` 写死），
		 * 所以「只在手机存最近 10 条」物理上不可能 —— 中间会留一个巨大的 seq 空洞。
		 *
		 * 因此同步来的会话**不在手机落一份完整日志**，而是：
		 *   - 打开时读最后一页（`beforeSeq` 不传 = 从尾部往前）
		 *   - 上滑时带上已加载的最小 seq 继续往前翻
		 *
		 * 实测带宽差：最大的会话全量 155 MB，而「最近 10 条」只要 131 KB —— 1200 倍。
		 *
		 * @returns `{ records, hasMore }`。
		 */
		/**
		 * 读某会话在**电脑上算好的投影**（`tokenUsage` / `contextPressure` / `title` …）。
		 *
		 * ## 为什么必须单独开一个 RPC（用户 2026-10-21 报障）
		 *
		 * 用户原话：「底部的 token 信息以及上下文信息，都没有显示了」。
		 *
		 * 手机端显示底部那两段，唯一的数据源是 `follow` 首帧里的
		 * `projections.values.tokenUsage` / `.contextPressure`
		 *（依据 `dsh-client-ui-chat/lib/client.js` 的 `UsagePill`：
		 * `const usage = useProjection("tokenUsage"); if (usage === void 0) return null;`
		 * —— 拿不到就**整块不渲染**，不是显示 0）。
		 *
		 * 而同步来的会话在手机上**没有本地日志**，本地投影永远是空的。
		 * 原本想复用 `readHistory` 返回的 `projections`，但那行不通：
		 * `SessionHistoryController.page()`（`dsh-api-session-controller/lib/index.js:1475`）
		 * 只返回 `{ records, hasMore }` —— **根本没有 projections 字段**。
		 * 带 projections 的是 `follow()` 的首帧，不是 `page()`。
		 *
		 * 所以这里直接读投影服务。两条路（与官方 `projectionsFor` 一致）：
		 *
		 *   1. 活会话 ⇒ `ctx.sessionProjections.cachedSnapshot(session)`；
		 *   2. 冷会话 ⇒ `ctx.get('sessionProjectionCache').cachedSnapshot(header)`。
		 *
		 * 冷会话那条会读**磁盘上的投影缓存**，所以 App 没打开过的会话也能拿到 ——
		 * 这正是同步会话的常态。
		 *
		 * @returns `{ projections: { asOfSeq, values } }`，拿不到时 `values` 为空对象。
		 */
		case 'readProjections': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			/** 只挑前端真正消费的键，避免把 `inbox` / `todos` 这类时序敏感的东西带过去。 */
			const pick = (values) => {
				const out = {};
				if (values === null || typeof values !== 'object') return out;
				if (values.tokenUsage !== undefined) out.tokenUsage = values.tokenUsage;
				if (values.contextPressure !== undefined) out.contextPressure = values.contextPressure;
				if (typeof values.title === 'string' && values.title !== '') out.title = values.title;
				return out;
			};
			// ① 活会话：内存投影最准。
			try {
				const live = ctx.sessions?.get?.(sessionId);
				if (live !== undefined && live !== null) {
					const block = ctx.sessionProjections?.cachedSnapshot?.(live);
					if (block !== undefined && block !== null) {
						const values = pick(block.values);
						if (Object.keys(values).length > 0) {
							return { projections: { asOfSeq: block.asOfSeq, values } };
						}
					}
				}
			} catch (error) {
				void debugLog(`readProjections 内存投影失败 ${sessionId}: ${String(error?.message ?? error)}`);
			}
			// ② 冷会话：读磁盘投影缓存。
			try {
				const cache = ctx.get?.('sessionProjectionCache');
				const header = { id: sessionId };
				const block =
					(typeof cache?.cachedSnapshot === 'function' ? cache.cachedSnapshot(header) : undefined) ??
					(typeof cache?.cachedPredecessorTitle === 'function' ? cache.cachedPredecessorTitle(header) : undefined);
				if (block !== undefined && block !== null) {
					const values = pick(block.values);
					if (Object.keys(values).length > 0) {
						return { projections: { asOfSeq: block.asOfSeq, values } };
					}
				}
			} catch (error) {
				void debugLog(`readProjections 磁盘投影失败 ${sessionId}: ${String(error?.message ?? error)}`);
			}
			return { projections: { asOfSeq: -1, values: {} } };
		}

		case 'readHistory': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			if (typeof controller.page !== 'function') throw new Error('controller.page 不可用');
			const address = { kind: 'session', sessionId };
			// ⚠️⚠️ **`throughSeq` 是必填项，而且它必须与 `beforeSeq` 配套算。**
			//
			// ## 为什么必填
			//
			// `SessionHistoryController.page` 的第一行就是
			// `validatePageRequest(request)`，要求
			// `Number.isSafeInteger(request.throughSeq) && request.throughSeq >= -1`
			//（`dsh-api-session-controller/lib/index.js:1373`）—— 不传直接抛
			// `gateway/bad-request: throughSeq must be an integer greater than or equal to -1`。
			// 官方前端永远带：`readPage(request, throughSeq, signal)` 把
			// `currentCursor()` 塞进去（`lib/client.js:427`）。
			//
			// ## 为什么不能简单地固定成 -1
			//
			// `paginate()`（同文件 `:1601`）的取页区间是
			//
			// ```js
			// const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1);
			// ```
			//
			// 传 `throughSeq = -1` 又带 `beforeSeq` 时，`end = Math.min(0, beforeSeq) = 0`
			// ⇒ `events.slice(cut, 0)` **永远是空数组**。「上滑加载更多」会拿到
			// 一页空数据，前端判成「历史到顶了」，加载更多直接失效。
			//
			// 所以这里把 `beforeSeq` 翻译成上界：`throughSeq = beforeSeq - 1`。
			// 语义正是「要 beforeSeq 之前的那些」，与前端 `prepend` 的意图一致
			//（它要的是 `firstCursor` 之前的一页，而 `beforeSeq` 就是 `firstCursor`）。
			//
			// 不传 `beforeSeq`（首屏）时用「日志末尾的 seq」，见下面那段 ⚠️。
			const hasBefore =
				typeof params.beforeSeq === 'number' && Number.isSafeInteger(params.beforeSeq) && params.beforeSeq >= 0;
			// ⚠️⚠️ **首屏（没有 `beforeSeq`）绝对不能用 `throughSeq = -1`。**
			//
			// 实测验证过（复刻 `paginate()` 跑了一遍）：`throughSeq = -1` 时
			//
			// ```js
			// const end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)  // = min(0, 0) = 0
			// return { events: events.slice(cut, 0), ... }                       // ← 永远空数组
			// ```
			//
			// 也就是说 `-1` 不是「不限上界」的哨兵，而是「取到第 -1 条为止」= 空。
			// 官方前端首屏**根本不走 `page`**（走 `follow` 的 snapshot），所以这个
			// 坑在官方代码里暴露不出来；我们主动用 `page` 取尾部一页，就会踩到。
			//
			// 正确做法：自己算出「日志末尾的 seq」传进去。
			// `dsh-session/lib/index.js:1195` 的 `get seq() { return this.log.length }`
			// 是 O(1)，取它再减 1 就是最后一条的 seq。
			//
			// ⚠️ **`ctx.sessions.get()` 只返回内存里活着的会话**，冷会话（很久没碰、
			// 已从内存卸载的）会返回 `undefined`。不能因为拿不到就断定它是空的。
			//
			// 所以策略是：能拿到 `seq` 就直接用它当上界；拿不到（冷会话）就走
			// `sessionQuery.observeSession()` 读它自带的 `cursor` —— 见下面那段 ⚠️。
			let total = -1;
			try {
				const local = ctx.sessions?.get?.(sessionId);
				if (local !== undefined && typeof local.seq === 'number') total = local.seq;
			} catch {
				total = -1;
			}
			if (total === 0) {
				// 确定是空会话（在内存里且 seq 为 0）：`page()` 对空会话必然抛
				// 「past cursor -1」，直接给空页，别让它报错。
				return { records: [], hasMore: false };
			}
			if (total < 0 && !hasBefore) {
				// ⚠️ **冷会话（不在内存里）的首屏**：`ctx.sessions.get()` 返回
				// `undefined`，拿不到末尾 seq。
				//
				// ⚠️ **不能用 `page({throughSeq: 0})` 探测来“激活”会话**：
				// `page()` 内部走 `sourceFor()` → `sessionQuery.observeSession()`，
				// 那是**只读观测**，**不会**把这个会话塞进 `ctx.sessions`。
				// 探完之后 `sessions.get()` 照样是 `undefined`（这一点查过源码，
				// `sourceFor` 只碰 `sessionQuery`，不碰 `sessions`）。
				//
				// 正解：走同一个 `sessionQuery`。它返回的 observation **自带
				// `cursor`**（`dsh-session-query/lib/index.js:487`：
				// `cursor: seq === 0 ? -1 : SessionSeq(seq - 1)`）—— 那正是
				// 「日志末尾那条的 seq」，也就是我们要的 `throughSeq`，不用自己算。
				//
				// ⚠️ **不要读 `observation.events`**：它是**懒加载 getter**
				//（同文件 `:485` 的 `materialized ??= session.snapshotEvents(...)`），
				// 一碰就会把整份日志快照进内存 —— 对大历史会话正是 155 MB 那个量级。
				// 只读 `cursor` / `inheritedEventCount` 这类标量就没有这个代价。
				//
				// ⚠️ observation 带 `[Symbol.dispose]`，**必须** dispose，
				// 否则每次同步会话首屏都漏一份观测租约。
				const query = ctx.get?.('sessionQuery');
				if (query === undefined || query === null || typeof query.observeSession !== 'function') {
					return { records: [], hasMore: false };
				}
				let observation;
				try {
					observation = await query.observeSession(sessionId, { projectionMode: 'none' });
					const cursor = observation?.cursor;
					// `cursor === -1` ⇒ 空会话；否则末尾 seq = cursor。
					total = typeof cursor === 'number' && Number.isSafeInteger(cursor) ? cursor + 1 : 0;
				} catch {
					// 会话不存在 / 持久化读失败 —— 按空页处理。
					total = 0;
				} finally {
					try {
						observation?.[Symbol.dispose]?.();
					} catch {
						/* dispose 失败不影响返回 */
					}
				}
				if (total === 0) return { records: [], hasMore: false };
			}
			// `total > 0` ⇒ 末尾 seq = total - 1。
			// 仍然 `-1` ⇒ 极端的冷会话兜底：`throughSeq: 0`（至少能看到最早一页）。
			//
			// ⚠️⚠️ **手机端显式给了 `throughSeq` 时必须原样用，不能再自己算。**
			//
			// 这是 1.0.22 真机踩到的硬坑：前端 `RemoteJournalStream.prepend()`
			// 拿到 page 后立刻 `assertPageThrough(page, through)`，判据是
			// **`tail(entries) === through`（精确相等）**，不等就抛
			// `session event stream page did not end at its requested cursor`，
			// 界面显示「历史加载失败」。
			//
			// 也就是说：**这一页的最后一个事件 seq 必须精确等于 `throughSeq`**。
			// 手机端手里就有前端的 `throughSeq`（同一个 seq 坐标系），透传过来
			// 比电脑端猜「最后一条在哪」可靠得多 —— 尤其用户刚发过消息时，
			// 两边的「末尾」会差一拍。
			const hasThrough =
				typeof params.throughSeq === 'number' &&
				Number.isSafeInteger(params.throughSeq) &&
				params.throughSeq >= -1;
			let throughSeq;
			if (hasThrough) {
				throughSeq = params.throughSeq;
			} else if (hasBefore) {
				throughSeq = params.beforeSeq - 1;
			} else if (total > 0) {
				throughSeq = total - 1;
			} else {
				throughSeq = 0;
			}
			const request = { address, throughSeq };
			// ⚠️ **不再传 `beforeSeq`**：`paginate()` 里
			// `end = Math.min(throughSeq + 1, beforeSeq ?? throughSeq + 1)`，
			// 而 `throughSeq` 已经等于 `beforeSeq - 1`，两者算出来一模一样。
			// 少传一个字段就少一处「两个上界不一致」的可能。
			request.maxMessages =
				typeof params.maxMessages === 'number' && Number.isSafeInteger(params.maxMessages) && params.maxMessages > 0
					? params.maxMessages
					: 10;
			// ⚠️ **`throughSeq` 超出电脑实际末尾时要夹回末尾**，不能让 `page()`
			// 抛 `session page through seq N is past cursor M`。
			//
			// 什么时候会超：手机端手里的 `throughSeq` 来自它自己的实时流游标，
			// 而电脑那边的日志可能还没追上（或用户刚在手机上发了一条、电脑的
			// 那条还没落盘）。夹回末尾至少能返回一页真实数据，比整页报错好 ——
			// 前端 `assertPageThrough` 仍然要求 `tail === throughSeq`，所以
			// **夹回之后必须把 `throughSeq` 一起改成实际的 tail**，否则前端照样抛。
			//
			// 实现方式：先按请求的 `throughSeq` 取，取到之后看 tail；
			// tail 与请求值不等就说明被夹过，此时返回真实 tail（前端会拿
			// `page` 的 entries 自行判断，`assertPageThrough` 用的是它**自己的**
			// `through`，所以这里必须让两者一致 —— 见下面 catch 的处理）。
			try {
				return await controller.page(request, idleSignal());
			} catch (error) {
				const message = String(error?.message ?? error);
				// 只兜「through 越界」这一种，其余照旧抛（那是真 bug，不该吞）。
				if (message.indexOf('is past cursor') < 0) throw error;
				// 越界 ⇒ 退回「末尾一页」：拿 `total - 1`（冷会话则是 0）。
				const fallback = total > 0 ? total - 1 : 0;
				if (fallback === throughSeq) throw error;
				request.throughSeq = fallback;
				return await controller.page(request, idleSignal());
			}
		}

		/**
		 * 读一张图片附件的原始字节（给手机端回看历史用）。
		 *
		 * ## 为什么需要（这是「手机上自己发的图看不到」的根因）
		 *
		 * 同步会话在手机本地不落盘、不存附件，所以前端 `MessageImage` 走
		 * `remote.session.attachment({sessionId, attachmentId})` 时，
		 * 手机本地引擎找不到那张图 ⇒ reject ⇒ 缩略图显示「图片加载失败」。
		 *
		 * 而**图片本身是电脑存的**（手机发消息时把 base64 内联在 `prompt` 里，
		 * 电脑用 `attachments.admitPromptContent` 落盘）。所以正确的读法就是
		 * 问电脑要。
		 *
		 * 直接转官方 `controller.attachment()`（`dsh-api-session-controller/lib/index.js:911`），
		 * 它返回 `{ attachment: ref, data: base64 }` —— 与手机端前端
		 * `readAttachment()` 期望的形状**逐字一致**，所以客户端零改动。
		 *
		 * ⚠️ **不要自己用 `attachments.readImage()` 重写**：官方那条分支还做了
		 * 两个必要检查 ——
		 *   1. `readSessionState()` 确认会话存在（否则报 session/not-found）；
		 *   2. `referencedImage(events, attachmentId)` 确认这张图**确实被该会话引用**。
		 * 少了第 2 条，任何人拿到 attachmentId 就能读走会话里的任意图片，
		 * 那是个越权漏洞。
		 */
		case 'attachment': {
			const sessionId = params.sessionId;
			const attachmentId = params.attachmentId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			if (typeof attachmentId !== 'string' || attachmentId === '') throw new Error('attachmentId required');
			if (typeof controller.attachment !== 'function') throw new Error('controller.attachment 不可用');
			return await controller.attachment({ sessionId, attachmentId });
		}

		/**
		 * 按 **seq 区间**读一段原始事件（给手机端补洞用）。
		 *
		 * 与 `readHistory` 的区别：那个按「消息边界」分页（`paginate()`），
		 * 返回的是一组完整的 user/assistant 消息；这个按 seq 精确切片，
		 * 用于「手机端发现事件跳号，要把中间缺的那几条捞回来」。
		 *
		 * `fromSeq` / `toSeq` 都是**闭区间**，且必须是安全整数。
		 * 返回 `{ events }`，按 seq 升序、保证连续。
		 *
		 * ⚠️ 这是**兜底路径**，正常不会走（电脑端 SSE 已经保证从 `fromSeq`
		 * 之后连续推送）。所以不追求效率，只追求「一条不漏、一条不多」。
		 * ⚠️ 一次最多回 `maxEvents`（默认 200）条：补洞场景缺口必然很小，
		 * 缺口大到这个量级说明流已经彻底错乱，该整条重开而不是硬补。
		 */
		case 'readEventRange': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			const fromSeq = params.fromSeq;
			const toSeq = params.toSeq;
			if (typeof fromSeq !== 'number' || !Number.isSafeInteger(fromSeq) || fromSeq < 0) {
				throw new Error('fromSeq must be a non-negative integer');
			}
			if (typeof toSeq !== 'number' || !Number.isSafeInteger(toSeq) || toSeq < fromSeq) {
				throw new Error('toSeq must be an integer >= fromSeq');
			}
			// ⚠️ `maxEvents` 是**客户端**传的，必须夹到服务端硬上限（P2-3）。
			//
			// 冷会话有 `COLD_RANGE_LIMIT` 兜底，但**活会话没有**：`maxEvents`
			// 原样取调用方的值，于是 `toSeq = 1e9` 能一路通过下面的上限判断，
			// 把活会话 `snapshotEvents()` 物化出来的整份日志按区间搬出去
			//（实测 29638 条 / 155 MB）—— 一次请求打满内存与带宽。
			//
			// 夹的是**服务端常量**：调用方可以说「我最多要 200 条」，但不能说
			// 「我要 10 亿条」。
			const maxEvents = Math.min(
				typeof params.maxEvents === 'number' && Number.isSafeInteger(params.maxEvents) && params.maxEvents > 0
					? params.maxEvents
					: 200,
				COLD_RANGE_LIMIT,
			);
			if (toSeq - fromSeq + 1 > maxEvents) {
				throw new Error(`range too large (${toSeq - fromSeq + 1} > ${maxEvents})`);
			}
			// 和 `readHistory` 一样：活会话直接快照，冷会话走 `sessionQuery`。
			const live = ctx.sessions?.get?.(sessionId);
			let source = null;
			if (live !== undefined && typeof live.snapshotEvents === 'function') {
				source = live.snapshotEvents();
			} else {
				// ⚠️ **冷会话要物化整份日志，必须设上限。**
				//
				// `observation.events` 是惰性 getter，一碰就把整个日志快照进内存。
				// 实测本机最大的会话是 41 MB 磁盘 / **155 MB 明文 / 29638 条** ——
				// 为了补一两条缺口把它整份读进内存是不可接受的。
				//
				// 所以先只读标量 `cursor`（末尾 seq），超过上限就直接放弃：
				// 补洞是**兜底**，放弃的后果只是手机端断流重连一次，而重连时
				// SSE handler 会用同样的 `sessionQuery` 补齐（那边是必须做的），
				// 代价已经在那里付过一次，这里不该再付一次。
				const query = ctx.get?.('sessionQuery');
				if (query === undefined || query === null || typeof query.observeSession !== 'function') {
					return { events: [] };
				}
				let observation;
				try {
					observation = await query.observeSession(sessionId, { projectionMode: 'none' });
					const cursor = observation?.cursor;
					const total = typeof cursor === 'number' && Number.isSafeInteger(cursor) ? cursor + 1 : 0;
					if (total === 0) return { events: [] };
					// 超过上限（大历史会话）就不物化，让手机端走重连。
					if (total > COLD_RANGE_LIMIT) {
						ctx.logger?.warn?.(
							`[dsh-link] 会话 ${sessionId} 有 ${total} 条事件，超过补洞上限 ${COLD_RANGE_LIMIT}，放弃补发`,
						);
						return { events: [] };
					}
					const events = observation?.events;
					source = Array.isArray(events) ? events : null;
				} catch {
					source = null;
				} finally {
					try {
						observation?.[Symbol.dispose]?.();
					} catch {
						/* dispose 失败不影响返回 */
					}
				}
				if (source === null) return { events: [] };
			}
			// 按 seq 取闭区间。`source` 的 seq 是连续 0..N-1，所以直接用下标，
			// 但仍然逐条校验 seq —— 万一底层不是从 0 开始（继承的历史），
			// 下标偏移会悄悄错位，那比返回空更糟。
			const events = [];
			for (let seq = fromSeq; seq <= toSeq; seq += 1) {
				const event = source[seq];
				if (event === undefined || event === null) break;
				if (event.seq !== seq) break;
				events.push(event);
			}
			return { events };
		}

		/**
		 * 电脑上的模型目录（供手机把「模型选择」列表换成电脑的）。
		 *
		 * ⚠️ **必须走 `controller.modelCatalog()`，不能自己去读配置**：它是官方的
		 * 模型目录构建器（`buildModelCatalog`），已经把「哪些 provider 可用、
		 * 每个模型支持哪些 reasoning effort」都算好了，而且失败会按 provider
		 * 隔离成 `failures` 而不是整体抛错。自己读配置只会得到一份对不上官方
		 * 前端的结构。
		 *
		 * @returns `{ default, routableProviders, groups, failures }`。
		 */
		case 'modelCatalog': {
			if (typeof controller.modelCatalog !== 'function') throw new Error('modelCatalog 不可用');
			return await controller.modelCatalog();
		}

		/**
		 * 在电脑上选定模型（手机的模型选择器选中的是电脑的模型时转发过来）。
		 *
		 * ⚠️ 不转发的话，手机本地 `selectModel` 会拿**手机**的 llm 注册表去校验，
		 * 电脑上独有的模型一律报「模型不可用」—— 而用户明明在菜单里看到了它。
		 */
		case 'selectModel': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			if (typeof controller.selectModel !== 'function') throw new Error('selectModel 不可用');
			const selected = await controller.selectModel({
				sessionId,
				provider: params.provider,
				model: params.model,
				...(typeof params.reasoningEffort === 'string' && params.reasoningEffort !== ''
					? { reasoningEffort: params.reasoningEffort }
					: {}),
			});
			return { sessionId, selected: selected?.selected ?? null };
		}

		/**
		 * 电脑上的预设列表（供手机把「预设」列表换成电脑的）。
		 *
		 * `agentPresets.remoteExportList()` 是官方给前端用的那份结构
		 * （`{presets: [{id, name, description, order, isDefault}]}`），
		 * 比 `list()` 多一个 `isDefault` —— 手机要照它显示「默认」标记。
		 */
		case 'presetList': {
			const presets = ctx.get?.('agentPresets');
			if (presets === undefined || typeof presets.remoteExportList !== 'function') {
				throw new Error('agentPresets 不可用');
			}
			return await presets.remoteExportList();
		}

		/**
		 * 读某个会话的权限预设（手机端「权限」挡位的数据源）。
		 *
		 * ## 数据源（官方投影，不自己猜）
		 *
		 * `permissions` 是 `dsh-permission-presets` 注册的会话投影
		 *（`lib/index.js:188-201`，stateVersion 2）。它有两种读法：
		 *
		 *   · **客户端视图**（wire）：只有 `currentValue` 一个字段 —— 就是官方前端
		 *     `useProjection("permissions")` 拿到的那个值；
		 *   · **宿主态**（stateOf）：`{preset, sandbox, approval, seeded}` 四个字段
		 *     （schema 在同文件 `:62-71`）。
		 *
		 * 所以这里分两段取：
		 *   · `preset` ← `sessionProjections.snapshot(session, ['permissions'])` 的
		 *     `values.permissions.currentValue`；
		 *   · `sandbox` / `approval` ← `permissionPresets.permissionState(session)`
		 *     （它内部就是 `sessionProjections.stateOf(session, 'permissions')`）。
		 *
		 * 冷会话（不在内存里）退回官方 `sessionProjectionCache`：那里只存客户端
		 * 视图，所以只能给 `preset`，两个挡位按约定给 `null`。
		 * **拿不到一律返回三个 null，不抛** —— 这是只读展示通道。
		 *
		 * @returns `{preset, sandbox, approval}`（拿不到的字段为 null）。
		 */
		case 'permissionGet': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			/** 约定返回：三个字段都是 null。 */
			const unknown = { preset: null, sandbox: null, approval: null };
			// ① 活会话：投影给 preset，预设服务给两个挡位。
			const session = ctx.sessions?.get?.(sessionId);
			if (session !== undefined && session !== null) {
				try {
					const presets = ctx.get?.('permissionPresets');
					let preset = null;
					try {
						// ⚠️ `sessionProjections` 不在本插件 `inject` 里，走 `ctx.get`（官方
						// 注释原文：读取服务、无 inject 要求，cordis `ReflectService.get`）。
						// 用 `snapshot` 而不是 `cachedSnapshot`：后者只读已物化的 cell、
						// 不 fold 历史，冷加载过的会话会拿不到值。
						const projections = ctx.get?.('sessionProjections');
						const snapshot =
							typeof projections?.snapshot === 'function'
								? projections.snapshot(session, ['permissions'])
								: undefined;
						const value = snapshot?.values?.permissions?.currentValue;
						if (typeof value === 'string' && value !== '') preset = value;
					} catch (error) {
						void debugLog(`permissionGet 读投影失败 ${sessionId}: ${String(error?.message ?? error)}`);
					}
					let sandbox = null;
					let approval = null;
					if (typeof presets?.permissionState === 'function') {
						try {
							const state = presets.permissionState(session);
							if (typeof state?.sandbox === 'string') sandbox = state.sandbox;
							if (typeof state?.approval === 'string') approval = state.approval;
						} catch (error) {
							void debugLog(`permissionGet 读宿主态失败 ${sessionId}: ${String(error?.message ?? error)}`);
						}
					}
					// 投影服务不可用时的兜底：`current(session)` 内部也是同一个投影。
					if (preset === null && typeof presets?.current === 'function') {
						try {
							const current = presets.current(session);
							if (typeof current === 'string' && current !== '') preset = current;
						} catch (error) {
							void debugLog(`permissionGet 读当前预设失败 ${sessionId}: ${String(error?.message ?? error)}`);
						}
					}
					if (preset !== null || sandbox !== null || approval !== null) return { preset, sandbox, approval };
				} catch (error) {
					void debugLog(`permissionGet 活会话失败 ${sessionId}: ${String(error?.message ?? error)}`);
				}
			}
			// ② 冷会话：官方持久化投影缓存（只有客户端视图 = preset）。
			// ⚠️ `cachedSnapshot(meta)` 用 meta 的 version/createdAt/cwd/isSeeded 做
			// **生命周期绑定**（`dsh-session-projection-cache/lib/index.js:363-407`），
			// 只传 `{id}` 会 identity 不匹配而恒拿不到 —— 所以先走官方
			// `sessionPersistence.stat()` 取权威 header，再读缓存。
			try {
				const persistence = ctx.get?.('sessionPersistence');
				const stored =
					typeof persistence?.stat === 'function' ? await persistence.stat(sessionId).catch(() => undefined) : undefined;
				const header = stored?.header;
				const cache = ctx.get?.('sessionProjectionCache');
				if (header !== undefined && typeof cache?.cachedSnapshot === 'function') {
					const block = cache.cachedSnapshot(header);
					const value = block?.values?.permissions?.currentValue;
					if (typeof value === 'string' && value !== '') return { preset: value, sandbox: null, approval: null };
				}
			} catch (error) {
				void debugLog(`permissionGet 读冷会话投影失败 ${sessionId}: ${String(error?.message ?? error)}`);
			}
			return unknown;
		}

		/**
		 * 把**某个会话**的权限预设切到 `preset`（手机端的挡位选择）。
		 *
		 * ## 走哪条官方通路（按装着的 0.2.1-rc.3 实装核实）
		 *
		 * 两条都在，而且**落到同一条写路径**：
		 *
		 *   · `permissionPresets.set(session, name)`（`permission-presets/lib/index.js:344-348`）
		 *     —— 本插件用这一条：只要**活会话**、不需要 agent、**同步**完成
		 *     （内部 `session.append('permission/preset')` + `setSandboxMode` +
		 *     `setApprovalPolicy`，同文件 `:350-361`）；
		 *   · `/permission <preset>` 斜杠命令 → `commands.execute(agent, line,
		 *     submittedAttachments, signal)`（`dsh-commands/lib/index.js:327`）
		 *     —— **异步**、要 agent（`ctx.agents.get(sessionId)`）、要 `await` 它
		 *     settle；它的 handler 内部同样调 `apply()`（`permission-presets/lib/index.js:222`）。
		 *     官方前端切当前会话用的正是后者（`dsh-client-ui-permission-presets/
		 *     lib/client.js:769` 的 `live.command('/permission ' + preset)`）。
		 *
		 * 这里走 service 的 `set()`：少一层 agent / command lifecycle，行为等价。
		 *
		 * ## 返回（业务错不抛）
		 *
		 * 成功 `{ok:true, preset}`；预设不在 catalog / 会话没加载 / 写入失败
		 * 一律 `{ok:false, reason}` —— 手机端要能显示原因，不能静默。
		 *
		 * ⚠️ 只改**该会话**：`set(session, …)` 把事件写进这个会话的日志并改它的
		 * 挡位；**不**改新会话默认值（那是 settings 的 `defaultPreset`，另一条路）。
		 *
		 * @returns `{ok:true, preset}` 或 `{ok:false, reason}`。
		 */
		case 'permissionSet': {
			const sessionId = params.sessionId;
			if (typeof sessionId !== 'string' || sessionId === '') throw new Error('sessionId required');
			const preset = params.preset;
			if (typeof preset !== 'string' || preset === '') return { ok: false, reason: 'preset required' };
			const presets = ctx.get?.('permissionPresets');
			if (presets === undefined || presets === null) {
				return { ok: false, reason: 'permissionPresets 不可用（引擎还没就绪？）' };
			}
			// catalog 判据用 `names`（可切换预设，含活着时的 auto）。`catalog().options`
			// 里那个 `custom` 是「当前挡位不匹配任何预设」的**派生状态**，不是可选目标
			//（`resolve('custom')` 会抛），所以不能用它当白名单。
			let names;
			try {
				names = presets.names;
			} catch (error) {
				return { ok: false, reason: `读取 permissionPresets 失败：${String(error?.message ?? error)}` };
			}
			if (!Array.isArray(names) || !names.includes(preset)) {
				const available = Array.isArray(names) && names.length > 0 ? names.join(', ') : '无';
				return { ok: false, reason: `未知预设 "${preset}"（可用：${available}）` };
			}
			if (typeof presets.set !== 'function') {
				return { ok: false, reason: 'permissionPresets.set 不可用（引擎版本不支持）' };
			}
			const session = ctx.sessions?.get?.(sessionId);
			if (session === undefined || session === null) {
				return { ok: false, reason: `电脑上没有加载中的会话 ${sessionId}（冷会话无法切换权限预设）` };
			}
			try {
				presets.set(session, preset);
			} catch (error) {
				return { ok: false, reason: String(error?.message ?? error) };
			}
			return { ok: true, preset };
		}

		/**
		 * 读电脑端「默认设置」三件套（手机端设置页的数据源）。
		 *
		 * 读的是**新会话会用的默认值**，与 `permissionGet` 那种「某个会话的当前挡位」
		 * 不是一回事：那一条看会话语义，这一条看组合 + profile 覆盖层。
		 *
		 * 每个字段读哪条官方通路、兜底怎么走，见 `readDefaultSettings()` 的 docstring。
		 * **只读、永不抛**：读不到的字段给 null（手机端据此显示「未设置」而不是报错）。
		 *
		 * @returns `{model: {provider, model, reasoningEffort?} | null, presetId: string | null, permissionPreset: string | null}`。
		 */
		case 'settingsGet':
			return readDefaultSettings(ctx);

		/**
		 * 改电脑端「默认设置」——**只改传进来的字段**。
		 *
		 * 手机端以后用它在设置页切「默认模型 / 默认预设 / 默认权限预设」，
		 * 效果等同于电脑上改设置页：改的是**以后新建的会话**用什么，不动已有会话。
		 *
		 * 写入通路（全部官方，出处见 `writeDefaultSettings()` 的 docstring）：
		 *   · 默认模型 → `agentDefaultModel.saveSelection()`
		 *   · 默认预设 → `settings.update('agent-preset-registry', {selectedDefault})`
		 *   · 默认权限预设 → `settings.mutate('permission', [{op:'set', path:['defaultPreset']}])`
		 *
		 * 业务错一律 `{ok:false, reason}` 不抛（手机端要能显示原因）；先校验全部再写，
		 * 所以「有一个非法值」不会留下半套改动。
		 *
		 * @returns `{ok:true, applied:["model"|"presetId"|"permissionPreset", ...]}` 或 `{ok:false, reason}`。
		 */
		case 'settingsSet':
			return await writeDefaultSettings(ctx, params);

		default:
			throw new Error(`unknown method "${method}"`);
	}
}

/**
 * 启动中继 HTTP 服务。
 *
 * @param ctx - Cordis 上下文。
 * @param token - 访问令牌。
 * @returns `{ close }`。
 */
function startRelay(ctx, token) {
	/** sessionId → Set<res>：正在跟随该会话的 SSE 连接。 */
	const followers = new Map();

	/**
	 * 当前有效的访问令牌。
	 *
	 * ⚠️ **必须是可变的**：配对是**运行中**发生的，配完要立刻生效。
	 * 若把 `token` 直接闭包进 `apply()` 的常量，手机填完配对码还得手动重启
	 * DSH —— 而那正是「面向大众」最不该有的一步。
	 */
	const auth = { token };

	/** 往某会话的所有跟随者推一条 SSE。 */
	const push = (sessionId, eventName, payload) => {
		const set = followers.get(sessionId);
		if (set === undefined || set.size === 0) return;
		const chunk = sse(eventName, payload);
		for (const res of set) {
			// 死连接先清掉：`writableEnded` / `destroyed` 说明这条 SSE 早就断了，
			// 只是 `req.on('close')` 没来得及跑（手机切后台、隧道被掐）。
			// 不清的话它会一直留在集合里，让 `askPhone` 误判「手机还在」。
			if (res === null || res === undefined || res.writableEnded === true || res.destroyed === true) {
				set.delete(res);
				continue;
			}
			try {
				res.write(chunk);
			} catch (error) {
				ctx.logger?.warn?.(`[dsh-link] 推送失败: ${String(error?.message ?? error)}`);
				set.delete(res);
			}
		}
		if (set.size === 0) followers.delete(sessionId);
	};

	// ══════════════════════════════════════════════════════════════════════
	// 交互转发：把电脑端的 ask / 权限授权弹窗送到手机
	// ══════════════════════════════════════════════════════════════════════
	//
	// ## 症状（用户 2026-10-21 报）
	//
	// 「手机在远程访问电脑的时候，电脑这边工作发起了 ask 弹窗或者权限授权
	//   弹窗，手机那边都没有正常的弹出，导致用户无法选择任务卡住」
	//
	// ## 根因
	//
	// 这两类交互**根本不走会话事件流**，所以原来的 SSE 转发一条都碰不到它们：
	//
	//   · `ctx.userQuestions.ask()` → `ctx.waterfall(scopeTarget(agent), 'user-questions/request', …)`
	//     （dsh-user-questions/lib/index.js:681）
	//   · `ctx.approval.request()`  → `ctx.waterfall(scopeTarget(agent), 'approval/request', …)`
	//     （dsh-user-approval/lib/index.js:176）
	//
	// 两者都是 **cordis waterfall**：从最内层往外问，谁先给出答案谁作数。电脑端
	// 只有官方 GUI 注册了 answerer，**手机不在这个瀑布里**。所以手机连着的时候
	// 官方 GUI 会弹（用户不在电脑前看不到），而一旦 GUI 不在前台 / 没应答，
	// 瀑布走到底返回兜底值：
	//
	//   · 提问 → `NO_PROVIDER`（`no user-questions answerer accepted the request`）
	//   · 授权 → `unavailable`（fail closed，见 ApprovalService.decide 的兜底）
	//
	// 两者都让这一轮**直接失败或永久等待** —— 正是用户说的「任务卡住」。
	//
	// ## 为什么不能靠官方已有的 `dsh-api-remotes` 转发
	//
	// 官方确实把这两个事件列进了转发白名单
	// （`dsh-api-remotes/lib/index.js` 的 API_REMOTE_FORWARDED_EVENTS，
	//   mode: 'waterfall'），但它走的是 **`typertGateway` 的 Remote 通道**，
	// 而本插件的手机端连的是**自建的 `/api/dsh-remote/rpc` + `/api/dsh-remote/stream`**
	// （为了能在公网隧道上跑、且不需要官方那套 Peer 鉴权）。
	// 两条通道互不相通 ⇒ 官方转发了，手机也收不到。
	//
	// ## 做法
	//
	// 自己注册 answerer，只在「这个会话确实有手机在跟」时才接手 ——
	// 没人跟就 `next()` 放行，让官方 GUI 照常处理，绝不抢答。
	//
	// ⚠️ **注册时不能带 `{ global: true }`**：官方 `dsh-api-remotes` 注册
	//    同样这两个事件时也是裸 `ctx.on(event, fn)`、不带 options。waterfall
	//    的作用域链决定派发顺序，带上 global 会改变它 —— 而「官方 GUI 优先、
	//    手机兜底」这个顺序正是我们要的。
	//
	// ⚠️ **必须让 GUI 优先**：用户可能就坐在电脑前。官方 GUI 是在 Agent
	//    作用域内注册的，天然比本插件（插件根作用域）靠前，所以 GUI 在就会
	//    先弹、先答；GUI 不在（用户走开了）才轮到手机。不需要额外判断。

	/** 待手机回答的交互：`requestId → { resolve, reject, timer }`。 */
	const pendingAsks = new Map();

	/**
	 * 把一个交互请求推给手机并等它回答。
	 *
	 * @param sessionId - 请求所属会话。
	 * @param kind - `'question'` 或 `'approval'`。
	 * @param payload - 给手机渲染用的数据（必须是可 JSON 化的纯数据）。
	 * @param signal - 请求自带的取消信号（用户中断这一轮时触发）。
	 * @param fallback - 手机不应答时返回给 waterfall 的值（fail closed）。
	 * @returns waterfall 的应答值。
	 */
	const askPhone = async (sessionId, kind, payload, signal, fallback) => {
		const set = followers.get(sessionId);
		// ⚠️ **不能只看 `set.size`**：手机切后台 / 断网 / 隧道被掐时，
		// `req.on('close')` 未必立刻触发，`followers` 里会留下**死连接**。
		//
		// 用户 2026-10-22 报障正是这个：他**没有**在手机上远程访问电脑，
		// 但 `desktop-debug.log` 里是 `followers=1` —— 残留订阅者让这里
		// 误判「手机还在」，于是把请求推给一个根本不存在的手机。
		//
		// 现在逐个检查 socket 是否还活着：`writableEnded` / `destroyed`
		// 任一为真就说明这条 SSE 已经死了，顺手清出集合。
		const live = [];
		if (set !== undefined) {
			for (const res of set) {
				const dead = res === null || res === undefined || res.writableEnded === true || res.destroyed === true;
				if (dead) {
					set.delete(res);
					continue;
				}
				live.push(res);
			}
			if (set.size === 0) followers.delete(sessionId);
		}
		// 诊断：把「有没有手机在跟」记下来，真机排查时一眼能看出是没进这里、
		// 还是进来了但没有**活着的**订阅者。
		void debugLog(
			`askPhone kind=${kind} session=${sessionId} followers=${set === undefined ? 'none' : `${live.length}/${set.size}`} all=[${[...followers.keys()].join(',')}]`,
		);
		// 没有**活着的**手机在跟这个会话 ⇒ 立刻返回 fallback（调用方据此放行给官方 GUI）。
		if (live.length === 0) return fallback;

		const requestId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
		const settled = Promise.withResolvers();

		const cleanup = () => {
			const entry = pendingAsks.get(requestId);
			if (entry !== undefined) {
				clearTimeout(entry.timer);
				pendingAsks.delete(requestId);
			}
		};

		// 超时兜底：手机可能在锁屏 / 隧道断了 / 用户压根没看。
		// 不设超时会让这一轮**永久挂住**（用户原话「任务卡住」），比失败更糟。
		const timer = setTimeout(() => {
			cleanup();
			settled.resolve(fallback);
		}, ASK_TIMEOUT_MS);

		pendingAsks.set(requestId, { resolve: settled.resolve, reject: settled.reject, timer, kind, sessionId });

		// 用户中断这一轮（点停止生成 / 会话被删）时立刻收尾，别等超时。
		const onAbort = () => {
			cleanup();
			settled.resolve(fallback);
		};
		if (signal !== undefined) {
			if (signal.aborted) {
				onAbort();
				return settled.promise;
			}
			signal.addEventListener('abort', onAbort, { once: true });
			void settled.promise.finally(() => signal.removeEventListener('abort', onAbort));
		}

		push(sessionId, 'ask', { requestId, kind, ...payload });

		try {
			return await settled.promise;
		} finally {
			cleanup();
		}
	};

	/**
	 * 手机端回答一条待决交互（经 RPC 调进来）。
	 *
	 * @param requestId - 推送时给的那个 id。
	 * @param answer - 手机的选择（形状由 `kind` 决定）。
	 * @returns `{ ok: true }`；找不到或已超时返回 `{ ok: false, reason }`。
	 */
	const answerAsk = (requestId, answer) => {
		const entry = pendingAsks.get(requestId);
		void debugLog(
			`answerAsk requestId=${requestId} 找到挂起=${entry !== undefined} 答案=${JSON.stringify(answer)?.slice(0, 150)}`,
		);
		if (entry === undefined) return { ok: false, reason: 'expired' };
		pendingAsks.delete(requestId);
		clearTimeout(entry.timer);
		entry.resolve(answer);
		void debugLog(`answerAsk 已 resolve，等待 waterfall 继续`);
		return { ok: true };
	};

	/**
	 * `carrierKeyOf` 的运行时副本（动态加载）。
	 *
	 * ⚠️ 不用静态 `import`：`@deepseek-ai/dsh-scope` 是引擎内部包，
	 * 万一某个版本没装/改名，**静态 import 会让整个插件加载失败**
	 *（连远程功能一起没）。动态加载失败只是让 `sessionIdOf()` 退回
	 * 第二条后备，最坏情况 `next()` 放行给官方 GUI。
	 */
	let carrierKeyOfImpl = null;
	const carrierKeyReady = import('@deepseek-ai/dsh-scope')
		.then((mod) => {
			if (typeof mod.carrierKeyOf === 'function') carrierKeyOfImpl = mod.carrierKeyOf;
			void debugLog(`carrierKeyOf 加载${carrierKeyOfImpl === null ? '失败' : '成功'}`);
		})
		.catch((error) => {
			void debugLog(`carrierKeyOf 加载失败（不影响主流程）: ${String(error?.message ?? error)}`);
		});

	/**
	 * 从一次 waterfall 派发里取出「这个请求属于哪个会话」。
	 *
	 * 三条路依次尝试，任一命中即返回：
	 *
	 * 1. `carrierKeyOf(this)` —— `this` 是 cordis 派发时的 carrier（`scopeTarget`
	 *    造的那个），它的路由键就是会话 id。这是**最可靠**的一条：官方
	 *    `dsh-api-remotes` 判断「这个请求该发给谁」用的就是它。
	 * 2. `request.agent.session.id` —— Agent 上挂的会话。官方在别处确实这么取，
	 *    但**不是每个 Agent 实例都有 `session`**，所以只能当后备。
	 * 3. 都拿不到 ⇒ 返回 `undefined`，调用方 `next()` 放行，交给官方 GUI。
	 *
	 * ⚠️ 为什么不用 `request.sessionId`：这两个 waterfall 的 request 形状里
	 *    没有它（见 `dsh-user-questions` 的 `ask()`，只带 `agent` / `questions`
	 *    / `signal` / `wait`）。
	 *
	 * @param carrier - 派发时的 `this`（scope carrier）。
	 * @param request - waterfall 的 request 参数。
	 * @returns 会话 id，或 `undefined`。
	 */
	function sessionIdOf(carrier, request) {
		// ① carrier 的路由键
		if (carrierKeyOfImpl !== null) {
			try {
				const key = carrierKeyOfImpl(carrier);
				if (typeof key === 'string' && key !== '') return key;
			} catch {
				// 拿不到就往下走
			}
		}
		// ② Agent 上的会话
		const fromAgent = request?.agent?.session?.id;
		if (typeof fromAgent === 'string' && fromAgent !== '') return fromAgent;
		return undefined;
	}

	// ---- approval/request：权限授权 ----
	//
	// 返回词表是固定的四个（见 dsh-user-approval 的 OUTCOMES）：
	// `allowed-once` / `rejected` / `cancelled` / `unavailable`。
	// 只有 `allowed-once` 是放行，其余一律拒绝 —— 手机端传回任何别的值
	// 都归一成 `unavailable`，避免一个手滑的字符串变成授权。
	//
	// ## ⚠️⚠️ 这里是「旁路」，不是「拦截」（用户 2026-10-22 报障）
	//
	// 用户原话：「我即使没有在手机上面远程访问电脑，电脑这边发起提问，
	// 电脑还是不会显示 —— 本来电脑应该也有弹窗的」。
	//
	// ## 之前的写法为什么错
	//
	// 原来的实现是 `await askPhone(...)`：**先问手机，手机不答就等 5 分钟**
	// （`ASK_TIMEOUT_MS`），这期间**根本不调 `next()`**。而 waterfall 的语义是
	// 「不调 next 就吞掉后面所有环节」，所以：
	//
	//   · `dsh-api-remotes` 排在本插件后面 ⇒ 拿不到请求 ⇒ 转发不到前端 ⇒
	//     **电脑上不弹窗**；
	//   · 只要 `followers` 里还有一条**残留的 SSE 订阅**（手机切后台/断网时
	//     `req.on('close')` 未必立刻触发），`askPhone` 就不走「没手机」的
	//     放行分支，而是一路等到超时 —— 症状就是「电脑端卡死不弹」。
	//
	// 真机日志证据（`desktop-debug.log`）：
	//
	//     user-questions/request 进入本插件 session=session-5d4da935-…
	//     askPhone kind=question session=session-5d4da935-… followers=1
	//
	// 用户当时**并没有**在手机上远程访问，但 `followers=1` ⇒ 走了等待分支。
	//
	// ## 现在的写法
	//
	// 「旁路」：**立刻** `next()` 让官方链路照常走（电脑该弹就弹），
	// 同时把请求推给手机。两条路谁先给出答案就用谁的：
	//
	//   · 手机先答 ⇒ 返回手机的答案（它已经 resolve，官方那条 promise 被丢弃）；
	//   · 电脑先答 ⇒ `next()` 的 promise 先 settle，用电脑的答案；
	//   · 手机压根没连 ⇒ `askPhone` 立刻返回 `NO_TAKEOVER`，完全不影响电脑。
	//
	// 代价：手机和电脑会**同时**看到同一个提问。这正是用户要的
	// ——「电脑那边就正常弹窗，手机响应的电脑，电脑再正常响应就行了」。
	ctx.on(
		'approval/request',
		async function (request, next) {
			// 等 `carrierKeyOf` 加载完（通常早已就绪，这里只是消除竞态）。
			await carrierKeyReady;
			const sessionId = sessionIdOf(this, request);
			void debugLog(`approval/request 进入本插件 session=${sessionId ?? 'none'}`);
			// 拿不到会话就放行，别挡着官方 GUI 那条路。
			if (typeof sessionId !== 'string' || sessionId === '') return next();

			// ⚠️ **电脑那条改成「惰性启动」**（2026-10-25 改）：这里**先不调**
			// `next()`。原因：`next()` 一调，`dsh-api-remotes` 就立刻把请求转发给
			// 前端 GUI ⇒ 电脑端弹窗；即使手机赢下 race 也只是 `return first.value`，
			// 电脑那条既不 resolve 也不 cancel，用户还得在电脑上再点一次。
			//
			// 所以先等手机到 `LAZY_GRACE_MS`：手机先答就**全程不启动**电脑那条
			//（电脑端不弹窗）；到点手机没答才 `startDesktop()`，照旧 race。
			//
			// ⚠️ 末尾的 `.catch(() => undefined)` 是**防 unhandled rejection**：
			// 手机先答时我们会把这条丢掉，但它稍后可能 reject（前端取消、
			// 用户关页面）。没有这个 catch，Node 会打一行 unhandledRejection，
			// 严重时（`--unhandled-rejections=strict`）直接把进程带走。
			let desktopPromise;
			const startDesktop = () => {
				if (desktopPromise === undefined) {
					desktopPromise = Promise.resolve()
						.then(next)
						.catch(() => undefined);
				}
				return desktopPromise;
			};

			const phone = askPhone(
				sessionId,
				'approval',
				{
					toolName: request.toolName ?? '',
					...(request.callId !== undefined ? { callId: request.callId } : {}),
					...(request.reason !== undefined ? { reason: request.reason } : {}),
				},
				request.signal,
				// 手机不在场时 = 没接手，此时只听电脑的。
				NO_TAKEOVER,
			);

			// 宽限期内手机作答 ⇒ 直接返回，全程不启动电脑那条（电脑端不弹窗）。
			const phoneRace = phone.then((v) => ({ from: 'phone', value: v }));
			let graceTimer;
			const grace = new Promise((resolve) => {
				graceTimer = setTimeout(() => resolve(undefined), LAZY_GRACE_MS);
			});
			const early = await Promise.race([phoneRace, grace]).catch(() => undefined);
			clearTimeout(graceTimer);

			if (early !== undefined && early.from === 'phone' && early.value !== NO_TAKEOVER) {
				void debugLog('approval/request 由手机在宽限期内作答，未启动电脑那条');
				return APPROVAL_OUTCOMES.includes(early.value) ? early.value : 'unavailable';
			}

			// 宽限期到点、或手机当场回了 `NO_TAKEOVER`（没有活着的订阅者）
			// ⇒ **立刻**启动电脑那条，不白等。
			const desktop = startDesktop();

			// 谁先给出有效答案用谁的。
			const first = await Promise.race([
				phoneRace,
				desktop.then((v) => ({ from: 'desktop', value: v })),
			]).catch(() => undefined);

			if (first === undefined) {
				// 两条都炸了 —— 交给官方兜底（它会抛自己的错，语义更准）。
				return desktop;
			}
			if (first.from === 'phone') {
				// 手机没接手（没连/超时/中断）⇒ 完全听电脑的。
				if (first.value === NO_TAKEOVER) return desktop;
				void debugLog(`approval/request 由手机作答，丢弃电脑那条`);
				return APPROVAL_OUTCOMES.includes(first.value) ? first.value : 'unavailable';
			}
			void debugLog(`approval/request 由电脑作答，手机那条作废`);
			return first.value;
		},
		// ⚠️⚠️ **必须 `{ global: true, prepend: true }`，两个都不能少。**
		//
		// ## global：让监听器绕过 scope 过滤
		//
		// cordis 的 `EventService.dispatch()` 有一行：
		//
		//     .filter((hook) => hook.global || !filter || filter.call(thisArg, hook.ctx))
		//
		// `dsh-user-approval` 派发时 `thisArg` 是 `scopeTarget(agent, agent)`，
		// 带 `Context.filter`。插件根 ctx 的 `scopeOf` 是 undefined，理论上
		// 会被放行（`tag === void 0 → return true`），但显式写 global 更稳 ——
		// 它明确表达「这个监听器对所有作用域生效」，不依赖 scope 标签的实现细节。
		//
		// ## prepend：仍然要抢在 `dsh-api-remotes` 前面
		//
		// `dsh-api-remotes` 也监听 `approval/request`（`API_REMOTE_FORWARDED_EVENTS`，
		// mode: 'waterfall'），拿到请求就 `forwardWaterfall()` 转发给**前端 GUI**。
		//
		// 注意它**并不是**「永不调 next」——`forwardWaterfall`（`dsh-api-remotes/
		// lib/index.js:187`）在前端回 `{kind:'result'}` 时直接 resolve，只有前端
		// 明确拒绝时才走 `next()`。也就是说：**只要本插件排在它后面，本插件就
		// 永远轮不到**（前端正常答题时它已经 settle 了）。
		//
		// 所以 `prepend` 依然必要 —— 但语义已经从「拦截」改成「旁路」：
		// 本插件**立刻** `next()` 让 api-remotes 照常转发给电脑，
		// 同时把同一个请求推给手机，谁先答用谁的（见上面函数体的注释）。
		{ global: true, prepend: true },
	);

	// ---- user-questions/request：ask_user_question ----
	//
	// 返回值形状是 `{ answers: [{ questionId, selected: [label…], custom?: string }] }`
	// （见 dsh-client-ui-user-questions 的 QuestionAnswer 组装）。手机端原样回传，
	// 这里只做形状校验 —— 形状不对就当没答，放行给下一环。
	ctx.on(
		'user-questions/request',
		async function (request, next) {
			// 等 `carrierKeyOf` 加载完（通常早已就绪，这里只是消除竞态）。
			await carrierKeyReady;
			const sessionId = sessionIdOf(this, request);
			void debugLog(`user-questions/request 进入本插件 session=${sessionId ?? 'none'}`);
			if (typeof sessionId !== 'string' || sessionId === '') return next();

			const questions = Array.isArray(request?.questions) ? request.questions : [];
			if (questions.length === 0) return next();

			// 只把手机渲染需要的字段挑出来 —— 整个 request 里有 Agent 实例、
			// 函数、Symbol，直接 JSON 化会抛「not lossless JSON」。
			const wire = questions.map((q) => ({
				id: q.id,
				question: q.question ?? '',
				...(q.header !== undefined ? { header: q.header } : {}),
				...(q.multiSelect === true ? { multiSelect: true } : {}),
				options: (Array.isArray(q.options) ? q.options : []).map((o) => ({
					label: o.label ?? '',
					...(o.description !== undefined ? { description: o.description } : {}),
				})),
			}));

			const answer = await (async () => {
				// ⚠️ **电脑那条同样改成惰性启动**（理由同上面 `approval/request`：
				// 先调 `next()` 会让 `dsh-api-remotes` 立刻转发给前端 ⇒ 电脑弹窗，
				// 手机赢下 race 也取消不掉它）。先等手机到 `LAZY_GRACE_MS`，
				// 手机没答再启动电脑那条。末尾 `.catch` 同样是防 unhandled rejection。
				let desktopPromise;
				const startDesktop = () => {
					if (desktopPromise === undefined) {
						desktopPromise = Promise.resolve()
							.then(next)
							.catch(() => undefined);
					}
					return desktopPromise;
				};

				// `{ answers: [...] }` 的形状校验（手机答案不合形状就当没答）。
				const shapeOk = (v) =>
					v !== null && typeof v === 'object' && Array.isArray(v.answers);

				const phone = askPhone(
					sessionId,
					'question',
					{
						questions: wire,
						...(request.wait?.callId !== undefined ? { callId: request.wait.callId } : {}),
					},
					request.signal,
					NO_TAKEOVER,
				);

				// 宽限期内手机作答 ⇒ 直接返回，全程不启动电脑那条（电脑端不弹窗）。
				const phoneRace = phone.then((v) => ({ from: 'phone', value: v }));
				let graceTimer;
				const grace = new Promise((resolve) => {
					graceTimer = setTimeout(() => resolve(undefined), LAZY_GRACE_MS);
				});
				const early = await Promise.race([phoneRace, grace]).catch(() => undefined);
				clearTimeout(graceTimer);

				if (early !== undefined && early.from === 'phone' && early.value !== NO_TAKEOVER) {
					if (shapeOk(early.value)) {
						void debugLog('user-questions/request 由手机在宽限期内作答，未启动电脑那条');
						return early.value;
					}
					// 形状不对就当没答，退回电脑那条 —— 这时才启动它。
					void debugLog('user-questions/request 手机答案形状不对，退回电脑那条');
					return startDesktop();
				}

				// 宽限期到点、或手机当场回了 `NO_TAKEOVER`（没有活着的订阅者）
				// ⇒ **立刻**启动电脑那条，不白等。
				const desktop = startDesktop();

				// 谁先答用谁的 —— 手机在旁边就手机上点，在电脑前就在电脑上点。
				const first = await Promise.race([
					phoneRace,
					desktop.then((v) => ({ from: 'desktop', value: v })),
				]).catch(() => undefined);

				if (first === undefined) return desktop;
				if (first.from === 'phone') {
					// 手机没接手 ⇒ 完全听电脑的。
					if (first.value === NO_TAKEOVER) return desktop;
					// ⚠️ 手机回的是 `{ answers: [...] }`；形状不对就当没答，
					// **退回电脑那条**（不能 `next()` —— 它已经被调用过一次了，
					// 再调一次等于把请求派发两遍）。
					if (!shapeOk(first.value)) {
						void debugLog(`user-questions/request 手机答案形状不对，退回电脑那条`);
						return desktop;
					}
					void debugLog(`user-questions/request 由手机作答，丢弃电脑那条`);
					return first.value;
				}
				void debugLog(`user-questions/request 由电脑作答，手机那条作废`);
				return first.value;
			})();
			return answer;
		},
		// 理由同上面 `approval/request`：**`prepend` 才是关键** ——
		// `dsh-api-remotes` 也监听这个事件且拿到就转发给前端、不调 `next()`，
		// 不插到它前面就永远轮不到本插件。
		{ global: true, prepend: true },
	);

	// ---- durable 通道：落盘的事件 ----
	ctx.on(
		'session/event',
		(session, event) => {
			// 诊断：`session.id` 和实际订阅键不一致时，`push` 会静默不推 ——
			// 症状正是「手机只收到逐字动画(frame)，永远看不到最终消息(event)」。
			// 只记关键类型，避免日志被刷爆。
			if (event?.type === 'assistant/message' || event?.type === 'turn/end') {
				const set = followers.get(session.id);
				void debugLog(
					`session/event ${event.type} session.id=${session.id} 订阅者=${set === undefined ? 0 : set.size}`,
				);
			}
			push(session.id, 'event', event);
		},
		{ global: true },
	);

	// 启动确认：把「answerer 是否真的注册上了」写进诊断日志。
	//
	// ⚠️ 这一行必须留：前面几次真机排查全靠它区分「没注册上」和「注册了但没被
	// 派发到」—— 两者症状完全一样（手机没卡片），但修法截然不同。
	void debugLog('startRelay 就绪：已注册 approval/request + user-questions/request answerer');

	// 诊断：把本插件 ctx 的 scope 标签打出来。
	//
	// `scopeTarget()` 的过滤器是这么判的：
	//     const tag = scopeOf(ctx);
	//     if (tag === void 0) return true;          // 无标签 ⇒ 全局放行
	//     …否则要求 tag 在 dispatch key 的祖先链上
	//
	// 所以「插件 ctx 有没有被打了某个 scope 标签」直接决定 answerer 收不收得到
	// 事件。打出来才能确定是被 filter 拒了，还是压根没派发。
	void import('@deepseek-ai/dsh-scope')
		.then((mod) => {
			void debugLog(`本插件 ctx 的 scope 标签 = ${String(mod.scopeOf(ctx))}`);
		})
		.catch((error) => {
			void debugLog(`读取 scopeOf 失败（不影响功能）: ${String(error?.message ?? error)}`);
		});

	// ---- 流式通道：进程内事件，不落盘，只给逐字动画 ----
	ctx.on(
		'agent/assistant-stream',
		({ agent, frame }) => {
			push(agent.session.id, 'frame', frame);
		},
		{ global: true },
	);

	/**
	 * 给 `handleRpc` 用的通道对象。
	 *
	 * `handleRpc` 是**模块级**函数，看不见 `startRelay` 的闭包。交互应答
	 * （`answerAsk`）必须落回这个闭包里的 `pendingAsks`，所以显式传进去 ——
	 * 与手机端插件里 `pendingPlans` / `workspaceMap` 的处理方式一致。
	 */
	const io = { answerAsk };

	const server = createServer((req, res) => {
		const url = new URL(req.url ?? '/', `http://127.0.0.1:${RELAY_PORT}`);

		// 鉴权：令牌走 header 或 query（EventSource 不能设 header，所以 query 也要收）。
		const provided = req.headers['x-dsh-remote-token'] ?? url.searchParams.get('token') ?? '';
		if (!tokenMatches(provided, auth.token)) {
			res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
			res.end(JSON.stringify({ error: 'unauthorized' }));
			return;
		}

		// ---- SSE：跟随一个会话的事件流 ----
		if (url.pathname === '/api/dsh-remote/stream' && req.method === 'GET') {
			const sessionId = url.searchParams.get('session');
			if (sessionId === null) {
				res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
				res.end(JSON.stringify({ error: 'session query required' }));
				return;
			}
			res.writeHead(200, {
				'content-type': 'text/event-stream; charset=utf-8',
				'cache-control': 'no-store, no-transform',
				connection: 'keep-alive',
				// 关掉代理缓冲，否则事件会攒着一起发，逐字动画变成一次性出现。
				'x-accel-buffering': 'no',
			});
			// 注释行当心跳：既让浏览器知道连接活着，也让中间代理不掐空闲连接。
			res.write(': connected\n\n');

			let set = followers.get(sessionId);
			if (set === undefined) {
				set = new Set();
				followers.set(sessionId, set);
			}
			// ⚠️ 这里**不能**引用 `fromSeq`：它在下面几十行才用 `const` 声明，
			// 提前引用会踩 TDZ（`ReferenceError: Cannot access 'fromSeq' before
			// initialization`），整个插件 apply 抛错 ⇒ DSH 起不来。
			// 这条诊断日志放在 `fromSeq` 解析之后（见下面的订阅处）。

			// 开场把已有事件补齐（断线重连后能接上）。
			//
			// ⚠️⚠️ **必须支持 `fromSeq`，否则「聊得越大越卡」**（用户报障根因）。
			//
			// 原实现无条件把**整份日志**重推一遍：
			//
			//     for (const event of session.snapshotEvents()) res.write(sse('event', event));
			//
			// 而隧道掐空闲连接、手机休眠断网都是**常态** —— 每次重连都重放全量。
			// 实测本机 311 个会话共 639 MB（磁盘 zstd 压缩后），明文还要再膨胀
			// 3.5～4 倍：最大的一个会话 41 MB → 明文 155 MB / 29638 个事件。
			// 也就是说一次重连就要推 155 MB，手机端当然卡死。
			//
			// 现在手机端在重连时把自己**已有的最大 seq** 用 `?fromSeq=` 带上来，
			// 这里只补 `seq > fromSeq` 的增量。正常重连（手机没丢事件）时
			// 增量就是 0 条，只剩心跳。
			//
			// ⚠️ `fromSeq` **缺省时仍推全量** —— 这是刻意的向后兼容：
			// 老版本手机端不会带这个参数，行为与改动前完全一致。
			const fromSeqRaw = url.searchParams.get('fromSeq');
			const fromSeq = fromSeqRaw === null ? null : Number(fromSeqRaw);
			// 诊断：手机连上来时记一行。放在 `fromSeq` 声明**之后**才不会踩 TDZ。
			void debugLog(`SSE 订阅 session=${sessionId} fromSeq=${fromSeq ?? 'null'} 该会话订阅者=${set.size}`);
			// ⚠️ **补齐必须排在 `set.add(res)` 之前，所以整块包进 async IIFE。**
			//
			// 顺序是硬要求：如果先把 `res` 挂进 `followers` 再慢慢补齐，补齐期间
			// 电脑上新产生的事件会经 `push()` 先写进这个 `res`，然后补齐的旧事件
			// 才到 —— 手机端收到 seq 45 又收到 seq 21，`acceptEntry` 直接判定
			// 不连续（或重复），照样炸。先补完、再订阅，才是单调递增的。
			void (async () => {
				// 已经写给这个 `res` 的**最大 seq**。
				//
				// ⚠️ 它必须被跟踪，因为补齐与订阅之间有**竞态窗口**：
				// `set.add(res)` 之前的任何新事件都不会经 `push()` 到达这里，
				// 补完之后若不再追一次，那些事件就永久丢了 ⇒ 手机端看到跳号 ⇒
				// 又是「历史加载失败」。所以 `set.add(res)` 之后立刻再补一次
				// `seq > sent` 的增量（此时已订阅，没补到的部分 `push()` 会负责）。
				let sent = fromSeq !== null && Number.isFinite(fromSeq) && fromSeq >= 0 ? fromSeq : -1;

				/**
				 * 把 `seq > sent` 的历史事件写给 `res`，并推进 `sent`。
				 *
				 * @param allowCold - 是否允许为**冷会话**物化整份日志。
				 *   首次补齐时允许（那是主修复点）；追竞态窗口那次**不允许** ——
				 *   那时会话已经被唤醒成活会话，走不到冷分支；万一走到，
				 *   说明期间又被卸载，再物化一次 155 MB 不值得，宁可让手机端重连。
				 */
				const pushBacklog = async (allowCold) => {
					const session = ctx.sessions?.get?.(sessionId);
					if (session !== undefined) {
						const all = session.snapshotEvents();
						for (const event of all) {
							if (event.seq <= sent) continue;
							sent = event.seq;
							res.write(sse('event', event));
						}
						return;
					}
					if (!allowCold) return;
					// ⚠️⚠️ **冷会话必须也补齐，否则手机端必然报「历史加载失败」。**
					//
					// 这是真机报错的**真根因**（比 `throughSeq` 那条更根本）：
					//
					// `ctx.sessions.get()` 只返回**内存里活着的**会话。同步来的对话
					// 在电脑上可能很久没碰、已被卸载，此时这里是 `undefined` ——
					// 原实现直接跳过补齐，**一条事件都不发**，但 `res` 已经进了
					// `followers`。等用户发消息把会话唤醒、agent 开始跑，新事件经
					// `push()` 广播过来时，**第一个事件的 seq 就比手机端本地
					// `cursor` 大了一大截**（中间那些历史全丢了）。
					//
					// 前端 `RemoteJournalStream.acceptEntry`
					//（`dsh-api-gateway/lib/client.js:1127`）一看
					// `!follows(lastCursor, firstSeq)`（要求 `first === last + 1`）
					// 就判定不连续，转去 `replaceThrough()` →
					// `assertPageThrough(page, requiredCursor)`，而补页请求给不出
					// 那个精确 cursor ⇒ 抛
					// `session event stream page did not end at its requested cursor`
					// ⇒ 界面「历史加载失败」。
					//
					// 所以冷会话也要补齐：走 `sessionQuery.observeSession()` 拿
					// 事件（**它给的 events 是惰性 getter，这里确实要用，必须物化**）。
					// ⚠️ 只用它补 `seq > sent` 的增量，绝不整份回放 ——
					// 大历史会话整份是 155 MB / 29638 条，那样重连一次就卡死。
					const query = ctx.get?.('sessionQuery');
					if (query === undefined || query === null || typeof query.observeSession !== 'function') {
						return;
					}
					let observation;
					try {
						observation = await query.observeSession(sessionId, { projectionMode: 'none' });
						const events = observation?.events;
						if (Array.isArray(events)) {
							for (const event of events) {
								if (event.seq <= sent) continue;
								sent = event.seq;
								res.write(sse('event', event));
							}
						}
					} finally {
						try {
							observation?.[Symbol.dispose]?.();
						} catch {
							/* dispose 失败不影响补发 */
						}
					}
				};

				try {
					await pushBacklog(true);
				} catch (error) {
					ctx.logger?.warn?.(`[dsh-link] 补发历史失败: ${String(error?.message ?? error)}`);
				}

				// 补齐完成后才订阅实时推送（顺序见上面的 ⚠️）。
				set.add(res);

				// ⚠️ **订阅后立刻追一次增量**：`pushBacklog(true)` 运行期间产生的事件
				// 既没进补发（那时 `sent` 还是旧的）、也没进 `push()`（那时 `res`
				// 还不在 `followers` 里）。这一趟把那个窗口缝上。
				try {
					await pushBacklog(false);
				} catch (error) {
					ctx.logger?.warn?.(`[dsh-link] 追补增量失败: ${String(error?.message ?? error)}`);
				}

				const heartbeat = setInterval(() => {
					try {
						res.write(': ping\n\n');
					} catch {
						clearInterval(heartbeat);
					}
				}, 15000);

				const cleanup = () => {
					clearInterval(heartbeat);
					set.delete(res);
					if (set.size === 0) followers.delete(sessionId);
				};
				req.on('close', cleanup);
				req.on('error', cleanup);
			})();
			return;
		}

		// ---- RPC：手机发起的动作 ----
		if (url.pathname === '/api/dsh-remote/rpc' && req.method === 'POST') {
			const chunks = [];
			req.on('data', (c) => chunks.push(c));
			req.on('end', async () => {
				const reply = (payload) => {
					res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify(payload));
				};
				let body;
				try {
					body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
				} catch (error) {
					res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
					res.end(JSON.stringify({ error: `bad json: ${String(error?.message ?? error)}` }));
					return;
				}
				try {
					reply({ id: body.id, ok: true, result: await handleRpc(ctx, body.method, body.params ?? {}, io) });
				} catch (error) {
					reply({ id: body.id, ok: false, error: String(error?.message ?? error) });
				}
			});
			return;
		}

		res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
		res.end(JSON.stringify({ error: 'not found' }));
	});

	/**
	 * ⚠️ `error` 处理器**不能省**，否则端口被占用时整个引擎进程会崩。
	 *
	 * `listen()` 的失败是**异步**通过 `'error'` 事件抛的，`apply()` 里那个
	 * try/catch 完全兜不住 —— 实测（本机已有一个 DSH 在跑时再起一个）：
	 *
	 *   Error: listen EADDRINUSE: address already in use 127.0.0.1:17890
	 *   Emitted 'error' event on Server instance at: ...
	 *   Node.js v24.16.0        ← 进程直接退出
	 *
	 * 后果远不止「远程功能不可用」：客户机上有残留的引擎进程是**常见现象**
	 *（本项目 AGENTS.md 就记着「3080 已被占用（多半是上一次残留的引擎进程）」），
	 * 而崩掉的是**整个 DSH**，客户完全看不出这是本插件造成的。
	 *
	 * 所以这里降级：日志说清原因，其余功能照常。
	 */
	server.on('error', (error) => {
		ctx.logger?.warn?.(
			`[dsh-link] 中继无法监听 127.0.0.1:${RELAY_PORT}（${String(error?.message ?? error)}）` +
				'；多半是另一个 DSH 实例已在运行。远程功能不可用，但本进程其余功能不受影响。',
		);
	});

	server.listen(RELAY_PORT, '127.0.0.1');
	return {
		/**
		 * 换令牌（配对后热更新，无需重启 DSH）。
		 *
		 * @param next - 新令牌。
		 */
		setToken: (next) => {
			auth.token = next;
		},
		close: () => {
			for (const set of followers.values()) {
				for (const res of set) {
					try {
						res.end();
					} catch {
						/* 连接已断 */
					}
				}
			}
			followers.clear();
			server.close();
		},
	};
}

/**
 * 这台请求是不是来自**本机**（loopback）。
 *
 * 双判：连接的远端地址 + `Host` 头。只看 `Host` 挡不住「同机其它进程」；
 * 只看远端地址挡不住 DNS rebinding（恶意域名解析到 127.0.0.1，浏览器仍带
 * `Host: evil.example`）。两个都满足才算本机。
 *
 * @param req - 请求。
 * @returns 是否来自本机。
 */
function isLoopbackRequest(req) {
	const remote = String(req.socket?.remoteAddress ?? '');
	const address = remote.startsWith('::ffff:') ? remote.slice(7) : remote;
	const remoteOk = address === '127.0.0.1' || address === '::1';
	if (!remoteOk) return false;
	const host = String(req.headers?.host ?? '');
	const hostname = host.startsWith('[')
		? host.slice(0, host.indexOf(']') + 1).toLowerCase()
		: host.split(':')[0].toLowerCase();
	return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1';
}

/**
 * 本机 Web 端口上的 `/api/dsh-remote/link/*` 前缀路由（**局域网流程的两个只读端点**）。
 *
 * | 端点 | 用途 | 调用方 |
 * |---|---|---|
 * | `GET /api/dsh-remote/link/role` | 单包门：回答「这台是电脑」 | `lib/client.js` 的 `probeDesktop()` |
 * | `GET /api/dsh-remote/link/claim-info` | 「电脑端授权码浮层」该不该弹 | `lib/client.js` 的授权码浮层 |
 *
 * ## ⚠️ `/role` 为什么在这里，而不是像当年那样挂在配对前缀下
 *
 * `/role` 的职责是「告诉浏览器这台机器的角色」，跟隧道/公网服务器毫无关系。
 * 当年图省事把它挂在 `/api/dsh-remote/pair/role` 下（顺带复用那道配对门的判据），
 * 于是删隧道时它会跟着陪葬 —— 前端拿不到 `desktop` ⇒ 降级成 `unknown` ⇒
 * 电脑端授权码浮层不弹、手机 UI 不注入，是**静默**功能失效。
 *
 * 现在归到 `link/` 前缀下：与 `claim-info` 同门（`isLoopbackRequest`）、同前缀，
 * 职责自洽。安全性上没有退让 —— 原来那道门真正要挡的是配对的 `handshake`
 * （「拿配对码 → 换令牌 → 驱动本机 agent」那条链），而 `/role` 泄露的只是
 * 「这台是电脑」这个事实，不构成那链条的一环。
 *
 * ## 两个端点共同的门（两层）
 *
 * 第一层 `isLoopbackRequest`：调用方**只可能是本机浏览器**，经隧道绕一圈回来
 * 没有意义，也让「同一 Wi-Fi 下另一台设备」够不着。
 *
 * 第二层 `linkGate`（引擎判据，P1-1）：**这一层才是真正挡住人的**。
 *
 * ⚠️⚠️ `claim-info` 的响应里带**当前有效的 6 位配对码**（`readClaimInfo` 的
 * `code` 字段）。而「来自 127.0.0.1」挡不住同机的其它进程或其它用户 ——
 * 它们打本机端口时 Host 同样是 loopback。于是攻击链是：
 *
 * ```
 * 同机任意进程 GET /link/claim-info  → 拿到 6 位配对码
 *   → POST https://<电脑IP>:8899/link/claim（带自己的 deviceId/deviceKey）
 *   → 进入设备白名单 → 之后所有 RPC 都以「已授权设备」的身份通过
 * ```
 *
 * 所以只判回环是**不够**的：它挡的是「别人家的电脑」，挡不住「这台电脑上
 * 除了浏览器以外的东西」。第二层补的正是后者 —— 复用引擎的
 * `connection.requestRejection`（含浏览器会话 cookie），与手机端桥路由同款，
 * 见 `lib/shared/engine-gate.js`。
 *
 * ⚠️ 失败一律不给细节（403/503 空 body、404/405 的 `{ok:false}`），
 * 别给探测者当探针用。
 *
 * @param ctx - Cordis 上下文（取引擎判据）。
 * @param req - 请求。
 * @param res - 响应。
 */
function handleLinkRoute(ctx, req, res) {
	if (!isLoopbackRequest(req)) {
		res.writeHead(403);
		res.end();
		return;
	}
	const url = new URL(req.url ?? '/', 'http://127.0.0.1');
	const rejected = linkGate(ctx, req);
	if (rejected !== undefined) {
		// 被拒时补一条宿主日志。⚠️ 不说「因为什么被拒」—— 那等于给探测者
		// 一份判据清单；只记路径与状态码，足够运维对账。
		ctx.logger?.warn?.(`[dsh-link][link] ${req.method ?? '?'} ${url.pathname} 被引擎判据拒绝 → ${rejected}`);
		res.writeHead(rejected);
		res.end();
		return;
	}
	const reply = (code, payload) => {
		res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
		res.end(payload === undefined ? undefined : JSON.stringify(payload));
	};
	const action = url.pathname.slice(LINK_ROUTE.length) || '/';

	// 安装向导子系统（`/setup` 含 GET 与 POST，自带方法分发与同源门）。
	if (action.startsWith('/setup')) {
		if (!setupController) {
			res.writeHead(503);
			res.end();
			return;
		}
		void setupController.handle(req, res, action);
		return;
	}

	/**
	 * 两段式配对的「允许 / 拒绝」：电脑端设置面板的待确认卡片调用。
	 * 与 `/claim-info` 同门（回环 + 引擎判据）；动作与 id 走 query，不读 body。
	 */
	if (action === '/pairing') {
		if (String(req.method ?? 'GET').toUpperCase() !== 'POST') {
			reply(405, { ok: false });
			return;
		}
		const shared = getSharedDeviceAuth();
		if (shared === null) {
			reply(503, { ok: false });
			return;
		}
		const pendingId = url.searchParams.get('pendingId') ?? '';
		const verb = url.searchParams.get('action') ?? '';
		const result = verb === 'approve'
			? shared.approvePairing({ pendingId })
			: verb === 'reject'
				? shared.rejectPairing({ pendingId })
				: { ok: false, error: 'bad-request' };
		reply(result.ok ? 200 : 404, result.ok ? { ok: true } : { ok: false, error: result.error });
		return;
	}

	if (String(req.method ?? 'GET').toUpperCase() !== 'GET') {
		reply(405, { ok: false });
		return;
	}
	/**
	 * 单包门：浏览器在注入任何 UI **之前**问一句「这台是电脑吗」。
	 *
	 * 只读、无参数、不碰任何状态。见 `lib/client.js` 的 `probeDesktop()`：
	 * 它答 `desktop` 才走「电脑端授权码浮层」，否则按 unknown 处理（不注入任何 UI）。
	 */
	if (action === '/role') {
		reply(200, { ok: true, role: 'desktop' });
		return;
	}
	if (action !== '/claim-info') {
		reply(404, { ok: false });
		return;
	}
	try {
		// 有共享实例就用它（能带上两段式配对的待确认队列）；没有就退回文件快照。
		const shared = getSharedDeviceAuth();
		reply(200, { ok: true, ...(shared === null ? readClaimInfo(STATE_DIR) : shared.claimInfo()) });
	} catch {
		reply(500, { ok: false });
	}
}

/**
 * ---- 子代理式自动通知：一轮结束 → 给手机 link agent 投一条消息 ----
 *
 * 只在**用户会话**上发：镜像/派生会话不发（手机端 `remotePaths` / `syncedSessions`
 * 两张表里的会话是被搬过去的副本，再反过来叫醒手机就是自问自答）；同一 sessionId
 * **10 秒内只发一次**；取不到该轮 assistant 文本的轮次不发（纯工具轮没有可读产出）。
 *
 * 下面几个纯函数是**导出**的：自检脚本可以直接 import 它们跑规则，不必起 cordis。
 */
const NOTIFY_THROTTLE_MS = 10_000;
const notifyLastAt = new Map();

/** 节流：同一 sessionId 10 秒内只放行一次（放行即记账）。 */
export function throttleNotify(sessionId, now = Date.now()) {
	const last = notifyLastAt.get(sessionId);
	if (last !== undefined && now - last < NOTIFY_THROTTLE_MS) return false;
	notifyLastAt.set(sessionId, now);
	return true;
}

/**
 * `turn/start` 的到达时刻：`${sessionId}|${turn}` → 毫秒。
 *
 * 「仅长任务」需要**本轮时长**，而 `turn/end` 事件本身不带它 —— 实测 DSH v4
 * 的 data 只有 `{ turn, reason }`（见 {@link turnErrorOf} 的取证注释）。所以
 * 自己从 `turn/start` 起表，`turn/end` 时取差值。
 *
 * ⚠️ 只在内存里，进程重启即弃：重启前已经开始的那一轮没有起点 ⇒ 时长按
 * 「未知」处理（`undefined`，不是 0），由 {@link handleSessionEventForNotify}
 * 在 `when === 'long'` 时按「不发」处理并记一行日志 —— 不能把「不知道」当成
 * 「0 秒」，那会让长任务通知在重启后的第一轮静默失效，且日志看不出原因。
 */
const turnStartAt = new Map();
/** 起点表上限：正常一轮结束就删；异常退出/丢 `turn/end` 时才可能留，按最早清。 */
const TURN_START_MAX = 512;

/** 记一轮的开始时刻（同一条 `turn/start` 重连会重放，已有起点不覆盖）。 */
export function rememberTurnStart(sessionId, turn, now = Date.now()) {
	if (typeof sessionId !== 'string' || sessionId === '' || typeof turn !== 'number') return;
	const key = `${sessionId}|${turn}`;
	if (turnStartAt.has(key)) return;
	turnStartAt.set(key, now);
	// 只防泄漏：丢 `turn/end` 的轮次会永远留着，数量不会自己降下来。
	while (turnStartAt.size > TURN_START_MAX) {
		const oldest = turnStartAt.keys().next().value;
		turnStartAt.delete(oldest);
	}
}

/** 取一轮时长（毫秒）并清掉起点；没有起点返回 `undefined`（= 未知，不是 0）。 */
export function takeTurnDuration(sessionId, turn, now = Date.now()) {
	const key = `${sessionId}|${turn}`;
	const startedAt = turnStartAt.get(key);
	turnStartAt.delete(key);
	return typeof startedAt === 'number' ? Math.max(0, now - startedAt) : undefined;
}

/**
 * 这一轮是否**出错**：看 `turn/end` 的 `data.reason`。
 *
 * ## 取证（不是猜的）
 *
 * 扫本机真实会话日志（`$DSH_HOME/sessions/**`，60 个会话 / 130 条 turn/end），
 * 形状固定为：
 *
 *     { turn: 1, reason: { kind: 'completed' | 'error' | 'interrupted' | 'blocked',
 *                          error?: { message, code, status } } }
 *
 * 只有 `kind === 'error'`（或带了 `reason.error`）算出错；`interrupted`
 * （用户停止）与 `blocked`（被权限/审批挡住）**不算错误**，不往这里塞。
 *
 * 形状不认识（老引擎 / 字段被改）返回 `undefined` = 判不清：调用方在
 * `when === 'error'` 下会保守跳过并记日志，而不是伪造一个「没出错」。
 *
 * @returns {boolean|undefined}
 */
export function turnErrorOf(event) {
	const reason = event?.data?.reason;
	if (reason === null || typeof reason !== 'object') return undefined;
	if (reason.error !== undefined && reason.error !== null) return true;
	if (typeof reason.kind === 'string') return reason.kind === 'error';
	return undefined;
}

/**
 * 当前「通知推送」配置（电脑端 `setup.json`）。
 *
 * `on` 不看了：真实开关是 `link-peer.json` 的 `notify`（`link-notify` 每次发送
 * 都读它），`setup.json` 的 `notify.on` 只是设置面板的镜像。这里读不到配置
 * （服务还没就绪 / 文件坏了）就退回规则层默认值 —— 通知不该因为读配置失败消失。
 */
function notifyConfigOf() {
	try {
		const notify = setupController?.service?.getState?.('desktop')?.notify;
		if (notify !== null && typeof notify === 'object') return notify;
	} catch {
		/* 读配置失败：按默认值继续 */
	}
	return DEFAULT_NOTIFY;
}


/**
 * 镜像会话清单：`$DSH_HOME/dsh-remote/link-mirror-sessions.json`（可选文件，60s 缓存）。
 *
 * ⚠️ 桌面端**没有**手机端的 `remotePaths` / `syncedSessions`（那是手机端插件自己维护的表，
 * 用来把电脑会话搬成手机里的镜像）。这里留一个落点：手机端把两张表里的 sessionId 写进
 * 这个文件，桌面端就按它排除；文件不存在 = 没有要排除的。
 */
let mirrorCache = { at: 0, ids: new Set() };
function mirrorSessionIds() {
	if (Date.now() - mirrorCache.at < 60_000) return mirrorCache.ids;
	let ids = new Set();
	try {
		const parsed = JSON.parse(readFileSync(join(STATE_DIR, 'link-mirror-sessions.json'), 'utf8'));
		const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.ids) ? parsed.ids : [];
		ids = new Set(list.filter((id) => typeof id === 'string' && id !== ''));
	} catch {
		/* 文件不存在 = 没有要排除的会话 */
	}
	mirrorCache = { at: Date.now(), ids };
	return ids;
}

/** 该会话要不要通知：子代理派生会话、清单里的镜像会话都不发；判不清时按「不发」处理。 */
export function isMirrorSession(session) {
	try {
		if (session?.header?.origin === 'subagent') return true;
		const id = typeof session?.id === 'string' ? session.id : '';
		return id === '' || mirrorSessionIds().has(id);
	} catch {
		return true;
	}
}

/** 取该轮**最后一条** assistant 文本（只算 text 块）；取不到返回 ''。 */
export function lastAssistantTextForTurn(log, turn) {
	if (!Array.isArray(log) || typeof turn !== 'number') return '';
	for (let index = log.length - 1; index >= 0; index -= 1) {
		const event = log[index];
		if (event?.type !== 'assistant/message' || event.data?.turn !== turn) continue;
		const content = event.data.message?.content;
		if (!Array.isArray(content)) continue;
		const text = content
			.filter((block) => block?.type === 'text' && typeof block.text === 'string' && block.text.trim() !== '')
			.map((block) => block.text.trim())
			.join('\n');
		if (text !== '') return text;
	}
	return '';
}

/**
 * 会话标题（通知正文用）。三级回落，取不到返回 ''（调用方再回落到 id 前 8 位）。
 *
 * ⚠️ 0.18.26：只靠官方 `title` 投影实机拿不到（真机通知里显示成了
 * `会话《7565e3e9》`，用户一眼看不出是哪个会话）。补两级**本地可读**的来源：
 *
 *   ① 官方投影快照（有就用，最权威）；
 *   ② 会话日志里最后一条 `session/title` —— 投影本来就是它折出来的；
 *   ③ 第一条 `user/message` 的正文前 20 字（兜底，别让通知只剩一个 id）。
 */
function sessionTitleOf(ctx, session) {
	try {
		const block = ctx.sessionProjections?.cachedSnapshot?.(session);
		const title = block?.values?.title;
		if (typeof title === 'string' && title.trim() !== '') return title.trim();
	} catch {
		/* 投影服务不可用：继续往下回落 */
	}
	const log = Array.isArray(session?.log) ? session.log : [];
	try {
		for (let index = log.length - 1; index >= 0; index -= 1) {
			const event = log[index];
			if (event?.type !== 'session/title') continue;
			const title = event.data?.title;
			if (typeof title === 'string' && title.trim() !== '') return title.trim();
		}
	} catch {
		/* 日志形状异常：继续往下回落 */
	}
	try {
		for (const event of log) {
			if (event?.type !== 'user/message') continue;
			const content = Array.isArray(event.data?.content) ? event.data.content : [];
			const text = content
				.filter((block) => block?.type === 'text' && typeof block.text === 'string')
				.map((block) => block.text.trim())
				.join(' ')
				.replace(/\s+/g, ' ')
				.trim();
			if (text !== '') return text.length > 20 ? `${text.slice(0, 20)}…` : text;
		}
	} catch {
		/* 忽略 */
	}
	return '';
}

/** 通知正文：`[电脑] 会话《<标题或 id 前 8 位>》第 <turn> 轮完成：<最后一条 assistant 文本前 200 字>`。 */
export function formatTurnEndNotice({ title, sessionId, turn, text }) {
	const raw = typeof title === 'string' ? title.trim() : '';
	const label = raw !== '' ? raw : String(sessionId ?? '').replace(/^session-/, '').slice(0, 8);
	const body = String(text ?? '').replace(/\s+/g, ' ').trim();
	return `[电脑] 会话《${label}》第 ${turn} 轮完成：${body.length > 200 ? `${body.slice(0, 200)}…` : body}`;
}

/**
 * 「这一轮是**手机发起**的」记账：`sessionId → { at, origin }`。
 *
 * ## 为什么要有它（0.18.23，用户要求）
 *
 * 插件原来对**任何**非镜像会话的 `turn/end` 都发通知 —— 用户在电脑上随手聊两句
 * 也会被推到手机上（原话：「自动通知会同步推送我在电脑上随便聊的，这没必要吧」）。
 *
 * 现在只回投**手机那边驱动的回合**：`prompt` RPC 进来时记一笔，`turn/end` 时消费掉。
 * 电脑本机的对话从此一条都不推。
 *
 * `origin` 是「干完活回投给手机哪个会话」：手机派活时可以显式给
 * （`prompt` 的 `notifySession` 参数）；没给就不推（用户已经在手机界面上看过这一轮了，
 * 再推一条是噪音）。
 */
const phoneDrivenTurns = new Map();
/** 一条记账最多留 6 小时（防止很久不动的会话一直算「手机发起」）。 */
const PHONE_DRIVEN_TTL_MS = 6 * 60 * 60 * 1000;

/**
 * 记一笔「这一轮由手机驱动」。
 *
 * @param {string} sessionId - 电脑端会话 id。
 * @param {string} [origin] - 回投目标（手机端会话 id）；空串 = 不推。
 */
function markPhoneDrivenTurn(sessionId, origin) {
	if (typeof sessionId !== 'string' || sessionId === '') return;
	phoneDrivenTurns.set(sessionId, {
		at: Date.now(),
		origin: typeof origin === 'string' ? origin : '',
	});
}

/**
 * 一条会话事件进来时的**全部判据**（导出：自检直接喂假事件，不必起 cordis）。
 *
 * - `turn/start` 只用来**起表**（「仅长任务」要算本轮时长），不通知；
 * - `turn/end` 依次判：① 非镜像/派生会话；② 该轮有 assistant 文本；
 *   ③ 设置里的通知条件（when=all/error/long + longMin）；④ 同 sessionId 10s 节流。
 *
 * 任何一条不满足 ⇒ 只写一行日志、不发。全程不抛错。真的往下发时返回正文（自检用）。
 */
export function handleSessionEventForNotify(ctx, session, event) {
	const sessionId = typeof session?.id === 'string' ? session.id : '';
	const turn = event?.data?.turn;
	// 记起点：`when === 'long'` 要的时长只能从这里来（turn/end 自身不带时长）。
	// 镜像/派生会话反正不通知，不必给它们占表。
	if (event?.type === 'turn/start') {
		if (sessionId !== '' && typeof turn === 'number' && !isMirrorSession(session)) {
			rememberTurnStart(sessionId, turn);
		}
		return;
	}
	if (event?.type !== 'turn/end') return;
	if (sessionId === '' || typeof turn !== 'number') return;
	// ⚠️ 先取出并清掉起点：下面无论从哪条早退，Map 里都不能留下这一轮。
	const durationMs = takeTurnDuration(sessionId, turn);
	if (isMirrorSession(session)) {
		void debugLog(`notify 跳过（镜像/派生会话）session=${sessionId}`);
		return;
	}
	// ⚠️ 0.18.23：**只回投手机发起的那一轮**。电脑本机的闲聊不推（用户要求）。
	const driven = phoneDrivenTurns.get(sessionId);
	if (driven === undefined || Date.now() - driven.at > PHONE_DRIVEN_TTL_MS) {
		void debugLog(`notify 跳过（不是手机发起的回合）session=${sessionId} turn=${turn}`);
		return;
	}
	// 这一轮已经结束：记账消费掉，下一次在电脑上继续聊就不算「手机发起」了。
	phoneDrivenTurns.delete(sessionId);
	if (driven.origin === '') {
		void debugLog(`notify 跳过（手机没指定回投会话）session=${sessionId} turn=${turn}`);
		return;
	}
	const text = lastAssistantTextForTurn(session.log, turn);
	if (text === '') {
		void debugLog(`notify 跳过（该轮没有 assistant 文本）session=${sessionId} turn=${turn}`);
		return;
	}
	// ---- ③ 设置里的触发条件（设置 →「通知推送」的 when / longMin）----
	//
	// `on` 不在这里判：真实开关是 `link-peer.json` 的 notify（link-notify 每次
	// 发送都读它）；setup.json 的 `notify.on` 只是设置面板的镜像。所以固定按
	// `on: true` 交给规则层，这一层只负责 when / longMin。
	const notify = notifyConfigOf();
	const when = notify.when === 'error' ? 'error' : notify.when === 'long' ? 'long' : 'all';
	const error = turnErrorOf(event);
	// 「仅出错」但事件形状判不清到底出没出错 ⇒ **不伪造、不发**（fail-closed）。
	// DSH v4 的 turn/end 一律带 reason（见 turnErrorOf 的取证），走到这里说明形态变了。
	if (when === 'error' && error === undefined) {
		void debugLog(`notify 跳过（when=error，但本轮 turn/end 没有可判定的错误字段）session=${sessionId} turn=${turn}`);
		return;
	}
	if (!shouldNotify({ ...notify, on: true }, { error: error === true, durationMs })) {
		const longMin = Number.isFinite(Number(notify.longMin)) ? Number(notify.longMin) : DEFAULT_NOTIFY.longMin;
		const spent = durationMs === undefined ? '时长未知' : `${Math.round(durationMs / 1000)}s`;
		void debugLog(
			when === 'long'
				? `notify 跳过（when=long，本轮 ${spent} < ${longMin} 分钟）session=${sessionId} turn=${turn}`
				: `notify 跳过（when=error，本轮未出错）session=${sessionId} turn=${turn}`,
		);
		return;
	}
	if (!throttleNotify(sessionId)) {
		void debugLog(`notify 跳过（10s 节流）session=${sessionId} turn=${turn}`);
		return;
	}
	const notice = formatTurnEndNotice({ title: sessionTitleOf(ctx, session), sessionId, turn, text });
	// notifyLink 自身从不抛错；这个 catch 只是防将来改动把异常漏出来。
	void notifyLink({ text: notice, sessionId: driven.origin }).catch(() => undefined);
	return notice;
}

/**
 * 插件入口。
 *
 * @param ctx - Cordis 上下文。
 * @param config - 插件配置。
 */
export function apply(ctx, config = {}) {
	const token = ensureToken(ctx);
	const state = { relay: undefined };

	ctx.effect(() => {
		try {
			state.relay = startRelay(ctx, token);
			ctx.logger?.info?.(`[dsh-link] 中继已监听 http://127.0.0.1:${RELAY_PORT}`);
			// ⚠️⚠️ **绝不能把令牌本身打进日志**（外部审计 D3）。
			// 令牌 = 这台电脑的完全控制权：日志会落盘、可被 GUI 的 `/export`
			// 导成 zip、可能随诊断包上传，而 **agent 自己就有读日志的能力**
			// （用户一句「把日志打出来」就等于把钥匙交出去）。
			// 需要排查时只打**指纹**：`tokenHash` 可对账、不可复用。
			ctx.logger?.info?.(
				`[dsh-link] 访问令牌: <已隐藏，指纹 ${tokenFingerprint(token)}>`
			);
			ctx.logger?.info?.(`[dsh-link] 令牌文件: ${TOKEN_PATH}`);
		} catch (error) {
			ctx.logger?.error?.(`[dsh-link] 中继启动失败: ${String(error?.message ?? error)}`);
		}

		// ---- 安装向导（首次配置弹窗 + 设置页）----
		//
		// 复用 `setup-service.js` 同一份业务规则，挂在 `/api/dsh-remote/link/setup*`
		// 前缀下（与 claim-info 同门、同回环 + 引擎门）。落盘 `setup.json` 放在本机
		// 配置目录，与 link.json / 证书 / 配对码同处，避免再开一套目录。
		//
		// ⚠️ 这里必须注入**真实数据源**（0.2.1 修）：
		// - 工作区是官方 `workspaceRegistry.list()`，不是页面里写死的示例路径；
		// - 「添加工作区」走本文件的 `listDirectory`（与手机端浏览对话框同一套
		//   盘符 / 禁区规则），用户自己点选，不是一句「打开目录选择器…（原型）」。
		setupController = createSetupController({
			dir: STATE_DIR,
			role: 'desktop',
			log: (line, level = 'info') => ctx.logger?.[level]?.(`[dsh-link][setup] ${line}`),
			providers: {
				// 本机真实地址：缺省由 setup-routes 的 pickLocalIPv4() 打分挑选
				// （私网优先、VPN/虚拟机网卡降权 —— 这台机器第一项是 Radmin VPN 26.x）。
				listWorkspaces: () => {
					const rows = ctx.workspaceRegistry?.list?.();
					if (!Array.isArray(rows)) return [];
					return rows
						.filter((row) => typeof row?.path === 'string' && row.path !== '')
						.map((row) => ({ path: row.path, id: typeof row.id === 'string' ? row.id : '' }));
				},
				// 已配对设备**以网关为准**（`devices.json`）：
				// 手机上真正输的是这份码，配置页不能再自己另生成一份。
				//
				// ⚠️ `readClaimInfo` 只给故意裁短的 8 位 id（展示用），而网关的
				// `revoke()` 按**完整 id 全等**匹配 —— 直接拿裁短 id 去解绑会永远失败。
				// 所以这里把 `devices.json` 里的完整 id 贴回来（id 本身不是秘密，
				// deviceKey/keyHash 一个都不带）。
				pairing: () => readPairingInfo(STATE_DIR),
				// 配对码已移除：配对改成「手机发起 → 电脑弹窗确认」。
				// 真实网关配置（link.json）：地址族 / 监听 / 端口 / 公网 / DDNS / 证书指纹。
				gatewayInfo: () => {
					const config = readLinkConfig(STATE_DIR) || {};
					const port = Number(config.port);
					return {
						addressFamily: typeof config.addressFamily === 'string' ? config.addressFamily : 'ipv4',
						listen: typeof config.listen === 'string' ? config.listen : '0.0.0.0',
						port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined,
						allowGlobal: config.allowGlobal === true,
						ddns: !!(config.ddns && config.ddns.enabled === true),
						ddnsConfig: config.ddns && typeof config.ddns === 'object' ? config.ddns : {},
					publicHost: typeof config.publicHost === 'string' ? config.publicHost : '',
						certFp: desktopGateway?.state?.fp || '',
					};
				},
				updateGateway: (patch = {}) => {
					const next = {};
					if (typeof patch.addressFamily === 'string') {
						if (!['ipv4', 'ipv6', 'dual'].includes(patch.addressFamily)) {
							return { ok: false, reason: '地址族只支持 ipv4 / ipv6 / dual' };
						}
						next.addressFamily = patch.addressFamily;
					}
					if (typeof patch.listen === 'string' && patch.listen.trim() !== '') next.listen = patch.listen.trim();
					if (patch.port !== undefined) {
						const port = Number(patch.port);
						if (!Number.isInteger(port) || port < 1 || port > 65535) return { ok: false, reason: '端口必须是 1-65535 的整数' };
						next.port = port;
					}
					if (typeof patch.allowGlobal === 'boolean') next.allowGlobal = patch.allowGlobal;
					if (typeof patch.publicHost === 'string' && patch.publicHost.trim() !== '') next.publicHost = patch.publicHost.trim();
					if (typeof patch.ddns === 'boolean' || (patch.ddns && typeof patch.ddns === 'object')) {
						const previous = readLinkConfig(STATE_DIR) || {};
						const prevDdns = previous.ddns && typeof previous.ddns === 'object' ? previous.ddns : {};
						next.ddns = typeof patch.ddns === 'object'
							? { ...prevDdns, ...patch.ddns }
						: { ...prevDdns, enabled: patch.ddns };
					}
					if (Object.keys(next).length === 0) return { ok: false, reason: '没有可保存的字段' };
					patchLinkConfig(STATE_DIR, next);
					return { ok: true };
				},
				// 端口也以 `link.json` 为准：配置页原来显示 setup.json 的默认 8899，
				// 用户改过端口就会给手机一个错地址。
				gatewayPort: () => {
					const config = readLinkConfig(STATE_DIR);
					const port = Number(config?.port);
					return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : undefined;
				},
				// 真实通知开关（`link-peer.json` 的 notify，link-notify 每次发送都读）。
				notifyEnabled: () => notifyEnabled(STATE_DIR),
				setNotifyEnabled: (on) => {
					patchLinkPeer(STATE_DIR, { notify: on === true });
					return on === true;
				},
				// 真实撤销设备（网关内存 + devices.json 一起改）。
				revokeDevice: (id) => {
					const devices = desktopGateway?.devices;
					if (!devices || typeof devices.revoke !== 'function') return { ok: false, reason: '网关未就绪' };
					return devices.revoke(id);
				},
			},
		});

		// ---- 授权码弹窗的状态接口（挂在同一个 Web 端口上，仅 loopback） ----
		//
		// 电脑端页面（`lib/client.js`）每 3 秒问一次 `GET /api/dsh-remote/link/claim-info`：
		// 「要不要弹授权码浮层」。只读、无副作用；数据直接读设备白名单与配对码文件。
		if (typeof ctx.webServer?.register === 'function') {
			ctx.effect(
				() =>
					ctx.webServer.register({
						kind: 'prefix',
						path: LINK_ROUTE,
						handler: (req, res) => handleLinkRoute(ctx, req, res),
					}),
				'dsh-link: claim-info route',
			);
		}

		// ---- 局域网直连网关（v2：TLS 流式直通） ----
		//
		// 配置在 `$DSH_HOME/dsh-remote/link.json`；enabled=false 就不启动（只记一行日志）。
		// 监听 listen:port（自签证书），请求/响应原样 pipe 到本机中继
		// （http://127.0.0.1:17890，upstreamPort 可配）。不解密、不缓冲，SSE 能逐块到达；
		// token 仍由中继的 x-dsh-remote-token 校验。失败只记日志，绝不把异常抛回 DSH。
		ctx.effect(() => {
			try {
				const stop = startLinkGateway({
					log: (line, level = 'info') => {
						ctx.logger?.[level]?.(`[dsh-link][link] ${line}`);
						void debugLog(`link ${line}`);
					},
				});
				// 句柄给配置页用（解绑 / 断开全部配对要真的改白名单）。
				desktopGateway = stop;
				return () => {
					desktopGateway = null;
					stop?.();
				};
			} catch (error) {
				ctx.logger?.error?.(`[dsh-link][link] 启动失败: ${String(error?.message ?? error)}`);
				void debugLog(`link 启动失败: ${String(error?.message ?? error)}`);
				return () => {};
			}
		}, 'dsh-link: link gateway');

		// ---- 子代理式自动通知：本机会话一轮结束 → 投给手机 link agent ----
		//
		// 判据（任何一条挡住都**不发**，只留一行日志）：
		//   ① 事件是 `turn/end`；② 不是镜像/派生会话；③ 该轮有 assistant 文本；
		//   ④ 同一 sessionId 10 秒内只发一次。
		// 只是**旁听** `session/event`：不调 next()、不 await、不抛错 —— 绝不阻塞会话。
		ctx.effect(() => {
			const off = ctx.on(
				'session/event',
				(session, event) => handleSessionEventForNotify(ctx, session, event),
				{ global: true },
			);
			void debugLog('notify 就绪：已监听 turn/end（notify=false 时只记「未启用」）');
			return () => {
				try {
					off?.();
				} catch {
					/* 已释放 */
				}
			};
		}, 'dsh-link: turn/end → 手机 link 通知');

		return () => {
			try {
				state.relay?.close();
			} catch {
				/* 已关闭 */
			}
		};
	}, 'dsh-link: relay + link gateway + notify');
}

// ⚠️ `handleLinkRoute` 导出是为了自测：`/role` 这条路由是前端单包门的**唯一判据**，
// 断掉的表现是「电脑端浮层不弹 + 手机 UI 不注入」这种静默失效，必须能被测到，
// 而不能只靠读代码的人记得它在哪。
export { RELAY_PORT, TOKEN_PATH, listDirectory, handleRpc, handleLinkRoute };
