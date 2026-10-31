/**
 * 通知收口（0.1.4 方案 A）自检。
 *
 * 用临时 `DSH_HOME` + 假会话目录驱动三个导出函数，不连电脑、不写真实配置：
 *   node tests/notify-target.mjs
 *
 * 覆盖：
 *   ① `notifyTargetSession` 命中 ⇒ 固定投它（哪怕别的会话更新）；
 *   ② 命中镜像会话 / 不存在的会话 ⇒ 回退到「最近活跃的非镜像会话」并记一行日志；
 *   ③ 空字段 ⇒ 与旧版一致（最近活跃的非镜像会话，镜像永远不选）；
 *   ④ 首启固定：`ensureNotifyTarget` 写进 `mobile.json`，且之后的
 *      `writeConfigFile`（配对/解绑都会走）不会把该字段抹掉。
 */
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ⚠️ 必须在 import 插件模块**之前**设好：模块级 `STATE_DIR` 在加载时算一次。
const sandbox = mkdtempSync(join(tmpdir(), 'dsh-link-notify-target-'));
process.env.DSH_HOME = sandbox;

const { pickMostRecentSessionId, isUsableNotifyTarget, ensureNotifyTarget, loadConfig, writeConfigFile } =
	await import('../lib/mobile/index.js');

const sessionsRoot = join(sandbox, 'sessions');
const stateDir = join(sandbox, 'dsh-remote');
const configPath = join(stateDir, 'mobile.json');
const logPath = join(stateDir, 'mobile-debug.log');
// `debugLog` 的落盘目录不一定存在（`flushLog` 不代建），先建好再测日志行。
mkdirSync(stateDir, { recursive: true });

const NOW = Date.now();
/** 造一个会话目录：`<sessions>/<slug>/<sessionId>/log.jsonl`，用文件 mtime 表示活跃时间。 */
function makeSession(slug, sessionId, atMs) {
	const dir = join(sessionsRoot, slug, sessionId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, 'log.jsonl');
	writeFileSync(file, '{"type":"x"}\n', 'utf8');
	utimesSync(file, atMs / 1000, atMs / 1000);
}

// 普通工作区：111 最新、222 更旧；镜像区：333 最新（但永远不该被选）。
makeSession('--E-DE--', 'session-11111111', NOW);
makeSession('--E-DE--', 'session-22222222', NOW - 10_000);
makeSession('--…-dsh-remote-abc123--', 'session-33333333', NOW + 5_000);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readLog = () => readFileSync(logPath, 'utf8');
const readConfig = () => JSON.parse(readFileSync(configPath, 'utf8'));

const cases = [];

cases.push(['没配收口目标 ⇒ 最近活跃的非镜像会话（镜像永远不选）', () => {
	assert.equal(pickMostRecentSessionId(), 'session-11111111');
	assert.equal(pickMostRecentSessionId(''), 'session-11111111');
}]);

cases.push(['配了且有效 ⇒ 固定投它，哪怕别的会话更新', () => {
	assert.equal(pickMostRecentSessionId('session-22222222'), 'session-22222222');
}]);

cases.push(['有效性校验：存在且非镜像才算可用', () => {
	assert.equal(isUsableNotifyTarget('session-22222222'), true);
	assert.equal(isUsableNotifyTarget('session-33333333'), false, '镜像会话不可用');
	assert.equal(isUsableNotifyTarget('session-99999999'), false, '不存在的会话不可用');
	assert.equal(isUsableNotifyTarget(''), false);
}]);

cases.push(['配了镜像会话 ⇒ 回退到最近活跃的非镜像会话，并记一行日志', async () => {
	const picked = pickMostRecentSessionId('session-33333333');
	assert.equal(picked, 'session-11111111');
	await sleep(260); // debugLog 200ms 批量落盘
	assert.match(readLog(), /通知收口目标 33333333 已失效（会话不存在或属于镜像工作区），回退到最近活跃会话/);
}]);

cases.push(['配了不存在的会话 ⇒ 回退并记日志', async () => {
	const picked = pickMostRecentSessionId('session-dead0000');
	assert.equal(picked, 'session-11111111');
	await sleep(260);
	assert.match(readLog(), /通知收口目标 dead0000 已失效/);
}]);

cases.push(['首启固定：没字段 ⇒ 写入 mobile.json 当前主会话 + 日志', async () => {
	const config = { notifyTargetSession: '' };
	const pinned = ensureNotifyTarget(config);
	assert.deepEqual(pinned, { sessionId: 'session-11111111', created: true });
	assert.equal(config.notifyTargetSession, 'session-11111111', '内存里的 config 也要立刻生效');
	assert.equal(readConfig().notifyTargetSession, 'session-11111111');
	await sleep(260);
	assert.match(readLog(), /通知收口目标已固定为 11111111/);
}]);

cases.push(['已有字段 ⇒ 不再改写', () => {
	const config = { notifyTargetSession: 'session-22222222' };
	const pinned = ensureNotifyTarget(config);
	assert.deepEqual(pinned, { sessionId: 'session-22222222', created: false });
	// 上面第一例已经写入 111，说明「已有字段」时没有覆盖它。
	assert.equal(readConfig().notifyTargetSession, 'session-11111111');
}]);

cases.push(['loadConfig 读得到 notifyTargetSession', () => {
	assert.equal(loadConfig().notifyTargetSession, 'session-11111111');
}]);

cases.push(['writeConfigFile（配对/解绑共用）不会抹掉 notifyTargetSession', () => {
	writeConfigFile({ endpoint: 'https://10.0.0.9:8899' });
	assert.equal(readConfig().endpoint, 'https://10.0.0.9:8899');
	assert.equal(readConfig().notifyTargetSession, 'session-11111111');
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

rmSync(sandbox, { recursive: true, force: true });
console.log(`\nnotify-target: ${pass}/${cases.length} 通过`);
