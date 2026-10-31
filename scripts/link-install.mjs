#!/usr/bin/env node
/**
 * link-install —— 在**电脑**上把插件包推到**手机**上装（0.1.2）。
 *
 * 链路：读 `link-peer.json` 的 `url`/`key`（与反向通知同一份配置）→ POST
 * `https://<手机>:8898/link/plugin-install`，头 `x-link-key` + `x-link-ts`，
 * 体 `{name, version, tgzBase64, sha256}`。手机端会**弹卡片让用户确认**，
 * 装完把 `requiresRestart:true` 带回来 —— 重启手机 DSH 后才生效。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/link-install.mjs E:\path\to\dsh-xxx-0.2.0.tgz
 * node scripts/link-install.mjs xxx.tgz --url https://192.168.1.10:8898 --key <pairKey>
 * ```
 *
 * 配置默认读 `%USERPROFILE%\.dsh\dsh-remote\link-peer.json`，可用 `--config` 或
 * 环境变量 `LINK_PEER_CONFIG` 换一份（自测用）。`--url`/`--key` 会覆盖配置里的值。
 *
 * ## 退出码
 *
 * | 码 | 含义 |
 * |---|---|
 * | 0 | 手机返回 200 且 `ok:true`，装好了（需重启手机生效） |
 * | 1 | 参数/本地文件/包内容不合法（读不到、不是 tgz、路径穿越…） |
 * | 2 | 请求没发出去或断了（连不上、超时、证书指纹不符） |
 * | 3 | 手机端拒绝（401/400/403/408/413…，含用户在手机上点「拒绝」） |
 *
 * 特别地：**用户拒绝 = 403（退出码 3）**，不是错误，是用户的选择；
 * 脚本会把手机返回的 `error`/`detail` 原样打出来，方便判断是重试还是改包。
 *
 * @module dsh-link/scripts/link-install
 */
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request as httpsRequest } from 'node:https';
import { connect as tlsConnect } from 'node:tls';
import { resolve } from 'node:path';

import { InstallError, readTgzPackage, sha256Hex } from '../lib/mobile/plugin-install.js';
import { statePathOf } from '../lib/shared/home.js';
import { unwrapHost } from '../lib/shared/net.js';

const EXIT_OK = 0;
const EXIT_USAGE = 1;
const EXIT_SEND = 2;
const EXIT_REFUSED = 3;
/** 等手机响应（含用户点卡片）的上限：给足 10 分钟。 */
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
/** 投递端点（与手机网关同一个常量）。 */
const INSTALL_PATH = '/link/plugin-install';

/** 打印一行用法说明。 */
function usage() {
	console.log('用法: node scripts/link-install.mjs <插件包.tgz> [--url https://<手机>:8898] [--key <pairKey>] [--config <link-peer.json>] [--timeout <ms>] [--trust-first-use]');
	console.log('  --trust-first-use  未 pin 证书指纹时仍发送（会打印对端实际指纹，供人工核对）');
}

/** 极简参数解析：第一个位置参数是 tgz，其余 `--flag value`。 */
function parseArgs(argv) {
	const options = { tgz: '', url: '', key: '', config: '', timeoutMs: DEFAULT_TIMEOUT_MS, trustFirstUse: false };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === '--help' || arg === '-h') return { help: true };
		// 显式认领「先用后信」：没 pin 指纹时**只有**加了这个开关才发（P1-3）。
		if (arg === '--trust-first-use') {
			options.trustFirstUse = true;
			continue;
		}
		if (arg === '--url' || arg === '--key' || arg === '--config' || arg === '--timeout') {
			const value = argv[index + 1];
			if (value === undefined || value.startsWith('--')) return { error: `${arg} 缺少值` };
			index += 1;
			if (arg === '--url') options.url = value;
			else if (arg === '--key') options.key = value;
			else if (arg === '--config') options.config = value;
			else {
				const timeoutMs = Number(value);
				if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { error: '--timeout 必须是正数（毫秒）' };
				options.timeoutMs = timeoutMs;
			}
			continue;
		}
		if (arg.startsWith('--')) return { error: `不认识的参数 ${arg}` };
		if (options.tgz !== '') return { error: '只接受一个 tgz 路径' };
		options.tgz = arg;
	}
	if (options.tgz === '') return { error: '缺少 tgz 路径' };
	return { options };
}

/**
 * 读 link-peer.json 的 url/key（读不到返回空，交给命令行覆盖）。
 *
 * ⚠️ 默认路径原来是 `join(homedir(), '.dsh', 'dsh-remote', ...)`（P1-5）：
 * **完全忽略 `$DSH_HOME`**，设了环境变量就永远读不到这份配置，装插件静默失败。
 * 现在统一走 `shared/home.js`。
 */
