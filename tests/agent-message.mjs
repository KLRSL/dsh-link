/**
 * 电脑端 RPC `agentMessage` 的自检（0.1.4 新增：手机 → 电脑 主动推消息）。
 *
 * 只驱动导出的 `handleRpc`，不连 DSH、不开端口：
 *   node tests/agent-message.mjs
 *
 * 覆盖：
 *   ① 非空 sessionId ⇒ 直接投这个会话，返回 `{ok:true, sessionId}`；
 *   ② 空 sessionId ⇒ 按「最近活跃的非派生会话」挑（跳过 subagent / parentSession）；
 *   ③ followup 被调用，且 `source.kind === 'agent-message'`（v4 拒收 'plugin'）；
 *   ④ 失败一律 `{ok:false, error}`，**不抛**（解析不到 agent / 没有会话 / 空文本）。
 */
import assert from 'node:assert/strict';

import { handleRpc } from '../lib/desktop/index.js';

const cases = [];

/** 造一个假 ctx：`list` 给候选，`resolveAgent` 记录并返回一个假 agent。 */
function makeCtx({ items = [], resolve } = {}) {
	const calls = [];
	const ctx = {
		sessionController: {
			list: async () => ({ items }),
			resolveAgent:
				resolve ??
				(async (sessionId) => ({
					agent: {
						followup(message) {
							calls.push({ sessionId, message });
						},
					},
				})),
		},
	};
	return { ctx, calls };
}

cases.push(['非空 sessionId：直接投递 + source.kind=agent-message', async () => {
	const { ctx, calls } = makeCtx({
		// 有别的更新会话也不能抢走显式指定的目标。
		items: [{ sessionId: 'session-newest', updatedAt: '2026-10-26T00:30:00.000Z' }],
	});
	const result = await handleRpc(ctx, 'agentMessage', { text: '手机让你把报告发我', sessionId: 'session-given' });
	assert.deepEqual(result, { ok: true, sessionId: 'session-given' });
	assert.equal(calls.length, 1, 'followup 必须被调用一次');
	assert.equal(calls[0].sessionId, 'session-given');
	const message = calls[0].message;
	assert.equal(message.role, 'user');
	assert.deepEqual(message.content, [{ type: 'text', text: '手机让你把报告发我' }]);
	assert.deepEqual(message.source, { kind: 'agent-message', plugin: 'dsh-link' });
	assert.equal(typeof message.id, 'string');
	assert.notEqual(message.id, '');
}]);

cases.push(['空 sessionId：挑最近活跃的非派生会话（跳过 subagent / parentSession）', async () => {
	const { ctx, calls } = makeCtx({
		items: [
			// 最新，但是子代理派生会话 ⇒ 必须跳过
			{ sessionId: 'session-subagent', updatedAt: '2026-10-26T00:40:00.000Z', origin: 'subagent' },
			// 次新，但有 parentSession ⇒ 也是派生会话
			{ sessionId: 'session-child', updatedAt: '2026-10-26T00:35:00.000Z', parentSessionId: 'session-parent' },
			// 普通会话里最新的
			{ sessionId: 'session-main', updatedAt: '2026-10-26T00:20:00.000Z' },
			{ sessionId: 'session-old', updatedAt: '2026-10-25T18:00:00.000Z' },
		],
	});
	const result = await handleRpc(ctx, 'agentMessage', { text: '在吗' });
	assert.deepEqual(result, { ok: true, sessionId: 'session-main' });
	assert.equal(calls.length, 1);
	assert.equal(calls[0].sessionId, 'session-main');
	assert.deepEqual(calls[0].message.content, [{ type: 'text', text: '在吗' }]);
}]);

cases.push(['空 sessionId 且全是派生会话 ⇒ {ok:false}，不调 followup', async () => {
	const { ctx, calls } = makeCtx({
		items: [
			{ sessionId: 'session-subagent', updatedAt: '2026-10-26T00:40:00.000Z', origin: 'subagent' },
			{ sessionId: 'session-child', updatedAt: '2026-10-26T00:35:00.000Z', parentSessionId: 'session-parent' },
		],
	});
	const result = await handleRpc(ctx, 'agentMessage', { text: '在吗' });
	assert.equal(result.ok, false);
	assert.match(result.error, /没有可投递的会话/);
	assert.equal(calls.length, 0);
}]);

cases.push(['resolveAgent 返回 error ⇒ {ok:false}，不抛', async () => {
	const { ctx } = makeCtx({
		resolve: async () => ({ error: { message: 'session/not-found' } }),
	});
	const result = await handleRpc(ctx, 'agentMessage', { text: '在吗', sessionId: 'session-gone' });
	assert.equal(result.ok, false);
	assert.match(result.error, /session\/not-found/);
}]);

cases.push(['resolveAgent 抛错 ⇒ {ok:false}，不抛', async () => {
	const { ctx } = makeCtx({
		resolve: async () => {
			throw new Error('resolveAgent 炸了');
		},
	});
	const result = await handleRpc(ctx, 'agentMessage', { text: '在吗', sessionId: 'session-gone' });
	assert.equal(result.ok, false);
	assert.match(result.error, /resolveAgent 炸了/);
}]);

cases.push(['text 为空 ⇒ {ok:false}，连 resolveAgent 都不碰', async () => {
	let resolved = 0;
	const { ctx } = makeCtx({
		resolve: async () => {
			resolved += 1;
			return { agent: { followup() {} } };
		},
	});
	const result = await handleRpc(ctx, 'agentMessage', { text: '   ', sessionId: 'session-x' });
	assert.equal(result.ok, false);
	assert.match(result.error, /text 为空/);
	assert.equal(resolved, 0);
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
console.log(`\nagent-message: ${pass}/${cases.length} 通过`);
