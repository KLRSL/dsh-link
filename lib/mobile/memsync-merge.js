/**
 * dsh-link —— 手机端记忆同步的「纯决策层」。
 *
 * ## 为什么单独拆一个文件
 *
 * `lib/mobile/index.js` 里的 memsync 要做的判断全在这里：哪条插、哪条改、哪条作废、
 * 哪条要推回电脑。这层不碰数据库、不碰网络，只吃两份数组、吐一份计划，
 * 于是可以脱离 DSH 运行时直接单测（`tests/memsync-merge.mjs`）。
 *
 * ## 合并规则（`fp` 换了算法也要能对上）
 *
 * | 情况 | 动作 |
 * |---|---|
 * | 电脑有、手机没有、电脑未归档 | INSERT |
 * | 两边同 `fp`、正文不同、电脑未归档 | UPDATE 手机的 `text` / `source_ref`（**电脑为准**） |
 * | 两边同 `fp`、正文相同 | 不动 |
 * | 两边同 `fp`、电脑已归档/墓碑 | 手机这条标 `status='deleted'`（**作废要传下去**） |
 * | 手机有、电脑全量快照里没有这个 `fp` | 记为「手机独有」，由调用方推回电脑 |
 * | **`fp` 不同、正文归一后相同** | 视为同一条：改写手机的 `fp` 为电脑的（对齐口径），正文按上表规则处理 |
 *
 * ## 为什么要按正文兜底
 *
 * 记忆层 dsh-memory-layer 的指纹算法会随版本变（0.11.0 从「前 20 字 djb2」换成「全文 sha1」）。
 * 两端版本一错开，同一个 `fp` 就永远对不上：电脑侧每条都被判成「手机没有」→ 手机整库再插一份，
 * 旧 `fp` 的行还留着，于是记忆翻倍。`fp` 是各端自己算的标识，跨版本不可信；
 * 正文才是唯一事实。对上了就顺手把手机的 `fp` 改成电脑的，下一轮又回到精确匹配。
 *
 * ## 两条硬约束
 *
 * - **「电脑有没有这条」必须用全量快照判断**（含归档/墓碑）。只看未归档的，手机每次
 *   都会把电脑已删的条目当成「手机独有」再推一遍 —— 实测每 10 分钟重复推 1 条。
 * - **只搬 `text` / `source_ref`**：`weight` / `pinned` / `hits` / `created_at` / `status`
 *   是记忆层自己的语义（提权、钉住、复活墓碑都只走 `memory` 工具），同步通道顺手改
 *   等于绕过审批。
 *
 * @module dsh-link/mobile/memsync-merge
 */

/** 把任意值收敛成字符串（null/undefined → 空串），避免 `null != ''` 这类假变更。 */
const str = (value) => (value === null || value === undefined ? '' : String(value));

/**
 * 正文归一：只压空白（含换行）与首尾空格。
 * 跨版本/跨通道的正文差异只可能来自空白，别拿「去标点」「转小写」这类会误判的规则。
 */
const normText = (value) => str(value).replace(/\s+/g, ' ').trim();

/**
 * 算出一次同步要做的事。
 *
 * @param {object} input
 * @param {Array<{fp?: string|null, text?: string|null, track?: string, source?: string|null,
 *   weight?: number, pinned?: boolean, createdAt?: string|null, archived?: boolean}>} input.pcItems
 *   电脑端 `memoryDump` 的全量快照（含归档/墓碑）。
 * @param {Array<{entry_id: string, fp?: string|null, text?: string|null, kind?: string|null,
 *   source_ref?: string|null, status?: string|null}>} input.localRows
 *   手机记忆库里 `status='active'` 的条目。
 * @returns {{
 *   inserts: Array<object>,
 *   updates: Array<{entryId: string, fp: string, text: string, source: string|null}>,
 *   tombstones: Array<{entryId: string, fp: string}>,
 *   fpRewrites: Array<{entryId: string, fp: string, fromFp: string}>,
 *   phoneOnly: Array<object>
 * }} 依次为：新增 / 改写 / 作废 / 指纹对齐 / 手机独有。
 */
