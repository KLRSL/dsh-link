/**
 * setup-routes —— dsh-link 真实宿主（DSH webServer）上的「连接配置」适配器。
 *
 * ## 它做什么
 *
 * 把 {@link createSetupService} 包成 DSH Web 端口上的路由，挂在
 * `/api/dsh-remote/link` 前缀下（与既有的 `/role`、`/claim-info` 同门）：
 *
 * | 路径 | 方法 | 动作 |
 * |---|---|---|
 * | `/setup`                | GET  | 配置页 HTML（独立页面形态，客户端 iframe 打开） |
 * | `/setup/state`          | GET/POST | 当前状态（含真实本机地址 / 可用工作区 / 是否已配对） |
 * | `/setup/workspaces`     | GET  | 本机真实工作区清单（给「让我自己选」用） |
 * | `/setup/address`        | POST | 保存连接地址（电脑端：就绪后生成验证码；手机端：落 mobile 配置） |
 * | `/setup/verify`         | POST | 电脑端：校验手机输入的码；手机端：连同电脑完成配对 |
 * | `/setup/workspace`      | POST | 工作区增删（双向） |
 * | `/setup/sync`           | POST | 双向同步 |
 * | `/setup/hide`           | POST | 隐藏方式（时效 × 范围） |
 * | `/setup/hide/clear`     | POST | 取消隐藏 |
 * | `/setup/config`         | GET/POST | 会话同步 / 通知 |
 * | `/setup/device/unbind`  | POST | 解绑设备 |
 * | `/setup/pairing/reset`  | POST | 重配对 |
 * | `/setup/prompted`       | POST | 记「已经自动弹过一次」 |
 * | `/setup/decline`        | POST | 用户点「否」：以后不再自动打开/询问 |
 * | `/setup/auto-open`      | POST | 设置页「重新启用向导」 |
 * | `/setup/finish`         | POST | 落 `configuredAt` |
 *
 * ## 两端同一份实现
 *
 * 电脑端与手机端共用本文件：差异（本机地址、可用工作区、目录浏览、配对动作）
 * 全部通过 `providers` 注入。手机端没有「本机对外地址」，它的地址来自
 * `mobile.json` 的 `lanHost/lanPort`；配对必须走宿主的桥（`lanConnect`），
 * 不能在手机自己的 setup.json 里凭空生成一个码 —— 码是电脑端生成的。
 *
 * 不传 `providers`/`role` 时行为与 0.2.0 的电脑端一致（本机 IPv4 自动探测），
 * 既有测试（`tests/setup-routes.mjs`）不需要改。
 *
 * @module dsh-link/setup/setup-routes
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { join } from 'node:path';

/**
 * 插件自身版本（设置页标题上那串数字）。
 *
 * ⚠️ 0.18.27：以前 `lib/client.js` 把 `· 0.18.0` **写死**在标题里，装到 0.18.26
 * 用户看到的还是 0.18.0（真机截图）。版本号只该有一处真相：包里的 `package.json`。
 * 这里读一次缓存起来，随 `/state` 一起下发，由前端显示。
 */
let pluginVersionCache = '';
function pluginVersionOf() {
	if (pluginVersionCache !== '') return pluginVersionCache;
	try {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
		pluginVersionCache = typeof manifest?.version === 'string' ? manifest.version : '';
	} catch {
		pluginVersionCache = '';
	}
	return pluginVersionCache;
}

import { createSetupStore } from './setup-store.js';
import { createSetupService } from './setup-service.js';

// 2026-10-29 重做：配置 UI 已并入 DSH 设置分区（client.js），
// 不再提供独立的 iframe 页面；这里只保留数据接口。

/** 名字里带这些词的网卡一律降权：它们是 VPN / 虚拟机 / 容器，手机在局域网里够不着。 */
const VIRTUAL_ADAPTER_RE = /(radmin|tailscale|zerotier|hamachi|vpn|vethernet|vmware|virtualbox|hyper-?v|docker|wsl|loopback|npcap|tap|tun)/i;