function readPeerConfig(path) {
	const target = path !== '' ? path : process.env.LINK_PEER_CONFIG || statePathOf('link-peer.json');
	try {
		const config = JSON.parse(readFileSync(target, 'utf8'));
		return { url: typeof config?.url === 'string' ? config.url.trim() : '', key: typeof config?.key === 'string' ? config.key.trim() : '', certFp: typeof config?.certFp === 'string' ? config.certFp.trim() : '', path: target };
	} catch (error) {
		return { url: '', key: '', certFp: '', path: target, error: String(error?.message ?? error) };
	}
}

/** 指纹归一（去冒号、大写），与 link-notify.js 同一口径。 */
function normalizeFingerprint(value) {
	return String(value ?? '').replace(/[^0-9a-f]/gi, '').toUpperCase();
}

/**
 * 只握手不发请求，拿对端证书 fingerprint256（pin 预检）。
 *
 * ⚠️ 必须**在发请求之前**做（P1-3）：`postInstall` 的 `key` 与整个 tgz 都是
 * 敏感数据，等响应回来再比对指纹，东西早就送出去了 —— 那是「事后确认」，
 * 不是校验。
 */
function peerFingerprint(url, timeoutMs) {
	return new Promise((resolvePromise, rejectPromise) => {
		let target;
		try {
			target = new URL(url);
		} catch (error) {
			rejectPromise(error);
			return;
		}
		const socket = tlsConnect({
			host: unwrapHost(target.hostname),
			port: Number(target.port || 443),
			rejectUnauthorized: false,
			timeout: timeoutMs,
		});
		let done = false;
		const finish = (error, value) => {
			if (done) return;
			done = true;
			socket.destroy();
			if (error) rejectPromise(error);
			else resolvePromise(value);
		};
		socket.on('secureConnect', () => {
			try {
				finish(null, socket.getPeerCertificate()?.fingerprint256 ?? '');
			} catch (error) {
				finish(error);
			}
		});
		socket.on('timeout', () => finish(Object.assign(new Error('TLS 握手超时'), { code: 'ETIMEDOUT' })));
		socket.on('error', finish);
	});
}

/** POST 一次，返回 `{ status, body, fingerprint }`；网络层失败直接 reject。 */
function postInstall({ url, key, payload, timeoutMs, certFp }) {
	const body = Buffer.from(JSON.stringify(payload), 'utf8');
	const target = new URL(url);
	if (target.protocol !== 'https:') return Promise.reject(new Error(`url 必须是 https://（当前 ${target.protocol}）`));
	return new Promise((resolvePromise, rejectPromise) => {
		const req = httpsRequest(
			{
				method: 'POST',
				hostname: unwrapHost(target.hostname),
				port: Number(target.port || 443),
				path: INSTALL_PATH,
				rejectUnauthorized: false, // 自签：链不校，靠 certFp pin
				agent: false,
				timeout: timeoutMs,
				headers: {
					'content-type': 'application/json',
					'content-length': body.length,
					'x-link-key': key,
					'x-link-ts': String(Date.now()),
					// ⚠️ nonce 是 P1-4 新增的第三道：只有 ts 的话，5 分钟窗口内
					// 同一个包（装着整个插件 tgz）仍可被重放无数次。
					'x-link-nonce': randomUUID(),
					'user-agent': 'dsh-link/1.0.0',
				},
			},
			(response) => {
				const fingerprint = response.socket?.getPeerCertificate?.()?.fingerprint256 ?? '';
				const chunks = [];
				response.on('data', (chunk) => chunks.push(chunk));
				response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), fingerprint }));
				response.on('error', rejectPromise);
			},
		);
		req.on('timeout', () => req.destroy(new Error(`等手机响应超过 ${timeoutMs}ms（用户还没点确认？）`)));
		req.on('error', rejectPromise);
		req.end(body);
	});
}

