/**
 * plugin-receive —— **手机把插件包推给电脑**，电脑收包 + 就地换装（0.18.19）。
 *
 * ## 为什么需要它
 *
 * 迭代方向一直是「手机改代码 → 手工拷到电脑 → 电脑 npm test / 打包 → 再装回手机」。
 * 手机是源码的真相、电脑是有 node 的构建机，两头只能靠人搬。这条链路把前半段
 * （手机 → 电脑）自动化：手机把**自己正在跑的那份包**打成 npm 形状的 tgz，
 * 经已有的鉴权 RPC 通道推过来，电脑落 inbox 并换装（重启后生效）。
 *
 * ## 链路
 *
 * ```
 * 手机 lib/mobile/plugin-push.js
 *   → POST /api/dsh-remote/rpc { method:'pluginReceive', params:{ name, version, sha256, base64 } }
 *   → 本模块：校验 → 落 $DSH_HOME/dsh-remote/inbox/ → installPlugin()（先暂存再换名）
 *   → 返回 { ok, version, requiresRestart:true, backupDir }
 * ```
 *
 * ## 安全口径（与手机端 `plugin-install.js` 同一份，别放宽）
 *
 * - **只看这份包自己**：`name` 必须是 `dsh-link`（拒官方 `@deepseek-ai/*`）；
 * - **sha256 必须与内容一致**（防中途篡改/半包）；
 * - **≤ 20MB**，解包上限沿用 `plugin-install.js` 的 128MB / 5000 条目；
 * - **路径穿越/tar 里的软链**由 `readTgzPackage()` 统一拒绝（两端共用一份解析）；
 * - **旧版永远留一份备份**（`dsh-remote/backups/`），换装失败自动回滚。
 *
 * ## 为什么可以「不弹确认」
 *
 * 手机端 `/link/plugin-install` **必须**用户点允许（那是电脑推手机，可信方向弱）；
 * 这里的方向是**手机推电脑**，而 RPC 通道本身是 device 身份签名鉴权的 ——
 * 能发这个请求的只有已配对的手机。用户在需求里明确要的就是「不用手动拷文件」，
 * 所以这里自动装，但**一定留备份**、失败回滚、并写清楚日志。
 *
 * ⚠️ 装完必须**重启电脑端 DSH** 才生效（node 已加载的模块不会换）。
 *
 * @module dsh-link/desktop/plugin-receive
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { InstallError, MAX_TGZ_BYTES, installPlugin, isValidPackageName, isValidVersion, readTgzPackage, resolveProfileDir, sha256Hex } from '../mobile/plugin-install.js';
import { statePathOf } from '../shared/home.js';
import { versionGreater } from '../shared/version.js';

/** 只允许推这一个包（本插件自己）。 */
export const ALLOWED_NAMES = Object.freeze(['dsh-link']);
/** inbox 里最多留几个包（多了按时间删旧的，避免越攒越大）。 */
export const INBOX_KEEP = 5;

/** 读本插件自己声明的版本（`lib/desktop/../..` = 包根）。 */
export function ownVersion() {
	try {
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));
		return typeof manifest?.version === 'string' ? manifest.version : '';
	} catch {
		return '';
	}
}

/** 本机安装目录（`<profile>/node_modules/dsh-link`）。 */
export function ownInstallDir() {
	try {
		return resolveProfileDir();
	} catch {
		return '';
	}
}

/** inbox 目录（`$DSH_HOME/dsh-remote/inbox`）。 */
export function inboxDirOf() {
	return statePathOf('inbox');
}

/** 备份目录（`$DSH_HOME/dsh-remote/backups`）。 */
export function backupDirOf() {
	return statePathOf('backups');
}