/**
 * 挑本机**手机够得着**的 IPv4。
 *
 * ## ⚠️ 为什么不能只取「第一个非回环地址」（0.2.1 的真实现场）
 *
 * 这台机器上 `networkInterfaces()` 的第一项是 Radmin VPN 的 `26.7.204.160`，
 * 于是「自动获取」把 VPN 地址填进了配置页 —— 手机在局域网里根本连不到它，
 * 用户只会看到「连不上」，而界面上没有任何线索说明这个地址是 VPN 的。
 * 真正的局域网地址是 `192.168.1.3`（以太网）。
 *
 * 打分规则：
 * - 私网优先：`192.168/16` > `10/8` > `172.16-31`；CGNAT/100.64（Tailscale 常用）更低；
 * - 网卡名命中 VPN / 虚拟机 / 容器关键词 → 降权；
 * - 链路本地 `169.254`、回环、internal 一律排除。
 *
 * @param {object} [interfaces] - 注入 `os.networkInterfaces()` 的结果（测试用）。
 * @returns {string} 选中的地址；没有候选返回空串。
 */
export function pickLocalIPv4(interfaces) {
	const table = interfaces !== undefined ? interfaces : networkInterfaces();
	const candidates = [];
	for (const [name, list] of Object.entries(table ?? {})) {
		if (!Array.isArray(list)) continue;
		for (const item of list) {
			if (item.family !== 'IPv4' && item.family !== 4) continue;
			if (item.internal === true) continue;
			const address = String(item.address ?? '');
			if (address === '' || address.startsWith('169.254.')) continue;
			let score;
			if (/^192\.168\./.test(address)) score = 40;
			else if (/^10\./.test(address)) score = 30;
			else if (/^172\.(1[6-9]|2\d|3[01])\./.test(address)) score = 20;
			else if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(address)) score = 5;
			else score = 10;
			if (VIRTUAL_ADAPTER_RE.test(name)) score -= 15;
			candidates.push({ address, score, name });
		}
	}
	candidates.sort((a, b) => (b.score - a.score) || a.address.localeCompare(b.address));
	return candidates.length > 0 ? candidates[0].address : '';
}

/** 给响应写 JSON。同源调用，不加 CORS（与 claim-info 一致）。 */
function sendJson(res, status, payload, extraHeaders = {}) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		'Content-Type': 'application/json; charset=utf-8',
		'Cache-Control': 'no-store',
		...extraHeaders,
	});
	res.end(body);
}

/**
 * 读请求体（限大小，防滥用）。空体解析为 `{}`。
 *
 * 超限时**不断连接**，而是停止记账、把剩余字节排空，等 `end` 再回 413 ——
 * 否则 `req.destroy()` 会让客户端拿到 socket error，看不到任何状态码。
 */
function readBody(req, limit = 1 << 16) {
	return new Promise((resolve, reject) => {
		let size = 0;
		let overflow = false;
		const chunks = [];
		req.on('data', (c) => {
			if (overflow) return;            // 已超限：只排空，不再占内存
			size += c.length;
			if (size > limit) {
				overflow = true;
				chunks.length = 0;
				return;
			}
			chunks.push(c);
		});
		req.on('end', () => {
			if (overflow) {
				reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
				return;
			}
			const text = Buffer.concat(chunks).toString('utf8');
			if (text === '') return resolve({});
			try {
				resolve(JSON.parse(text));
			} catch {
				reject(Object.assign(new Error('JSON 解析失败'), { code: 'BAD_JSON' }));
			}
		});
		req.on('aborted', () => reject(Object.assign(new Error('连接中断'), { code: 'ABORTED' })));
		req.on('error', reject);
	});
}

/** 调一个可选的 provider；失败返回 `undefined`（配置页不能因为探测失败就打不开）。 */
async function callProvider(fn, ...args) {
	if (typeof fn !== 'function') return undefined;
	try {
		return await fn(...args);
	} catch {
		return undefined;
	}
}

/**
 * 创建一个配置控制器。
 *
 * @param {object} [options]
 * @param {string} [options.dir] - 配置目录（落 `setup.json`）；缺省纯内存。
 * @param {'desktop'|'mobile'} [options.role] - 本机角色（决定状态口径）。
 * @param {(line: string, level?: string) => void} [options.log] - 日志器。
 * @param {object} [options.providers] - 两端差异的注入点：
 *   - `localAddress()`：电脑端真实本机 IPv4（缺省 {@link pickLocalIPv4}）；
 *   - `listWorkspaces()`：本机真实工作区（电脑端 = 官方注册表）；
 *   - `gatewayPort()`：电脑端网关真实端口（`link.json` 的 `port`）；
 *   - `pairing()`：电脑端真实配对码与设备（`device-auth`）；
 *   - `revokeDevice(id)`：真正撤销一台设备（网关的 `devices.revoke`）；
 *   - `notifyEnabled()` / `setNotifyEnabled(on)`：真实通知开关（`link-peer.json`）；
 *   - `status()`：手机端 lanStatus（host/port/paired/authorized/fp）；
 *   - `saveAddress(input)`：手机端把地址写进 `mobile.json`；
 *   - `connect({host,port,code,name})`：手机端与电脑完成配对；
 *   - `syncedWorkspaces()`：手机端已镜像的电脑工作区路径。
 * @returns {{ service: object, store: object, handle: Function, role: string }}
 */