async function main() {
	const parsed = parseArgs(process.argv.slice(2));
	if (parsed.help === true) {
		usage();
		return EXIT_OK;
	}
	if (parsed.error !== undefined) {
		console.error(`[link-install] ${parsed.error}`);
		usage();
		return EXIT_USAGE;
	}
	const { options } = parsed;

	// ① 本地：读包 + 预检（包内 name/version、路径穿越都先在本地挡一遍，免得手机白跑一趟）。
	let tgz;
	let info;
	try {
		tgz = readFileSync(resolve(options.tgz));
		info = readTgzPackage(tgz);
	} catch (error) {
		const detail = error instanceof InstallError ? `${error.code}${error.detail === '' ? '' : `: ${error.detail}`}` : String(error?.message ?? error);
		console.error(`[link-install] 包不合法：${detail}`);
		return EXIT_USAGE;
	}
	const sha256 = sha256Hex(tgz);

	// ② 配置：命令行 > link-peer.json。
	const peer = readPeerConfig(options.config);
	const url = options.url !== '' ? options.url : peer.url;
	const key = options.key !== '' ? options.key : peer.key;
	if (url === '' || key === '') {
		const why = peer.error !== undefined ? `（读 ${peer.path} 失败: ${peer.error}）` : `（${peer.path} 里缺 url/key）`;
		console.error(`[link-install] 拿不到手机地址或密钥${why}`);
		console.error('[link-install] 用 --url/--key 直接指定，或检查 link-peer.json');
		return EXIT_USAGE;
	}

	console.log(`[link-install] 包=${resolve(options.tgz)}`);
	console.log(`[link-install] 插件=${info.name}@${info.version} 大小=${tgz.length}B sha256=${sha256}`);
	console.log(`[link-install] 目标=${url}${INSTALL_PATH}`);

	// ③ **先**校验证书指纹，通过才发（P1-3）。
	//
	// ⚠️ 从前这一步在 `postInstall` **之后**：先 POST（带 `key` 与整个 tgz），
	// 再拿响应里的 fingerprint 跟期望值比。那是事后确认，不是校验 ——
	// 东西已经送给可能是冒充者的对端了。
	const expectedFp = normalizeFingerprint(peer.certFp);
	let actualFp = '';
	try {
		actualFp = normalizeFingerprint(await peerFingerprint(url, options.timeoutMs));
	} catch (error) {
		console.error(`[link-install] 证书预检失败（未发送任何数据）：${String(error?.message ?? error)}`);
		return EXIT_SEND;
	}
	if (actualFp === '') {
		console.error('[link-install] 拿不到对端证书，已中止（无法确认连的是不是那台手机）');
		return EXIT_SEND;
	}
	if (expectedFp === '') {
		// 没 pin ⇒ 不许发，除非运维显式认领这次「先用后信」。
		// 命令行工具可以要一个开关：这是**人**在敲命令，不是后台静默行为。
		if (options.trustFirstUse !== true) {
			console.error(`[link-install] 未 pin 证书指纹，拒绝发送（对端实际为 ${actualFp}）。`);
			console.error('[link-install] 确认无误后加 --trust-first-use 重跑，或把上面这段指纹填进 link-peer.json 的 certFp。');
			return EXIT_USAGE;
		}
		console.warn(`[link-install] --trust-first-use：本次按「先用后信」发送，指纹 ${actualFp} 未记入配置，下次仍会提示。`);
	} else if (actualFp !== expectedFp) {
		console.error(`[link-install] 证书指纹不符（拒绝发送）：期望 ${expectedFp.slice(0, 16)}… 实际 ${actualFp.slice(0, 16)}…`);
		return EXIT_SEND;
	}

	console.log('[link-install] 已发出，手机端会弹卡片，请在手机上点「允许」…');

	// ④ 发送。
	let response;
	try {
		response = await postInstall({ url, key, timeoutMs: options.timeoutMs, certFp: peer.certFp, payload: { name: info.name, version: info.version, sha256, tgzBase64: tgz.toString('base64') } });
	} catch (error) {
		console.error(`[link-install] 发送失败：${String(error?.message ?? error)}`);
		return EXIT_SEND;
	}

	// ⑤ 结果。
	let parsedBody;
	try {
		parsedBody = JSON.parse(response.body);
	} catch {
		parsedBody = undefined;
	}
	if (response.status === 200 && parsedBody?.ok === true) {
		console.log(`[link-install] 安装成功：${parsedBody.name}@${parsedBody.version}（HTTP 200）`);
		if (parsedBody.requiresRestart === true) console.log('[link-install] 需要重启手机上的 DSH 才生效（插件在重启时加载）。');
		return EXIT_OK;
	}
	const code = String(parsedBody?.error ?? '');
	const detail = String(parsedBody?.detail ?? '');
	const hint = code === 'user-denied' ? '用户在手机上点了拒绝' : code === 'confirm-timeout' ? '等确认超时（手机没点）' : code === 'no-confirm-channel' ? '手机上现在没有确认通道（App 不在前台/没有活着的会话）' : '';
	console.error(`[link-install] 手机端拒绝：HTTP ${response.status} ${code}${detail === '' ? '' : ` — ${detail}`}${hint === '' ? '' : `（${hint}）`}`);
	console.error(`[link-install] 原始响应：${response.body.slice(0, 500)}`);
	return EXIT_REFUSED;
}

main().then(
	(code) => {
		process.exitCode = code;
	},
	(error) => {
		console.error(`[link-install] 未捕获异常：${String(error?.stack ?? error)}`);
		process.exitCode = EXIT_SEND;
	},
);
