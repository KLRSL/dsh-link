/**
 * plugin-install —— 手机端「电脑推一个插件包过来，本机装上」的落地实现。
 *
 * 链路：电脑 `scripts/link-install.mjs` → POST https://<手机>:8898/link/plugin-install
 * （网关 `lib/mobile/link-gateway.js` 负责鉴权/限长）→ 本模块校验 + 解包 + 落盘 + 改 profile。
 *
 * 安全口径（全部 fail-closed）：
 *  - **必须用户确认**：没有确认通道就不装（{@link installPlugin} 直接 503），
 *    确认超时 408，用户拒绝 403；只有明确「允许」才算允许。
 *  - **拒装官方包**：`@deepseek-ai/*` 是引擎自带的，装进去只会打架。
 *  - **拒装路径穿越**：包内条目出现 `..` / 绝对路径 / 盘符 / 反斜杠 / 软链硬链一律拒绝，
 *    且所有条目必须落在 `package/` 前缀下（npm pack 的形状）。
 *  - **限长**：tgz ≤ {@link MAX_TGZ_BYTES}（20MB），解包后 ≤ {@link MAX_UNPACKED_BYTES}（128MB），
 *    gunzip 时就带上限，防压缩炸弹。
 *  - **sha256 必须与包内容一致**；解包后 `package/package.json` 的 `name`/`version`
 *    必须与请求一层层对得上（防「说是 A 装成 B」）。
 *
 * 落盘：先解到 `node_modules/.tmp-<slug>-<pid>`，再 rename 到 `node_modules/<name>`
 * （原来有旧版就先 rename 成 `.bak-<slug>-<ts>`）；任何一步失败都回滚到旧版。
 * profile 的 `package.json` 最后改：`dependencies[name]=version`、`dsh.profile.bundles` 追加去重，
 * 写临时文件再 rename，避免写坏。
 *
 * 只依赖 node 内置模块（自带最小 tar 解析），不新增依赖，可单独 import 自测。
 * @module dsh-link/plugin-install
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

/** 单个 tgz 上限：20MB（base64 后约 26.7MB，网关按这个再抬一点做请求体上限）。 */
export const MAX_TGZ_BYTES = 20 * 1024 * 1024;
/** 解包后总字节上限（防压缩炸弹）。 */
export const MAX_UNPACKED_BYTES = 128 * 1024 * 1024;
/** 单包条目数上限。 */
export const MAX_ENTRIES = 5000;
/** 等用户在手机上点「允许/拒绝」的上限。 */
export const CONFIRM_TIMEOUT_MS = 120_000;
/** 拒装的官方包前缀（引擎自带，装了会打架）。 */
export const OFFICIAL_SCOPES = Object.freeze(['@deepseek-ai/']);
/** tar 头长度。 */
const BLOCK = 512;
/** 包名规则：可选 scope + 小写名（npm 口径），不许大写/空白/斜杠以外的怪字符。 */
const NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]{0,63}\/)?[a-z0-9][a-z0-9._-]{0,213}$/;
/** 版本规则：数字开头，允许 semver 常见的 `. + -` 后缀。 */
const VERSION_RE = /^[0-9][0-9A-Za-z.+-]{0,63}$/;

/** 带 HTTP 状态码的安装错误（网关拿来直接回状态）。 */
export class InstallError extends Error {
	/**
	 * @param {number} status - HTTP 状态码。
	 * @param {string} code - 机器可读错误码（进响应的 `error`）。
	 * @param {string} [detail] - 给人看的细节（进 `detail`，不含包内容）。
	 */
	constructor(status, code, detail = '') {
		super(detail === '' ? code : `${code}: ${detail}`);
		this.name = 'InstallError';
		this.status = status;
		this.code = code;
		this.detail = detail;
	}
}

