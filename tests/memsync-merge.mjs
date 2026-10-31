/**
 * memsync 合并决策的单元测试（0.1.4）。
 *
 * 只测纯函数 `planMemsync` —— 不连数据库、不连电脑，所以能脱离 DSH 运行时跑：
 *   node tests/memsync-merge.mjs
 *
 * 重点覆盖 0.1.3 修掉的三个问题：
 *   ① 同 fp 正文变了必须更新（旧版直接 continue，手机上永远停在第一份）；
 *   ② 电脑归档/墓碑要传到手机（旧版把归档条目整个过滤掉，删除永远不生效）；
 *   ③ 「手机独有」必须按全量快照判断（旧版按未归档子集判，每轮重复推墓碑）。
 *
 * 外加「指纹算法换过之后」：记忆层换了指纹算法（djb2 前 20 字 → 全文 sha1）后，两端版本一错开
 * `fp` 就永远对不上。纯按 fp 合并会让手机把整库再插一份，所以按正文兜底配对并回写 fp。
 */
import assert from 'node:assert/strict';

import { planMemsync } from '../lib/mobile/memsync-merge.js';

const pc = (fp, text, extra = {}) => ({ fp, text, track: 'user', source: null, archived: false, ...extra });
const local = (entryId, fp, text, extra = {}) => ({
	entry_id: entryId,
	fp,
	text,
	kind: '知识',
	source_ref: null,
	status: 'active',
	...extra,
});

const cases = [];

cases.push(['电脑有、手机没有 → 新增', () => {
	const plan = planMemsync({ pcItems: [pc('a1', '条目 A')], localRows: [] });
	assert.equal(plan.inserts.length, 1);
	assert.equal(plan.inserts[0].fp, 'a1');
	assert.equal(plan.updates.length, 0);
	assert.equal(plan.tombstones.length, 0);
	assert.equal(plan.phoneOnly.length, 0);
}]);

cases.push(['两边同 fp、正文相同 → 不动', () => {
	const plan = planMemsync({ pcItems: [pc('a1', '条目 A')], localRows: [local('e1', 'a1', '条目 A')] });
	assert.equal(plan.inserts.length + plan.updates.length + plan.tombstones.length + plan.phoneOnly.length, 0);
}]);

cases.push(['两边同 fp、正文不同 → 以电脑为准更新', () => {
	const plan = planMemsync({
		pcItems: [pc('a1', '条目 A（已发布）', { source: 'src-2' })],
		localRows: [local('e1', 'a1', '条目 A（未 push）')],
	});
	assert.equal(plan.updates.length, 1);
	assert.deepEqual(plan.updates[0], { entryId: 'e1', fp: 'a1', text: '条目 A（已发布）', source: 'src-2' });
	assert.equal(plan.inserts.length, 0);
}]);

cases.push(['电脑已归档、手机还活着 → 标作废', () => {
	const plan = planMemsync({
		pcItems: [pc('a1', '条目 A', { archived: true })],
		localRows: [local('e1', 'a1', '条目 A')],
	});
	assert.equal(plan.tombstones.length, 1);
	assert.deepEqual(plan.tombstones[0], { entryId: 'e1', fp: 'a1' });
	assert.equal(plan.inserts.length, 0);
	assert.equal(plan.phoneOnly.length, 0, '归档条目不能算手机独有');
}]);

cases.push(['电脑已归档、手机已删 → 什么都不做', () => {
	const plan = planMemsync({
		pcItems: [pc('a1', '条目 A', { archived: true })],
		localRows: [local('e1', 'a1', '条目 A', { status: 'deleted' })],
	});
	assert.equal(plan.tombstones.length, 0);
	assert.equal(plan.phoneOnly.length, 0);
}]);

cases.push(['电脑已归档、手机没有 → 不插入', () => {
	const plan = planMemsync({ pcItems: [pc('a1', '条目 A', { archived: true })], localRows: [] });
	assert.equal(plan.inserts.length, 0);
	assert.equal(plan.tombstones.length, 0);
}]);

cases.push(['手机有、电脑全量里没有 → 记为手机独有（可推回）', () => {
	const plan = planMemsync({
		pcItems: [pc('a1', '条目 A')],
		localRows: [local('e1', 'a1', '条目 A'), local('e2', 'b2', '手机自己的条目')],
	});
	assert.equal(plan.phoneOnly.length, 1);
	assert.equal(plan.phoneOnly[0].entry_id, 'e2');
}]);

cases.push(['电脑墓碑里的 fp 也算「有」→ 不算手机独有', () => {
	const plan = planMemsync({
		pcItems: [pc('a1', '条目 A', { archived: true })],
		localRows: [local('e1', 'a1', '条目 A', { status: 'deleted' }), local('e9', 'a1', '条目 A')],
	});
	assert.equal(plan.phoneOnly.length, 0);
}]);

