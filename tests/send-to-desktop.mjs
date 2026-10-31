/**
 * 手机端 bridge 方法 `sendToDesktop` 的自检（0.1.4 新增：手机 → 电脑 主动推消息）。
 *
 * 只驱动导出的 `handleBridge`（不连电脑、不发请求）：
 *   node tests/send-to-desktop.mjs
 *
 * 用 `io.callRemote` 注入点替代真网络调用，断言：
 *   ① 成功：调用电脑 RPC `agentMessage`，参数字段正确，返回 `{ok:true, sessionId}`；
 *   ② 空文本：`{ok:false, error}`，连 RPC 都不发；
 *   ③ 电脑端回 `{ok:false, error}`：原样转成 `{ok:false, error}`；
 *   ④ 传输层抛错（没连电脑 / 网络失败）：收成 `{ok:false, error}`，**不抛**。
 */
import assert from 'node:assert/strict';

import { handleBridge } from '../lib/mobile/index.js';

const cases = [];

/** 假 ctx：`sendToDesktop` 不碰任何服务，只留一个能吞日志的 logger。 */
const ctx = { logger: { info() {}, warn() {}, error() {} } };

/** 手机配置：只要有「已连接」的凭据形态即可（测试里 callRemote 是假的）。 */
const config = {
	endpoint: 'https://192.168.1.17:8899',
	token: 'test-token',
	deviceId: 'device-1',
	deviceKey: 'key-1',
	deviceClaimed: true,
};

/** 发一条 bridge 请求：`params` 是方法入参，`callRemote` 是假电脑端。 */
function callSend(params, callRemote) {
	return handleBridge(ctx, config, {
		body: { method: 'sendToDesktop', params },
		callRemote,
	});
}

cases.push(['成功：调 agentMessage 并回 {ok:true, sessionId}', async () => {
	const seen = [];
	const result = await callSend({ text: '电脑那边把今天的报告发我' }, async (cfg, method, params) => {
		seen.push({ cfg, method, params });
		return { ok: true, sessionId: 'session-pc-1' };
	});
	assert.deepEqual(result, { ok: true, sessionId: 'session-pc-1' });
	assert.equal(seen.length, 1);
	assert.equal(seen[0].method, 'agentMessage', '必须走电脑端的 agentMessage');
	assert.equal(seen[0].params.text, '电脑那边把今天的报告发我');
	assert.equal(seen[0].params.sessionId, '', '没指定时传空串，让电脑端自己挑');
	assert.equal(seen[0].params.from, 'mobile');
	assert.equal(seen[0].cfg, config);
}]);

cases.push(['指定 sessionId：原样透传给电脑端', async () => {
	const seen = [];
	await callSend({ text: '只发这个会话', sessionId: 'session-given' }, async (cfg, method, params) => {
		seen.push(params);
		return { ok: true, sessionId: 'session-given' };
	});
	assert.equal(seen[0].sessionId, 'session-given');
}]);

cases.push(['空文本：{ok:false}，不发 RPC', async () => {
	let called = 0;
	const result = await callSend({ text: '   ' }, async () => {
		called += 1;
		return { ok: true, sessionId: 'x' };
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /text 为空/);
	assert.equal(called, 0);
}]);

cases.push(['电脑端回 {ok:false}：原样转成 {ok:false, error}', async () => {
	const result = await callSend({ text: '在吗' }, async () => ({
		ok: false,
		error: '没有可投递的会话（最近活跃的非派生会话为空）',
	}));
	assert.equal(result.ok, false);
	assert.match(result.error, /没有可投递的会话/);
}]);

cases.push(['传输层抛错（没连电脑 / 网络失败）：{ok:false}，不抛', async () => {
	const result = await callSend({ text: '在吗' }, async () => {
		throw new Error('连不上电脑（HTTP 502）：请确认电脑上的 DSH 还开着、没休眠，然后重发一次');
	});
	assert.equal(result.ok, false);
	assert.match(result.error, /连不上电脑/);
}]);

let pass = 0;
for (const [name, fn] of cases) {
	try {
		await fn();
		pass += 1;
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
console.log(`\nsend-to-desktop: ${pass}/${cases.length} 通过`);
