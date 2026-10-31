/**
 * plugin-push —— **手机把自己正在跑的这份包打成 npm 形状的 tgz，推给电脑换装**（0.18.19）。
 *
 * ## 为什么是「自己这份」
 *
 * 迭代的真相在手机上：我改的就是 `<DSH_HOME>/profiles/ondevice/node_modules/dsh-link`。
 * 电脑上有 node、能跑 `npm test`、能 `npm pack`，但它手里那份往往落后好几个版本。
 * 所以推送的**输入必须是本机安装目录**，不是任何仓库路径 —— 否则推过去的不是
 * 「现在正在跑的东西」，排查时会对着版本号怀疑人生。
 *
 * ## 为什么不直接 `npm pack`
 *
 * 手机上**没有 npm**（也没有 node 可执行文件，插件跑在宿主进程里）。所以这里用
 * `node:zlib` + 自写的 ustar 编码器在内存里打一个 npm 形状的包：
 *
 * ```
 * package/package.json
 * package/lib/...
 * package/locale/...
 * ```
 *
 * 打出来的包由电脑端 `lib/desktop/plugin-receive.js` 的 `readTgzPackage()`
 * （与手机端 `/link/plugin-install` 同一份解析）逐条校验：路径穿越、软链、
 * `package/` 前缀、manifest 的 name/version 全部对得上才会落盘。
 *
 * ## 排除哪些文件
 *
 * `node_modules/`、`.git/`、`.virtfs_metadata/`（鸿蒙的元数据目录）、`*.bak*`、
 * `.tmp-*`、日志。README 里写明了「包里不该有这些」——它们进了包只会有两种结局：
 * 白占体积，或者在解包时把别的目录覆盖掉。
 *
 * @module dsh-link/mobile/plugin-push
 */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { gzipSync } from 'node:zlib';

import { resolveProfileDir } from './plugin-install.js';
import { versionGreater } from '../shared/version.js';

/** tar 头长度。 */
const BLOCK = 512;
/** 只打这些顶层条目（`npm pack` 的口径 + 本插件的实际内容）。 */
const INCLUDE_TOP = ['package.json', 'README.md', 'LICENSE', 'cordis.patch.yml', 'lib', 'locale', 'scripts', 'tools'];
/** 这些目录不打包。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.virtfs_metadata', '.svn', '.hg']);
/** 这些后缀不打包（备份/临时/日志）。 */
const SKIP_SUFFIX = ['.bak', '.bak2', '.log', '.tmp', '.swp'];

/** 本机安装目录：`<profile>/node_modules/dsh-link`。 */
export function packageRootOf() {
	return join(resolveProfileDir(), 'node_modules', 'dsh-link');
}

/** 该文件/目录要不要跳过。 */
function skipName(name) {
	if (name.startsWith('.tmp-') || name.startsWith('.bak-')) return true;
	return SKIP_SUFFIX.some((suffix) => name.endsWith(suffix));
}

/**
 * 递归收集要打包的文件（返回 `{ rel, data }`，`rel` 用 `/` 分隔）。
 *
 * 只跟**普通文件**：软链一律跳过（tar 里的软链是路径穿越的经典载体，
 * 电脑端解析器本来也会拒，这里干脆不出）。
 */
function collectFiles(root) {
	const out = [];
	const walk = (dir, prefix) => {
		let entries;
		try {
			entries = readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const name = entry.name;
			if (skipName(name)) continue;
			const abs = join(dir, name);
			const rel = prefix === '' ? name : `${prefix}/${name}`;
			let stat;
			try {
				stat = lstatSync(abs);
			} catch {
				continue;
			}
			if (stat.isSymbolicLink()) continue;
			if (stat.isDirectory()) {
				if (SKIP_DIRS.has(name)) continue;
				walk(abs, rel);
				continue;
			}
			if (!stat.isFile()) continue;
			try {
				out.push({ rel, data: readFileSync(abs) });
			} catch {
				// 读不到就跳过（不影响其它文件）
			}
		}
	};
	for (const top of INCLUDE_TOP) {
		const abs = join(root, ...top.split('/'));
		if (!existsSync(abs)) continue;
		const stat = lstatSync(abs);
		if (stat.isDirectory()) walk(abs, top);
		else if (stat.isFile()) {
			try {
				out.push({ rel: top, data: readFileSync(abs) });
			} catch {
				// 忽略
			}
		}
	}
	// 稳定排序：同一个源永远打出同一个包（便于比对 sha256）
	out.sort((left, right) => (left.rel < right.rel ? -1 : left.rel > right.rel ? 1 : 0));
	return out;
}

/** 八进制字段（tar 头里的数字都是这个格式）。 */
function octalField(value, length) {
	const text = Math.max(0, Math.floor(value)).toString(8);
	return `${'0'.repeat(Math.max(0, length - 1 - text.length))}${text}\0`;
}

