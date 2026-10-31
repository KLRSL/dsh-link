/**
 * version —— 插件版本号的比较（两端共用，别各写一份）。
 *
 * 只做「点分数字 + 可选后缀」的粗比较，够判断「谁更新」：
 *
 *   versionGreater('0.18.19', '0.18.17') === true
 *   versionGreater('0.18.19', '0.18.19') === false
 *   versionGreater('0.18.2', '0.18.10') === false   ← 逐段数字比，不是字符串比
 *
 * ⚠️ 字符串比会把 `0.18.10` 判成比 `0.18.2` 旧（字典序），这正是推送链路里
 * 最容易踩的坑：手机明明更新，却永远不推；或者反过来，旧包把新包覆盖掉。
 *
 * @module dsh-link/shared/version
 */

/** 把版本号切成数字段（非数字后缀忽略）。 */
function segmentsOf(version) {
	return String(version ?? '')
		.split('.')
		.map((part) => Number.parseInt(part, 10))
		.map((value) => (Number.isFinite(value) ? value : 0));
}

/**
 * `a` 是否严格新于 `b`。
 *
 * @param {string} a - 版本号（如 `0.18.19`）。
 * @param {string} b - 版本号。
 * @returns {boolean} `a > b` 时为 true；相等或更旧为 false。
 */
export function versionGreater(a, b) {
	const left = segmentsOf(a);
	const right = segmentsOf(b);
	const size = Math.max(left.length, right.length);
	for (let index = 0; index < size; index += 1) {
		const l = left[index] ?? 0;
		const r = right[index] ?? 0;
		if (l > r) return true;
		if (l < r) return false;
	}
	return false;
}