/** sha256 → 小写十六进制。 */
export function sha256Hex(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

/** 是不是官方包（`@deepseek-ai/*`）——这类一律拒装。 */
export function isOfficialPackage(name) {
	const text = String(name ?? '').trim().toLowerCase();
	return OFFICIAL_SCOPES.some((scope) => text.startsWith(scope));
}

/** 包名是否合法（也顺带挡住 `..`、绝对路径、反斜杠这些花活）。 */
export function isValidPackageName(name) {
	const text = String(name ?? '').trim();
	if (text === '' || text.includes('..') || text.includes('\\') || text.startsWith('/') || text.includes('/../')) return false;
	return NAME_RE.test(text);
}

/** 版本号是否可接受（只做形状检查，不做 semver 全量）。 */
export function isValidVersion(version) {
	return typeof version === 'string' && VERSION_RE.test(version.trim());
}

// ─────────────────────────── 最小 tar 解析（够读 npm tgz 就行） ───────────────────────────

/** tar 头里的「字符串」字段：读到 NUL 为止。 */
function cString(buffer, offset, length) {
	return buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '');
}

/** tar 头里的八进制数字字段。 */
function octal(buffer, offset, length) {
	const raw = buffer.subarray(offset, offset + length).toString('latin1').replace(/\0.*$/, '').trim();
	if (raw === '') return 0;
	if (!/^[0-7]+$/.test(raw)) throw new InstallError(400, 'bad_tgz', `tar 头字段不是八进制（${JSON.stringify(raw)}）`);
	return Number.parseInt(raw, 8);
}

/** tar 头的校验和（校验位本身按空格算）。 */
function headerChecksum(block) {
	let sum = 0;
	for (let index = 0; index < BLOCK; index += 1) sum += index >= 148 && index < 156 ? 0x20 : block[index];
	return sum;
}

/**
 * 把一个条目路径变成安全的包内相对路径。
 *
 * 拒绝：绝对路径、`..`/`.` 段、空段、盘符、反斜杠、NUL、非 `package/` 前缀。
 * 返回去掉 `package/` 之后的相对路径（`/` 分隔）。
 */
function safePackageRelPath(rawPath) {
	const text = String(rawPath ?? '');
	if (text === '') throw new InstallError(400, 'unsafe_entry', 'tar 里有空路径条目');
	if (text.includes('\0') || text.includes('\\')) throw new InstallError(400, 'unsafe_entry', `条目含非法字符: ${text}`);
	if (text.startsWith('/') || /^[A-Za-z]:/.test(text)) throw new InstallError(400, 'unsafe_entry', `条目是绝对路径: ${text}`);
	const segments = text.split('/');
	for (const segment of segments) {
		if (segment === '' || segment === '.' || segment === '..') throw new InstallError(400, 'unsafe_entry', `条目含路径穿越: ${text}`);
	}
	if (segments[0] !== 'package') throw new InstallError(400, 'bad_tgz', `条目不在 package/ 下: ${text}`);
	return segments.slice(1).join('/');
}

/**
 * 读 tgz → `{ name, version, files: [{ rel, data }] }`。
 *
 * 只接受 npm pack 的形状（全部条目在 `package/` 下、有 `package/package.json`），
 * 软链/硬链/设备文件一律拒绝（它们能绕过路径检查）。
 */
