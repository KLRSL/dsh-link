/**
 * 同步会话「预载历史」的**纯决策函数**。
 *
 * ## 为什么单独一个文件
 *
 * 这段逻辑决定了「往手机本地日志里写哪一段电脑历史」。手机本地日志一旦写了
 * 不合法的内容，官方校验器会在**下次打开会话时**才报 `stored log is corrupt`
 * —— 那时损失不可逆（电脑上的历史还在，但手机这份可能打不开）。
 *
 * 所以判据必须能单独测（`tests/preload-window.mjs`），而不是埋在
 * `syncConversations` 那一大段里靠真机试。
 *
 * ## 铁律
 *
 * 官方 v4 校验器（`dsh-session-format-v3-to-v4/lib/index.js`）在**读取**时按
 * 状态机逐条校验：
 *
 *   · `turn/start` 必须正好开出「下一个应开的轮次」（`nextTurn`）；
 *   · `step/start` 必须匹配 open turn 与 `nextStep`；
 *   · `session/title` 的 `messageSeqs` 必须引用**日志里真实存在、更早的**
 *     `user/message`（按绝对 seq）。
 *
 * 前两条靠 `turnOffset`（轮次整体平移到本地已占用的轮次之后）满足；第三条是
 * 窗口选择的责任：窗口里只要有一条带 `messageSeqs` 的标题，它就指向窗口之外
 * （本地还不存在的 seq）⇒ 会话 corrupt。
 *
 * ## ⚠️ 还有一条容易被忽略的：`agent/inbox/spliced`
 *
 * 投影 `inbox`（`dsh-agent-loop/lib/index.js:27`）按顺序**重放**这些事件：
 *
 *     const removedCount = splice.removedCount ?? 0;
 *     if (splice.start > inbox.length || splice.start + removedCount > inbox.length)
 *       throw new Error('invalid inbox splice')
 *
 * 也就是「消费队列项」的那条（`removedCount: 1`）必须在「插入队列项」之后。
 * 而电脑端的顺序是
 *
 *     seq 3  agent/inbox/spliced  {start:0, removedCount:0, inserted:[用户消息]}
 *     seq 4  turn/start           {turn: N}
 *     seq 5  agent/inbox/spliced  {start:0, removedCount:1}      ← 消费上面那条
 *
 * 如果窗口正好从 seq 4 的 `turn/start` 开始，本地重放到 seq 5 时队列是空的
 * ⇒ 整个会话报 `failed to project session … invalid persisted inbox splice`
 * ⇒ **打不开**（这正是 1.0.x 踩过的坑）。所以窗口要往前多带一条插入事件。
 *
 * @module lib/mobile/preload-window
 */

/**
 * 一条事件最多允许占多少条：一条消息可能带几十个工具事件，事件数才是真开销。
 *
 * ⚠️ 0.18.7：300 → 4000。300 条只够最后半轮，用户看到「只有一段、也没有加载更早」。
 * 真机样本会话全量 834 条事件（3.9MB）——抬到 4000 后这类会话能一次搬全。
 * 更长的会话仍然只取「最后 4000 条事件」这一段（不会去拉 155MB 的那种巨型会话）。
 */
export const PRELOAD_MAX_EVENTS = 4000;

/**
 * 是否**必须排除**（没法安全改写）的事件。
 *
 * ⚠️ 0.18.6 起 `session/title` 不在排除之列：它**能被安全改写**——
 * 把 `messageSeqs` 清空、`source.kind` 改成 `user` 就是一条合法的「手动改名」标题
 *（校验器 `dsh-session-format-v3-to-v4/lib/index.js:838` 正是这么判的）。
 * 真机上丢掉标题的后果是「会话标题变成工作区 slug」（`e-de-423910b0`），
 * 用户一眼就看不出来这是哪个会话。
 *
 * @param event - 电脑端 wire event。
 * @returns 需要排除时为 true。
 */
function referencesAbsoluteSeqs(event) {
	const type = typeof event?.type === 'string' ? event.type : '';
	if (type === 'session/title') return false;
	if (type === 'session/title-llm-request') return true;
	// `compaction/*` 用 `shadowedSeqs` / `shadowedRange` 引用绝对区间，且改不动
	//（它要和 compaction/start 配对），只能整条丢。
	if (type.startsWith('compaction/')) return true;
	return false;
}

/**
 * 把一条「带绝对 messageSeqs 的标题」改写成合法的用户标题（0.18.6）。
 *
 * `messageSeqs` 指向电脑上最早的那些 user/message，本地窗口里根本没有 ⇒ 原样写进去
 * 必被判 corrupt。改写成 `{ messageSeqs: [], source: { kind: 'user' } }` 后，
 * 标题文字保留、引用被清掉，校验器接受。
 *
 * @param event - 候选事件。
 * @returns 可能是改写后的**新对象**（不改入参）。
 */