/** 把一个条目写成 tar 头（自动用 prefix 拆长路径）。 */
function tarHeader(relPath, size, mtimeSeconds) {
	const name = `package/${relPath}`;
	const nameBytes = Buffer.from(name, 'utf8');
	const header = Buffer.alloc(BLOCK, 0);
	let shortName = nameBytes;
	let prefix = Buffer.alloc(0);
	if (nameBytes.length > 100) {
		// 从后往前找一个 `/`：前半进 prefix（≤155），后半进 name（≤100）。
		let splitAt = -1;
		for (let index = nameBytes.length - 100; index < nameBytes.length; index += 1) {
			if (index > 0 && nameBytes[index] === 0x2f) {
				splitAt = index;
				break;
			}
		}
		if (splitAt < 0) throw new Error(`包内路径太长（>100 字节且没有可拆分的目录）：${name}`);
		prefix = nameBytes.subarray(0, splitAt);
		shortName = nameBytes.subarray(splitAt + 1);
		if (prefix.length > 155) throw new Error(`包内路径的目录部分太长（>155 字节）：${name}`);
	}
	shortName.copy(header, 0);
	header.write(octalField(0o644, 8), 100, 'latin1');
	header.write(octalField(0, 8), 108, 'latin1');
	header.write(octalField(0, 8), 116, 'latin1');
	header.write(octalField(size, 12), 124, 'latin1');
	header.write(octalField(mtimeSeconds, 12), 136, 'latin1');
	header.write('0', 156, 'latin1'); // typeflag：普通文件
	header.write('ustar\0', 257, 'latin1');
	header.write('00', 263, 'latin1');
	header.write('node', 265, 'latin1');
	header.write('node', 297, 'latin1');
	prefix.copy(header, 345);
	// ⚠️⚠️ 校验和必须**最后算**，且要把上面所有字段（含 typeflag / magic / prefix）
	// 都算进去 —— 解包端 `headerChecksum()` 是对整块 512 字节求和。
	// 0.18.21 真机事故：先写校验和、再写 typeflag/magic ⇒ 求和少了两段字节
	// ⇒ 电脑端 `readTgzPackage` 报 `bad_tgz: tar 头校验和不对`，整次推送失败。
	header.write('        ', 148, 'latin1');
	let sum = 0;
	for (let index = 0; index < BLOCK; index += 1) sum += header[index];
	header.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1');
	return header;
}

/**
 * 把文件列表打成 tgz（npm 形状：全部条目在 `package/` 下）。
 *
 * @param {Array<{rel: string, data: Buffer}>} files - 相对包根的文件。
 * @param {number} [mtimeSeconds] - 固定 mtime（默认 0，保证可复现）。
 * @returns {Buffer} tgz 字节。
 */
export function buildTgz(files, mtimeSeconds = 0) {
	const chunks = [];
	for (const file of files) {
		chunks.push(tarHeader(file.rel, file.data.length, mtimeSeconds));
		chunks.push(file.data);
		const pad = (BLOCK - (file.data.length % BLOCK)) % BLOCK;
		if (pad > 0) chunks.push(Buffer.alloc(pad, 0));
	}
	// 结尾两个全零块（tar 规范）。
	chunks.push(Buffer.alloc(BLOCK * 2, 0));
	return gzipSync(Buffer.concat(chunks), { level: 9 });
}

/** sha256（小写十六进制）。 */
export function sha256Hex(buffer) {
	return createHash('sha256').update(buffer).digest('hex');
}

/**
 * 把**本机这一份**打成 tgz。
 *
 * @returns {{ name: string, version: string, tgz: Buffer, sha256: string, files: number }}
 */
export function buildOwnTgz() {
	const root = packageRootOf();
	const manifestPath = join(root, 'package.json');
	if (!existsSync(manifestPath)) throw new Error(`找不到安装目录里的 package.json：${manifestPath}`);
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
	const name = typeof manifest?.name === 'string' ? manifest.name : '';
	const version = typeof manifest?.version === 'string' ? manifest.version : '';
	if (name === '' || version === '') throw new Error('本机 package.json 缺 name/version');
	const files = collectFiles(root);
	if (!files.some((file) => file.rel === 'package.json')) throw new Error('收集到的文件里没有 package.json');
	const tgz = buildTgz(files);
	return { name, version, tgz, sha256: sha256Hex(tgz), files: files.length };
}

/**
 * 把本机这份推到电脑并换装。
 *
 * @param {object} options
 * @param {(method: string, params: object) => Promise<any>} options.rpc - 手机端 `callRemote`（注入，避免循环依赖）。
 * @param {boolean} [options.force] - 电脑端版本不比手机旧也照推（排障用）。
 * @param {(line: string) => void} [options.log] - 诊断日志。
 * @returns {Promise<{ ok: boolean, skipped?: string, version: string, fromVersion?: string, requiresRestart?: boolean }>}
 */
export async function pushOwnPackage({ rpc, force = false, log = () => {} }) {
	const built = buildOwnTgz();
	let desktopVersion = '';
	try {
		const info = await rpc('pluginVersion', {});
		desktopVersion = typeof info?.version === 'string' ? info.version : '';
	} catch (error) {
		// 电脑还是旧版（没有 pluginVersion）⇒ 它也不可能有 pluginReceive，直接说清楚。
		log(`推送跳过：电脑端没有 pluginVersion（${String(error?.message ?? error)}）`);
		return { ok: false, skipped: 'no-pluginVersion', version: built.version };
	}
	if (!force && !versionGreater(built.version, desktopVersion)) {
		return { ok: false, skipped: 'not-newer', version: built.version, fromVersion: desktopVersion };
	}
	log(`推送 ${built.name}@${built.version}（电脑 ${desktopVersion || '未知'}）→ ${built.files} 个文件 / ${built.tgz.length} 字节`);
	const result = await rpc('pluginReceive', {
		name: built.name,
		version: built.version,
		sha256: built.sha256,
		base64: built.tgz.toString('base64'),
	});
	log(`推送结果：电脑已换装 ${result?.version ?? built.version}（备份 ${result?.backupDir ?? '无'}），重启电脑端 DSH 后生效`);
	return { ok: true, version: built.version, fromVersion: desktopVersion, requiresRestart: result?.requiresRestart === true, detail: result };
}