export function readTgzPackage(tgz) {
	if (!Buffer.isBuffer(tgz) || tgz.length === 0) throw new InstallError(400, 'bad_tgz', '包内容为空');
	if (tgz.length > MAX_TGZ_BYTES) throw new InstallError(413, 'too_large', `包 ${tgz.length} 字节，超过上限 ${MAX_TGZ_BYTES}`);
	let tar;
	try {
		tar = gunzipSync(tgz, { maxOutputLength: MAX_UNPACKED_BYTES });
	} catch (error) {
		const tooBig = String(error?.code ?? '').includes('BUFFER_TOO_LARGE') || /maxOutputLength/i.test(String(error?.message ?? ''));
		if (tooBig) throw new InstallError(413, 'too_large', `解包后超过上限 ${MAX_UNPACKED_BYTES}`);
		throw new InstallError(400, 'bad_tgz', '不是合法的 .tgz（gzip 解不开）');
	}

	const files = [];
	let packageJsonText = '';
	let offset = 0;
	let pendingPath;
	let pendingLongName;
	let total = 0;
	while (offset + BLOCK <= tar.length) {
		const header = tar.subarray(offset, offset + BLOCK);
		if (header.every((byte) => byte === 0)) break;
		if (headerChecksum(header) !== octal(header, 148, 8)) throw new InstallError(400, 'bad_tgz', 'tar 头校验和不对');
		const size = octal(header, 124, 12);
		const type = String.fromCharCode(header[156] || 0x30);
		let name = cString(header, 0, 100);
		const prefix = cString(header, 345, 155);
		if (prefix !== '') name = `${prefix}/${name}`;
		const dataStart = offset + BLOCK;
		const dataEnd = dataStart + size;
		if (size < 0 || dataEnd > tar.length) throw new InstallError(400, 'bad_tgz', 'tar 条目越界');
		const data = tar.subarray(dataStart, dataEnd);
		offset = dataStart + Math.ceil(size / BLOCK) * BLOCK;

		// pax 扩展头：只认 `path=`（长路径），其余忽略。
		if (type === 'x' || type === 'g') {
			for (const line of data.toString('utf8').split('\n')) {
				const matched = /^\d+ ([^=]+)=(.*)$/.exec(line);
				if (matched !== null && matched[1] === 'path' && type === 'x') pendingPath = matched[2];
			}
			continue;
		}
		// GNU 长文件名。
		if (type === 'L') {
			pendingLongName = data.toString('utf8').replace(/\0.*$/, '');
			continue;
		}
		if (pendingLongName !== undefined) {
			name = pendingLongName;
			pendingLongName = undefined;
		}
		if (pendingPath !== undefined) {
			name = pendingPath;
			pendingPath = undefined;
		}
		if (type === '5') continue; // 目录：落盘时按文件路径自动建
		if (type !== '0' && type !== '\0') {
			// 软链/硬链/设备文件：一律拒（能绕过路径检查）。
			throw new InstallError(400, 'unsafe_entry', `不支持的 tar 条目类型 ${type}: ${name}`);
		}
		const rel = safePackageRelPath(name);
		total += data.length;
		if (total > MAX_UNPACKED_BYTES) throw new InstallError(413, 'too_large', `解包后超过上限 ${MAX_UNPACKED_BYTES}`);
		if (files.length >= MAX_ENTRIES) throw new InstallError(400, 'bad_tgz', `条目超过 ${MAX_ENTRIES} 个`);
		if (rel === 'package.json') {
			if (packageJsonText !== '') throw new InstallError(400, 'bad_tgz', '包里有多个 package.json');
			packageJsonText = data.toString('utf8');
		} else {
			files.push({ rel, data });
		}
	}

	if (packageJsonText === '') throw new InstallError(400, 'bad_tgz', '包内没有 package/package.json');
	let manifest;
	try {
		manifest = JSON.parse(packageJsonText);
	} catch {
		throw new InstallError(400, 'bad_tgz', 'package/package.json 不是合法 JSON');
	}
	if (manifest === null || typeof manifest !== 'object' || typeof manifest.name !== 'string' || typeof manifest.version !== 'string') {
		throw new InstallError(400, 'bad_tgz', 'package/package.json 缺 name/version');
	}
	return { name: manifest.name, version: manifest.version, files: [{ rel: 'package.json', data: Buffer.from(packageJsonText, 'utf8') }, ...files] };
}

/** 给电脑端脚本用：只读包名/版本（校验路径穿越的同时拿到元数据）。 */
export function readTgzPackageInfo(tgz) {
	const { name, version } = readTgzPackage(tgz);
	return { name, version };
}

// ─────────────────────────── profile 定位 / 落盘 / 改清单 ───────────────────────────

/**
 * 当前 profile 目录（插件就装在 `<profile>/node_modules/dsh-link/`）。
 * 优先 `DSH_LINK_PROFILE_DIR`（自测/非常规安装用），否则从本模块位置往上找 `node_modules` 的父目录。
 */