function rewriteTitle(event) {
	if (event?.type !== 'session/title') return event;
	const data = event.data;
	if (data === null || typeof data !== 'object') return event;
	if (!Array.isArray(data.messageSeqs) || data.messageSeqs.length === 0) return event;
	return { ...event, data: { ...data, messageSeqs: [], source: { kind: 'user' } } };
}

/**
 * 事件信封是否值得考虑（与 `isWireEvent` 的核心判据一致）。
 *
 * @param event - 待判事件。
 * @returns 可用时为 true。
 */
function usable(event) {
	return (
		event !== null &&
		typeof event === 'object' &&
		typeof event.type === 'string' &&
		typeof event.seq === 'number' &&
		Number.isInteger(event.seq) &&
		event.seq >= 0
	);
}

/**
 * 按 `inbox` 投影的折叠规则试算一遍，找出第一处会抛错的下标。
 *
 * @param events - 候选窗口。
 * @returns 第一处非法 `agent/inbox/spliced` 的下标；没有则 -1。
 */
function firstInvalidInboxSplice(events) {
	const inbox = { 'next-turn': 0, 'next-step': 0 };
	for (let index = 0; index < events.length; index += 1) {
		const event = events[index];
		if (event.type !== 'agent/inbox/spliced') continue;
		const data = event.data;
		const target = data?.target;
		if (target !== 'next-turn' && target !== 'next-step') return index;
		const start = data?.start;
		const removedCount = data?.removedCount ?? 0;
		const inserted = Array.isArray(data?.inserted) ? data.inserted.length : 0;
		if (!Number.isSafeInteger(start) || start < 0 || start > inbox[target]) return index;
		if (!Number.isSafeInteger(removedCount) || removedCount < 0 || start + removedCount > inbox[target]) return index;
		inbox[target] += inserted - removedCount;
	}
	return -1;
}

/**
 * 从「电脑一整页历史」里挑出**可以安全写进本地日志**的尾部窗口。
 *
 * @param events - 电脑 `readHistory` 返回的 wire events（顺序不限，允许乱序）。
 * @param options - `{ maxEvents }`，默认 `PRELOAD_MAX_EVENTS`。
 * @returns `{ events, firstTurn }`；没有安全窗口时返回 `null`。
 */
