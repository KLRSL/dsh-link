#!/usr/bin/env node
/**
 * preload-window —— 同步会话「预载历史」窗口选择的单元测试。
 *
 * 这段逻辑决定往手机本地日志里写哪一段电脑历史。写错一条，官方校验器在
 * **下次打开会话**时才报 `stored log is corrupt`，且不可回滚 —— 所以这里把
 * 每条判据都钉死：
 *
 *   ① 窗口必须以 `turn/start` 开头（否则状态机第一步就错）；
 *   ② 带 `messageSeqs` 的标题必须被排除（它引用绝对 seq，本地对不上）；
 *   ③ 有洞的 seq 只能取最长的连续尾巴；
 *   ④ 挑不出安全窗口时返回 null（宁可不写）。
 */
import assert from 'node:assert/strict';
import { needsPreload, nextTurnOfLocalLog, pickPreloadWindow } from '../lib/mobile/preload-window.js';

/** 造一条最小 wire event。 */
const ev = (seq, type, data = {}) => ({ type, seq, time: 1700000000000, data });

const turn = (seq, n) => ev(seq, 'turn/start', { turn: n });
const end = (seq, n) => ev(seq, 'turn/end', { turn: n });
const msg = (seq, n, role) =>
	ev(seq, role === 'user' ? 'user/message' : 'assistant/message', {
		turn: n,
		step: 1,
		message: { role, content: [{ type: 'text', text: 'x' }] },
	});

// ① 普通情况：最后一个 turn 完整落在尾巴里，窗口从它的 turn/start 开始。
{
	const events = [
		turn(0, 1), msg(1, 1, 'user'), msg(2, 1, 'assistant'), end(3, 1),
		turn(4, 2), msg(5, 2, 'user'), msg(6, 2, 'assistant'), end(7, 2),
	];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.equal(picked.firstTurn, 1, 'maxEvents 够大时应从最早的 turn/start 起');
	assert.equal(picked.events.length, 8);
	assert.equal(picked.events[0].type, 'turn/start');

	const tight = pickPreloadWindow(events, { maxEvents: 4 });
	assert.ok(tight !== null);
	assert.equal(tight.firstTurn, 2, 'maxEvents 不够时要退到后一个 turn/start');
	assert.equal(tight.events.length, 4);
}

// ② 尾巴不是从 turn/start 开始的（比如从 assistant/message 开始）⇒ 退回前一个 turn/start。
{
	const events = [turn(0, 1), msg(1, 1, 'user'), msg(2, 1, 'assistant'), end(3, 1), msg(4, 2, 'user')];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.equal(picked.firstTurn, 1);
	assert.equal(picked.events[0].type, 'turn/start');
}

// ③ 带 messageSeqs 的标题 ⇒ **只把这条标题扔掉**，内容照常预载（0.18.3 起）。
//
// 旧行为是「连同它之前的内容一起排除，从它之后的 turn/start 重新开始」。
// 真机上那条路走不通：标题是**追加在日志末尾**的，它后面不再有 turn/start
// ⇒ 整个会话永远 no-window（实测 session-c92593ec 就是这样被卡住的）。
{
	const title = ev(3, 'session/title', { title: 't', messageSeqs: [1], source: { kind: 'provider' } });
	const events = [
		turn(0, 1), msg(1, 1, 'user'), msg(2, 1, 'assistant'), title, end(4, 1),
		turn(5, 2), msg(6, 2, 'user'), end(7, 2),
	];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.equal(picked.firstTurn, 1, '标题改写后，窗口可以照样从第一轮开始');
	// 0.18.6：带 messageSeqs 的标题**不再丢弃**，而是改写成合法的用户标题
	//（否则本地会话的标题会退化成工作区 slug，真机上是 `e-de-423910b0`）。
	const kept = picked.events.filter((event) => event.type === 'session/title');
	assert.equal(kept.length, 1, '标题要保留');
	assert.deepEqual(kept[0].data.messageSeqs, [], '绝对 seq 引用必须清空');
	assert.equal(kept[0].data.source.kind, 'user', '清空 messageSeqs 后 source 必须标成 user');
	assert.equal(kept[0].data.title, 't', '标题文字不能丢');
	assert.deepEqual(picked.events.map((event) => event.seq), [0, 1, 2, 3, 4, 5, 6, 7]);
}

// ③b 标题挂在最后一个轮次后面（真机最常见）⇒ 仍然要有窗口（旧实现这里返回 null）。
{
	const title = ev(3, 'session/title', { title: 't', messageSeqs: [1], source: { kind: 'provider' } });
	const request = ev(4, 'session/title-llm-request', { turn: 1, messageSeqs: [1], messages: [{ role: 'user' }] });
	const events = [turn(0, 1), msg(1, 1, 'user'), msg(2, 1, 'assistant'), title, request, end(5, 1)];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null, '尾部标题不能把整个窗口废掉');
	assert.equal(picked.events.filter((event) => event.type === 'session/title').length, 1, '标题保留');
	assert.equal(picked.events.filter((event) => event.type === 'session/title-llm-request').length, 0, 'LLM 请求记录丢弃');
	assert.equal(picked.events[0].type, 'turn/start');
}