export function resolveProfileDir(explicit) {
	const fromEnv = typeof process.env.DSH_LINK_PROFILE_DIR === 'string' ? process.env.DSH_LINK_PROFILE_DIR.trim() : '';
	if (typeof explicit === 'string' && explicit.trim() !== '') return resolve(explicit.trim());
	if (fromEnv !== '') return resolve(fromEnv);
	let dir = dirname(fileURLToPath(import.meta.url));
	for (let depth = 0; depth < 8; depth += 1) {
		if (basename(dir) === 'node_modules') return dirname(dir);
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new InstallError(500, 'profile_not_found', '找不到当前 profile 目录（可用 DSH_LINK_PROFILE_DIR 指定）');
}

/** 把包名压成一个安全的目录名片段（scoped 包的 `/` 变 `_`）。 */
function slugOf(name) {
	return name.replace(/^@/, '').replace(/[^a-z0-9._-]/gi, '_');
}

/** 包内相对路径 → 绝对路径，并再兜一次「不能逃出包目录」。 */
function destOf(root, rel) {
	const dest = join(root, ...rel.split('/'));
	const guard = root.endsWith(sep) ? root : `${root}${sep}`;
	if (dest !== root && !dest.startsWith(guard)) throw new InstallError(400, 'unsafe_entry', `条目逃出包目录: ${rel}`);
	return dest;
}

/**
 * 改 profile 的 `package.json`：`dependencies[name]=version`、`dsh.profile.bundles` 追加（去重）。
 * 写临时文件再 rename —— 宁可这次没改，也不要把 profile 清单写坏。
 */
function updateProfileManifest(profileDir, name, version, options = {}) {
	const manifestPath = join(profileDir, 'package.json');
	let raw;
	try {
		raw = readFileSync(manifestPath, 'utf8');
	} catch (error) {
		throw new InstallError(500, 'profile_manifest_unreadable', String(error?.message ?? error));
	}
	let manifest;
	try {
		manifest = JSON.parse(raw);
	} catch {
		throw new InstallError(500, 'profile_manifest_invalid', `${manifestPath} 不是合法 JSON`);
	}
	if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) throw new InstallError(500, 'profile_manifest_invalid', 'profile/package.json 顶层不是对象');
	const dependencies = manifest.dependencies !== null && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies) ? manifest.dependencies : {};
	// ⚠️ 0.18.20：`dependencies[name]` 可能是 `file:.../dsh-link-0.18.17.tgz` 这种**本地包引用**。
	// 直接写成裸版本号（`0.18.20`）会让下次 `npm install` 去 registry 找一个不存在的版本
	// （真机上 npm 上的 `dsh-link` 是别人占用的 0.0.1），直接装坏。
	// 所以「保留既有 file:/link: 引用」是一个可选开关，由调用方决定：
	//   · 电脑端收包（`plugin-receive`）⇒ 打开：只换盘上的文件，不碰引用；
	//   · 手机端 `/link/plugin-install` ⇒ 关闭（保持老行为，profile 里是裸版本号）。
	const current = dependencies[name];
	const isFileSpec = typeof current === 'string' && /^(file:|link:)/.test(current);
	if (!(options.preserveFileSpec === true && isFileSpec)) dependencies[name] = version;
	manifest.dependencies = dependencies;
	const dsh = manifest.dsh !== null && typeof manifest.dsh === 'object' && !Array.isArray(manifest.dsh) ? manifest.dsh : {};
	const profile = dsh.profile !== null && typeof dsh.profile === 'object' && !Array.isArray(dsh.profile) ? dsh.profile : {};
	const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
	const addedBundle = !bundles.includes(name);
	if (addedBundle) bundles.push(name);
	profile.bundles = bundles;
	dsh.profile = profile;
	manifest.dsh = dsh;
	const tmpPath = `${manifestPath}.tmp-${process.pid}`;
	writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
	renameSync(tmpPath, manifestPath);
	return { addedBundle };
}

/** 等用户确认；超时抛 408（用 setTimeout 实现，不需要第三方库）。 */
function withTimeout(promise, timeoutMs) {
	return new Promise((resolvePromise, rejectPromise) => {
		const timer = setTimeout(() => rejectPromise(new InstallError(408, 'confirm-timeout', `等用户确认超过 ${timeoutMs}ms`)), timeoutMs);
		promise.then(
			(value) => {
				clearTimeout(timer);
				resolvePromise(value);
			},
			(error) => {
				clearTimeout(timer);
				rejectPromise(error);
			},
		);
	});
}