export function planMemsync(input) {
	const pcItems = Array.isArray(input?.pcItems) ? input.pcItems : [];
	const localRows = Array.isArray(input?.localRows) ? input.localRows : [];

	/** @type {Map<string, object>} 电脑侧按 fp 建表（同 fp 多条时取第一条，别让后到的随机覆盖）。 */
	const pcByFp = new Map();
	/** 全量快照的 fp 集合 —— 判断「手机独有」必须用它（含归档/墓碑）。 */
	const pcAllFp = new Set();
	/** @type {Map<string, object>} 电脑侧按归一正文建表（fp 算法跨版本对不上时的兜底）。 */
	const pcByText = new Map();
	for (const item of pcItems) {
		if (item === null || typeof item !== 'object') continue;
		const textKey = normText(item.text);
		if (textKey !== '') {
			if (!pcByText.has(textKey)) pcByText.set(textKey, item);
		}
		const fp = item.fp;
		if (fp === null || fp === undefined || str(fp) === '') continue;
		const key = str(fp);
		pcAllFp.add(key);
		if (!pcByFp.has(key)) pcByFp.set(key, item);
	}

	/** @type {Map<string, object>} 手机侧按 fp 建表（同一 fp 有重复时只认第一条）。 */
	const localByFp = new Map();
	/** @type {Map<string, object>} 手机侧按归一正文建表（只收活条目，已删的不参与配对）。 */
	const localByText = new Map();
	for (const row of localRows) {
		if (row === null || typeof row !== 'object') continue;
		const textKey = normText(row.text);
		if (textKey !== '' && str(row.status ?? 'active') === 'active' && !localByText.has(textKey)) {
			localByText.set(textKey, row);
		}
		const fp = row.fp;
		if (fp === null || fp === undefined || str(fp) === '') continue;
		const key = str(fp);
		if (!localByFp.has(key)) localByFp.set(key, row);
	}

	const inserts = [];
	const updates = [];
	const tombstones = [];
	const fpRewrites = [];

	for (const [fp, item] of pcByFp) {
		const textKey = normText(item.text);
		const byFp = localByFp.get(fp);
		// fp 对不上就按正文找；两层都对不上才算「手机没有」。fp 是各端自己算的，
		// 记忆层换过指纹算法（0.11.0 前 20 字 djb2 → 全文 sha1），不能只认它。
		const local = byFp ?? (textKey === '' ? undefined : localByText.get(textKey));
		const archived = item.archived === true;
		if (archived) {
			// 归档/墓碑：只在手机还有活条目时才需要「作废」，已经删过的什么都不做。
			if (local !== undefined && str(local.status ?? 'active') === 'active') {
				tombstones.push({ entryId: String(local.entry_id), fp: str(local.fp) || fp });
			}
			continue;
		}
		if (local === undefined) {
			inserts.push(item);
			continue;
		}
		if (byFp === undefined) {
			// 正文对上了、fp 没对上：把手机的 fp 改成电脑的，下一轮回到精确匹配。
			fpRewrites.push({ entryId: String(local.entry_id), fp, fromFp: str(local.fp) });
		}
		if (normText(local.text) !== normText(item.text)) {
			updates.push({
				entryId: String(local.entry_id),
				fp,
				text: str(item.text),
				source: item.source === null || item.source === undefined ? null : String(item.source),
			});
		}
	}

	const phoneOnly = localRows.filter((row) => {
		if (row === null || typeof row !== 'object') return false;
		if (row.fp === null || row.fp === undefined || str(row.fp) === '') return false;
		if (pcAllFp.has(str(row.fp))) return false;
		// 正文在电脑快照里出现过（哪怕 fp 不同、哪怕已归档）也不算手机独有：
		// 否则换一次指纹算法就会把整库重新推回电脑。
		const textKey = normText(row.text);
		return !(textKey !== '' && pcByText.has(textKey));
	});

	return { inserts, updates, tombstones, fpRewrites, phoneOnly };
}