export function createSetupController({ dir, role = 'desktop', log = () => {}, providers = {} } = {}) {
	const store = createSetupStore({
		file: dir ? join(dir, 'setup.json') : undefined,
		// 手机端的 store 角色必须真的是 mobile：否则 getState('mobile').role 会说 desktop，
		// 前端只能靠 localRole 兜底，日志/排障时容易误判。
		defaults: { role: role === 'mobile' ? 'mobile' : 'desktop' },
	});
	const service = createSetupService({ store, log });
	/** 本机角色：手机端的状态/写动作走另一套口径。 */
	const selfRole = role === 'mobile' ? 'mobile' : 'desktop';

	/**
	 * 手机端状态补充：地址/配对来自 `providers.status()`，不是 setup.json。
	 * 合并规则：status 有值就以它为准（它才是真正在用的连接配置）。
	 */
	async function mergeMobileStatus(state) {
		const status = await callProvider(providers.status);
		if (status && typeof status === 'object') {
			if (typeof status.host === 'string' && status.host !== '') state.host = status.host;
			if (Number.isInteger(status.port)) state.port = status.port;
			// ⚠️ 只认**真实握手**结果：`paired` 必须是「带凭据 ping 成功」。
			// 0.2.x 把「本地有凭据」当已连接 ⇒ 电脑删了设备手机仍显示已连接。
			state.paired = status.connected === true;
			state.connected = status.connected === true;
			state.authorized = status.authorized === true;
			state.reason = typeof status.reason === 'string' ? status.reason : '';
			state.certFp = typeof status.fp === 'string' ? status.fp : '';
			state.endpoint = typeof status.endpoint === 'string' ? status.endpoint : '';
		}
		const syncStatus = await callProvider(providers.syncStatus);
		if (syncStatus && typeof syncStatus === 'object') state.syncStatus = syncStatus;
		const synced = await callProvider(providers.syncedWorkspaces);
		if (Array.isArray(synced)) {
			state.syncedWorkspaces = synced;
			// 能拿到电脑的勾选列表 = 这次请求已经通过设备鉴权打通了。
			// 状态探测（ping）偶发失败时，以这条实打实的 RPC 为准，避免
			// 「会话都能同步、设置页却说未连接」。
			if (synced.length > 0 && state.connected !== true) {
				state.paired = true;
				state.connected = true;
				state.authorized = true;
				state.reason = 'ok';
			}
		}
		// 真实连上 = 配置完成（手机可能从别处配过，setup.json 里 configuredAt 为空）。
		if (state.connected === true) {
			state.addressReady = true;
			if (!state.configuredAt) state.configuredAt = 1;
		}
		// 手机端不生成码（码在电脑端）；前端据此不渲染「重新生成」。
			return state;
	}

	/**
	 * 组装一份**原始**状态（只取 store；真实数据由 {@link enrichState} 合并）。
	 *
	 * @param {string} [want] - `desktop` / `mobile` 视角（缺省本机角色）。
	 * @returns {Promise<object>}
	 */
	async function stateOf(want) {
		const view = want === 'mobile' || want === 'desktop' ? want : selfRole;
		// 手机端不返回配对码明文（与 0.2.0 的 claimInfo 同口径）。
		const state = service.getState(view === 'desktop' ? 'desktop' : 'mobile');
		state.localRole = selfRole;
		return state;
	}

	/**
	 * 把「真实数据」合并进**任意一份**状态（读、写两条路共用）。
	 *
	 * ## ⚠️ 为什么写动作也要合并（0.2.1 的真实缺陷）
	 *
	 * 早先只有 `/state` 会合并真实配对信息，而保存地址 / 勾工作区 / 解绑这些
	 * 写动作返回的是 store 裸状态。页面 `adopt()` 一接：
	 * - `devices` 变空、`paired` 变 false ⇒ 步骤 2 从「已配对」退回未就绪；
	 * - 保存地址后显示的是 setup.json 自造的 6 位码（真码在网关里）⇒ 手机上必错。
	 * 所以这里要求**所有带 `state` 的响应统一过一遍**。
	 *
	 * @param {object} state
	 * @returns {Promise<object>}
	 */
	async function enrichState(state) {
		if (!state || typeof state !== 'object') return state;
		state.localRole = selfRole;
		// 设置页标题要显示的版本号：唯一来源是包里的 package.json。
		if (typeof state.version !== 'string' || state.version === '') state.version = pluginVersionOf();
		if (selfRole === 'desktop') {
			if (typeof state.localAddress !== 'string') {
				const address = await callProvider(providers.localAddress);
				state.localAddress = typeof address === 'string' ? address : pickLocalIPv4();
			}
			const available = await callProvider(providers.listWorkspaces);
			state.availableWorkspaces = Array.isArray(available) ? available : [];
			const port = await callProvider(providers.gatewayPort);
			if (Number.isInteger(port) && port > 0) state.gatewayPort = port;
			const notifyEnabled = await callProvider(providers.notifyEnabled);
			if (typeof notifyEnabled === 'boolean') state.notifyEnabled = notifyEnabled;
			// 真实网关配置（link.json）：地址族 / 监听 / 端口 / 公网 / DDNS / 证书指纹。
			const gateway = await callProvider(providers.gatewayInfo);
			if (gateway && typeof gateway === 'object') {
				state.gateway = gateway;
				if (typeof gateway.certFp === 'string' && gateway.certFp !== '') state.certFp = gateway.certFp;
			}
			await mergeDesktopPairing(state);
		} else {
			await mergeMobileStatus(state);
		}
		return state;
	}

	/**
	 * 电脑端：配对码与已配对设备**以网关为准**（`device-auth` 的
	 * `devices.json`）。
	 *
	 * ## ⚠️ 为什么不能用 setup.json 里那份码（0.2.0 的真实缺陷）
	 *
	 * 真正的配对接的是网关的 `POST /link/claim`，它校验的是 `device-auth` 的
	 * 配对码；而 0.2.0 的配置页自己另生成一份码、只存在 `setup.json` 里 ——
	 * 用户在电脑上看到的那 6 位数字**在手机上输进去永远是错的**。
	 * 所以这里把真实码与真实设备覆盖进来，页面不再自说自话。
	 *
		 * 只要有一台旧设备就永远加不了第二台（页面显示「已与 N 台设备配对」、
	 * 却没有码，重启也不会生成 —— 用户实际报障）。
	 */
	async function mergeDesktopPairing(state) {
		const pairing = await callProvider(providers.pairing);
		if (!pairing || typeof pairing !== 'object') return state;
		const devices = Array.isArray(pairing.devices)
			? pairing.devices.map((device) => ({
				id: String(device?.id ?? ''),
				shortId: String(device?.id ?? '').slice(0, 8),
				name: typeof device?.name === 'string' && device.name !== '' ? device.name : '设备',
				fingerprint: '',
				pairedAt: Number(device?.addedAt) || 0,
				lastSeen: Number(device?.lastSeen) || 0,
			}))
			: [];
		state.devices = devices;
		state.paired = state.paired === true || devices.length > 0;
		return state;
	}

	/** 手机端连接后的收尾：落配对态 + 设备 + configuredAt。 */
	async function connectMobile(body = {}) {
		const connect = providers.connect;
		if (typeof connect !== 'function') return { ok: false, reason: '手机端配对通道未就绪（宿主桥不可用）' };
		const input = {
			host: String(body.host ?? '').trim(),
			port: Number(body.port),
			code: String(body.code ?? '').trim(),
			name: typeof body.name === 'string' ? body.name : '手机',
		};
		let outcome;
		try {
			outcome = await connect(input);
		} catch (error) {
			return { ok: false, reason: String((error && error.message) || error) };
		}
		if (!outcome || outcome.ok !== true) {
			return { ok: false, reason: String(outcome?.reason ?? outcome?.error ?? '连接失败') };
		}
		const state = service.markConnected({
			deviceId: outcome.deviceId,
			name: input.name,
			fingerprint: outcome.fp,
			host: input.host !== '' ? input.host : outcome.host,
			port: Number.isInteger(input.port) ? input.port : outcome.port,
		}).state;
		return {
			ok: true,
			result: 'ok',
			state: await mergeMobileStatus(state),
			needCode: outcome.needCode === true,
			// lanConnect 可能「连通但没授权」（没填码/码没通过），必须把授权结果带出去，
			// 否则 /pair 会把「连上了但电脑不认」当成配对成功 —— UI 就会出现
			// 红字「已连接」、状态却一直是未连接。
			authorized: outcome.authorized === true,
		};
	}

	/** 动作分发（sub 形如 `/state`、`/address`、`/workspaces`…）。 */
	async function dispatch(sub, body, url) {
		switch (sub) {
			case '/state':
				return { ok: true, state: await stateOf(body.role || url.searchParams.get('role') || selfRole) };
			case '/workspaces': {
				const available = await callProvider(providers.listWorkspaces);
				return { ok: true, workspaces: Array.isArray(available) ? available : [] };
			}
			case '/address': {
				if (selfRole === 'mobile') {
					const save = providers.saveAddress;
					if (typeof save === 'function') {
						try {
							await save({ family: body.family, host: body.host, port: body.port });
						} catch (error) {
							return { ok: false, field: 'host', reason: String((error && error.message) || error) };
						}
					}
					const applied = service.applyAddressInfo(body);
					if (applied.ok !== true) return applied;
					return { ok: true, state: applied.state };
				}
				// 电脑端的码在网关里：本地**不再**生成一份假码（否则页面显示错码）。
				return service.submitAddress(body);
			}
			case '/gateway': {
				// 真实网关配置（link.json）：地址族 / 监听地址 / 端口 / 公网 / DDNS。
				const update = providers.updateGateway;
				if (typeof update !== 'function') return { ok: false, reason: '本机不支持修改网关配置' };
				try {
					const outcome = await update(body);
					if (!outcome || outcome.ok !== true) return { ok: false, reason: (outcome && outcome.reason) || '保存失败' };
					return { ok: true, restartRequired: true, state: service.getState('desktop') };
				} catch (error) {
					return { ok: false, reason: String((error && error.message) || error) };
				}
			}
			case '/pair': {
				// 手机端一步完成：存地址 → 校验配对码 → 落 configuredAt。
				// 设置面板里直接填地址/端口/验证码，不再弹任何窗口。
				if (selfRole !== 'mobile') return { ok: false, reason: '仅手机端使用' };
				const save = providers.saveAddress;
				if (typeof save === 'function') {
					try {
						await save({ family: body.family || 'ipv4', host: body.host, port: body.port });
					} catch (error) {
						return { ok: false, reason: String((error && error.message) || error) };
					}
				}
				const applied = service.applyAddressInfo(body);
				if (applied.ok !== true) return applied;
				const connected = await connectMobile(body);
				if (connected.ok !== true) return connected;
				if (connected.authorized !== true) {
					return { ok: false, reason: '配对没完成：验证码没有通过（电脑上的码 5 分钟内有效，先在电脑端点「生成配对码」）' };
				}
				// 授权成功就是已连接：不再让 UI 等下一次 linkStatus 才更新状态
				//（手机网络慢/刚 pin 完证书时，那次探测可能瞬时失败，界面就会
				// 停在上一次的「未连接 / 不认识这台手机」）。
				if (connected.state && typeof connected.state === 'object') {
					connected.state.connected = true;
					connected.state.paired = true;
					connected.state.authorized = true;
					connected.state.reason = 'ok';
				}
				// 配对成功立刻建工作区 + 搬会话；失败原因直接写进 state。
				const syncNow = providers.syncNow;
				if (typeof syncNow === 'function') {
					try {
						const outcome = await syncNow();
						if (connected.state && typeof connected.state === 'object') connected.state.syncStatus = outcome;
					} catch { /* syncNow 自己会写 lastSyncState */ }
				}
				return connected;
			}
			case '/workspace':
				return service.applyWorkspaceOp(body);
			case '/sync':
				return service.mergeSync(body);
			case '/hide':
				return service.setHide(body);
			case '/hide/clear':
				return service.clearHide(body.path);
			case '/config':
				return body && Object.keys(body).length > 0
					? service.setConfig(body)
					: { ok: true, config: service.getConfig() };
			case '/notify': {
				// 真实开关：电脑端写 `link-peer.json` 的 `notify`（link-notify 每次发送都读它）。
				const set = providers.setNotifyEnabled;
				if (typeof set !== 'function') return { ok: false, reason: '本机不支持通知开关' };
				try {
					await set(body.on !== false);
				} catch (error) {
					return { ok: false, reason: String((error && error.message) || error) };
				}
				return { ok: true, state: service.getState('desktop') };
			}
			case '/device/unbind': {
				// 真实白名单：`devices.json`（网关的 device-auth），不是 setup.json 的副本。
				const revoke = providers.revokeDevice;
				if (typeof revoke === 'function') {
					const outcome = await callProvider(revoke, body.id);
					if (!outcome || outcome.ok !== true) return { ok: false, reason: '没有找到这台设备（可能已解绑）' };
					return { ok: true, removed: true, state: service.getState('desktop') };
				}
				return service.unbind(body.id);
			}
			case '/pairing/reset': {
				// 「断开全部配对」必须真的清网关白名单，否则手机下次仍能直接连。
				const revoke = providers.revokeDevice;
				if (typeof revoke === 'function') {
					const pairing = await callProvider(providers.pairing);
					const devices = Array.isArray(pairing?.devices) ? pairing.devices : [];
					for (const device of devices) await callProvider(revoke, device?.id);
					return { ok: true, revoked: devices.length, state: service.resetPairing().state };
				}
				return service.resetPairing();
			}
			case '/prompted':
				return service.markPrompted();
			case '/decline':
				return service.declinePrompt();
			case '/auto-open':
				return service.setAutoOpen(body.on !== false);
			case '/finish':
				return service.finishSetup();
			default:
				throw new Error(`未知 action: ${sub}`);
		}
	}

	/**
	 * 处理一个 `/api/dsh-remote/link/setup*` 请求。
	 *
	 * @param {import('node:http').IncomingMessage} req
	 * @param {import('node:http').ServerResponse} res
	 * @param {string} action - `url.pathname` 去掉 `/api/dsh-remote/link` 后的剩余部分
	 *                           （如 `/setup`、`/setup/state`）。
	 */
	async function handle(req, res, action) {
		// 只接管 `/setup*` 这一段，其余交给 `handleLinkRoute` 的既有逻辑。
		if (!action.startsWith('/setup')) return false;
		const sub = action.slice('/setup'.length) || '/'; // '' → '/'

		// 独立配置页已删除：UI 并入 DSH 设置分区（client.js）。
		// 保留一个明确的 410，旧书签/旧 iframe 不会拿到半截页面。
		if (sub === '/' || sub === '') {
			sendJson(res, 410, { ok: false, reason: '配置页已并入 DSH 设置 →「局域互联」，不再单独提供页面' });
			return true;
		}

		const method = String(req.method ?? 'GET').toUpperCase();
		if (method === 'OPTIONS') {
			sendJson(res, 204, {});
			return true;
		}
		// 方法矩阵：
		//   POST 收写动作，**也收 /state** —— 前端 `getState(role)` 把 role 放在 body 里，
		//        早先只放行 GET 会导致真实宿主里 405、状态永远拿不到。
		// 未知 action 交给 dispatch 抛「未知 action」→ 400，比 405 更准确。
		const GET_OK = sub === '/state' || sub === '/config' || sub === '/workspaces';
		const POST_OK = true;
		if (method === 'GET' && !GET_OK) {
			sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return true;
		}
		if (method === 'POST' && !POST_OK) {
			sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return true;
		}
		if (method !== 'GET' && method !== 'POST') {
			sendJson(res, 405, { ok: false, error: 'method-not-allowed' });
			return true;
		}

		const url = new URL(req.url ?? '/', 'http://127.0.0.1');
		try {
			const body = method === 'GET' ? Object.fromEntries(url.searchParams) : await readBody(req);
			const result = await dispatch(sub, body, url);
			// ⚠️ 所有带 `state` 的响应统一合并真实数据（读和写都走这里）。
			if (result && typeof result === 'object' && result.state && typeof result.state === 'object') {
				result.state = await enrichState(result.state);
			}
			sendJson(res, 200, result);
		} catch (err) {
			// 请求体过大给 413（语义准确，客户端能区分「传太多」和「传错格式」）。
			const status = err?.code === 'BODY_TOO_LARGE' ? 413 : 400;
			sendJson(res, status, { ok: false, reason: err?.message ?? '请求处理失败' });
		}
		return true;
	}

	return { service, store, handle, role: selfRole };
}

export default createSetupController;