/**
 * 装一个插件包。**校验全部通过、且用户明确点「允许」**之后才动磁盘。
 *
 * @param {object} options
 * @param {Buffer} options.tgz - 包内容。
 * @param {string} options.name - 请求里的包名。
 * @param {string} options.version - 请求里的版本。
 * @param {string} options.sha256 - 请求里的 sha256（必须与 tgz 一致）。
 * @param {string} [options.profileDir] - 手机 profile 目录（缺省自动定位）。
 * @param {(info: {name: string, version: string, sha256: string, bytes: number}) => Promise<boolean>} [options.confirm]
 *   - 弹确认卡片的回调：resolve true = 允许，false = 拒绝；没有这个回调 ⇒ 503（fail-closed）。
 * @param {number} [options.timeoutMs] - 等确认的上限，默认 {@link CONFIRM_TIMEOUT_MS}。
 * @param {boolean} [options.preserveFileSpec] - 见 `updateProfileManifest`：profile 里是 `file:`/`link:` 引用时不改写（电脑端收包用）。
 * @param {string} [options.backupDir] - 旧版挪到哪里（并保留）。缺省 `node_modules/.bak-*` 且成功后删除；
 *   电脑端收包（`lib/desktop/plugin-receive.js`）必须传它，留一份能回滚的备份。
 * @param {(line: string) => void} [options.log] - 诊断日志（不含包内容）。
 * @returns {Promise<{ ok: true, name: string, version: string, requiresRestart: true, dir: string, backupDir: string }>}
 */