cases.push(['fp 为空/缺失的行一律跳过（不插入、不推回）', () => {
	const plan = planMemsync({
		pcItems: [pc(null, '无 fp'), pc(undefined, '无 fp 2')],
		localRows: [local('e1', null, '手机无 fp')],
	});
	assert.equal(plan.inserts.length, 0);
	assert.equal(plan.phoneOnly.length, 0);
}]);

cases.push(['同一 fp 多条电脑快照 → 只认第一条', () => {
	const plan = planMemsync({
		pcItems: [pc('a1', '第一份'), pc('a1', '第二份')],
		localRows: [],
	});
	assert.equal(plan.inserts.length, 1);
	assert.equal(plan.inserts[0].text, '第一份');
}]);

cases.push(['null/空输入不炸', () => {
	const plan = planMemsync({ pcItems: null, localRows: undefined });
	assert.deepEqual(plan, { inserts: [], updates: [], tombstones: [], fpRewrites: [], phoneOnly: [] });
}]);

// ---- 指纹算法换过之后，fp 对不上但正文对得上 ----

cases.push(['fp 不同、正文相同 → 不插入，产出指纹对齐', () => {
	const plan = planMemsync({
		pcItems: [pc('sha1-new', '条目 A')],
		localRows: [local('e1', 'djb2-old', '条目 A')],
	});
	assert.equal(plan.inserts.length, 0, '不能把整库再插一份');
	assert.equal(plan.updates.length, 0);
	assert.equal(plan.tombstones.length, 0);
	assert.deepEqual(plan.fpRewrites, [{ entryId: 'e1', fp: 'sha1-new', fromFp: 'djb2-old' }]);
	assert.equal(plan.phoneOnly.length, 0, 'fp 不同不等于手机独有');
}]);

cases.push(['fp 不同、正文也不同 → 没有可靠配对依据，按两条独立条目处理', () => {
	// 正文被电脑改过又没有共同 fp 时，无法证明「是同一条」；硬合会丢内容，
	// 所以保持各自独立：电脑那条插进来，手机那条按手机独有推回（与 0.1.3 口径一致）。
	const plan = planMemsync({
		pcItems: [pc('sha1-new', '条目 A（已发布）', { source: 'src-9' })],
		localRows: [local('e1', 'djb2-old', '条目 A（未 push）')],
	});
	assert.equal(plan.inserts.length, 1);
	assert.equal(plan.fpRewrites.length, 0);
	assert.equal(plan.phoneOnly.length, 1);
}]);

cases.push(['fp 不同、电脑已归档 → 手机仍要标作废', () => {
	const plan = planMemsync({
		pcItems: [pc('sha1-new', '条目 A', { archived: true })],
		localRows: [local('e1', 'djb2-old', '条目 A')],
	});
	assert.equal(plan.tombstones.length, 1);
	assert.deepEqual(plan.tombstones[0], { entryId: 'e1', fp: 'djb2-old' });
	assert.equal(plan.inserts.length, 0);
	assert.equal(plan.fpRewrites.length, 0, '墓碑不需要对齐指纹');
}]);

cases.push(['正文只差空白 → 视为同一条', () => {
	const plan = planMemsync({
		pcItems: [pc('sha1-new', '条目 A\n第二行')],
		localRows: [local('e1', 'djb2-old', '  条目 A   第二行  ')],
	});
	assert.equal(plan.inserts.length, 0);
	assert.equal(plan.updates.length, 0, '归一后相同就不该改写正文');
	assert.equal(plan.fpRewrites.length, 1);
	assert.equal(plan.phoneOnly.length, 0);
}]);

cases.push(['fp 都不同、正文也确实不同 → 仍是两条独立条目', () => {
	const plan = planMemsync({
		pcItems: [pc('sha1-a', '电脑侧的条目')],
		localRows: [local('e1', 'djb2-b', '手机侧的条目')],
	});
	assert.equal(plan.inserts.length, 1);
	assert.equal(plan.fpRewrites.length, 0);
	assert.equal(plan.phoneOnly.length, 1);
	assert.equal(plan.phoneOnly[0].entry_id, 'e1');
}]);

cases.push(['手机侧已删的同正文行不参与配对', () => {
	const plan = planMemsync({
		pcItems: [pc('sha1-new', '条目 A')],
		localRows: [local('e1', 'djb2-old', '条目 A', { status: 'deleted' })],
	});
	assert.equal(plan.fpRewrites.length, 0, '墓碑行不该被复活成对齐目标');
	assert.equal(plan.phoneOnly.length, 0);
}]);

let pass = 0;
for (const [name, fn] of cases) {
	try {
		fn();
		pass += 1;
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
		process.exitCode = 1;
	}
}
console.log(`\nmemsync-merge: ${pass}/${cases.length} 通过`);