export function pickPreloadWindow(events, options = {}) {
	const maxEvents =
		typeof options.maxEvents === 'number' && Number.isInteger(options.maxEvents) && options.maxEvents > 0
			? options.maxEvents
			: PRELOAD_MAX_EVENTS;
	if (!Array.isArray(events) || events.length === 0) return null;
	// ① **先只按「可用信封」筛，不要在这一步扔掉 `session/end-seed`**（0.18.10 修）。
	//
	// 旧实现先滤掉 end-seed 再算「连续尾部」，于是 end-seed 被当成**缺口**：
	// 真机样本 session-c92593ec 的 end-seed 出现在 seq 652 / 722 / 796 / 833
	// （每个 seed 段一条，不在开头！），滤掉后连续尾只剩 797..832 这 36 条
	// ⇒ 用户看到的就是「只有最后一段」。其实整份日志 834 条是连续的，
	// 只是中间夹着几条**本来就不可写**的事件。
	//
	// 正确顺序：先用原始 seq 算连续尾，再把 end-seed（以及后面那些引用绝对 seq、
	// 需要丢弃的事件）从尾里摘掉。本地 append 会重新编号，摘掉不会留洞。
	const cleaned = events.filter((event) => usable(event));
	if (cleaned.length === 0) return null;
	// ② 按 seq 升序，只保留**最长的连续尾部**：中间有洞的话写进去就是缺口。
	cleaned.sort((left, right) => left.seq - right.seq);
	let contiguousStart = 0;
	for (let index = cleaned.length - 1; index > 0; index -= 1) {
		if (cleaned[index].seq !== cleaned[index - 1].seq + 1) {
			contiguousStart = index;
			break;
		}
	}
	// end-seed 只是「seed 段结束」的标记，`mirrorEvent` 里也是无条件跳过的：
	// 从窗口里摘掉，但它不参与上面那次「连续性」判断。
	const tail = cleaned.slice(contiguousStart).filter((event) => event.type !== 'session/end-seed');
	// ②.5 处理「引用绝对 seq」的事件（0.18.3 起不再靠移动窗口起点）。
	//
	// 旧逻辑是「遇到这类事件就把窗口起点推到它之后的第一个 `turn/start`」。
	// 真机上这条路走不通：`session/title-llm-request` / `session/title` 是
	// **追加在日志末尾**的（标题在最后一轮结束后才生成），它们后面根本不会再有
	// `turn/start` ⇒ 整个窗口被判成 `no-window` ⇒ 一条历史都写不进去。
	// 实测样本 session-c92593ec：尾部 36 条里就有 seq 804 的 title-llm-request 和
	// seq 807 的 title（带 messageSeqs），于是「预载」永远返回 no-window。
	//
	// 现在的处理分两种（都能保住内容，且不留 seq 空洞——本地 append 重新编号）：
	//   · `session/title`（带 messageSeqs）⇒ **改写**成合法的用户标题（见 `rewriteTitle`），
	//     标题文字保留。丢标题的后果是真机上标题变成工作区 slug（`e-de-423910b0`）；
	//   · `session/title-llm-request` / `compaction/*` ⇒ **整条丢掉**。前者没有独立
	//     标题文字（只有 request 记录），后者只影响上下文压缩投影，不影响消息内容。
	const safeTail = tail
		.filter((event) => !referencesAbsoluteSeqs(event))
		.map((event) => rewriteTitle(event));
	if (safeTail.length === 0) return null;
	// ③ 起点必须是 `turn/start`，且在 `maxEvents` 之内取**最早**的那个（多带点上下文）。
	let begin = -1;
	for (let index = 0; index < safeTail.length; index += 1) {
		if (safeTail[index].type !== 'turn/start') continue;
		if (safeTail.length - index > maxEvents) continue;
		begin = index;
		break;
	}
	if (begin === -1) return null;
	// ④ 起点前如果紧跟一条「插入队列项」，一起带上：否则紧跟其后的「消费队列项」
	//   会让本地 inbox 投影重放失败（见文件头）。
	const isInsertSplice = (event) => {
		if (event?.type !== 'agent/inbox/spliced') return false;
		const data = event.data;
		const removed = data?.removedCount ?? 0;
		return Number.isSafeInteger(data?.start) && data.start === 0 && removed === 0;
	};
	if (begin > 0 && isInsertSplice(safeTail[begin - 1])) begin -= 1;
	let start = begin;
	for (let guard = 0; guard <= safeTail.length; guard += 1) {
		const window = safeTail.slice(start);
		// ⑤ inbox 重放会失败：先试着往前多带一条「插入队列项」；带不动就往后退一轮。
		const invalidInboxAt = firstInvalidInboxSplice(window);
		if (invalidInboxAt === -1) break;
		if (start > 0 && isInsertSplice(safeTail[start - 1])) {
			start -= 1;
			continue;
		}
		let next = -1;
		for (let index = invalidInboxAt + 1; index < window.length; index += 1) {
			if (window[index].type === 'turn/start') {
				next = index;
				break;
			}
		}
		if (next === -1) return null;
		start += next;
	}
	const picked = safeTail.slice(start);
	if (picked.length === 0) return null;
	if (picked.some((event) => referencesAbsoluteSeqs(event))) return null;
	if (firstInvalidInboxSplice(picked) !== -1) return null;
	// ⑦ 窗口里必须有一个正整数轮次的 `turn/start`（`turnOffset` 的换算基准）。
	const firstTurnAt = picked.findIndex((event) => event.type === 'turn/start');
	if (firstTurnAt === -1) return null;
	const firstTurn = picked[firstTurnAt]?.data?.turn;
	if (typeof firstTurn !== 'number' || !Number.isInteger(firstTurn) || firstTurn < 1) return null;
	return { events: picked, firstTurn };
}

/**
 * 本地日志里「下一个应开的轮次」。
 *
 * 占位轮次（`turn: 1`）成对闭合后就是 2 —— 预载窗口的第一个 turn 要平移到这里。
 *
 * @param log - 本地会话日志（`session.log`）。
 * @returns 下一个应开的轮次编号（至少 1）。
 */
export function nextTurnOfLocalLog(log) {
	if (!Array.isArray(log)) return 1;
	let maxTurn = 0;
	let openTurn = null;
	for (const entry of log) {
		const turn = entry?.data?.turn;
		if (typeof turn !== 'number' || !Number.isInteger(turn) || turn < 1) continue;
		if (entry.type === 'turn/start') {
			openTurn = turn;
			maxTurn = Math.max(maxTurn, turn);
		} else if (entry.type === 'turn/end') {
			openTurn = null;
			maxTurn = Math.max(maxTurn, turn);
		}
	}
	return openTurn === null ? maxTurn + 1 : openTurn + 1;
}

/**
 * 本地日志是否只是「同步时建出来的空壳」（可以预载）。
 *
 * 判据与 `markSessionNonBlank` 幂等判据同源：只有占位轮次、没有任何真实消息。
 *
 * @param log - 本地会话日志。
 * @returns 需要预载时为 true。
 */
export function needsPreload(log) {
	if (!Array.isArray(log) || log.length === 0) return true;
	for (const entry of log) {
		if (entry?.type === 'user/message' || entry?.type === 'assistant/message') return false;
		if (entry?.type === 'turn/start' && entry?.data?.turn !== 1) return false;
	}
	return true;
}