export async function installPlugin({ tgz, name, version, sha256, profileDir, confirm, timeoutMs = CONFIRM_TIMEOUT_MS, backupDir, preserveFileSpec, log = () => {} }) {
	const pkgName = String(name ?? '').trim();
	const pkgVersion = String(version ?? '').trim();
	if (!isValidPackageName(pkgName)) throw new InstallError(400, 'bad_name', `包名不合法: ${JSON.stringify(name)}`);
	if (isOfficialPackage(pkgName)) throw new InstallError(400, 'official-package', '官方包（@deepseek-ai/*）由引擎自己装，这里一律拒装');
	if (!isValidVersion(pkgVersion)) throw new InstallError(400, 'bad_version', `版本不合法: ${JSON.stringify(version)}`);
	const expectedSha = String(sha256 ?? '').trim().toLowerCase();
	if (!/^[0-9a-f]{64}$/.test(expectedSha)) throw new InstallError(400, 'bad_sha256', 'sha256 必须是 64 位十六进制');
	if (!Buffer.isBuffer(tgz) || tgz.length === 0) throw new InstallError(400, 'bad_tgz', '包内容为空');
	if (tgz.length > MAX_TGZ_BYTES) throw new InstallError(413, 'too_large', `包 ${tgz.length} 字节，超过上限 ${MAX_TGZ_BYTES}`);

	// ① 内容与请求必须对得上（先校验，脏包不打扰用户）。
	const actualSha = sha256Hex(tgz);
	if (actualSha !== expectedSha) throw new InstallError(400, 'sha256_mismatch', `请求 sha256=${expectedSha.slice(0, 8)}…，实际=${actualSha.slice(0, 8)}…`);
	const parsed = readTgzPackage(tgz);
	if (parsed.name !== pkgName) throw new InstallError(400, 'name_mismatch', `包内 name=${JSON.stringify(parsed.name)}，请求=${JSON.stringify(pkgName)}`);
	if (parsed.version !== pkgVersion) throw new InstallError(400, 'version_mismatch', `包内 version=${JSON.stringify(parsed.version)}，请求=${JSON.stringify(pkgVersion)}`);

	// ② 必须有人能问用户；没有通道 ⇒ 直接拒（fail-closed）。
	if (typeof confirm !== 'function') throw new InstallError(503, 'no-confirm-channel', '本机没有可用的确认通道，按 fail-closed 拒装');

	// ③ 确认。
	let allowed;
	try {
		allowed = await withTimeout(Promise.resolve(confirm({ name: pkgName, version: pkgVersion, sha256: actualSha, bytes: tgz.length })), timeoutMs);
	} catch (error) {
		if (error instanceof InstallError) throw error;
		if (error?.code === 'NO_CHANNEL') throw new InstallError(503, 'no-confirm-channel', String(error?.message ?? '没有确认通道'));
		throw error;
	}
	if (allowed !== true) {
		log(`plugin-install 用户拒绝 ${pkgName}@${pkgVersion}`);
		throw new InstallError(403, 'user-denied', '用户拒绝安装');
	}

	// ④ 落盘：先解到 .tmp-*，再 rename；失败回滚旧版。
	const root = resolveProfileDir(profileDir);
	const nodeModules = join(root, 'node_modules');
	const target = join(nodeModules, ...pkgName.split('/'));
	const slug = slugOf(pkgName);
	const tmp = join(nodeModules, `.tmp-${slug}-${process.pid}`);
	// ⚠️ 0.18.19：可选把旧版挪到**调用方指定的备份目录**（并保留）。默认行为不变
	// （node_modules/.bak-*，成功后删掉）—— 那是「手机端用户点允许」的路径，旧版
	// 没留下也无所谓（手机上重新推一次即可）；电脑端收包（`plugin-receive`）则必须
	// 留一份能回滚的备份，所以那边传 `backupDir`。
	const keepBackup = typeof backupDir === 'string' && backupDir.trim() !== '';
	const backup = keepBackup ? resolve(backupDir.trim()) : join(nodeModules, `.bak-${slug}-${Date.now()}`);
	mkdirSync(nodeModules, { recursive: true });
	rmSync(tmp, { recursive: true, force: true });
	try {
		writePackageTo(tmp, parsed.files);
	} catch (error) {
		rmSync(tmp, { recursive: true, force: true });
		throw new InstallError(500, 'extract_failed', String(error?.message ?? error));
	}

	let movedAside = false;
	try {
		if (existsSync(target)) {
			rmSync(backup, { recursive: true, force: true });
			mkdirSync(dirname(backup), { recursive: true });
			renameSync(target, backup);
			movedAside = true;
		}
		mkdirSync(dirname(target), { recursive: true });
		renameSync(tmp, target);
	} catch (error) {
		rollback(target, backup, movedAside);
		throw new InstallError(500, 'install_failed', String(error?.message ?? error));
	}

	// ⑤ 改 profile 清单；改不动就把刚装的那份撤掉。
	try {
		// ⚠️ 0.18.24：这里在 `installPlugin` 里，形参是**解构**的 —— 没有 `options` 这个对象！
		// 0.18.20~0.18.23 写的 `options.preserveFileSpec` 会直接 `ReferenceError: options is not defined`
		// （真机症状：推送最后一步 `manifest_update_failed: options is not defined`）。
		updateProfileManifest(root, pkgName, pkgVersion, { preserveFileSpec: preserveFileSpec === true });
	} catch (error) {
		rollback(target, backup, movedAside);
		if (error instanceof InstallError) throw error;
		throw new InstallError(500, 'manifest_update_failed', String(error?.message ?? error));
	}
	if (movedAside && !keepBackup) rmSync(backup, { recursive: true, force: true });
	log(`plugin-install 已安装 ${pkgName}@${pkgVersion} → ${target}`);
	return {
		ok: true,
		name: pkgName,
		version: pkgVersion,
		requiresRestart: true,
		dir: target,
		backupDir: movedAside && keepBackup ? backup : '',
	};
}

/** 解包到目录（只负责写文件；路径再次做逃逸检查）。 */
function writePackageTo(root, files) {
	if (files.length === 0) throw new InstallError(400, 'bad_tgz', '包里一个文件都没有');
	for (const file of files) {
		const dest = destOf(root, file.rel);
		mkdirSync(dirname(dest), { recursive: true });
		writeFileSync(dest, file.data);
	}
}

/** 回滚：有旧版就换回去，没有就删掉刚 rename 过来的新目录。 */
function rollback(target, backup, movedAside) {
	try {
		if (existsSync(target)) rmSync(target, { recursive: true, force: true });
		if (movedAside && existsSync(backup)) renameSync(backup, target);
	} catch {
		// 回滚失败也没法再做什么，保持静默（调用方会回 500，日志里有原因）
	}
}