/** 时间戳片段（备份目录名用）。 */
function stamp() {
	const now = new Date();
	const pad = (value) => String(value).padStart(2, '0');
	return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

/** 只留最近 {@link INBOX_KEEP} 个 tgz（按修改时间，最新的留）。 */
function pruneInbox(dir) {
	try {
		const entries = readdirSync(dir, { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith('.tgz'))
			.map((entry) => {
				const path = join(dir, entry.name);
				return { path, at: statSync(path).mtimeMs };
			})
			.sort((left, right) => right.at - left.at);
		for (const stale of entries.slice(INBOX_KEEP)) rmSync(stale.path, { force: true });
	} catch {
		// 清理失败不影响收包
	}
}

/**
 * 收一个包并换装。
 *
 * @param {object} options
 * @param {string} options.name - 请求里的包名（必须 {@link ALLOWED_NAMES}）。
 * @param {string} options.version - 请求里的版本。
 * @param {string} options.sha256 - 请求里的 sha256（64 位十六进制）。
 * @param {string} options.base64 - tgz 的 base64 内容。
 * @param {(line: string) => void} [options.log] - 诊断日志（不含包内容）。
 * @param {boolean} [options.dryRun] - 只校验不落盘（排障用）。
 * @returns {Promise<{ok:true, name:string, version:string, fromVersion:string, requiresRestart:true, dir:string, backupDir:string, tgzPath:string}>}
 */
export async function receivePlugin({ name, version, sha256, base64, log = () => {}, dryRun = false }) {
	const pkgName = String(name ?? '').trim();
	const pkgVersion = String(version ?? '').trim();
	if (!isValidPackageName(pkgName)) throw new InstallError(400, 'bad_name', `包名不合法: ${JSON.stringify(name)}`);
	if (!ALLOWED_NAMES.includes(pkgName)) {
		throw new InstallError(400, 'not-allowed', `只接受 ${ALLOWED_NAMES.join(' / ')}，收到 ${JSON.stringify(pkgName)}`);
	}
	if (!isValidVersion(pkgVersion)) throw new InstallError(400, 'bad_version', `版本不合法: ${JSON.stringify(version)}`);
	const expectedSha = String(sha256 ?? '').trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new InstallError(400, 'bad_sha256', 'sha256 必须是 64 位十六进制');
	if (typeof base64 !== 'string' || base64 === '') throw new InstallError(400, 'bad_body', 'base64 内容为空');

	// ① 内容自证（先校验，脏包一个字节都不落盘）。
	let tgz;
	try {
		tgz = Buffer.from(base64, 'base64');
	} catch {
		throw new InstallError(400, 'bad_body', 'base64 解不开');
	}
	if (tgz.length === 0) throw new InstallError(400, 'bad_body', '包内容为空');
	if (tgz.length > MAX_TGZ_BYTES) throw new InstallError(413, 'too_large', `包 ${tgz.length} 字节，超过上限 ${MAX_TGZ_BYTES}`);
	const actualSha = sha256Hex(tgz);
	if (actualSha !== expectedSha) {
		throw new InstallError(400, 'sha256_mismatch', `请求 sha256=${expectedSha.slice(0, 8)}…，实际=${actualSha.slice(0, 8)}…`);
	}
	const parsed = readTgzPackage(tgz);
	if (parsed.name !== pkgName) throw new InstallError(400, 'name_mismatch', `包内 name=${JSON.stringify(parsed.name)}`);
	if (parsed.version !== pkgVersion) throw new InstallError(400, 'version_mismatch', `包内 version=${JSON.stringify(parsed.version)}`);

	const fromVersion = ownVersion();
	if (dryRun) {
		log(`plugin-receive 预检通过 ${pkgName}@${pkgVersion}（本机 ${fromVersion || '未知'}）`);
		return { ok: true, name: pkgName, version: pkgVersion, fromVersion, requiresRestart: true, dir: '', backupDir: '', tgzPath: '' };
	}

	// ② 落 inbox（审计 + 人工重试都靠它）。
	const inbox = inboxDirOf();
	mkdirSync(inbox, { recursive: true });
	const tgzPath = join(inbox, `${pkgName}-${pkgVersion}-${stamp()}.tgz`);
	writeFileSync(tgzPath, tgz);
	pruneInbox(inbox);

	// ③ 换装：旧版先挪进 backups/（保留，不随成功删除），失败由 installPlugin 回滚。
	const backupDir = join(backupDirOf(), `${pkgName}-${fromVersion || 'unknown'}-${stamp()}`);
	mkdirSync(backupDirOf(), { recursive: true });
	let installed;
	try {
		installed = await installPlugin({
			tgz,
			name: pkgName,
			version: pkgVersion,
			sha256: actualSha,
			// 方向是「已配对手机推电脑」，RPC 层已鉴权；这里自动放行（见模块头注释）。
			confirm: async () => true,
			backupDir,
			// profile 里若是 `file:.../dsh-link-<ver>.tgz` 这种本地引用，**别改**：
			// 写成裸版本号会让下次 `npm install` 去 registry 找一个不存在的版本。
			preserveFileSpec: true,
			log,
		});
	} catch (error) {
		log(`plugin-receive 换装失败 ${pkgName}@${pkgVersion}: ${String(error?.message ?? error)}（包留在 ${tgzPath}）`);
		if (error instanceof InstallError) throw error;
		throw new InstallError(500, 'install_failed', String(error?.message ?? error));
	}
	log(`plugin-receive 已换装 ${pkgName}@${fromVersion || '?'} → ${pkgVersion}，备份 ${backupDir}，**重启电脑端 DSH 后生效**`);
	return {
		ok: true,
		name: installed.name,
		version: installed.version,
		fromVersion,
		requiresRestart: true,
		dir: installed.dir,
		backupDir: existsSync(backupDir) ? backupDir : '',
		tgzPath,
	};
}

/**
 * 「电脑端现在装的是哪个版本」—— 手机端据此决定要不要推。
 *
 * 不做成 `ping` 的字段：`ping` 是最便宜的探活，别让它去读文件。
 *
 * @returns {{name:string, version:string, dir:string}}
 */
export function pluginVersion() {
	return { name: 'dsh-link', version: ownVersion(), dir: ownInstallDir() };
}