// ③c 用户手动改名的标题（messageSeqs 为空）是安全的，允许进窗口。
{
	const rename = ev(2, 'session/title', { title: '自己起的', messageSeqs: [], source: { kind: 'user' } });
	const events = [turn(0, 1), msg(1, 1, 'user'), rename, end(3, 1)];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.deepEqual(picked.events.map((event) => event.seq), [0, 1, 2, 3]);
}

// ④ compaction 引用绝对区间 ⇒ 只扔掉它，其余照常。
{
	const compaction = ev(3, 'compaction/prune', { turn: 1, shadowedRange: { start: 0, end: 2 }, shadowedSeqs: [0] });
	const events = [turn(0, 1), msg(1, 1, 'user'), msg(2, 1, 'assistant'), compaction, turn(4, 2), msg(5, 2, 'user'), end(6, 2)];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.equal(picked.firstTurn, 1);
	assert.ok(picked.events.every((event) => !event.type.startsWith('compaction/')));
}

// ⑤ 有洞的 seq ⇒ 只取最长连续尾巴。
{
	const events = [turn(0, 1), msg(1, 1, 'user'), msg(5, 1, 'assistant'), end(6, 1), turn(7, 2), msg(8, 2, 'user')];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.equal(picked.events[0].seq, 7, '洞之前的都不该进来');
}

// ⑥ `session/end-seed` 必须被跳过（跳过后只剩尾巴）。
{
	const seed = ev(0, 'session/end-seed', {});
	const events = [seed, turn(1, 1), msg(2, 1, 'user'), end(3, 1)];
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.ok(picked.events.every((event) => event.type !== 'session/end-seed'));
	assert.equal(picked.events[0].seq, 1);
}

// ⑦ 一个 turn/start 都没有 ⇒ 没有安全窗口。
{
	assert.equal(pickPreloadWindow([msg(0, 1, 'user'), end(1, 1)], { maxEvents: 100 }), null);
	assert.equal(pickPreloadWindow([], { maxEvents: 100 }), null);
}

// ⑧ `turn/start` 的 turn 不是正整数 ⇒ 宁可放弃。
{
	assert.equal(pickPreloadWindow([ev(0, 'turn/start', { turn: 0 }), msg(1, 0, 'user')], { maxEvents: 100 }), null);
}

// ⑨ 本地「下一个轮次」：占位轮次闭合后是 2；没有轮次是 1；开着的是它的下一轮。
{
	assert.equal(nextTurnOfLocalLog([]), 1);
	assert.equal(nextTurnOfLocalLog([turn(0, 1), end(1, 1)]), 2);
	assert.equal(nextTurnOfLocalLog([turn(0, 1), msg(1, 1, 'user')]), 2);
	assert.equal(nextTurnOfLocalLog([turn(0, 1), end(1, 1), turn(2, 2), msg(3, 2, 'user')]), 3);
}

// ⑩ 是否还是空壳：只有占位轮次 ⇒ 需要预载；有真实消息/真实轮次 ⇒ 不需要。
{
	assert.equal(needsPreload([]), true);
	assert.equal(needsPreload([turn(0, 1), end(1, 1)]), true);
	assert.equal(needsPreload([turn(0, 1), end(1, 1), msg(2, 2, 'user')]), false);
	assert.equal(needsPreload([turn(0, 1), end(1, 1), turn(2, 2)]), false);
}

// ⑪ inbox：电脑每个轮次的顺序是「插入队列项 → turn/start → 消费队列项」。
//    窗口起点在 turn/start 时，**必须**把前一条插入事件一起带上，否则本地重放到
//    消费那条时队列是空的 ⇒ `invalid persisted inbox splice` ⇒ 会话打不开。
const insertSplice = (seq) =>
	ev(seq, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 0, inserted: [{ id: `m${seq}` }] });
const consumeSplice = (seq) =>
	ev(seq, 'agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
{
	const events = [];
	let seq = 0;
	for (const n of [1, 2, 3]) {
		events.push(insertSplice(seq++));
		events.push(turn(seq++, n));
		events.push(consumeSplice(seq++));
		events.push(msg(seq++, n, 'user'));
		events.push(ev(seq++, 'step/start', { turn: n, step: 1 }));
		events.push(msg(seq++, n, 'assistant'));
		events.push(ev(seq++, 'step/end', { turn: n, step: 1 }));
		events.push(end(seq++, n));
	}
	const picked = pickPreloadWindow(events, { maxEvents: 100 });
	assert.ok(picked !== null);
	assert.equal(picked.firstTurn, 1);
	assert.equal(picked.events[0].type, 'agent/inbox/spliced', '必须带上前一条插入事件');

	// 窗口被迫从第 3 轮开始，同样要带上它前面的插入事件。
	const tight = pickPreloadWindow(events, { maxEvents: 13 });
	assert.ok(tight !== null);
	assert.equal(tight.firstTurn, 3);
	assert.equal(tight.events[0].type, 'agent/inbox/spliced');

	// 把插入事件全部拿掉（只剩「消费」）⇒ 没有安全窗口，宁可不写。
	const broken = events.filter(
		(event) => !(event.type === 'agent/inbox/spliced' && (event.data.removedCount ?? 0) === 0),
	);
	assert.equal(pickPreloadWindow(broken, { maxEvents: 100 }), null);
}

console.log('preload-window ok');
