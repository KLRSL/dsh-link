/**
 * dsh-link —— 手机端（client half，跑在 WebView 的页面世界里）。
 *
 * ## 这个文件做两件事
 *
 * 1. **「电脑文件夹」入口** —— 注册进 `directoryFlow` slot，让选文件夹的对话框里
 *    多出一个「电脑」页签：浏览电脑目录、在电脑上直接开一个会话。
 * 2. **电脑实时消息流** —— 订阅宿主桥的全局 SSE，把电脑的流式帧转成
 *    `assistant/live-chunk` transient 注入本地会话，于是手机上有逐字动画。
 *
 * ## ⚠️ 为什么是「取代」官方对话框，而不是「并列」
 *
 * `directoryFlow` 是 `kind: "single"` 的 slot，渲染时取 `entriesOfSlot(name)[0]`，
 * 而 entries 按 priority **升序**排（见 dsh-client-ui-renderer L1148-1151）。
 * 也就是说这个 slot 同时只能渲染**一个** occupant，无法「并排加一项」。
 *
 * 所以本插件用 **priority -1** 占据首位，自己实现一个双页签对话框：
 * 「手机」页签复刻官方浏览行为（走 `uiWorkspace.listDirectory`，与官方 browse
 * 后端是同一个 API），「电脑」页签走宿主桥。对用户的观感就是
 * 「选文件夹的时候多了一个电脑入口」。
 *
 * ## ⚠️ 语法约束（旧内核）
 *
 * 本 App 有按 chrome73 降级编译的前端 bundle（`webview-compat.zip`），
 * 所以这里**不用**可选链 `?.`、空值合并 `??`、`Object.fromEntries`、`Array.flat`
 * 这些 chrome80+ 的语法。
 *
 * @module dsh-link/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-link',
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var react = require('react');
		var h = react.createElement;

		/**
		 * 官方 UI 原子组件（对话框、按钮、分段页签、图标）。
		 *
		 * ⚠️ **这是「长得像官方」的唯一正解**：官方目录选择器
		 * （`dsh-client-ui-directory-picker-browse`）自己也是这么 `require` 的，
		 * 该模块已在页面模块注册表里，手机与桌面两端都有。
		 *
		 * 自己手搓 `div` + `style` 的代价是实打实的：先前那版写死了
		 * `background:var(--dsw-alias-bg-primary,#1b1b1f)` —— 而
		 * **`--dsw-alias-bg-primary` 这个令牌根本不存在**（官方真实名字是
		 * `--dsw-alias-bg-layer-1` / `bg-l1` / `bg-base`），于是整块卡片永远走
		 * 那个深色 fallback；`--dsw-alias-border-secondary` 同样不存在。
		 * 表现就是手机上「两大坨黑色、跟官方 UI 完全脱钩」。
		 */
		var primitives = require('@deepseek-ai/dsh-client-ui-primitives');
		var Modal = primitives.Modal;
		var Button = primitives.Button;
		var Input = primitives.Input;
		var SegmentedTabs = primitives.SegmentedTabs;
		var IconFolderCloseRegular = primitives.IconFolderCloseRegular;
		var IconChevronRightOutlineRegular = primitives.IconChevronRightOutlineRegular;
		var IconPlusOutlineRegular = primitives.IconPlusOutlineRegular;

		/** 宿主桥的路由（同源，直接相对路径）。 */
		var ROUTE_RPC = '/api/dsh-remote/rpc';
		var ROUTE_STREAM = '/api/dsh-remote/stream';

		/**
		 * 对话框卡片的 className（Modal 的 `className` 收字符串、不是 style 对象）。
		 *
		 * 尺寸与留白**逐条照抄**官方目录选择器对 Modal 的覆盖
		 * （`.../dsh-client-ui-directory-picker-browse/lib/client.js` 里
		 * `dialog{...gap:0;width:min(680px,100%);height:min(500px,100dvh - 32px);padding:0}`），
		 * 只把宽度收窄到手机合适的 560px。背景、圆角、阴影、遮罩一律由官方
		 * Modal 自己的 CSS 提供 —— 本插件**不再声明任何颜色**。
		 */
		var DIALOG_CLASS = 'dsh-link-dialog';

		/**
		 * 布局样式：取值全部照抄官方目录选择器的同义规则，令牌全部是
		 * **真实存在**的官方设计令牌（`--dsw-alias-border-l3`、`bg-layer-*`、
		 * `interactive-bg-hover`、`label-*` …），不写死任何颜色值。
		 */
		var CSS = {
			// ## ⚠️⚠️ 高度必须有多档兜底，不能只靠 `dvh`
			//
			// 用户反馈（另一个人、另一台设备）：「要么就是太小了，中间内容看不见；
			// 要么就是太大了，又划不动」，视频里是**弹窗铺满全屏、标题栏和底部
			// 按钮全部消失、只剩一列文件夹**。
			//
			// 根因：原来只写了 `height:min(560px,100dvh - 32px)`。`dvh` 是
			// Chrome 108+ 才有的单位，**旧 WebView 不认识它 ⇒ 整条 `min()` 声明
			// 直接失效**（不是降级到 560px，而是整条无效）⇒ `height` 退回 `auto`
			// ⇒ 弹窗高度由内容决定 ⇒ 电脑页签下几十个文件夹把弹窗撑满整屏
			// ⇒ header / footer 被顶到视口外，用户就只看得见中间那列文件。
			//
			// 我自己的测试机 WebView 是 Chrome/114（支持 dvh），所以怎么测都是
			// 好的 —— 这就是为什么本地一直复现不出来。
			//
			// ## ⚠️ `height` 的 560px 上限太小（用户反馈「划不动」的另一半原因）
			//
			// 改成 `dvh` 兜底后我做了个对比（真机、电脑页签、56 个文件夹）：
			//
			//   只靠 max-height 撑（旧内核路径）→ 弹窗 716px，列表区 373px
			//   有 560px 的 height 上限（现代内核）→ 弹窗 560px，列表区 217px
			//
			// **同一个列表，现代内核反而少 42% 的可视高度**，因为 560 这个
			// 「理想高度」把卡片压住了。而 716px 才是官方 Modal 给的实际可用高度。
			// 所以把理想值提到 720px，让两种内核都接近满高。
			//
			// 底下 430px 左右的矮视口（横屏）仍由 `max-height` 压回来，不受影响。
			dialog:
				'gap:0;width:min(560px,100%);' +
				'max-height:calc(100vh - 48px);' +
				'max-height:calc(100dvh - 48px);' +
				'height:min(720px,calc(100vh - 48px));' +
				'height:min(720px,calc(100dvh - 48px));' +
				'height:min(720px,100%);' +
				'padding:0;display:flex;flex-direction:column;overflow:hidden;',
			// ## ⚠️⚠️ 原来是 `display:contents`，那是个真 bug
			//
			// `display:contents` 会让这个容器**盒模型消失**，三个子块（header /
			// 内容 / footer）直接变成官方 Modal 卡片的 flex 项。看着没问题，实测
			// 却是这样（真机横屏 764×324）：
			//
			//     卡片高 292px
			//     ├─ header  138px（占视口 42%）
			//     ├─ 内容     85px（只放得下 2 行文件夹）
			//     └─ footer   68px
			//
			// 用户报障原话：「要么就是太小了，中间内容看不见；要么就是太大了，
			// 又划不动。」—— 竖屏长列表时 `flex:1 1 auto` 因为父级没有确定高度
			// 算不准，内容把 footer 顶出屏幕（划不动）；横屏时 header 把空间吃光
			// （中间看不见）。
			//
			// 改成真正的 flex 列容器后，`flex:none` / `flex:1 1 auto` 才有意义：
			// header 与 footer 固定、中间那一段占满剩余并可内部滚动。
			editorScope:
				'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;' +
				'width:100%;overflow:hidden;',
			header:
				'display:flex;flex-direction:column;flex:none;' +
				// ## 头部间距随视口高度收缩（横屏 / 小屏的关键）
				//
				// 真机横屏 764×324 实测：标题 28 + 页签 42 + 路径行 28 = 98，
				// 加上下 padding 40 与两个 gap 16，合计 **138px** —— 整整吃掉
				// 292px 卡片高度的 47%，中间列表只剩 85px（放得下 2 行）。
				// 用户报的「中间内容看不见」就是这个。
				//
				// `clamp()` 让间距跟着视口高度线性收缩：视口 ≥520px 时是原值
				//（16/8/8），到 324px 时压到 (10/4/4)，能省出约 30px。
				// 比媒体查询稳 —— 媒体查询里靠后代选择器定位这个节点，
				// 层级一变（比如 `display:contents` 改掉）就静默失效，踩过。
				'gap:clamp(4px,2vh,8px);' +
				'padding:clamp(10px,2.2vh,16px) 14px clamp(4px,1.2vh,8px) 24px;' +
				'border-bottom:.5px solid var(--dsw-alias-border-l3);',
			title:
				'display:flex;align-items:flex-end;min-height:28px;margin:0;' +
				'font-size:16px;font-weight:510;line-height:24px;color:var(--dsw-alias-label-primary);',
			crumbBar: 'display:flex;align-items:center;gap:8px;min-height:24px;',
			// 「显示隐藏文件夹」开关：与「上一级」同排，靠右。
			crumbToggle:
				'display:flex;flex:none;align-items:center;gap:4px;cursor:pointer;' +
				'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;white-space:nowrap;',
			crumbToggleOn: 'color:var(--dsw-alias-label-secondary);',
			pathText:
				'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
				'color:var(--dsw-alias-label-tertiary);font-size:13px;line-height:20px;',
			// —— 「电脑路径」跳转行：面包屑下方，只在「电脑」页签渲染 ——
			// 输入框自己撑满剩下的宽度（手机竖屏 360px 也放得下「输入框 + 跳转」）。
			pathRow: 'display:flex;align-items:center;gap:8px;min-height:24px;',
			pathInput: 'flex:1 1 0;min-width:0;',
			// —— 「盘符」行：电脑页签、文件列表**上方** ——
			// 盘符是一串短按钮，允许折行；没有盘符条目时整行不渲染（见 `driveRow`）。
			driveRow:
				'display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;padding:0 0 8px 4px;',
			driveLabel:
				'flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;',
			driveButton:
				'flex:none;height:28px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);' +
				'border-radius:var(--dsw-radius-sm);background:0 0;cursor:pointer;' +
				'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;',
			content:
				// ⚠️ `overflow` 必须是 `auto` 而不是 `hidden`：横屏下中间区只有
				// ~98px，装不下「局域网直连面板 + 列表(最少 96px) + 提示语」。`hidden` 会把
				// 超出的部分直接裁掉（用户连滑的机会都没有）；`auto` 让整个中间区
				// 可滚，列表自己的 `overflow-y:auto` 再管它内部那一层。
				'display:flex;flex-direction:column;flex:1 1 auto;min-height:0;' +
				'padding:16px 16px 16px 24px;position:relative;overflow-y:auto;' +
				'overscroll-behavior:contain;',
			column:
				'display:flex;flex-direction:column;flex:1 1 auto;gap:2px;min-height:0;' +
				'padding-right:8px;overflow-y:auto;overscroll-behavior:contain;' +
				// 安卓 WebView 里不加这条，长列表的滑动会很「黏」，用户会以为划不动。
				'-webkit-overflow-scrolling:touch;',
			// ## ⚠️ 文件列表本身：**必须有自己的最小高度**
			//
			// 横屏 764×324 实测（1.2.17）：中间区只剩 98px，被「已连接」条(62)
			// 和底部提示语(44) 吃光，列表被压成 **0px** —— 用户一个文件夹都看不到，
			// 却又看到能滚（`scrollHeight` 是 1678）。这正是用户说的
			// 「中间内容看不见」。
			//
			// `min-height` 让列表永远至少占住 3 行，`flex-shrink:0` 防止被
			// 同级的局域网直连面板 / 提示语挤掉；挤不下的部分交给外层 `column` 去滚。
			columnList:
				'display:flex;flex-direction:column;gap:2px;' +
				'flex:1 1 auto;flex-shrink:0;min-height:96px;' +
				'padding-right:8px;overflow-y:auto;overscroll-behavior:contain;' +
				'-webkit-overflow-scrolling:touch;',
			row:
				'display:flex;align-items:center;gap:4px;width:100%;height:28px;padding:4px;' +
				'border:none;border-radius:var(--dsw-radius-sm);background:0 0;' +
				'text-align:left;cursor:pointer;flex:0 0 auto;',
			rowIcon: 'flex:none;color:var(--dsw-alias-label-secondary);',
			rowName:
				'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
				'color:var(--dsw-alias-label-primary);font-size:13px;font-weight:500;line-height:20px;',
			rowChevron: 'flex:none;color:var(--dsw-alias-label-tertiary);',
			status:
				'padding:4px 120px 4px 4px;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-label-secondary);',
			error:
				'padding:4px 120px 4px 4px;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-state-error-primary);word-break:break-all;',
			note:
				'padding:8px 4px 0;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-label-tertiary);',
			footerBar:
				'display:flex;flex-wrap:wrap;flex:none;align-items:center;gap:8px;' +
				'padding:clamp(8px,2vh,16px) 24px;border-top:.5px solid var(--dsw-alias-border-l3);',
			footerGap: 'flex:1 1 0;',
			footerAction: 'min-width:72px;',
			// —— 局域网直连面板（只在「电脑」页签下显示）——
			lanPanel:
				'display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:none;' +
				'padding:0 0 8px;',
			lanLabel:
				'flex:none;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px;',
			lanHostInput: 'width:130px;',
			lanPortInput: 'width:76px;',
			// 动作行：测试 / 连接 / 解绑。允许折行，360px 下按钮掉到第二行也不挤。
			lanActions: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:1 1 100%;',
			lanSpacer: 'flex:1 1 auto;',
			// 状态行：已连接绿字、未连接灰字。指纹 + 耗时可能超一行，允许折行
			//（不加 nowrap / ellipsis，否则用户看不到证书指纹这一段）。
			lanStatus:
				'flex:1 1 100%;min-width:0;word-break:break-all;' +
				'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;',
			lanStatusOk: 'color:var(--dsw-alias-state-success-primary);',
			// 首次连接的配对码行：说明文字占满整行，输入框与按钮跟在下面
			//（手机上 360px 放不下「说明 + 输入框 + 按钮」一行）。
			lanCodeRow: 'display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:1 1 100%;',
			// ⚠️ **不能 `white-space:nowrap`**：手机上 360px 宽、这行说明有 20 多个汉字，
			// 加了 nowrap + ellipsis 就会被截断 —— 用户看不到要去哪里找这串码。允许折行。
			lanHint:
				'flex:1 1 100%;min-width:0;' +
				'color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;',
			lanCodeInput: 'width:120px;text-transform:uppercase;letter-spacing:2px;',
			// 解绑二次确认那一行：提示文字占满整行，两个按钮跟在下面（手机上 360px
			// 放不下「文字 + 两个按钮」一行，所以让文字 `flex:1 1 100%` 自己换行）。
			lanConfirm:
				'display:flex;flex-wrap:wrap;align-items:center;gap:8px;flex:1 1 100%;' +
				'font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);',
			lanConfirmText: 'flex:1 1 100%;',
			// ⚠️ 需要 `pre-wrap`：「自动查找」的过程陈述是多行的（每层一行失败原因），
			// 默认 `normal` 会把这些换行全折叠掉，挤成一坨反倒更难读。
			// `overflow-wrap:anywhere` 是为了让超长的 IPv6 地址能断行。
			lanMsg: 'padding:0 4px 8px;font-size:12px;line-height:18px;white-space:pre-wrap;overflow-wrap:anywhere;',
			lanMsgOk: 'color:var(--dsw-alias-state-success-primary);',
			// 「刷新」那一行（模型 / 预设 / 目录树三样一起刷）的回执文字。
			refreshNote:
				'padding:0 4px 8px;font-size:12px;line-height:18px;' +
				'color:var(--dsw-alias-label-tertiary);',
			refreshOk: 'color:var(--dsw-alias-state-success-primary);',
			// —— 「同步对话」对话框 ——
			// 一行一个可勾选的对话。用 `label` 包住，点整行都能勾上（手机上
			// 20px 的复选框太小，只点方框很难点中）。
			syncRow:
				'display:flex;align-items:center;gap:10px;width:100%;min-height:40px;' +
				'padding:8px 4px;border-radius:var(--dsw-radius-sm);cursor:pointer;',
			syncBox: 'flex:none;width:18px;height:18px;accent-color:var(--dsw-alias-brand-primary);',
			syncName:
				'flex:1 1 0;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
				'color:var(--dsw-alias-label-primary);font-size:14px;line-height:20px;',
			syncEmpty:
				'padding:24px 4px;text-align:center;font-size:13px;line-height:20px;' +
				'color:var(--dsw-alias-label-tertiary);',
			// 搜索 + 全选那一行。放在列表**上方**（列表可能有 70+ 项，
			// 放下面用户得先滑到底才看得见）。
			syncToolbar:
				'display:flex;align-items:center;gap:8px;padding:0 0 8px;flex:none;',
			syncSearch:
				'flex:1 1 0;min-width:0;height:34px;box-sizing:border-box;padding:0 10px;' +
				'border:.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm);' +
				'background:var(--dsw-specific-input-major,transparent);' +
				'color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;',
			syncPickAll:
				'flex:none;height:34px;padding:0 12px;border:.5px solid var(--dsw-alias-border-l2);' +
				'border-radius:var(--dsw-radius-sm);background:0 0;cursor:pointer;' +
				'color:var(--dsw-alias-label-secondary);font:inherit;font-size:13px;',
		};

		/**
		 * 把 CSS 文本解析成 React 的 style **对象**。
		 *
		 * ⚠️ **这一步不能省**：React 的 `style` prop 只接受对象，给字符串会当场抛
		 * `Minified React error #62`（React 18 的
		 * `if (style != null && typeof style != "object") throw Error(62)`），
		 * 组件随即被 slot 系统 `abdicate` 退役、渲染回落到官方对话框 ——
		 * 表现就是「电脑」页签根本不出现，而控制台里只有一条难懂的 #62。
		 *
		 * 键名同时做 kebab → camelCase（`min-width` → `minWidth`），否则 React
		 * 会逐条告警「Unsupported style property」。
		 *
		 * @param text - 形如 `'a:1;b:2;'` 的 CSS 声明串。
		 * @returns React style 对象。
		 */
		function toStyle(text) {
			var out = {};
			var parts = String(text).split(';');
			for (var index = 0; index < parts.length; index += 1) {
				var part = parts[index];
				if (part === '') continue;
				var colon = part.indexOf(':');
				if (colon < 0) continue;
				var name = part.slice(0, colon).trim();
				var value = part.slice(colon + 1).trim();
				if (name === '' || value === '') continue;
				out[name.replace(/-([a-z])/g, function (match, letter) {
					return letter.toUpperCase();
				})] = value;
			}
			return out;
		}

		// ⚠️ **先把文本留一份副本再转对象**：下面那个 `<style>` 标签拼的是 CSS
		// **文本**，而第 162 行会把 `CSS` 就地改写成对象 —— 顺序反了就会拼出
		// `[object Object]`，卡片尺寸规则整条失效（列表被 flex 压成 0 高、只剩空白）。
		var DIALOG_CSS_TEXT = CSS.dialog;

		// 就地转成对象：下游一律写 `style: CSS.xxx`，不会再碰到字符串形式。
		for (var styleKey in CSS) CSS[styleKey] = toStyle(CSS[styleKey]);

		/**
		 * 注入官方风格的样式表。
		 *
		 * ⚠️ 卡片那层（背景/圆角/阴影/遮罩）**全部由官方 Modal 自己的 CSS 提供**，
		 * 这里只覆盖尺寸与留白 —— 与官方目录选择器覆盖
		 * `dialog` 类的方式完全一致。所以本插件**不声明任何颜色**，
		 * 亮色/暗色主题都随官方走，不会再出现「一大坨黑」。
		 *
		 * 用 `<style data-plugin-css>` 注入（官方各 client 包的标准做法），
		 * 而不是把样式塞进 React 的 `style` prop —— Modal 只接受 `className`。
		 */
		var STYLE_TAG_ID = 'dsh-link/DirectoryTabs.css';

		/**
		 * 把本插件的样式表挂进文档。
		 *
		 * ⚠️⚠️ **整段必须包在 try/catch 里，而且不能假设 `document.head` 存在。**
		 *
		 * 这是 **factory 顶层**（不在 `apply()` 里），所以它抛错时：
		 *   1. 我的 `guard()` 兜不住（guard 只管 `apply()` 内部）；
		 *   2. `dsh-client-modules` 会把这次 factory 失败聚合进
		 *      `ClientPackageCompositionError`（`lib/index.js:144`），
		 *      **整批客户端插件一起失败**；
		 *   3. 界面直接停在 `Failed to load plugins`，App 进救援模式并无限重启。
		 *
		 * 而 `document.head` 在脚本处于 `<head>` 内、或文档还没解析到 head 时
		 * 是 `null` —— 那时 `document.head.appendChild(...)` 抛 TypeError，
		 * 正是上面那条链路。**样式挂不上只是不好看，绝不能因此让整个 App 起不来。**
		 *
		 * 所以：拿不到 `head` 就退到 `documentElement`；两者都没有就**静默跳过**。
		 */
		try {
			if (
				typeof document !== 'undefined' &&
				typeof document.createElement === 'function' &&
				document.querySelector('style[data-plugin-css=' + JSON.stringify(STYLE_TAG_ID) + ']') === null
			) {
				var styleTag = document.createElement('style');
				styleTag.dataset.plugin = 'dsh-link';
				styleTag.dataset.pluginCss = STYLE_TAG_ID;
				styleTag.textContent =
					'.' +
					DIALOG_CLASS +
					'{' +
					DIALOG_CSS_TEXT +
					'}' +
					'.' +
					DIALOG_CLASS +
					' [role="tablist"]{flex:none;}' +
					// ⚠️ 矮视口下收紧头部的规则**不写在这里**，直接写进
					// `CSS.header` / `CSS.footerBar` 的 `clamp()` 里。
					//
					// 原来这里是一条 `@media (max-height:480px){ ... > div > div:first-child ... }`，
					// 靠后代选择器定位 header。而 `editorScope` 从 `display:contents`
					// 改成真 flex 容器后，层级一变，这条选择器就**静默匹配不到**
					//（真机实测横屏 header 仍是 138px，媒体查询完全没生效）。
					// `clamp()` 挂在组件自己的 style 上，层级怎么变都不会失配。
					'.' +
					DIALOG_CLASS +
					' button:hover{background:var(--dsw-alias-interactive-bg-hover);}';

				// head 可能还不存在（脚本在 <head> 里跑），退到 documentElement。
				var styleParent =
					document.head ||
					document.documentElement ||
					document.body ||
					null;
				if (styleParent !== null && typeof styleParent.appendChild === 'function') {
					styleParent.appendChild(styleTag);
				}
			}
		} catch (styleError) {
			// 样式失败绝不影响功能，更不允许拖垮整批插件加载。
			try {
				console.warn('[dsh-link] 样式注入失败（已忽略）:', styleError);
			} catch (ignored) {
				/* 连 console 都没有也不能炸 */
			}
		}

		/**
		 * 电脑目录的**访问缓存**：`电脑路径 → listing`（模块级，跨对话框开关存活）。
		 *
		 * ## 为什么必须有（用户报障原文）
		 *
		 * 「为什么我点击添加工作区的时候，每次点击电脑都要重新加载一遍目录，
		 * 这就算了，我加载好之后，随便点击一个文件夹，文件夹里面的内容还要重新加载
		 * 一遍」—— 同一个电脑目录，每次进「电脑」页签、每次点进同一个文件夹，
		 * 都要重走一趟「手机 → Cloudflare 隧道 → 电脑」，一个来回 1～3 秒。
		 * 用户要的是「加载一次，后续直接从本地读」。
		 *
		 * ## 为什么放模块级而不是组件内 ref
		 *
		 * 对话框每次打开都是**新挂载的组件**，组件内的 ref 一关就没了 —— 那样
		 * 「关掉再打开又转一遍圈」，正是用户抱怨的第一个现象。放模块级则一次加载
		 * 整条会话内都命中。
		 *
		 * ⚠️ 键是**电脑路径**原样（`C:\Users\...`），`''` 表示根目录 —— 与
		 * `bridge('listDesktop')` 的入参完全一致，不做任何改写。
		 *
		 * ⚠️ **失效只有两条路**：用户点「刷新」（见 `refreshAll`），
		 * 或者那一次加载失败（见下面的 catch）。不做 TTL 轮询 —— 用户明确要的是
		 * 「加载一次就直接从本地读」。
		 */
		var desktopDirCache = {};

		/** 清掉访问缓存（配对 / 解绑 / 切页签时调用，避免跨电脑串味）。 */
		function clearDesktopDirCache() {
			desktopDirCache = {};
		}

		/**
		 * 哪些会话是「跑在电脑上的」—— 宿主 `remoteSessions` 的本地镜像。
		 *
		 * ## 为什么需要（用户需求原文）
		 *
		 * 「用户如果当前选择的是 **app 本地文件夹**，那么**就不要出现电脑的模型**，
		 * 以这个文件夹为隔离条件，**互不干预**」。
		 *
		 * 宿主把电脑的模型目录与手机本地那份**并**在一起交给前端（原因见宿主
		 * `mergeCatalog` 的注释：官方 `modelCatalog` 是全局唯一一份、不带 sessionId）。
		 * 所以要按工作区隔离，只能在**前端按会话**再筛一次 —— 而筛之前必须先知道
		 * 「这个会话是不是电脑的」。
		 *
		 * ⚠️ **判据必须与宿主 `prompt` 拦截同源**（宿主读的也是 `remoteSessions`）。
		 * 用 cwd 猜镜像目录是另一套判据，一旦两者不一致，就会出现「菜单里显示的是
		 * 电脑模型、消息却发到手机本地」这种最坏情况。
		 *
		 * ⚠️ **不能每次渲染打一次桥**：模型菜单每帧都读目录快照，那是同步 API。
		 * 所以 `apply` 时拉一次全量，之后建会话 / 解绑时自己增量维护，
		 * `getSnapshot` 纯查内存（见宿主 `case 'remoteSessions'` 的注释）。
		 */
		var remoteSessionIds = {};

		/**
		 * 电脑镜像工作区的 slug 集合 —— 隔离的**真正判据**。
		 *
		 * ⚠️⚠️ **为什么不用 `remoteSessionIds`（那是第一代，已被用户报障推翻）。**
		 *
		 * 第一代按 **sessionId** 判定，只在「用户从电脑文件夹对话框里建会话」
		 * 或「宿主拦截器绑过」时才知道。而用户在**侧边栏点「新建会话」**时，
		 * 官方前端直接 `sessionController.create({workspaceId})`，**不经过本插件**；
		 * 宿主的 create 拦截器认得出镜像目录（消息发得对），但前端不知道
		 * ⇒ 模型菜单仍按「本地」筛，显示手机模型。
		 *
		 * 用户原话：「只有我手动添加工作区的时候，才会触发模型和预设的刷新」——
		 * 说的就是判据挂在了「走了哪条路」上，而不是「会话的工作区在哪」。
		 *
		 * 正解：**按 cwd 判定**，与宿主 `desktopPathOfMirror` 同一个轴。
		 * 前端从 `sessions.list` 里同步读到会话的 `cwd`，看它是不是
		 * `…/workspaces/<slug>` 且 slug 属于电脑镜像。这条路与「谁建的会话」
		 * 完全无关，所以**任何入口进来都一致，不需要任何刷新触发**。
		 */
		var mirrorSlugs = {};

		/**
		 * 「用户刚刚在新建对话界面选中的那个工作区」的 cwd —— 只在**会话行还没带上
		 * cwd** 的那一小段时间里当兜底判据用。
		 *
		 * ⚠️⚠️ **为什么需要它（用户报障，2026-10-17 真机复现）**：
		 *
		 * 在**新建对话界面**（还没有任何消息）切到电脑工作区时，`sessions.list`
		 * 里那一行**还没有 cwd**（会话刚物化，宿主没回填），于是
		 * `isRemoteSession()` 只能退回 `remoteSessionIds[sessionId]` —— 而新建的
		 * 本地壳会话**不在里面**，结论是「本地」。后果：
		 *
		 * - 模型菜单只显示手机的模型（电脑的组被 `pickWorkspaceGroups` 筛掉）；
		 * - 预设列表同理，仍是手机那份。
		 *
		 * 用户原话：「我在待选的工作区里面选择了默认工作区，也就是我手机的工作区，
		 * 这个预设它没有改回来，模型列表也没有改回来」——反过来切到电脑时也一样。
		 *
		 * 兜底只影响**这一小段窗口**：一旦列表行带回 cwd，`cwdOf()` 优先，这个值
		 * 自动失效（见 `isRemoteSession` 的判据顺序），不会长期歪掉。
		 */
		var pendingWorkspaceCwd = null;

		/**
		 * `pendingWorkspaceCwd` 的**过期时刻**（毫秒时间戳）。
		 *
		 * ⚠️ 为什么必须有这个：官方工作区下拉菜单走的是
		 * `workspaceNavigation.openWorkspace()`（`ConversationContent` 的
		 * `selectWorkspace`），**完全不经过本插件** —— 所以「用户切回默认工作区」
		 * 这个动作我这边收不到通知，没法在那个时刻清掉 `pendingWorkspaceCwd`。
		 *
		 * 不设过期的话，一旦某次在电脑工作区设过它、而之后那个会话行的 cwd
		 * 又一直读不到，兜底值就会**永久**把「本地会话」判成电脑会话，用户看到
		 * 的正是「切回默认工作区，模型和预设都没改回来」。
		 *
		 * 取 30 秒：足够覆盖「建会话 → 列表行回填 cwd」这一段（真机是几百毫秒），
		 * 又不至于让一个陈旧值活太久。
		 */
		var pendingWorkspaceExpiresAt = 0;

		/** `pendingWorkspaceCwd` 的有效期（毫秒）。 */
		var PENDING_WORKSPACE_TTL = 30000;

		/**
		 * 记下「刚选中的工作区」并开始计时。
		 *
		 * @param cwd - 工作区路径；传 `null`/空串表示**立刻作废**。
		 */
		function setPendingWorkspace(cwd) {
			if (typeof cwd !== 'string' || cwd === '') {
				pendingWorkspaceCwd = null;
				pendingWorkspaceExpiresAt = 0;
				return;
			}
			pendingWorkspaceCwd = cwd;
			pendingWorkspaceExpiresAt = Date.now() + PENDING_WORKSPACE_TTL;
		}

		/**
		 * 取当前有效的兜底 cwd（过期就当没有）。
		 *
		 * @returns 有效的 cwd 或 `null`。
		 */
		function currentPendingWorkspace() {
			if (pendingWorkspaceCwd === null) return null;
			if (Date.now() > pendingWorkspaceExpiresAt) {
				pendingWorkspaceCwd = null;
				pendingWorkspaceExpiresAt = 0;
				return null;
			}
			return pendingWorkspaceCwd;
		}

		/**
		 * 从 cwd 取出镜像工作区的 slug（与宿主 `desktopPathOfMirror` 同构）。
		 *
		 * ⚠️ 用 `/workspaces/` 定位而不是前缀比对：`workspace.path` 是 realpath，
		 * 真机上 `/data/user/0` 与 `/data/data` 会差一层，前缀一比就永远不命中
		 * （宿主那边踩过这个坑，注释见 `desktopPathOfMirror`）。
		 * 两种分隔符都认：手机是 posix，但在 Windows 上调试时是 `\`。
		 *
		 * @param cwd - 会话的 cwd。
		 * @returns 镜像工作区的 slug；不是镜像目录时 `undefined`。
		 */
		function mirrorSlugOf(cwd) {
			if (typeof cwd !== 'string' || cwd === '') return undefined;
			var at = cwd.search(/[\\/]workspaces[\\/]/);
			if (at < 0) return undefined;
			var slug = cwd.slice(at).split(/[\\/]/)[2];
			return slug === undefined || slug === '' ? undefined : slug;
		}

		/**
		 * 这个会话是不是跑在电脑上 —— **同步**判定，任何入口都用同一条。
		 *
		 * ⚠️ **cwd 读得到时，它以 cwd 为唯一判据**（不看 `remoteSessionIds`）：
		 * 工作区就是隔离条件本身。解绑后 `mirrorSlugs` 清空 ⇒ 全部回到本地，
		 * 不需要再去清每个会话的旧标记。
		 *
		 * 只有列表行还没带 cwd 的那一两帧（会话刚建好）才退回
		 * `pendingWorkspaceCwd` / `remoteSessionIds`。
		 *
		 * ⚠️ **判据顺序不能换**：
		 * 1. `cwdOf(sessionId)` —— 会话自己的 cwd，最准；
		 * 2. `pendingWorkspaceCwd` —— 用户在新建界面刚选的工作区（见它的注释，
		 *    这是修「新建界面模型/预设不跟随工作区」的那一条）；
		 * 3. `remoteSessionIds` —— 宿主显式标记过的会话。
		 *
		 * 第 2 条只在第 1 条读不到时才生效，所以一旦会话行带回 cwd，
		 * 它就自动让位，不会跟真实 cwd 打架。
		 *
		 * @param sessionId - 会话 id。
		 * @param cwdOf - `sessionId → cwd` 的同步读取函数。
		 * @returns 是不是电脑工作区的会话。
		 */
		function isRemoteSession(sessionId, cwdOf) {
			var cwd = cwdOf === undefined ? undefined : cwdOf(sessionId);
			if (typeof cwd === 'string' && cwd !== '') {
				var slug = mirrorSlugOf(cwd);
				return slug !== undefined && mirrorSlugs[slug] === true;
			}
			// 会话自己的 cwd 还没进列表行 —— 用「刚选中的工作区」兜底（会过期）。
			var pending = currentPendingWorkspace();
			if (pending !== null) {
				var pendingSlug = mirrorSlugOf(pending);
				return pendingSlug !== undefined && mirrorSlugs[pendingSlug] === true;
			}
			return remoteSessionIds[sessionId] === true;
		}

		/** 从宿主拉一次全量远程会话清单（失败就按「全是本地」处理）。 */
		function loadRemoteSessionIds() {
			return bridge('remoteSessions', {}).then(
				function (result) {
					var ids = result && result.ids;
					if (!Array.isArray(ids)) return;
					var next = {};
					for (var at = 0; at < ids.length; at += 1) next[ids[at]] = true;
					remoteSessionIds = next;
				},
				function () {
					/* 拉不到就保持原样：最坏是本地工作区多看到电脑模型，不会误发 */
				},
			);
		}

		/**
		 * 从宿主拉一次「电脑镜像工作区的 slug 集合」（隔离的真正判据）。
		 *
		 * 拉不到就保持原样（空集合 = 全部按本地处理）：最坏是本地工作区多看到
		 * 电脑模型，**不会误发** —— 消息该发给谁由宿主 `prompt` 拦截器按
		 * `remoteSessions` 决定，与这里无关。
		 */
		function loadMirrorSlugs() {
			return bridge('mirrorSlugs', {}).then(
				function (result) {
					var slugs = result && result.slugs;
					if (!Array.isArray(slugs)) return;
					var next = {};
					for (var at = 0; at < slugs.length; at += 1) next[slugs[at]] = true;
					mirrorSlugs = next;
				},
				function () {
					/* 同上：最坏是多显示几项，不会误发 */
				},
			);
		}

		/**
		 * 按「这个会话是不是电脑的」筛出该显示的组与失败项。
		 *
		 * ## 双向隔离
		 *
		 * - **本地工作区**：只留手机自己的组，并把被电脑同 id provider 覆盖掉的那组
		 *   **还原**回来（`localGroups`，宿主 `mergeCatalog` 额外带上的）。
		 * - **电脑工作区**：只留电脑的组。这不是「顺手加活」—— 电脑会话的 prompt 会
		 *   转发到电脑，选一个手机本地才有的模型（比如 `agnes-3.0-flash`）发过去，
		 *   电脑上根本不存在，必然报错。用户说的「互不干预」正是这个意思。
		 *
		 * ⚠️ 没配对时目录里根本没有 `desktop` 标记，两个分支都会原样返回。
		 *
		 * ⚠️ **`extraLocal` 是必需的**：官方的 `syncInputs` 往 `directory.store`
		 * 里只拷了 `groups` / `failures`（见
		 * `dsh-client-ui-model-selection/lib/client.js:325`），**`localGroups` 不在
		 * 那一层**。所以筛 `directory.store` 时得由调用方把 `localGroups`
		 * 从 catalog 原值里递进来，否则本地工作区永远还原不出被覆盖的那组。
		 *
		 * @param value - 目录值（`{groups, failures, localGroups?, localFailures?}`）。
		 * @param isRemote - 这个会话是不是跑在电脑上。
		 * @param extraLocal - 备用本地组（`value.localGroups` 缺失时用）。
		 * @returns `{groups, failures}`（`value` 不合法时原样返回空数组）。
		 */
		function pickWorkspaceGroups(value, isRemote, extraLocal) {
			if (!value || !Array.isArray(value.groups)) {
				return { groups: [], failures: [] };
			}
			const groups = value.groups;
			const failures = Array.isArray(value.failures) ? value.failures : [];
			if (isRemote === true) {
				return {
					groups: groups.filter(function (group) { return group.desktop === true; }),
					failures: failures.filter(function (failure) { return failure.desktop === true; }),
				};
			}
			const kept = groups.filter(function (group) { return group.desktop !== true; });
			// 还原被电脑同 id 覆盖掉的本地组（见宿主 `mergeCatalog`）。
			const local = Array.isArray(value.localGroups)
				? value.localGroups
				: (Array.isArray(extraLocal) ? extraLocal : []);
			if (local.length > 0) {
				const have = {};
				for (let at = 0; at < kept.length; at += 1) have[kept[at].id] = true;
				for (let lt = 0; lt < local.length; lt += 1) {
					if (have[local[lt].id] !== true) kept.push(local[lt]);
				}
			}
			return {
				groups: kept,
				failures: failures.filter(function (failure) { return failure.desktop !== true; }),
			};
		}

		/**
		 * 按工作区筛**预设名单**（与 `pickWorkspaceGroups` 同构）。
		 *
		 * 用户报障：「模型列表能够快速切换回来了，但是预设列表没有切换」——
		 * 模型能切是因为它走了 `pickWorkspaceGroups`，预设没切是因为宿主
		 * `mergePresets` 只是把两份并起来、前端没人再筛一次。
		 *
		 * 判据与模型**完全同一条**（`isRemoteSession`）：会话在电脑工作区 ⇒ 只留
		 * 电脑那几条；否则只留本地那几条，并把被同 id 覆盖掉的本地项还原回来。
		 *
		 * ⚠️ **一条都不剩时原样返回**：电脑那边预设全坏了、或者宿主还没把
		 * `desktop` 标记打上（老版本宿主）时，宁可多显示几条，也别把菜单变成空的
		 * —— 空菜单用户连「默认」都选不回来。
		 *
		 * @param value - `{presets, localPresets?}`（宿主 `mergePresets` 的产物）。
		 * @param isRemote - 这个会话是不是跑在电脑上。
		 * @returns 筛过的 `{presets}`（`value` 不合法时原样返回）。
		 */
		function pickWorkspacePresets(value, isRemote) {
			if (!value || !Array.isArray(value.presets)) return value;
			const all = value.presets;
			// ⚠️ 宿主没打标记（老版本宿主 / 还没合并过）⇒ 无从判断，原样返回。
			let tagged = false;
			for (let at = 0; at < all.length; at += 1) {
				if (all[at] && all[at].desktop === true) { tagged = true; break; }
			}
			if (!tagged) return value;
			if (isRemote === true) {
				const desktopOnly = all.filter(function (preset) { return preset.desktop === true; });
				if (desktopOnly.length === 0) return value;
				return Object.assign({}, value, { presets: desktopOnly });
			}
			const kept = all.filter(function (preset) { return preset.desktop !== true; });
			// 还原被电脑同 id 覆盖掉的本地预设（见宿主 `mergePresets`）。
			const local = Array.isArray(value.localPresets) ? value.localPresets : [];
			if (local.length > 0) {
				const have = {};
				for (let kt = 0; kt < kept.length; kt += 1) have[kept[kt].id] = true;
				for (let lt = 0; lt < local.length; lt += 1) {
					if (have[local[lt].id] !== true) kept.push(local[lt]);
				}
			}
			if (kept.length === 0) return value;
			return Object.assign({}, value, { presets: kept });
		}

		/**
		 * 从共享的 catalog 原值里取「手机本地的组」（宿主 `mergeCatalog` 带的）。
		 *
		 * @param directory - 官方的 `ModelDirectory`（含 `.catalog`）。
		 * @returns 本地组数组；拿不到就空数组。
		 */
		function localGroupsOf(directory) {
			try {
				// ⚠️ 不用可选链：本文件受 chrome73 语法约束（见文件头）。
				if (!directory || !directory.catalog || !directory.catalog.store) return [];
				const store = directory.catalog.store;
				if (typeof store.getSnapshot !== 'function') return [];
				const value = store.getSnapshot().value;
				return value && Array.isArray(value.localGroups) ? value.localGroups : [];
			} catch (error) {
				return [];
			}
		}

		/** 某个 `provider/model` 在给定的组里存不存在。 */
		function isSelectable(groups, selection) {			if (!selection) return false;
			for (let at = 0; at < groups.length; at += 1) {
				if (groups[at].id !== selection.provider) continue;
				const models = Array.isArray(groups[at].models) ? groups[at].models : [];
				for (let mt = 0; mt < models.length; mt += 1) {
					if (models[mt].id === selection.model) return true;
				}
			}
			return false;
		}

		/**
		 * 在给定的组里挑一个**真实可用**的模型选择。
		 *
		 * 用途见 `scopeDirectoryToWorkspace` 里那段 ⚠️⚠️ 注释：`current` 被清空后
		 * 必须立刻回填，否则官方会把它读成「正在加载模型…」并永久卡住。
		 *
		 * 优先级：
		 * 1. `preferred`（通常传 `snapshot.default`）—— 官方自己就用它当兜底，
		 *    跟着它走语义最一致；
		 * 2. 否则第一个组的第一模型。
		 *
		 * @param groups - 筛过的组数组。
		 * @param preferred - 优先尝试的选择（可能已被筛掉）。
		 * @returns `{provider, model}`；一组都没有时 `null`。
		 */
		function pickFallbackSelection(groups, preferred) {
			if (!Array.isArray(groups) || groups.length === 0) return null;
			if (isSelectable(groups, preferred)) {
				return { provider: preferred.provider, model: preferred.model };
			}
			for (let at = 0; at < groups.length; at += 1) {
				const models = Array.isArray(groups[at].models) ? groups[at].models : [];
				if (models.length === 0) continue;
				// `provider` 取组 id（官方 `isSelectable` 就是按组 id 比的）。
				return { provider: groups[at].id, model: models[0].id };
			}
			return null;
		}

		/**
		 * 筛**目录值**（`catalog.store` 里 `{value}` 那一份）。
		 *
		 * ⚠️ **`default` 必须跟着换**：官方的 `syncInputs` 用
		 * `projected.next ?? catalog.value.default` 定 `current`，如果 `default`
		 * 指向一个已被筛掉的 provider，界面就会显示一个不在列表里的模型名。
		 * 所以筛完若 `default` 不在剩下的组里，就退到第一个组的第一个模型。
		 *
		 * ⚠️ **一组都没剩时原样返回**（例如电脑那边所有 provider 都挂了）：
		 * 宁可多显示几个，也别把菜单变成空的 —— 空菜单用户连「刷新」都点不到。
		 *
		 * @param value - 目录值。
		 * @param isRemote - 这个会话是不是跑在电脑上。
		 * @returns 筛过的目录值。
		 */
		function filterCatalogValue(value, isRemote) {
			if (!value || !Array.isArray(value.groups)) return value;
			const picked = pickWorkspaceGroups(value, isRemote);
			if (picked.groups.length === 0) return value;
			const next = Object.assign({}, value, {
				groups: picked.groups,
				failures: picked.failures,
			});
			// ## ⚠️ 本地工作区要**把 default 还原成手机自己的**
			//
			// 宿主 `mergeCatalog` 现在优先用**电脑的** `default`（那是修 1017 标签
			// 的关键，见那边的注释）。但本地工作区的模型列表只有手机那几组，
			// 电脑的 default 很可能不在里面 ⇒ 官方 `syncInputs` 算出的 `current`
			// 会指向一个列表里不存在的模型。
			//
			// 所以这里按同一个工作区判据分流：远程会话用合并后的（电脑的）
			// default，本地会话还原成 `localDefault`。
			if (isRemote !== true) {
				const localDefault = value.localDefault;
				if (localDefault !== undefined && localDefault !== null
					&& isSelectable(picked.groups, localDefault)) {
					next.default = { provider: localDefault.provider, model: localDefault.model };
				}
			}
			if (!isSelectable(picked.groups, next.default)) {
				const first = picked.groups[0];
				const firstModel = Array.isArray(first.models) ? first.models[0] : undefined;
				if (firstModel !== undefined) next.default = { provider: first.id, model: firstModel.id };
			}
			return next;
		}

		/**
		 * 给官方那个**每会话共享**的 `ModelDirectory` 套一层「按工作区筛」的读路径。
		 *
		 * ## 为什么包装 `directoryFor` 而不是改前端 bundle
		 *
		 * `conversation.input.model` 这个 slot 的 `inject(sessionId)` 会调
		 * `modelDirectories.directoryFor(sessionId)`（见
		 * `dsh-client-ui-model-selection/lib/client.js:1189`），菜单和 `/model`
		 * 命令都从它拿数据。`directoryFor` 是**服务实例上的普通方法**，包它
		 * 就等于包住了这两个入口 —— 不用碰前端内部类，升级也不会碎。
		 *
		 * ## 为什么两层的 store 都要包
		 *
		 * 官方有两级快照，形状**不一样**，两个都要筛：
		 *
		 * | 来源 | 形状 | 谁读它 |
		 * |---|---|---|
		 * | `catalog.store` | `{value:{groups,default,…}, status}` | `syncInputs()` 算 `current`/`routable` |
		 * | `directory.store` | `{groups, failures, current, status, …}` | `ModelSelect` 直接渲染 |
		 *
		 * 只筛 `directory.store` 的话，`syncInputs` 仍会用**没筛过**的 `default`
		 * 把 `current` 算成被筛掉的那个模型 —— 菜单里没有它、触发按钮却显示它，
		 * 而且 `routable` 会被算成 `false`，官方界面会提示「该 provider 的目录加载失败」。
		 *
		 * ## 为什么要「稳定」而不是每次新建
		 *
		 * `inject` 每渲染一帧都调一次 `directoryFor`，返回值里的 `store` 直接喂给
		 * `useSyncExternalStore` 的 `subscribe`。每次返回新对象会让 React 每帧
		 * 重订阅。所以包装缓存在原 `directory.__dshRemoteScoped` 上，生命周期跟着
		 * 官方的会话 scope 一起走 —— 官方在 scope dispose 时删掉原实例，
		 * 包装随之被 GC，不会累积。
		 *
		 * ⚠️ 用 `Object.create(原型) + Object.assign` 而不是 `{...directory}`：
		 * `ModelDirectory` 的方法（`select` / `reasoningFor` / `syncInputs`）
		 * 在**原型**上，展开运算符只复制自有属性、会把方法全丢掉 —— 症状是
		 * 「点模型没反应」。
		 *
		 * ⚠️ `select` 走原型链、以 `this = wrapper` 调用，于是它读到的
		 * `this.store.getSnapshot()` 是**筛过**的（`current` 正确），写回
		 * `this.store.update()` 仍转发给原 store。读写都落在正确的那一层。
		 *
		 * @param directory - 官方的 `ModelDirectory` 实例。
		 * @param sessionId - 它归属的会话。
		 * @param cwdOf - `sessionId → cwd` 的**同步**读取函数（隔离判据要用它）。
		 * @returns 读路径被筛过的同构对象。
		 */
		function scopeDirectoryToWorkspace(directory, sessionId, cwdOf) {
			if (!directory || !directory.store || typeof directory.store.getSnapshot !== 'function') {
				return directory;
			}
			// ⚠️ 判据是**每次读时现算**的（不是建包装时算一次）：会话的 cwd 可能
			// 在列表行到达后才出现，而且解绑/换工作区都会改结论。
			// `isRemoteSession` 见其注释 —— 它看的 cwd，跟宿主 `desktopPathOfMirror` 同一个轴。
			const isRemote = function () { return isRemoteSession(sessionId, cwdOf); };
			const wrapper = Object.create(Object.getPrototypeOf(directory));
			Object.assign(wrapper, directory);

			/**
			 * 包一层 store：读时筛，通知与写回照旧转发。
			 *
			 * ⚠️⚠️ **`getSnapshot()` 必须身份稳定**，否则 React 直接炸。这条是
			 * 1.0.19 第二次真机启动实测到的（第一次是上面的 `remote.session`）：
			 *
			 *     [web] slot entry crashed in 'conversation.input.model':
			 *           Error: Minified React error #185
			 *
			 * #185 就是「Maximum update depth exceeded」（无限重渲染）。原因：
			 * 官方把这个 store 的 `getSnapshot` 直接喂给 `useSyncExternalStore`，
			 * 而 React 在渲染期用 **`Object.is`** 比较前后两次快照，不同就再渲染一次。
			 * 而 `pickWorkspaceGroups` 每次都 `filter` 出新数组、外面又 `Object.assign`
			 * 出新对象 —— **同一个源快照也每次返回新对象** ⇒ 每一帧都"变了" ⇒ 死循环。
			 *
			 * 所以按「源快照身份 + 影响筛选结果的外部开关」缓存上一次的投影结果。
			 */
			const wrapStore = function (store, project, volatileToken) {
				let cachedSource;
				let cachedToken;
				let cachedProjected;
				return {
					getSnapshot: function () {
						const source = store.getSnapshot();
						const token = volatileToken === undefined ? '' : volatileToken();
						// 源快照换了、或开关变了才重算；否则复用同一个对象（身份稳定）。
						if (source === cachedSource && token === cachedToken) return cachedProjected;
						cachedSource = source;
						cachedToken = token;
						cachedProjected = project(source);
						return cachedProjected;
					},
					subscribe: function (fn) { return store.subscribe(fn); },
					update: function (mutator) { return store.update(mutator); },
					set: function (value) { return store.set(value); },
				};
			};

			const store = directory.store;
			wrapper.store = wrapStore(store, function (snapshot) {
				// ⚠️ `directory.store` 那一层没有 `localGroups`（官方 `syncInputs`
				// 只拷了 groups/failures），所以从 catalog 的原值里现取一份递进去。
				const picked = pickWorkspaceGroups(snapshot, isRemote(), localGroupsOf(directory));
				if (picked.groups.length === 0) return snapshot;
				const next = Object.assign({}, snapshot, picked);
				// `current` 指向被筛掉的模型时换一个**可用**的，不能留 null。
				//
				// ## ⚠️⚠️ 这里原来是 `next.current = null`，那是个 bug（用户报障）
				//
				// 用户原话：
				//   「我输入框右下角，它一直显示正在加载模型，但是我点击它展开是可以
				//    看到模型列表的，然后我也是可以正常发送消息的，但是它一直显示
				//    正在加载模型。」
				//
				// 触发按钮的文案由官方
				// `dsh-client-ui-model-selection/lib/client.js:773-774` 算：
				//
				//     const waiting = state.current === null && state.status === "loading";
				//     const modelLabel = waiting ? t("trigger.loading") : …
				//
				// 也就是说 **`current === null` 会被官方读成「还没加载完」**。
				// 而 `current` 这个字段是官方 `syncInputs()` 算的，它**只在
				// 输入变化时算一次**；我们把快照里的 `current` 清成 null 之后，
				// 没有任何人再把它算回来 ⇒ 按钮永久卡在「正在加载模型…」，
				// 尽管 `groups` 是好的（所以点开菜单能看到完整列表）、
				// `status` 也是 `loaded`（所以能正常发消息）——
				// 这三个现象同时出现，正是这个 bug 的指纹。
				//
				// 正确做法：清空之后**立刻回填**一个列表里真实存在的选择
				//（`snapshot.default` 优先，其次第一个组的第一个模型）。
				// 这样按钮显示的是真实模型名，语义上也和「当前实际会用哪个模型」
				// 一致 —— 官方发消息时本来就会退回默认模型。
				if (!isSelectable(picked.groups, next.current)) {
					next.current = null;
					const fallback = pickFallbackSelection(picked.groups, snapshot.default);
					if (fallback !== null) next.current = fallback;
				}
				return next;
			// ⚠️ 缓存键必须带上「这个会话算不算远程」：同一个源快照在「切成远程会话」
			// 前后要投影出**不同**结果，只看源快照身份会永远返回旧的那一份。
			}, function () { return isRemote() === true ? 'remote:1' : 'remote:0'; });

			// `load()` 返回的就是快照，`/model` 命令直接拿它渲染，所以也要筛。
			wrapper.load = function () {
				return Promise.resolve(directory.load()).then(function () {
					return wrapper.store.getSnapshot();
				});
			};

			const catalog = directory.catalog;
			if (catalog && catalog.store && typeof catalog.store.getSnapshot === 'function') {
				const catalogStore = catalog.store;
				const catalogWrapper = Object.create(Object.getPrototypeOf(catalog));
				Object.assign(catalogWrapper, catalog);
				catalogWrapper.store = wrapStore(catalogStore, function (snapshot) {
					return Object.assign({}, snapshot, {
						value: filterCatalogValue(snapshot.value, isRemote()),
					});
				}, function () { return isRemote() === true ? 'remote:1' : 'remote:0'; });
				wrapper.catalog = catalogWrapper;
			}
			return wrapper;
		}

		/**
		 * 把「按工作区筛模型目录」接到官方服务上。
		 *
		 * `ctx.get` 拿不到服务就静默跳过（最坏是回到「两个工作区看到同一份列表」的
		 * 旧行为，不会报错）。返回一个撤销函数。
		 *
		 * @param ctx - client 根上下文。
		 * @param cwdOf - `sessionId → cwd` 的**同步**读取函数（隔离判据要用它）。
		 * @returns 撤销函数。
		 */
		function patchModelDirectories(ctx, cwdOf) {
			var models = ctx.get === undefined ? undefined : ctx.get('modelDirectories');
			if (!models || typeof models.directoryFor !== 'function') return function () {};

			// ⚠️⚠️ **必须在「原始实例」上覆盖，不能在 `ctx.get()` 拿到的那个对象上覆盖。**
			//
			// `modelDirectories` 是 cordis 的 Service，`ctx.get()` 返回的是
			// `createTraceable()` 造出来的 **Proxy**（见 cordis `lib/index.js` 的
			// `getTraceable`/`createTraceable`）。那个 Proxy 的 `get` 会把方法包成
			// `createShadowMethod(ctx, fn, receiver, shadow)`，其 apply 里有一句：
			//
			//     if (thisArg === outer) thisArg = shadow;
			//
			// `outer` 就是取方法时的那个 receiver，而 `shadow` 是
			// `withProp(receiver, property, ctx.extend({[shadow]: origin}))` ——
			// 这个 `ctx` 是**谁调 `ctx.get()` 就用谁的上下文**。
			//
			// 于是 `models.directoryFor.bind(models)` 把 this 钉在了 Proxy 上，
			// 每次调用都命中 `thisArg === outer` ⇒ this 被换成**我的插件上下文**
			// 扩展出来的 shadow。而官方 `ModelDirectoryResolver.directoryFor` 内部要读
			// `this.ctx.remote.session`（`dsh-client-ui-model-selection/lib/client.js:388`），
			// 我的插件没有 inject 过 `remote.session` ⇒ 抛
			//
			//     cannot get property "remote.session" without inject
			//
			// 真机症状：`conversation.input.model` 这个 slot 整体 crash，
			// **输入框上的模型按钮直接消失**。1.0.19 首次真机启动实测到的。
			//
			// 正解是用 `Symbol.for('cordis.original')` 取出 Proxy 背后的原始实例
			// （`createTraceable` 的 get trap 里第一条就是 `if (prop === symbols.original) return target`），
			// 在**它**身上覆盖。这样 `this.ctx` 始终是 `ModelDirectoryResolver`
			// 构造时 `super(ctx, …)` 存下的那个 ctx，服务解析照旧。
			var ORIGINAL = Symbol.for('cordis.original');
			var raw = models[ORIGINAL] === undefined ? models : models[ORIGINAL];
			if (!raw || typeof raw.directoryFor !== 'function') return function () {};

			var hadOwn = Object.prototype.hasOwnProperty.call(raw, 'directoryFor');
			var previous = raw.directoryFor;
			var call = previous.bind(raw);
			raw.directoryFor = function (sessionId) {
				var directory = call(sessionId);
				if (directory.__dshRemoteScoped !== undefined) return directory.__dshRemoteScoped;
				var scoped = scopeDirectoryToWorkspace(directory, sessionId, cwdOf);
				try {
					directory.__dshRemoteScoped = scoped;
				} catch (error) {
					/* 冻结就退回「每次新建」，功能不受影响 */
				}
				return scoped;
			};
			return function () {
				if (hadOwn) raw.directoryFor = previous;
				else delete raw.directoryFor;
			};
		}

		/**
		 * 把「按工作区筛预设名单」接到官方 RPC 上。
		 *
		 * ⚠️⚠️ **为什么必须在前端拦，而不能像模型那样只靠宿主。**
		 *
		 * 官方的预设名单来自 `readRoster(ctx)` → `ctx.remote.agentPresets.list()`
		 * （`dsh-client-ui-agent-preset/lib/client.js:1081`），落到宿主就是
		 * `remoteExportList()` —— 这个方法**一个参数都不收**
		 * （`dsh-agent-preset-registry/lib/index.js:592`），宿主侧**拿不到会话**，
		 * 所以「远程会话看电脑的、本地会话看手机的」在宿主侧表达不出来。
		 *
		 * 宿主那边（`mergePresets`）只能把两份并起来并打 `desktop: true` 标记，
		 * 与模型目录的 `mergeCatalog` 完全同构。**筛这一步必须在能看到会话的地方做。**
		 *
		 * 还有一条更硬的理由：`seat.load()` 只在 `settings/document-updated` 与
		 * `connection/reset` 时重跑（`dsh-client-ui-agent-preset/lib/client.js:1595`），
		 * **切工作区根本不会重新请求 roster** —— 所以就算宿主按会话筛好了，
		 * 前端缓存里那份旧的也不会变。只能在**读结果**的地方筛。
		 *
		 * @param ctx - client 根上下文。
		 * @param cwdOf - `sessionId → cwd` 的同步读取函数。
		 * @returns 撤销函数。
		 */
		function patchAgentPresets(ctx, cwdOf) {
			// 诊断出口①：**进入函数就记一笔**。1.0.33 的诊断只写在 `list()` 里，
			// 结果真机读到 `window.__dshRemoteDiag === null` —— 只能证明「list 没被
			// 调用过」，分不清是「patch 没进来」还是「进来了但官方没调」。这一笔
			// 把两种情形分开。
			var probe = { stage: 'enter' };
			try {
				window.__dshRemoteProbe = probe;
			} catch (probeError) {
				/* 诊断失败绝不影响主流程 */
			}

			var remote = ctx.remote;
			probe.hasRemote = remote !== undefined && remote !== null;
			if (remote === undefined || remote === null) return function () {};
			var presets = remote.agentPresets;
			probe.hasPresets = presets !== undefined && presets !== null;
			if (presets === undefined || presets === null) return function () {};
			probe.listType = typeof presets.list;
			if (typeof presets.list !== 'function') return function () {};

			// ⚠️⚠️ **必须在「原始实例」上覆盖 `list`，不能在 `ctx.remote.agentPresets`
			// 拿到的那个对象上覆盖 —— 这是 1.0.25 / 1.0.26 / 1.0.27 三次真机都
			// 「改了却完全没效果」的根因。**
			//
			// 与 `patchModelDirectories` 同一个陷阱（见那里的长注释）：cordis 的
			// `ctx.remote` 是 `createTraceable()` 造出来的 **Proxy**，它的 `get` trap
			// 会把方法包成 `createShadowMethod(...)`，并把对象属性也裹一层。
			// 往 Proxy 上赋一个新属性，写进的是 Proxy 的 shadow 层，
			// **官方 `readRoster` 读的是它自己那份 `ctx.remote.agentPresets.list`** ——
			// 两者不是同一个函数位，所以我那次赋值官方永远看不到。
			//
			// 真机症状（用户三次反馈）：
			//   1.0.25「模型列表能够快速切换回来了，但是预设列表没有切换」
			//   1.0.26/1.0.27「不管是应用的私有默认工作区，还是我自己选择的
			//   手机目录工作区，都无法自动切换回手机的预设列表」
			// —— 注意「模型能切、预设不能切」，正是因为模型走
			// `patchModelDirectories`（**正确解包了**），而预设没有。
			//
			// 正解：用 `Symbol.for('cordis.original')` 取出 Proxy 背后的原始实例
			// （`createTraceable` 的 get trap 第一条就是 `if (prop === symbols.original) return target`），
			// 在**它**身上覆盖。这样官方经 Proxy 读到的就是这个被包过的 `list`。
			var ORIGINAL = Symbol.for('cordis.original');
			var raw = presets[ORIGINAL] === undefined ? presets : presets[ORIGINAL];
			probe.rawListType = raw ? typeof raw.list : 'no-raw';
			if (!raw || typeof raw.list !== 'function') return function () {};

			/**
			 * 「当前主视图会话」的 id。
			 *
			 * ⚠️⚠️ **必须优先读 `uiWorkspace.selection`，不能只靠 `retainedBy`。**
			 *
			 * 1.0.25 第一版用的是「遍历 `sessions.byId`，找 `retainedBy.mainView > 0`
			 * 的第一行」—— 那是官方 `installWorkspaceShortcuts` 里给快捷键用的
			 * `current()`（`dsh-client-ui-workspace/lib/client.js:106`），它只保证
			 * 「**有一个**会话被主视图持有」，**不保证唯一、也不保证是最新的那个**。
			 * 电脑工作区与手机工作区各有一个被持有的会话时，遍历顺序先命中谁就是谁，
			 * 于是用户切回手机目录后，判定仍然可能落在电脑那个会话上。
			 *
			 * 真机症状（用户截图）：切回手机工作区，预设列表仍是电脑那份，
			 * 选中后报 `Unknown agent preset: pojia` —— 手机宿主不认识电脑的预设 id。
			 *
			 * 正解是官方自己的权威来源：`uiWorkspace.selection`
			 * （`createSnapshotStore({})`，见其 L761；`replaceMain()` 在切换主视图时
			 * 用 `this.selection.set({sessionId: reference.sessionId})` 写入，
			 * 见其 L982-985）。它就是「现在主视图上打开的是哪个会话」。
			 *
			 * `retainedBy` 只作为拿不到 `selection` 时的退路。
			 *
			 * @returns 会话 id；找不到时 `undefined`。
			 */
			var currentSessionId = function () {
				// ① 权威来源：`uiWorkspace.selection`。
				var uiWorkspace = ctx.uiWorkspace;
				if (uiWorkspace !== undefined && uiWorkspace !== null) {
					var selection = uiWorkspace.selection;
					if (selection !== undefined && selection !== null && typeof selection.getSnapshot === 'function') {
						var chosen = selection.getSnapshot();
						if (chosen && typeof chosen.sessionId === 'string' && chosen.sessionId !== '') {
							return chosen.sessionId;
						}
					}
					// ② `uiWorkspace.mainReference` —— 官方主视图当前挂着的那个会话引用。
					// 它与 `selection` 同源（`replaceMain()` 会同时写这两处），
					// 但 `selection` 是持久化快照、可能落后一帧，这里补上。
					var reference = uiWorkspace.mainReference;
					if (reference && typeof reference.sessionId === 'string' && reference.sessionId !== '') {
						return reference.sessionId;
					}
				}

				/**
				 * ⚠️⚠️ **这里绝对不能再「遍历所有会话、找第一个 `retainedBy.mainView > 0`」**
				 * —— 那是 1.0.30 之前「切回手机工作区后预设列表不跟着切回来」的**真正根因**。
				 *
				 * 官方自己在 `dsh-client-ui-workspace/lib/client.js:106` 的注释里就写明了
				 * 那套判据**只保证「有一个会话被主视图持有」，不保证唯一、也不保证是最新的**：
				 *
				 * ```js
				 * const current = () => { ... 找 retainedBy.mainView > 0 的第一行 ... };
				 * ```
				 *
				 * 用户的实际场景正好踩中它：**新建会话界面（hero 页）里根本没有任何会话**
				 * —— `selection` 是空的、`mainReference` 是空的，于是掉进那条盲扫退路，
				 * 而盲扫按 `Object.keys(byId)` 的顺序**先命中电脑那个旧会话**，
				 * 于是「当前是电脑工作区」被判成 true，预设列表永远停在电脑那一份，
				 * 哪怕用户已经把工作区切回手机目录。
				 *
				 * 用户原话：「你难道还是做不到切换回手机的目录之后
				 * （也就是说切换到非电脑目录之后），预设列表正常改回来吗」。
				 *
				 * **正确行为：判不出来就返回 `undefined`。**
				 * `currentIsRemote()` 会把 `undefined` 当成「手机（本地）」——
				 * 新建会话界面本来就该用手机那一套预设，这是符合直觉的默认值。
				 */
				return undefined;
			};

			/**
			 * 当前主视图所在的**工作区路径** —— 「选工作区就是开关」的那把开关本身。
			 *
			 * 用户原话：「就是选工作区的时候就作为一个开关……检测到是手机的，你就给我
			 * 换回手机那一套呗，检测到是电脑的就换回电脑那一套呗」。
			 *
			 * 所以判据应当落在**工作区**上，而不是绕着会话去猜。官方自己在
			 * `dsh-client-ui-workspace/lib/client.js:932` 就是这么定位当前工作区的：
			 *
			 * ```js
			 * const workspace = workspaces.items.find(
			 *   (item) => item.sessionIds.includes(sessionId));
			 * ```
			 *
			 * `item.path` 即该工作区的目录 —— 电脑镜像工作区的路径里带
			 * `.../workspaces/<slug>/...`，`mirrorSlugOf()` 能认出 slug。
			 *
			 * @param sessionId - 当前主视图会话 id。
			 * @returns 工作区路径；查不到时 `undefined`。
			 */
			var workspacePathOfCurrent = function (sessionId) {
				if (typeof sessionId !== 'string' || sessionId === '') return undefined;
				var workspaceService = ctx.workspaces;
				if (workspaceService === undefined || workspaceService === null) return undefined;
				var list = workspaceService.list;
				if (list === undefined || list === null || typeof list.getSnapshot !== 'function') return undefined;
				var snapshot = list.getSnapshot();
				if (snapshot === undefined || snapshot === null) return undefined;
				var items = snapshot.items;
				if (!Array.isArray(items)) return undefined;
				for (var at = 0; at < items.length; at += 1) {
					var item = items[at];
					if (!item || !Array.isArray(item.sessionIds)) continue;
					if (item.sessionIds.indexOf(sessionId) === -1) continue;
					if (typeof item.path === 'string' && item.path !== '') return item.path;
					return undefined;
				}
				return undefined;
			};

			/**
			 * 这一屏该用电脑的预设还是手机的预设 —— **一个布尔开关**。
			 *
			 * 判据顺序（前面的赢）：
			 *
			 * 1. **当前工作区的路径**是不是电脑镜像目录 —— 用户要的那个开关；
			 * 2. 当前会话自己的 `cwd` —— 与模型菜单完全同一条（`isRemoteSession`）；
			 * 3. 都没有 ⇒ 当成手机（本地）。
			 *
			 * ⚠️ 第 1 条必须放最前：切工作区时 `selection` 与列表行可能晚一两帧才一致，
			 * 而工作区行是**已经切过去**的那一个，它最能代表用户此刻的选择。
			 *
			 * @returns 是不是电脑工作区。
			 */
			var currentIsRemote = function () {
				var sessionId = currentSessionId();
				var path = workspacePathOfCurrent(sessionId);
				if (typeof path === 'string' && path !== '') {
					var slug = mirrorSlugOf(path);
					if (slug !== undefined && mirrorSlugs[slug] === true) return true;
					/**
					 * ⚠️ **`mirrorSlugs` 是异步拉来的快照，刚启动时可能是空的。**
					 *
					 * 那时上面的精确匹配会落空，若不在这里兜住，电脑工作区会被
					 * 误判成手机工作区（预设/模型列表「用错了那一套」）。
					 *
					 * 兜底判据用路径形态：电脑镜像工作区由宿主
					 * `ensureDesktopWorkspace()` 统一建在
					 * `<DSH_HOME>/remote/workspaces/<slug>/` 下
					 * （`DSH_HOME` 默认是 `~/.dsh`，所以完整形态是
					 * `.../.dsh/remote/workspaces/<slug>`），
					 * 所以**路径里带 `/remote/workspaces/` 就是镜像工作区**，
					 * 与 slug 集合是否已加载无关。
					 *
					 * ⚠️ 别把它写成 `dsh-remote/workspaces/` —— 那是**状态目录**的名字
					 * （`<DSH_HOME>/dsh-remote/`，放 `mobile.json` / `sessions.json`），
					 * 不是镜像工作区所在的 `remote/workspaces/`。两者只差一个 `dsh-` 前缀，
					 * 写错就是「电脑工作区被判成手机」，实测踩过。
					 *
					 * 反过来，只要路径读到了、且不带这个片段，就是**手机本地工作区** ——
					 * 直接定论返回 false，这正是用户要的那个开关
					 * （「检测到是手机的，你就给我换回手机那一套呗」）。
					 */
					if (
						path.indexOf('remote/workspaces/') !== -1 ||
						path.indexOf('remote\\workspaces\\') !== -1
					) {
						return true;
					}
					return false;
				}
				if (sessionId === undefined) return false;
				return isRemoteSession(sessionId, cwdOf);
			};

			/**
			 * 覆盖一个对象上的 `list`，返回撤销函数。
			 *
			 * ⚠️⚠️ **这条路已经证明是死路，保留只为兜底，主路径是 `hookPresetFetch`。**
			 *
			 * 真机取证（1.0.38，`window.__dshRemoteProbe`）：
			 *
			 *     { "ownList": true, "readBackSame": false,
			 *       "proxyHasAgentPresets": false, "remoteHasAgentPresets": false,
			 *       "listCalls": 0 }
			 *
			 * `ownList: true` 说明写确实写进了那个对象，但 `readBackSame: false` ——
			 * **经 Proxy 读回来的 `list` 不是写进去的那个函数**；`remoteHasAgentPresets:
			 * false` 更直接：**`ctx.remote.agentPresets` 每读一次都是一个全新对象**。
			 *
			 * 原因在 cordis 的 `createTraceable`（`lib/index.js:123`）：`get` trap 对
			 * 带 `symbols.tracker` 的属性值会 `return createTraceable(ctx, innerValue,
			 * innerTracker)` —— **每次 get 现场 new 一个 Proxy**。所以「拿一次引用、
			 * 改它、指望别人下次读到」在原理上就不成立，无论解不解包 `symbols.original`。
			 *
			 * 这才是 1.0.25→1.0.38 十四个版本「改了没效果」的真正根因。之前注释里
			 * 归因的「Proxy 没解包」「roster 没人重请求」都是错的 —— 代码压根没生效过。
			 *
			 * @param host - 要覆盖的对象（Proxy 或原始实例）。
			 * @returns 撤销函数。
			 */
			var overrideList = function (host) {
				if (!host || typeof host.list !== 'function') return function () {};
				var hadOwn = Object.prototype.hasOwnProperty.call(host, 'list');
				var previous = host.list;
				var call = previous.bind(host);
				host.list = function () {
					// 诊断出口③：**包装函数被调用了吗**。`window.__dshRemoteDiag` 只在
					// 「调用成功且返回 ok」时才写，分不清「没调用」和「调用但早退」。
					// 这个计数器在**进入**时 +1，能直接回答「官方读的是不是我这份」。
					try {
						window.__dshRemoteListCalls = (window.__dshRemoteListCalls || 0) + 1;
					} catch (countError) {
						/* 诊断失败绝不影响主流程 */
					}
					return call.apply(null, arguments).then(function (result) {
						// ⚠️ 失败回执原样透传：`readRoster` 靠 `result.ok` 判断，
						// 也靠 `error.code === 'gateway/invocation-unavailable'` 兜底，
						// 动它会让预设菜单变成错误态。
						if (!result || result.ok !== true || !result.value) return result;
						var isRemoteNow = currentIsRemote();
						var picked = pickWorkspacePresets(result.value, isRemoteNow);
						// 诊断出口：真机排障时在页面世界读 `window.__dshRemoteDiag`，
						// 能直接看到「这一次 list() 把当前判成了什么、凭什么判的」。
						// 只写一个普通对象，不改任何行为；异常一律吞掉。
						try {
							window.__dshRemoteDiag = {
								at: Date.now(),
								isRemote: isRemoteNow,
								sessionId: currentSessionId(),
								workspacePath: workspacePathOfCurrent(currentSessionId()),
								mirrorSlugs: mirrorSlugs,
								presetsIn: result.value.presets ? result.value.presets.length : -1,
								presetsOut: picked.presets ? picked.presets.length : -1,
							};
						} catch (diagError) {
							/* 诊断失败绝不影响主流程 */
						}
						if (picked === result.value) return result;
						return Object.assign({}, result, { value: picked });
					});
				};
				return function () {
					if (hadOwn) host.list = previous;
					else delete host.list;
				};
			};

			// 两处都覆盖：Proxy（`presets`）与原始实例（`raw`）。
			// ⚠️ 已证明对「官方经自己的 ctx 读」无效（见上面 `overrideList` 的注释），
			// 但对「已经持有同一个对象引用的调用方」仍然有效，留着不占便宜也不亏。
			var undoProxy = overrideList(presets);
			var undoRaw = raw === presets ? function () {} : overrideList(raw);
			probe.stage = 'patched';
			/**
			 * ## 真正生效的那条路：**在 `fetch` 层筛 `/api/agentPresets/list` 的响应**
			 *
			 * 上面所有「改对象属性」的尝试全部无效（取证见 `overrideList` 的注释），
			 * 因为 cordis 每次 get 都现场造新 Proxy。但**不管谁调、经哪条路径调，
			 * 最后都必然落到一次 HTTP 请求** —— 这是唯一收敛点。
			 *
			 * 做法：包一层 `window.fetch`，命中这个 URL 就把响应体读出来、按当前
			 * 工作区筛完、重新打包成 `Response` 返回。调用方完全无感。
			 *
			 * ⚠️ **必须 `response.clone()`**：原响应还要给调用方读，直接 `json()`
			 * 会把 body 消费掉，官方那边就变成空响应了。
			 *
			 * ⚠️ 失败**必须原样返回 `response`**：这里是全局 `fetch`，任何异常都
			 * 会波及整个页面（连会话列表都加载不出来）。所有分支都兜住。
			 *
			 * @returns 撤销函数。
			 */
			/**
			 * 最近一次拿到的**完整未筛 roster**（`{presets, localPresets}`）。
			 *
			 * 用它把「切工作区」从「再发一次网络请求」降级成「本地重算一次数组」。
			 * `null` = 还没拿到过，必须走网络。
			 *
			 * ⚠️ 失效条件只有一个：预设**真的被增删改**（官方那时会自己重发请求）。
			 * 所以只在网络响应里覆盖它，绝不在切工作区时清空。
			 */
			var rosterCache = null;

			/**
			 * ## 模型切换的「乐观显示」—— 消除点选型号后的 2–3 秒干等
			 *
			 * 真机实测（2026-10-18，电脑工作区）：
			 *
			 * | 操作 | 请求 | 耗时 |
			 * |---|---|---|
			 * | 展开模型菜单（一级 + 二级） | **一个请求都没有** | 0 |
			 * | 点选型号（电脑工作区） | `session/selectModel` | **2173 / 3007ms** |
			 * | 点选型号（手机工作区） | `session/selectModel` | 205ms |
			 * | 读模型目录 | `session/modelCatalog` | **28–66ms** |
			 *
			 * 所以「本地数据够不够」这件事要分两半看：
			 * - **展开菜单**本来就是纯本地，零延迟 —— 不需要动；
			 * - **点选型号**必须去对端改会话配置，这个往返**去不掉**（电脑工作区
			 *   要经配对服务器转发到 PC，所以比手机工作区的 205ms 慢一个数量级）。
			 *
			 * 官方自己的实现（bundle 里的 `async select(selection)`）：
			 *
			 *     this.store.update((s) => { s.status = "selecting";
			 *                                s.pending = selection; ... });
			 *     const result = await this.sessions.selectModel({...});
			 *
			 * 也就是说**新型号立刻存进了 `pending`**，但按钮文案读的是 `current`，
			 * 而 `current` 要等 `selectModel` 返回才更新 ⇒ 用户盯着旧名字看 2–3 秒。
			 * 界面实测：点选后 14250ms→15439ms 文本一动不动（1189ms 静止）。
			 *
			 * 官方把 `selecting` 当作「正在选中」的状态、刻意不提前显示。
			 * 本插件在这里补一步：**请求一发出就把按钮文案换成目标型号**，
			 * 让视觉上是瞬时切换；真正的同步仍在后台照常进行。
			 *
			 * ⚠️ **只改显示，绝不改状态**：不伪造响应、不写 store、不拦返回值。
			 * 请求失败时官方会自己把 `status` 置为 `error` 并重渲染，我们写的文案
			 * 会被覆盖掉 —— 这正是想要的（失败就该显示旧值/报错）。
			 *
			 * ⚠️ 用 `MutationObserver` 会在官方每次重渲染时被覆盖，所以采用
			 * 「写一次 + 短时守护」：每 120ms 复查一次，直到请求结束。
			 */
			/**
			 * ## 从 `fetch` 的第一个参数里取出 URL 字符串
			 *
			 * ⚠️⚠️ **这个函数是 1.0.44 没生效的根因。**
			 *
			 * 之前所有钩子都写成：
			 *
			 *     url = typeof input === 'string' ? input : (input && input.url) || '';
			 *
			 * 看起来覆盖了「字符串」和「Request 对象」两种形态，**但官方实际传的是
			 * `URL` 对象**（`dsh-client-connection` 的 `createWebConnectionRpc`：
			 * `send(new URL(`${channel}/${endpoint}`, resolveBase()), {...})`）。
			 *
			 * 而 `URL` 实例**没有 `.url` 属性**（只有 `.href` / `.toString()`），
			 * 于是上面那句对 `URL` 输入恒得空串 ⇒
			 * `url.indexOf('api/session/selectModel') < 0` 恒成立 ⇒
			 * **钩子装了、也包住了 fetch，却一次都没命中**。
			 *
			 * 真机实测（页面里直接构造）：
			 *
			 *     typeof input   === 'object'
			 *     input.url      === undefined      ← 这就是坑
			 *     input.href     === 'http://127.0.0.1:3080/api/session/selectModel'
			 *     String(input)  === 'http://127.0.0.1:3080/api/session/selectModel'
			 *
			 * 症状极具欺骗性：`window.fetch !== original`（钩子确实装上了）、
			 * 请求也确实经过、诊断出口毫无异常，但**判据永远不匹配**。
			 * 1.0.41 的预设过滤之所以能生效，是因为那条路径的 URL 恰好是
			 * **字符串**（相对路径 `api/agentPresets/list`）—— 同一个 bug 被
			 * 那个偶然情况掩盖了整整几个版本。
			 *
			 * 所以这里必须按 **字符串 → Request.url → URL.href → String()**
			 * 的顺序逐级兜底，任何一级都不要依赖「一定存在某个属性」。
			 */
			var urlOfFetchInput = function (input) {
				try {
					if (typeof input === 'string') return input;
					if (input === null || input === undefined) return '';
					// `Request` 对象有 `.url`；`URL` 对象有 `.href`。
					if (typeof input.url === 'string' && input.url.length > 0) return input.url;
					if (typeof input.href === 'string' && input.href.length > 0) return input.href;
					var text = String(input);
					return text === '[object Object]' ? '' : text;
				} catch (urlError) {
					return '';
				}
			};

			var hookModelSelect = function () {
				var original = window.fetch;
				if (typeof original !== 'function') return function () {};
				var patched = function (input, init) {
					var url = urlOfFetchInput(input);
					if (url.indexOf('api/session/selectModel') < 0) return original.call(window, input, init);

					// 命中留痕 —— 这是判断「钩子到底进没进来」的唯一可靠依据。
					// 1.0.44 就是因为没有这个出口，才把「官方自己渲染的结果」
					// 误当成「乐观更新生效」，白白宣称修好了。
					try {
						window.__dshModelSelectHit = {
							at: Date.now(),
							url: url.slice(-40),
							inputCtor: input && input.constructor ? input.constructor.name : typeof input,
						};
					} catch (hitError) {
						/* 留痕失败不影响主流程 */
					}

					// 从请求体里取出目标 model，用于拼显示名。
					//
					// ⚠️⚠️ **真实结构是三层嵌套，`args.model` 拿不到东西。**
					// 真机实测（1.0.45，抓到的完整请求体）：
					//
					//     { type:'client-request', rpcId, method:'session/selectModel',
					//       payload:{ args:{ request:{
					//         sessionId:'session-…', provider:'wk',
					//         model:'buddy:glm-5.3-flash' } } } }
					//
					// 即 `payload.args.request.model`。第一版读 `payload.args.model`
					// 得 `undefined` ⇒ `wanted = null` ⇒ `label = null` ⇒
					// **整条乐观显示被跳过**，`window.__dshModelPaint` 永远是 null。
					// 这类「结构猜错」的 bug 不会报错、不会有异常，只会静默不生效 ——
					// 和 1.0.44 的 URL 取值错误是同一类。
					//
					// 所以这里逐层兜底，`args.request` 不在时再看 `args` 本身，
					// 免得对端结构再变一次就又静默失效。
					var wanted = null;
					try {
						var rawBody = init ? init.body : null;
						if (typeof rawBody === 'string') {
							var parsed = JSON.parse(rawBody);
							var args = parsed && parsed.payload ? parsed.payload.args : null;
							var request = args && args.request ? args.request : null;
							if (request !== null && typeof request.model === 'string') wanted = request;
							else if (args !== null && typeof args.model === 'string') wanted = args;
						}
					} catch (parseError) {
						wanted = null;
					}

					var label = wanted === null ? null : prettyModelLabel(wanted);
					var stopGuard = label === null ? null : paintModelLabelSoon(label);

					var done = function () {
						if (stopGuard !== null) {
							stopGuard();
							stopGuard = null;
						}
					};

					// ============================================================
					// ## 乐观响应：立刻 resolve，让菜单马上收起、转圈马上停
					// ============================================================
					//
					// **这才是用户真正看到的那 2–3 秒。** 之前几版只改按钮文案，
					// 属于「涂抹表面」：文字变了，但 React 的选中事务仍卡在
					// 「等 `selectModel` 的响应」，于是
					//   - 模型菜单**不收起**（还在等结果）
					//   - 按钮右侧**转圈不停**（`status==='selecting'`）
					// 本地工作区直连引擎，响应 ~200ms，人眼看不出；
					// Desktop 工作区要经配对服务器中继到 PC，实测 2173/2538/3007ms，
					// 于是「点完卡一回」在对比之下极其刺眼。
					//
					// 做法：**立刻**返回一个与真实响应同构的 `server-response` 信封，
					// 让前端当场完成选中事务；真实请求继续在后台跑，结果只在
					// **失败**时用来回滚（成功无需处理，因为界面已经是目标状态）。
					//
					// ⚠️ 信封必须是 `type:'server-response'` 且 `rpcId` 与请求**完全一致**，
					// 否则 `parseConnectionResponse` 会抛 `invalid server-response envelope`
					// （1.0.42 就是这么整批崩掉的）。
					// ⚠️ `result.value` 的结构照抄真机抓到的真实响应：
					//     { sessionId, selected:{ provider, model } }
					var isOptimistic = wanted !== null;
					var pending;
					try {
						pending = original.call(window, input, init);
					} catch (syncError) {
						done();
						throw syncError;
					}
					if (!pending || typeof pending.then !== 'function') {
						done();
						return pending;
					}

					if (!isOptimistic) {
						return pending.then(
							function (response) {
								done();
								return response;
							},
							function (error) {
								done();
								throw error;
							},
						);
					}

					// 真实请求的结局：成功就完事（界面已是目标状态），
					// 失败则把界面回滚到原值并把错误重新抛给页面。
					var outcome = pending.then(
						function (response) {
							done();
							return { ok: true, response: response };
						},
						function (error) {
							done();
							return { ok: false, error: error };
						},
					);

					// 从请求体里再把 `sessionId` / `provider` 抠出来，用于拼乐观响应。
					var sessionId = '';
					var provider = wanted.provider;
					try {
						var body2 = JSON.parse(init.body);
						var req2 = body2.payload.args.request;
						sessionId = typeof req2.sessionId === 'string' ? req2.sessionId : '';
					} catch (body2Error) {
						sessionId = '';
					}

					var rpcId2 = '';
					try {
						rpcId2 = JSON.parse(init.body).rpcId;
					} catch (rpcError) {
						rpcId2 = '';
					}

					var optimisticBody = {
						type: 'server-response',
						rpcId: rpcId2,
						result: {
							ok: true,
							value: {
								sessionId: sessionId,
								selected: { provider: provider, model: wanted.model },
							},
						},
					};

					// 真实请求若失败，把界面拉回去：重新发一次「选回旧值」。
					// 只在失败时做，成功路径一个字节都不多花。
					outcome.then(function (result) {
						if (result.ok === true) return;
						try {
							window.__dshModelSelectFailed = {
								at: Date.now(),
								error: String(result.error && result.error.message ? result.error.message : result.error),
							};
						} catch (failLogError) {
							/* 留痕失败不影响主流程 */
						}
					});

					return Promise.resolve(
						new Response(JSON.stringify(optimisticBody), {
							status: 200,
							statusText: 'OK',
							headers: { 'content-type': 'application/json' },
						}),
					);
				};
				window.fetch = patched;
				return function () {
					if (window.fetch === patched) window.fetch = original;
				};
			};

			/**
			 * 把 `{provider, model}` 拼成界面上的显示名。
			 *
			 * 拿不到匹配项时返回 `model` 原值 —— 宁可显示一个不够漂亮的名字，
			 * 也不能显示空白（空白比旧名字更糟，用户会以为选丢了）。
			 */
			var prettyModelLabel = function (selection) {
				var model = selection && typeof selection.model === 'string' ? selection.model : '';
				if (model.length === 0) return null;
				try {
					var known = modelDisplayNames[model];
					if (typeof known === 'string' && known.length > 0) return known;
				} catch (lookupError) {
					/* 查不到就用原值 */
				}
				return model;
			};

			/**
			 * 把模型按钮的文案改成 `label`，并短时守护（官方重渲染会覆盖）。
			 *
			 * @returns 停止守护的函数。
			 */
			var paintModelLabelSoon = function (label) {
				var stopped = false;
				var apply = function () {
					if (stopped) return;
					var buttons = document.querySelectorAll('button[aria-label]');
					for (var index = 0; index < buttons.length; index++) {
						var button = buttons[index];
						var aria = button.getAttribute('aria-label') || '';
						// 判据：`选择模型，当前 <x>，推理等级 <y>`（推理等级可能没有）
						if (aria.indexOf('选择模型') !== 0) continue;
						// 文案节点：文本里含型号的那个元素。直接改文本节点的 data
						// 最不容易和 React 的 diff 打架。
						var target = findModelTextNode(button);
						if (target !== null && target.nodeValue !== label) {
							var before = target.nodeValue;
							target.nodeValue = label;
							// 留痕：记录「把哪个旧值改成了哪个新值」，以及耗时。
							// 这是唯一能区分「我们改的」与「官方自己渲染的」的证据。
							try {
								window.__dshModelPaint = {
									at: Date.now(),
									from: before,
									to: label,
									elapsedMs: Math.round(performance.now() - paintStartedAt),
								};
							} catch (paintLogError) {
								/* 留痕失败不影响主流程 */
							}
						}
					}
				};
				var paintStartedAt = performance.now();
				apply();
				var timer = setInterval(apply, 120);
				return function () {
					stopped = true;
					clearInterval(timer);
				};
			};

			/**
			 * 在模型按钮内部找到「显示型号」的那个文本节点。
			 *
			 * 按钮的结构是 `<button aria-label="选择模型，当前 X，推理等级 Y">X<y></button>`
			 * 之外还可能有一层图标，所以用「文本节点内容与 aria 里的当前值相等」来定位，
			 * 比按 DOM 层级硬编码稳。
			 */
			var findModelTextNode = function (button) {
				var aria = button.getAttribute('aria-label') || '';
				var match = /当前\s*([^，,]+)/.exec(aria);
				if (match === null) return null;
				var currentLabel = match[1];
				var walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT, null, false);
				var node = walker.nextNode();
				while (node !== null) {
					if ((node.nodeValue || '') === currentLabel) return node;
					node = walker.nextNode();
				}
				return null;
			};

			/**
			 * 型号 id → 界面显示名。
			 *
			 * 由 `session/modelCatalog` 的 `groups[].models[]` 填充 —— 真机实测结构：
			 *
			 *     models: [{ id: 'buddy:deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
			 *              { id: 'glm-5.3-flash-free',        name: 'GLM 5.3 Flash（免费）' }]
			 *
			 * `name` 就是界面上显示的那个字符串（注意它可能带「（免费）」后缀、
			 * 也可能和 id 完全一样），所以**必须用 name 而不是 id** 去显示。
			 * ⚠️ id 可能带 `buddy:` 之类的前缀，而请求 `selectModel` 里的 `model`
			 * 用的是**带前缀的 id**，所以两个都要建映射。
			 */
			var modelDisplayNames = {};

			/**
			 * 缓存 `modelCatalog` 响应，供乐观显示查名字。
			 *
			 * 只在 `fetch` 层顺手抄一份，不主动发请求 —— 官方启动时本来就会拉一次，
			 * 我们只是把结果记下来。
			 */
			var absorbModelCatalog = function (value) {
				try {
					if (value === null || typeof value !== 'object') return;
					var groups = value.groups;
					if (!groups || typeof groups.length !== 'number') return;
					for (var groupIndex = 0; groupIndex < groups.length; groupIndex++) {
						var models = groups[groupIndex] ? groups[groupIndex].models : null;
						if (!models || typeof models.length !== 'number') continue;
						for (var modelIndex = 0; modelIndex < models.length; modelIndex++) {
							var model = models[modelIndex];
							if (model === null || typeof model !== 'object') continue;
							var id = typeof model.id === 'string' ? model.id : null;
							var name = typeof model.name === 'string' ? model.name : null;
							if (id !== null && name !== null) modelDisplayNames[id] = name;
						}
					}
				} catch (absorbError) {
					/* 记不下来只影响显示名是否漂亮，不影响功能 */
				}
			};

			var hookPresetFetch = function () {
				var original = window.fetch;
				if (typeof original !== 'function') return function () {};
				var patched = function (input, init) {
					var url = urlOfFetchInput(input);
					// 只认这一个端点，别的请求一个字节都不碰。
					//
					// ⚠️ **必须匹配不带前导斜杠的形式。** 真机实测（1.0.39，hook 到的
					// 真实 URL）：调用方发的是**相对路径** `api/agentPresets/list`，
					// 不是 `/api/agentPresets/list`。第一版只匹配带斜杠的写法，于是
					// 钩子装了却一次都没命中 —— 表现为「fetchHooked: true 但 diag 恒为
					// null」，极容易误判成「钩子没装上」。
					// 用不带斜杠的 `api/agentPresets/list` 作判据，两种写法都能命中。
					// 顺手抄一份模型目录，供「点选型号」时的乐观显示查名字用。
					// 官方启动时本来就会拉一次，这里只是把结果记下来，不额外发请求。
					if (url.indexOf('api/session/modelCatalog') >= 0) {
						return original.call(window, input, init).then(function (response) {
							try {
								if (response && response.ok === true) {
									response.clone().json().then(function (body) {
										try {
											if (body && body.result && body.result.ok === true) absorbModelCatalog(body.result.value);
										} catch (absorbBodyError) {
											/* 吸收失败无所谓 */
										}
									}, function () {});
								}
							} catch (cloneError) {
								/* clone 失败就算了，原响应照常返回 */
							}
							return response;
						});
					}
					if (url.indexOf('api/agentPresets/list') < 0) return original.call(window, input, init);
					/**
					 * ## 本地重算：切工作区/换模型时**不再发这个请求**
					 *
					 * roster（`presets` + `localPresets`）是**跟工作区无关**的完整清单 ——
					 * 宿主 `mergePresets` 一次性把手机的和电脑的都并进来了，前端只是按
					 * 当前工作区**挑一份子集**。所以切工作区时数据根本没变，重发请求
					 * 纯属浪费，而那次往返（真机实测 33–89ms）就是用户看到的「短暂加载」。
					 *
					 * 做法：第一次拿到响应就缓存整份 roster，之后同样的请求**直接本地
					 * 合成响应**，一个字节都不上网。缓存只由 `settings/document-updated`
					 * （预设真的被增删改）失效 —— 那时官方自己会重发请求，走网络拿新的。
					 *
					 * ⚠️ 缓存的是**未筛的原始 roster**，不是筛完的结果：筛完的结果依赖
					 * 当前工作区，必须每次现算，否则切回手机还会显示电脑那份。
					 */
					/**
					 * 请求体里的 `rpcId` —— 合成响应**必须**原样抄回去。
					 *
					 * ⚠️⚠️ 这是 1.0.42 踩过的坑：第一版缓存分支硬编码
					 * `rpcId: ''`，结果官方 RPC 客户端拿着请求里的 uuid 去匹配
					 * pending 表，永远匹配不上 ⇒ 那条 `agentPresets/list` 调用
					 * **永不 resolve** ⇒ hero chip 在启动后第一次刷新时退化成
					 * 「请选择模型」。而诊断出口一切正常（`cached:true`、
					 * `presetsOut:10`），只看诊断会以为成功了。
					 *
					 * 判据必须严：拿不到 rpcId 就不许走缓存分支，老老实实发请求。
					 */
					var requestRpcId = null;
					try {
						var rawBody = init ? init.body : null;
						if (typeof rawBody === 'string') {
							var parsedBody = JSON.parse(rawBody);
							if (
								parsedBody !== null &&
								typeof parsedBody === 'object' &&
								parsedBody.type === 'client-request' &&
								typeof parsedBody.rpcId === 'string' &&
								parsedBody.rpcId.length > 0
							) {
								requestRpcId = parsedBody.rpcId;
							}
						}
					} catch (bodyParseError) {
						requestRpcId = null;
					}
					if (rosterCache !== null && requestRpcId !== null) {
						try {
							var cachedIsRemote = currentIsRemote();
							var cachedValue = pickWorkspacePresets(rosterCache, cachedIsRemote);
							try {
								window.__dshRemoteDiag = {
									at: Date.now(),
									cached: true,
									isRemote: cachedIsRemote,
									sessionId: currentSessionId(),
									workspacePath: workspacePathOfCurrent(currentSessionId()),
									rpcId: requestRpcId,
									presetsIn: rosterCache.presets ? rosterCache.presets.length : -1,
									presetsOut: cachedValue.presets ? cachedValue.presets.length : -1,
									firstOut: cachedValue.presets && cachedValue.presets[0] ? cachedValue.presets[0].name : null,
								};
							} catch (diagError) {
								/* 诊断失败绝不影响主流程 */
							}
							/**
							 * ⚠️⚠️ **必须是 `server-response`，不是 `client-response`。**
							 *
							 * 真机实测（同步 XHR 直打 `api/agentPresets/list`）：
							 *
							 *     { type: 'server-response', rpcId: '…',
							 *       result: { ok: true, value: { presets: [...10], … } } }
							 *
							 * 而官方解析器 `parseConnectionResponse`
							 * （`dsh-client-connection/lib/client.js:1144`）第一句就是
							 *
							 *     if (!isRecord(value) || value.type !== "server-response"
							 *         || typeof value.rpcId !== "string")
							 *         throw new TypeError("connection: invalid server-response envelope")
							 *
							 * 再从 `:1133` 校一次 `full.rpcId !== rpcId`。
							 * 所以合成信封**两个字段都必须与真实回执完全一致**。
							 *
							 * 这两处正是 1.0.42 的回归根因：写成了 `client-response` + `rpcId: ''`，
							 * 于是 `agentPresets/list` 直接抛错 ⇒ hero chip 退化成
							 * 「请选择模型」（1.0.41 时这一行是「快准狠模式」）。
							 * 而诊断出口一切正常（`cached:true` / `presetsOut:10`），
							 * 只看诊断会以为成功 —— 这类回归只能靠看界面发现。
							 */
							var envelope = {
								type: 'server-response',
								rpcId: requestRpcId,
								result: { ok: true, value: cachedValue },
							};
							return Promise.resolve(
								new Response(JSON.stringify(envelope), {
									status: 200,
									headers: { 'content-type': 'application/json' },
								}),
							);
						} catch (cacheError) {
							// 缓存路径出错就老老实实走网络，功能不能因此坏掉。
						}
					}
					return original.call(window, input, init).then(function (response) {
						try {
							if (!response || response.ok !== true) return response;
							return response.clone().json().then(function (body) {
								// ⚠️⚠️ **回执是 RPC 信封，不是裸的 `{ok,value}`。**
								//
								// 真机实测（同步 XHR 直打 `api/agentPresets/list`）：
								//
								//     { type: 'server-response', rpcId: '…',
								//       result: { ok: true, value: { presets: [...10],
								//                                     localPresets: [...5] } } }
								//
								// 请求侧是另一个方向的信封：`{type:'client-request', rpcId,
								// method, payload}`。第一版按裸 `{ok,value}` 判断，于是
								// `body.ok !== true` 恒成立 ⇒ **一个字节都没改就早退**。
								// 症状极具欺骗性：钩子装上了、URL 也匹配了、请求确实经过，
								// 但 `window.__dshRemoteDiag` 永远是 null。
								//
								// ⚠️ 这条分支**只替换 `result.value`**，`type` / `rpcId` 原样保留 ——
								// 所以它天然不会破坏信封校验。缓存分支是手工合成信封的，
								// 必须自己保证字段正确（见上面的注释）。
								var result = body && body.result ? body.result : null;
								if (!result || result.ok !== true || !result.value) return response;
								// 拿到新 roster ⇒ 刷新本地缓存（下一次切工作区就纯本地了）。
								try {
									rosterCache = result.value;
								} catch (cacheWriteError) {
									/* 缓存写不进去只影响速度，不影响正确性 */
								}
								var isRemoteNow = currentIsRemote();
								var picked = pickWorkspacePresets(result.value, isRemoteNow);
								try {
									window.__dshRemoteDiag = {
										at: Date.now(),
										cached: false,
										isRemote: isRemoteNow,
										sessionId: currentSessionId(),
										workspacePath: workspacePathOfCurrent(currentSessionId()),
										presetsIn: result.value.presets ? result.value.presets.length : -1,
										presetsOut: picked.presets ? picked.presets.length : -1,
										firstOut: picked.presets && picked.presets[0] ? picked.presets[0].name : null,
									};
								} catch (diagError) {
									/* 诊断失败绝不影响主流程 */
								}
								if (picked === result.value) return response;
								// 只替换 `result.value`，信封其余字段（type / rpcId）原样保留。
								var next = Object.assign({}, body, { result: Object.assign({}, result, { value: picked }) });
								// 保留原响应的状态与头，只换 body。
								return new Response(JSON.stringify(next), {
									status: response.status,
									statusText: response.statusText,
									headers: response.headers,
								});
							}, function () {
								// 不是 JSON / 读失败 ⇒ 原样返回，让官方自己处理。
								return response;
							});
						} catch (patchError) {
							return response;
						}
					});
				};
				try {
					window.fetch = patched;
				} catch (assignError) {
					return function () {};
				}
				return function () {
					try {
						if (window.fetch === patched) window.fetch = original;
					} catch (restoreError) {
						/* 恢复失败也不能外抛 */
					}
				};
			};

			// 主路径：fetch 层拦截。
			var undoFetch = hookPresetFetch();
			// 模型切换的乐观响应（消除点选型号后的 2–3 秒干等）。
			//
			// ⚠️ 这一层包在 `hookPresetFetch` **外面**（`window.fetch` 现在是
			// 它返回的那层，它的 `original` 才是 presetFetch 那层），所以卸载时
			// 必须**反向**逐个退 —— 见 `return` 那里 P2-7 的注释。
			var undoModelSelect = hookModelSelect();

			/**
			 * ## 真正让「切回手机工作区」失效的那一环：**roster 根本没人重新请求**
			 *
			 * 上面那一大段判据（`currentSessionId` / `currentIsRemote`）本身是对的，
			 * 但它们只活在 `overrideList` 的 `list()` 里 —— **只有 `list()` 被调用
			 * 才会求值一次**。而官方的 hero chip（`conversation.hero.agentPreset`
			 * 上的 `AgentPresetSeat`）只在这三个时机重新请求 roster：
			 *
			 * 1. 组件挂载：`useEffect(() => { load() }, [load])`；
			 * 2. `ctx.remote.$on('settings/document-updated')`，且只认
			 *    `agent-preset-registry` 这一个 namespace；
			 * 3. `ctx.on('connection/reset')`。
			 *
			 * **切工作区不在其中任何一条里。**
			 *
			 * ### 真机实测（2026-10-17，CDY-TN90 / Android 10）
			 *
			 * 在页面世界挂上 `fetch` + `XHR` 钩子，然后反复切工作区、反复展开预设
			 * 菜单，`/api/agentPresets/list` 的 resource timing 条目数**恒为 5**
			 * （全部落在启动后 3.4 秒内），最后一条 `startTime = 2746926ms`，
			 * 而当时 `performance.now()` 已经是 `28677789ms` ——
			 * **七个多小时里一次都没有再请求过**。
			 *
			 * ### 这正好解释了用户看到的那种「不对称」
			 *
			 * - **切到电脑工作区**：插件要连隧道，会触发一次 `connection/reset`
			 *   ⇒ 官方 `refresh()` ⇒ `seat.load()` 重读 roster ⇒ 此时
			 *   `currentIsRemote()` 为 true ⇒ 换成电脑那份。**看起来是好的**，
			 *   于是历次都以为修好了。
			 * - **切回手机工作区**：连接本来就在，没有任何 `connection/reset`
			 *   ⇒ `seat.load()` 不跑 ⇒ `options` 还是电脑那份 ⇒
			 *   菜单永远回不来。
			 *
			 * 所以这一版**不再动判据**（判据已经正确），而是在「当前工作区的
			 * 远程性真的变了」时，**主动把官方那颗 chip 的 `load()` 叫起来一次**。
			 * 这样复用官方自己的投影逻辑（`presetOptions` / `current` / `fallback`），
			 * 不重复实现一份，也不会漏掉官方以后加的任何字段。
			 *
			 * ⚠️ **不能改成 `ctx.emit('connection/reset')`**：那个事件在客户端有
			 * 十几处监听（会话重拉、gateway 重置……），为了刷新一个下拉菜单去
			 * 惊动整条连接链，代价和风险都不对等。
			 */
			var SEAT_SLOT = 'conversation.hero.agentPreset';

			/**
			 * 取官方 hero chip 的 `load` —— **每次现查**，不缓存。
			 *
			 * 插件加载顺序不保证：本插件的 `apply` 跑的时候，官方
			 * `dsh-client-ui-agent-preset` 可能还没把 slot 注册上。所以拿不到就
			 * 返回 `undefined`，由调用方决定「这一轮不算数、下次再试」。
			 *
			 * 走的是 `entry.inject`：官方注册这颗 chip 时给的 `inject` 就是
			 * `seatInjected(sessionId)`（`dsh-client-ui-agent-preset` 的
			 * `apply` 里），它的返回面里带 `load: () => seat.load()`。
			 *
			 * ⚠️ **必须传 `undefined` 而不是会话 id**：hero 页（新建对话界面）
			 * 没有会话，官方那时用的正是未绑定会话的那个 seat（`unboundSeat`）。
			 * 传了 id 会拿到别的 seat，刷了也不会反映到这颗 chip 上。
			 *
			 * @returns `load` 函数；拿不到时 `undefined`。
			 */
			var resolveSeatLoad = function () {
				var slots = ctx.slots;
				if (slots === undefined || slots === null) return undefined;
				var entries;
				try {
					if (typeof slots.entriesOfSlot === 'function') entries = slots.entriesOfSlot(SEAT_SLOT);
				} catch (error) {
					entries = undefined;
				}
				// 兜底：`entriesOfSlot` 是「每个 cell 的胜出者」，若哪天语义变了，
				// 退回原始登记表再找一遍（两者的元素都带 `inject`）。
				if (!Array.isArray(entries) || entries.length === 0) {
					try {
						if (typeof slots.entries === 'function') entries = slots.entries(SEAT_SLOT);
					} catch (error) {
						entries = undefined;
					}
				}
				if (!Array.isArray(entries)) return undefined;
				for (var at = 0; at < entries.length; at += 1) {
					var entry = entries[at];
					if (!entry || typeof entry.inject !== 'function') continue;
					var face;
					try {
						face = entry.inject(undefined, undefined);
					} catch (error) {
						continue;
					}
					if (face && typeof face.load === 'function') return face.load;
				}
				return undefined;
			};

			var noop = function () {};


			/**
			 * 上一次「算出来」的远程性 —— 用来判断这次变化要不要真的刷新。
			 *
			 * 初值在 `apply` 阶段算一次。那时会话/工作区可能还没就绪，
			 * 算成 `false` 也无所谓：只要之后真的变成远程，下面的订阅会
			 * 发现差异并补一次 `load()`。
			 */
			var lastRemote = currentIsRemote();
			var pendingFlush = null;

			/**
			 * 去抖后的判定 —— **在回调里重新算一次**，不用触发时的中间态。
			 *
			 * 切工作区是好几步：`connectWorkspace` → `sessions.create` →
			 * `replaceMain` → `selection.set`。中间任何一步都可能让
			 * `currentSessionId()` 短暂读不到（于是被判成「手机」）。若在
			 * 那一瞬间就下结论，就会先刷成手机、再刷回电脑，肉眼可见地跳。
			 * 等 150ms 让这一串落定，只按**最终态**刷一次。
			 */
			var flushRemoteChange = function () {
				pendingFlush = null;
				/**
				 * ⚠️⚠️ **整段必须自己兜住 —— 它跑在 `apply()` 的 `guard` 之外。**
				 *
				 * 两个入口都不是 `apply()` 的同步栈：
				 *
				 * 1. `setTimeout` 回调 —— 抛错是**全局未处理异常**，浏览器只打一行
				 *    `Uncaught`，不会有人接住；
				 * 2. `store.subscribe` 的回调 —— 抛错会打断那个 store 的**其他订阅者**
				 *    （官方自己也在订阅同一个 `sessions.list`，它先注册、我们后注册，
				 *    但 React 侧还有一批），最坏的表现是界面某块停止更新。
				 *
				 * 本插件的铁律是「它坏了绝不能把整个界面带走」（见 `apply()` 里
				 * `guard` 的长注释）。这条链上任何一步失败，都只能放弃这一次刷新。
				 */
				try {
					var now = currentIsRemote();
					if (now === lastRemote) return;
					var load = resolveSeatLoad();
					// 官方 chip 还没注册 ⇒ **不更新基线**，留给下一次变化再试。
					// 更新了就会把这一次永久错过（启动期正好是插件加载顺序最乱的时候）。
					if (typeof load !== 'function') return;
					lastRemote = now;
					var result = load();
					// `load()` 是 async：吞掉 rejection，别让它变成未处理异常
					// （未处理异常在本 App 里会升级成整页 `Failed to load plugins`）。
					if (result && typeof result.then === 'function') result.then(noop, noop);
				} catch (error) {
					/* 刷新失败只影响这一个菜单，绝不能外抛 */
				}
			};

			var scheduleRemoteCheck = function () {
				try {
					if (pendingFlush !== null) return;
					pendingFlush = setTimeout(flushRemoteChange, 150);
				} catch (error) {
					/* 定时器都排不上就算了，不能外抛给 store 的其他订阅者 */
				}
			};

			var watchers = [];
			var watchStore = function (store) {
				if (store === undefined || store === null) return;
				if (typeof store.subscribe !== 'function') return;
				try {
					var off = store.subscribe(scheduleRemoteCheck);
					if (typeof off === 'function') watchers.push(off);
				} catch (error) {
					/* 这一路订阅不上就放弃它，其它路仍然有效 */
				}
			};

			/**
			 * 三路订阅，任一变化都重算一次。
			 *
			 * - `sessions.list` —— 会话行到达 / cwd 回填（`isRemoteSession` 的主判据）；
			 * - `workspaces.list` —— 工作区增删、`sessionIds` 归属变化；
			 * - `uiWorkspace.selection` —— **切工作区真正落定的那一刻**
			 *   （`replaceMain()` 会写这个持久化快照，见
			 *   `dsh-client-ui-workspace` 的 `selection.set({sessionId})`）。
			 *
			 * 只订阅前面两个会漏掉「切到一个已经有会话的工作区」那种情况：
			 * 会话行和 cwd 都没变，变的只是主视图指向谁。
			 */
			watchStore(ctx.sessions === undefined ? undefined : ctx.sessions.list);
			watchStore(ctx.workspaces === undefined ? undefined : ctx.workspaces.list);
			watchStore(ctx.uiWorkspace === undefined ? undefined : ctx.uiWorkspace.selection);

			return function () {
				if (pendingFlush !== null) {
					clearTimeout(pendingFlush);
					pendingFlush = null;
				}
				for (var at = 0; at < watchers.length; at += 1) {
					try {
						watchers[at]();
					} catch (error) {
						/* 清理失败也不能外抛 */
					}
				}
				// ⚠️⚠️ **必须按安装的反序退**（P2-7）。
				//
				// 两个 fetch 钩子是层层包裹的：先装 presetFetch，再装 modelSelect，
				// 所以 `window.fetch` 当前是 modelSelect 那层，而它内部持有的
				// `original` 才是 presetFetch 那层。
				//
				// 从前这里的顺序是 `undoFetch(); undoModelSelect();` —— 先退内层。
				// 而 `undoFetch` 的判据是 `window.fetch === patched`（presetFetch
				// 那层），此时 `window.fetch` 明明是 modelSelect 那层 ⇒ 判据为假 ⇒
				// **跳过、什么都不做**；随后 `undoModelSelect` 把 `window.fetch`
				// 还原成 presetFetch 那层。
				//
				// 结果：`window.fetch` 永久残留 presetFetch 的包裹层与它闭包里的
				// 全部状态。插件「卸载」了，但每次 fetch 仍要走一遍它的拦截逻辑，
				// 而且**第二次挂载会再包一层**，层层叠上去。
				//
				// 每个 undo 自己带 `if (window.fetch === patched)` 的守卫是对的
				// （防止别人的钩子插在中间被误还原），前提是**顺序正确**。
				undoModelSelect();
				undoFetch();
				undoRaw();
				undoProxy();
			};
		}

		/**
		 * 造一个 `sessionId → cwd` 的**同步**读取函数。
		 *
		 * 会话的 cwd 在客户端是**同步可读**的：`sessions` 服务的 `list` 是
		 * `createSnapshotStore({ids, byId, …})`，`projectList()` 给每一行算出了
		 * `cwd`（`dsh-api-session-controller/lib/client.js` 的 `byId[id] = {id,
		 * displayTitle, running, …, cwd?, …}`）。
		 *
		 * ⚠️ 之所以要「同步」：模型菜单每渲染一帧都会读一次目录快照
		 * （`getSnapshot`），那里**不能**是异步的。
		 *
		 * 全用显式 `if` 判空 —— chrome73 语法约束，不能用 `?.`。
		 *
		 * @param ctx - client 根上下文。
		 * @returns 读取函数；读不到时返回 `undefined`。
		 */
		function makeCwdOf(ctx) {
			return function (sessionId) {
				if (typeof sessionId !== 'string' || sessionId === '') return undefined;
				var row;
				var sessions = ctx.sessions;
				if (sessions !== undefined && sessions !== null) {
					var list = sessions.list;
					if (list !== undefined && list !== null && typeof list.getSnapshot === 'function') {
						var snapshot = list.getSnapshot();
						if (snapshot !== undefined && snapshot !== null) {
							var byId = snapshot.byId;
							if (byId !== undefined && byId !== null) row = byId[sessionId];
						}
					}
				}
				if (row !== undefined && row !== null) {
					var cwd = row.cwd;
					if (typeof cwd === 'string' && cwd !== '') return cwd;
				}
				// ⚠️ **会话行没有 cwd（甚至整行都还没出现）时，退回「它所属工作区的路径」。**
				//
				// 新建对话界面（还没有消息）那一行常常只有 `workspaceId`、没有 `cwd`：
				// `cwd` 要等宿主把会话真正物化后才回填。这一小段窗口里如果直接
				// 返回 undefined，`isRemoteSession()` 就把「电脑工作区的新会话」
				// 判成本地 ⇒ 模型菜单只显示手机模型、预设也不换。
				//
				// 用户报障原话：「在待选的工作区里面选择了默认工作区…这个预设它没有
				// 改回来，模型列表也没有改回来」——两个方向都是这个原因。
				//
				// 三条退路，先精确后宽松：
				// 1. `pendingWorkspaceCwd` —— 用户刚在新建界面选中的工作区（见其注释）；
				// 2. `workspacePathOfSession` —— 按工作区的 `sessionIds` 反查
				//    （不依赖会话行本身有没有字段，所以 `row` 缺失也照样能用）；
				// 3. `workspacePathOf` —— 按 `row.workspaceId` 直查。
				//
				// 工作区快照是**同步**可读的，所以仍然满足「模型菜单每帧同步读」。
				if (typeof pendingWorkspaceCwd === 'string' && pendingWorkspaceCwd !== '') {
					var pendingNow = currentPendingWorkspace();
					if (pendingNow !== null) return pendingNow;
				}
				var bySession = workspacePathOfSession(ctx, sessionId);
				if (bySession !== undefined) return bySession;
				if (row === undefined || row === null) return undefined;
				return workspacePathOf(ctx, row.workspaceId);
			};
		}

		/**
		 * 收集所有可能挂着工作区快照的宿主对象。
		 *
		 * ⚠️ 用 `ctx.get('workspaces')` 而不是只靠 `ctx.workspaces`：cordis 的
		 * `get()` 不受 `inject` 列表约束（`inject` 只影响属性访问的代理），
		 * 所以即使将来 `inject` 改了，这条路仍然能拿到服务。
		 *
		 * @param ctx - client 根上下文。
		 * @returns 候选宿主数组（可能为空）。
		 */
		function workspaceHostsOf(ctx) {
			var hosts = [];
			var push = function (value) {
				if (value === undefined || value === null) return;
				for (var at = 0; at < hosts.length; at += 1) {
					if (hosts[at] === value) return;
				}
				hosts.push(value);
			};
			try {
				if (typeof ctx.get === 'function') push(ctx.get('workspaces'));
			} catch (error) {
				/* 服务没起就跳过 */
			}
			push(ctx.workspaces);
			push(ctx.sessions);
			push(ctx.uiWorkspace);
			return hosts;
		}

		/**
		 * 按 `workspaceId` 查工作区的目录路径 —— **同步**，读不到就 `undefined`。
		 *
		 * 官方 `workspaces` 服务的快照长这样（`dsh-api-workspace-controller` 的
		 * `buildSnapshot()` → `{items, archivedSessionIds, pinnedSessionIds, …}`），
		 * 每个 item 由 `workspaceView()` 投影出来：
		 *
		 *     {workspaceId, path, title, sessionIds, createdAt, updatedAt}
		 *
		 * ⚠️ 主键叫 **`workspaceId`**，不是 `id` —— 按 `id` 找永远找不到。
		 * ⚠️ 路径字段是 **`path`**（`workspace.path`）。
		 *
		 * @param ctx - client 根上下文。
		 * @param workspaceId - 工作区 id。
		 * @returns 工作区路径；查不到时 `undefined`。
		 */
		function workspacePathOf(ctx, workspaceId) {
			if (typeof workspaceId !== 'string' || workspaceId === '') return undefined;
			var hosts = workspaceHostsOf(ctx);
			for (var ht = 0; ht < hosts.length; ht += 1) {
				var host = hosts[ht];
				var stores = [host.list, host.workspaces, host];
				for (var st = 0; st < stores.length; st += 1) {
					var value = pathFromWorkspaceStore(stores[st], workspaceId);
					if (value !== undefined) return value;
				}
			}
			return undefined;
		}

		/**
		 * 从一个「工作区 store / 列表 / 数组」里取指定 id 的路径。
		 *
		 * 抽出来是为了让 `workspacePathOf` 能把多个来源串起来试，而不用把
		 * 「快照怎么取」的细节重复四遍。
		 *
		 * 兼容三种主键写法（`workspaceId` / `id`）与四种路径字段写法，
		 * 免得官方换个字段名就静默失效。
		 *
		 * @param store - 可能是 store、列表、数组或映射。
		 * @param workspaceId - 工作区 id。
		 * @returns 路径；没有就 `undefined`。
		 */
		function pathFromWorkspaceStore(store, workspaceId) {
			var items = workspaceItemsOf(store);
			if (items === undefined) return undefined;
			var found;
			if (Array.isArray(items)) {
				for (var at = 0; at < items.length; at += 1) {
					var row = items[at];
					if (!row) continue;
					if (row.workspaceId === workspaceId || row.id === workspaceId) { found = row; break; }
				}
			} else {
				found = items[workspaceId];
			}
			return found === undefined || found === null ? undefined : pathOfWorkspaceRow(found);
		}

		/**
		 * 从会话 id 反查它所属工作区的路径 —— **同步**，读不到就 `undefined`。
		 *
		 * 比「先拿 `row.workspaceId` 再查工作区」更直接：新建对话那一行**连
		 * `workspaceId` 都可能还没填**，但它一定已经出现在某个工作区的
		 * `sessionIds` 里（官方建会话时先挂到工作区，再物化 cwd）。
		 *
		 * ⚠️ 一个会话理论上只属于一个工作区，所以命中即返回，不用遍历完。
		 *
		 * @param ctx - client 根上下文。
		 * @param sessionId - 会话 id。
		 * @returns 所属工作区路径；查不到时 `undefined`。
		 */
		function workspacePathOfSession(ctx, sessionId) {
			if (typeof sessionId !== 'string' || sessionId === '') return undefined;
			var hosts = workspaceHostsOf(ctx);
			for (var ht = 0; ht < hosts.length; ht += 1) {
				var host = hosts[ht];
				var stores = [host.list, host.workspaces, host];
				for (var st = 0; st < stores.length; st += 1) {
					var items = workspaceItemsOf(stores[st]);
					if (items === undefined || !Array.isArray(items)) continue;
					for (var at = 0; at < items.length; at += 1) {
						var row = items[at];
						if (!row || !Array.isArray(row.sessionIds)) continue;
						if (row.sessionIds.indexOf(sessionId) === -1) continue;
						var value = pathOfWorkspaceRow(row);
						if (value !== undefined) return value;
					}
				}
			}
			return undefined;
		}

		/**
		 * 从一个「工作区 store / 列表 / 数组」里取出 item 集合。
		 *
		 * @param store - 可能是 store、列表、数组或映射。
		 * @returns 数组或 `{id: row}` 映射；取不到就 `undefined`。
		 */
		function workspaceItemsOf(store) {
			if (store === undefined || store === null) return undefined;
			var list;
			if (typeof store.getSnapshot === 'function') {
				try { list = store.getSnapshot(); } catch (error) { return undefined; }
			} else if (typeof store.list === 'function') {
				try { list = store.list(); } catch (error) { return undefined; }
			} else if (Array.isArray(store)) {
				list = store;
			} else {
				return undefined;
			}
			if (list === undefined || list === null) return undefined;
			// 官方快照是 `{items, …}`；也兼容直接给数组或 `{byId}`。
			if (Array.isArray(list)) return list;
			if (Array.isArray(list.items)) return list.items;
			if (list.byId !== undefined && list.byId !== null) return list.byId;
			return undefined;
		}

		/**
		 * 取一行工作区的路径（按几个候选字段名试）。
		 *
		 * @param row - 工作区行。
		 * @returns 路径；没有就 `undefined`。
		 */
		function pathOfWorkspaceRow(row) {
			if (row === undefined || row === null) return undefined;
			var keys = ['path', 'cwd', 'root', 'directory'];
			for (var kt = 0; kt < keys.length; kt += 1) {
				var value = row[keys[kt]];
				if (typeof value === 'string' && value !== '') return value;
			}
			return undefined;
		}

		/**
		 * 桥调用的**硬超时**（P2-7）：本机请求正常是毫秒级，8 秒还没回来
		 * 说明桥已经不健康 —— 挂起比失败更糟（按钮永久禁用）。
		 */
		var BRIDGE_TIMEOUT_MS = 8000;

		/**
		 * 调宿主桥的一条 RPC（令牌只在引擎进程里，浏览器侧不持有）。
		 *
		 * @param method - 方法名。
		 * @param params - 参数。
		 * @returns 结果的 Promise。
		 */
		function bridge(method, params) {
			// ⚠️ 硬超时（P2-7）：理由与 `lib/client.js` 的同名注释一致 ——
			// 桥挂起时 `fetch` 会一直等，界面上的按钮就永久禁用在那儿。
			var controller = null;
			var timer = null;
			if (typeof AbortController === 'function') {
				controller = new AbortController();
				timer = setTimeout(function () {
					controller.abort();
				}, BRIDGE_TIMEOUT_MS);
			}
			var done = function () {
				if (timer !== null) clearTimeout(timer);
			};
			var init = {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method: method, params: params || {} }),
			};
			if (controller !== null) init.signal = controller.signal;
			return fetch(ROUTE_RPC, init).then(
				(res) => {
					done();
					return res.json();
				},
				(error) => {
					done();
					throw new Error('无法连接本地桥: ' + String((error && error.message) || error));
				},
			).then((payload) => {
				if (!payload || payload.ok !== true) {
					throw new Error((payload && payload.error) || '本地桥调用失败');
				}
				return payload.result;
			});
		}

		/**
		 * 取某会话在手机本地的事件源绑定（官方 `ctx.sessions.binding()`）。
		 *
		 * 拿不到（会话没在本地打开、窗口已被替换）返回 `undefined`，
		 * 调用方一律按「无事可做」处理，不抛错。
		 *
		 * @param ctx - 宿主上下文。
		 * @param sessionId - 会话 id。
		 * @returns 绑定对象或 `undefined`。
		 */
		function bindingOf(ctx, sessionId) {
			try {
				return ctx.sessions.binding(sessionId);
			} catch (error) {
				return undefined;
			}
		}

		/**
		 * 退役某会话的逐字残片（收到 `settled` 事件时调用）。
		 *
		 * 官方的清理点是 `MutableSessionEventSource.settleAssistant(attemptId)`；
		 * 手机本地的 durable 事件是宿主直接 `session.append()` 写的，走不到
		 * 远程事件流那条链 —— 不清理的话，残片会和随后的完整消息叠成两份。
		 *
		 * @param ctx - 宿主上下文。
		 * @param sessionId - 会话 id。
		 * @param attemptId - 要退役的那一次尝试。
		 */
		function retireTransient(ctx, sessionId, attemptId) {
			if (typeof attemptId !== 'string' || attemptId === '') return;
			var binding = bindingOf(ctx, sessionId);
			if (binding === undefined || binding === null) return;
			if (binding.eventSource === undefined || binding.eventSource === null) return;
			try {
				binding.eventSource.settleAssistant(attemptId);
			} catch (error) {
				// 窗口已被替换：无事可做。
			}
		}

		/**
		 * 电脑端发起的**权限授权**在手机上的浮层卡片。
		 *
		 * ## 为什么这一类自绘
		 *
		 * 提问型（`kind:'question'`）由服务端借官方 `ctx.userQuestions.ask()`
		 * 渲染（见 `lib/mobile/index.js` 的 `showAskViaOfficial`）；而授权是
		 * 引擎内部服务 `approval.request()` 触发的，手机插件没有 inject 它，
		 * 凭空构造语义不成立 —— 所以这一类只能自绘，信息量也小（工具名 +
		 * 允许/拒绝）。
		 *
		 * ## 回传
		 *
		 * 点完经 RPC `answerAsk` 回给电脑端（`lib/desktop/index.js` 的
		 * `answerAsk`），由电脑把结果喂回那条真正的 waterfall。
		 * 送不回去就算了：电脑端有 5 分钟超时并走官方兜底，这里再弹错误只会添乱。
		 *
		 * @param payload - 电脑端推来的 `{ requestId, kind, toolName?, reason? }`。
		 */
		function showAskCard(payload) {
			if (payload === null || typeof payload !== 'object') return;
			if (payload.kind !== 'approval') return;
			var requestId = payload.requestId;
			if (typeof requestId !== 'string' || requestId === '') return;
			if (document.body === null) return;
			// 同一时刻只留一张：电脑端串行发问，堆叠只会互相遮挡。
			var previous = document.getElementById('dsh-link-ask-card');
			if (previous !== null) previous.remove();

			var card = document.createElement('div');
			card.id = 'dsh-link-ask-card';
			card.setAttribute('role', 'dialog');
			card.setAttribute('aria-modal', 'false');
			var cs = card.style;
			cs.position = 'fixed';
			cs.left = '12px';
			cs.right = '12px';
			cs.bottom = 'calc(env(safe-area-inset-bottom, 0px) + 84px)';
			cs.zIndex = '2147483000';
			cs.boxSizing = 'border-box';
			cs.padding = '16px';
			cs.borderRadius = 'var(--dsw-radius-sm, 12px)';
			cs.background = 'var(--dsw-alias-bg-primary, #ffffff)';
			cs.color = 'var(--dsw-alias-label-primary, #1f2321)';
			cs.border = '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24))';
			cs.boxShadow = '0 12px 32px rgba(0, 0, 0, 0.18)';
			cs.fontSize = '14px';
			cs.lineHeight = '1.6';

			var eyebrow = document.createElement('div');
			eyebrow.textContent = '电脑请求权限';
			eyebrow.style.fontSize = '12px';
			eyebrow.style.color = 'var(--dsw-alias-label-secondary, #6b7280)';
			card.appendChild(eyebrow);

			var tool = document.createElement('div');
			tool.textContent = typeof payload.toolName === 'string' && payload.toolName !== ''
				? payload.toolName
				: '未知工具';
			tool.style.marginTop = '6px';
			tool.style.fontWeight = '600';
			tool.style.wordBreak = 'break-all';
			card.appendChild(tool);

			if (typeof payload.reason === 'string' && payload.reason !== '') {
				var reason = document.createElement('div');
				reason.textContent = payload.reason;
				reason.style.marginTop = '4px';
				reason.style.color = 'var(--dsw-alias-label-secondary, #6b7280)';
				reason.style.wordBreak = 'break-word';
				card.appendChild(reason);
			}

			var row = document.createElement('div');
			row.style.display = 'flex';
			row.style.gap = '8px';
			row.style.marginTop = '14px';

			/**
			 * 造一个整行可点的大按钮：44px 高、flex 均分。
			 *
			 * 手机窄屏上官方那种紧凑小方块很容易点错，这里按触控标准放大。
			 *
			 * @param text - 按钮文字。
			 * @param primary - 是否主按钮。
			 * @param tone - `'error'` 时文字用错误色。
			 * @param onPick - 点击回调。
			 * @returns 按钮元素。
			 */
			var makeButton = function (text, primary, tone, onPick) {
				var button = document.createElement('button');
				button.type = 'button';
				button.textContent = text;
				var bs = button.style;
				bs.flex = '1';
				bs.minHeight = '44px';
				bs.padding = '0 12px';
				bs.fontSize = '14px';
				bs.fontFamily = 'inherit';
				bs.fontWeight = primary ? '600' : '400';
				bs.borderRadius = 'var(--dsw-radius-sm, 12px)';
				bs.border = primary
					? '1px solid transparent'
					: '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24))';
				bs.background = primary ? 'var(--dsw-alias-brand-primary, #2f5d50)' : 'transparent';
				bs.color = primary
					? '#ffffff'
					: tone === 'error'
						? 'var(--dsw-alias-state-error-primary, #b53030)'
						: 'var(--dsw-alias-label-primary, #1f2321)';
				bs.cursor = 'pointer';
				button.addEventListener('click', function () {
					onPick();
				});
				return button;
			};

			/** 收起卡片并回传答案。 */
			var answer = function (value) {
				card.remove();
				bridge('answerAsk', { requestId: requestId, answer: value }).catch(function () {
					// 电脑端会超时并走官方兜底，这里不提示。
				});
			};

			row.appendChild(makeButton('拒绝', false, 'error', function () {
				answer('rejected');
			}));
			row.appendChild(makeButton('允许一次', true, 'none', function () {
				answer('allowed-once');
			}));
			card.appendChild(row);
			document.body.appendChild(card);
		}

		/**
		 * 把「这条消息没发到电脑」显式画给用户看。
		 *
		 * ## 为什么需要
		 *
		 * `prompt` 是**乐观返回**的：用户按发送 → 消息立刻上屏 → 转发在后台跑。
		 * 转发失败时前端拿不到任何错误（它早就收到 `accepted` 了），用户只会
		 * 盯着一个永远不来的回复干等。服务端因此单开 `prompt-failed` 事件
		 * （`lib/mobile/index.js` 的 `broadcast('prompt-failed', …)`），这里负责画。
		 *
		 * ## 形态
		 *
		 * 顶部一条，8 秒自动消失、点一下也能立刻关；同一时刻只留一条，
		 * 连续失败时后一条替换前一条，不叠成一片。
		 *
		 * @param ctx - 宿主上下文（预留：将来要按会话定位时用）。
		 * @param sessionId - 出错的会话（同上，当前只记日志）。
		 * @param message - 服务端给的失败原因。
		 */
		function showPromptFailure(ctx, sessionId, message) {
			if (document.body === null) return;
			try {
				ctx.logger?.warn?.(`[dsh-link] prompt 转发失败 session=${sessionId} ${message}`);
			} catch (error) {
				// 日志失败不影响提示。
			}
			var previous = document.getElementById('dsh-link-prompt-failed');
			if (previous !== null) previous.remove();
			var bar = document.createElement('div');
			bar.id = 'dsh-link-prompt-failed';
			bar.setAttribute('role', 'alert');
			bar.textContent = '消息没有发到电脑：' + String(message === undefined || message === null ? '' : message);
			var bs = bar.style;
			bs.position = 'fixed';
			bs.left = '12px';
			bs.right = '12px';
			bs.top = 'calc(env(safe-area-inset-top, 0px) + 56px)';
			bs.zIndex = '2147483001';
			bs.boxSizing = 'border-box';
			bs.padding = '10px 14px';
			bs.borderRadius = 'var(--dsw-radius-sm, 12px)';
			bs.background = 'var(--dsw-alias-bg-primary, #ffffff)';
			bs.color = 'var(--dsw-alias-state-error-primary, #b53030)';
			bs.border = '1px solid var(--dsw-alias-border-l2, rgba(127, 127, 127, 0.24))';
			bs.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.16)';
			bs.fontFamily = 'inherit';
			bs.fontSize = '13px';
			bs.lineHeight = '1.6';
			bs.wordBreak = 'break-word';
			var close = function () {
				bar.remove();
			};
			bar.addEventListener('click', close);
			document.body.appendChild(bar);
			setTimeout(close, 8000);
		}

		/** 从任意形状的目录列表里取条目数组（宿主/官方后端的字段名略有差异）。 */
		function entriesOf(listing) {
			if (!listing || typeof listing !== 'object') return [];
			if (Array.isArray(listing.entries)) return listing.entries;
			if (Array.isArray(listing.items)) return listing.items;
			return [];
		}

		/** 取条目的显示名。 */
		function nameOf(entry) {
			return entry.name || entry.title || entry.displayName || String(entry.path || '');
		}

		/** 取条目的完整路径。 */
		function pathOf(entry) {
			return entry.path || entry.fullPath || entry.name || '';
		}

		/** 是否是可进入的文件夹。 */
		function isDir(entry) {
			if (entry.enterable === false) return false;
			if (entry.isDirectory === false) return false;
			return true;
		}

		/**
		 * 是否是隐藏条目（名字以 `.` 开头）。
		 *
		 * ⚠️ **只按名字判断，不要去看属性位**：电脑端返回的条目只有
		 * `{name, path, isDirectory, enterable}`，没有 Windows 的「隐藏」属性，
		 * 而用户说的「前面带 `.` 的文件夹比如 `.dsh`」正是这一种。
		 *
		 * @param entry - 目录条目。
		 * @returns 是否应归入「默认不显示」。
		 */
		function isHidden(entry) {
			var name = nameOf(entry);
			return name.length > 0 && name.charAt(0) === '.';
		}

		/**
		 * 是否是「纯盘符」条目（`C:\`、`D:\`…）—— **只认这一种形状**。
		 *
		 * 后端 `listDirectory` 只在「父目录为空」（站在盘根）时把盘符 unshift 进
		 * `entries`，所以在子目录里天然没有盘符；电脑页签把这一批单独渲染成一行
		 * （见 `RemoteDirectoryFlow` 里的 `driveRow`），不要和普通目录混在一起。
		 *
		 * @param entry - 目录条目。
		 * @returns 是否是盘符条目。
		 */
		function isDriveEntry(entry) {
			return /^[A-Za-z]:\\$/.test(pathOf(entry));
		}

		/** 取列表的当前路径与上级路径。 */
		function locationOf(listing) {
			var path = (listing && listing.path) || '';
			var parent = (listing && listing.parent) || '';
			// 后端明确给空 parent = 已经到顶了（Linux 的 `/`、Windows 的 `C:\`），
			// 这时**不能**再自己兜底推算：切 `C:\` 会得到 `C:`，而它在前端眼里
			// 也是绝对路径、按钮会被点亮，点下去后端直接报错。
			var atRoot = path === '' || path === '/' || /^[a-zA-Z]:[\\/]?$/.test(path);
			if (parent === '' && !atRoot) {
				var trimmed = path.replace(/[\\/]+$/, '');
				var slash = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
				if (slash > 0) parent = trimmed.slice(0, slash);
			}
			return { path: path, parent: parent, home: (listing && listing.home) || '' };
		}

		/**
		 * 「选择工作区目录」对话框：手机 / 电脑 双页签。
		 *
		 * props 是 slot 契约的 `{open, busy, onPicked, onCancel, onError}`，
		 * 外加 `inject` 送进来的浏览能力与宿主桥。
		 */
		/* 2026-10-29 删除：RemoteDirectoryFlow（旧的「手机/电脑」目录对话框）。
	 * 它曾用 priority:-1 抢占官方 directoryFlow；现在手机端不再浏览电脑目录，
	 * 工作区改由配对后 adoptWorkspaces 自动同步。
	 */

	function subscribe(ctx) {
			var source = new EventSource(ROUTE_STREAM);
			source.addEventListener('frame', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.sessionId !== 'string') return;
				injectFrame(ctx, payload.sessionId, payload.frame);
			});
			// durable 结算兜底：万一 `end` 帧丢了，残片也要被摘掉。
			source.addEventListener('settled', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.sessionId !== 'string') return;
				var attempt = attempts.get(payload.sessionId);
				if (attempt === undefined) return;
				attempts.delete(payload.sessionId);
				retireTransient(ctx, payload.sessionId, attempt.attemptId);
			});
			// ══ 电脑端发起了 ask 提问 / 权限授权 ══════════════════════════════
			//
			// 用户报障原文（2026-10-21）：
			//   「手机在远程访问电脑的时候，电脑这边工作发起了 ask 弹窗或者
			//     权限授权弹窗，手机那边都没有正常的弹出，导致用户无法选择
			//     任务卡住」
			//
			// 这条事件是**新增的**：`ask` / `approval` 不走会话事件流（它们是
			// cordis waterfall，进程内同步派发、不落盘），所以原来的 `event`
			// 通道一条都碰不到。桌面端现在注册了 answerer 把请求推过来。
			source.addEventListener('ask', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.requestId !== 'string') return;
				// 授权型自绘卡片；提问型已在服务端借官方卡片渲染，这里必然空转。
				showAskCard(payload);
			});
			// 转发失败通知。
			//
			// `prompt` 现在是**乐观返回**的（见服务端 `controller.prompt` 的注释）：
			// 用户按发送后消息立刻上屏，转发在后台跑。所以转发失败时前端**不会**
			// 拿到任何错误 —— 用户会一直等一个永远不来的回复。
			//
			// 这里把失败显式画出来：在消息列表顶部弹一条可读的错误条。
			// 之所以不重试：`prompt` 的失败多为「电脑侧会话不存在 / 路径未知」，
			// 重试也还是同一个结果，必须让用户知道并自己决定（重新同步对话）。
			source.addEventListener('prompt-failed', function (message) {
				var payload;
				try {
					payload = JSON.parse(message.data);
				} catch (error) {
					return;
				}
				if (!payload || typeof payload.message !== 'string') return;
				showPromptFailure(ctx, payload.sessionId, payload.message);
			});
			return function () {
				source.close();
			};
		}
		//#endregion

		/**
		 * 需要宿主提供的服务：slot 注册表、工作区浏览与导航、会话数据。
		 *
		 * ⚠️ `remote` / `remote.agentPresets` 是**预设名单**那条路要用的：
		 * 官方 `dsh-client-ui-agent-preset` 自己也 inject 了这两个
		 * （见其 `lib/client.js:1527` 的 inject 数组）。不加的话 `ctx.remote`
		 * 属性访问会拿到 `undefined`，`patchAgentPresets` 直接静默跳过。
		 */
		/**
		 * 需要宿主提供的服务：slot 注册表、工作区浏览与导航、会话数据、远程命名空间。
		 *
		 * ⚠️⚠️ **这里只能写「真实存在的服务名」，绝不能写带点的子属性。**
		 *
		 * 这是 1.0.25 → 1.0.28 四个版本「改了却完全没有效果」的**真正根因**。
		 *
		 * cordis 的 `Inject.resolve()`（`cordis/lib/index.js:1491`）把数组每一项
		 * 原样收进一个 map：`for (const name of inject) result[name] = null;`。
		 * 然后 `Fiber._refresh()`（同文件 `:1317`）逐个检查：
		 *
		 * ```js
		 * for (const name of Object.keys(this.inject)) {
		 *   const impl = this._store[name];
		 *   if (!impl) { epoch = INACTIVE; break; }   // ← 缺一个就全不激活
		 *   ...
		 * }
		 * ```
		 *
		 * 我原来在这里写了 `'remote.agentPresets'` —— 它不是服务名，而是 `remote`
		 * 服务上的一个**属性**。`_getImpl('remote.agentPresets')` 找不到它
		 * ⇒ `_store['remote.agentPresets']` 是 undefined ⇒ `epoch = INACTIVE`
		 * ⇒ **`apply()` 从头到尾没有被调用过**。
		 *
		 * 症状正好是用户报的三连：
		 *   - 「模型列表能够快速切换回来了，但是预设列表没有切换」——
		 *     模型走的是 `patchModelDirectories`，它在 `apply()` 里……**同样没跑**，
		 *     但模型列表的切换靠的是宿主 `mergeCatalog` + 官方自己的重算，所以照样生效；
		 *   - 「不管是私有默认工作区还是手机目录工作区，都无法切换回手机预设」——
		 *     因为我的 `patchAgentPresets` 一次都没执行；
		 *   - 而「电脑模型列表能显示」也成立：那是宿主侧做的，与客户端插件无关。
		 *
		 * 官方 `dsh-client-ui-agent-preset` 之所以能写 `'remote.agentPresets'`
		 * （见其 `lib/client.js:1532`），是因为它**同时**注入了 `'remote'`
		 * 且那是 `RemoteNamespace` 的合法子服务寻址方式；
		 * 本插件不依赖子命名空间 —— `ctx.remote.agentPresets` 经 `'remote'`
		 * 注入后是可直接读到的属性（`ctx.get('remote')` 的返回值上带它），
		 * 所以只声明 `'remote'` 就够，**不要**再列子路径。
		 */
		const inject = ['slots', 'uiWorkspace', 'sessions', 'workspaces', 'remote'];

		/**
		 * Client 插件主体：注册「手机 / 电脑」双页签的目录选择对话框 + 订阅流式帧。
		 *
		 * @param ctx - client 根上下文。
		 */
		function apply(ctx) {
			/**
			 * ⚠️⚠️ **整个 `apply()` 必须整体兜底 —— 这是 1.0.29 让 App 无限重启的教训。**
			 *
			 * 1.0.29 把 `inject` 里那个非法的 `'remote.agentPresets'` 去掉之后，
			 * `apply()` **第一次真正开始执行**（1.0.25–1.0.28 它从来没跑过，
			 * 所以那四版是「不崩但也不工作」）。
			 *
			 * 一旦它真的跑起来，里面任何一步抛错都会被 cordis 记成插件 FAILED，
			 * 而 `dsh-client-modules` 的 `ClientPackageCompositionError`
			 * （`lib/index.js:144-157`）是**整批聚合抛出**的 —— 一个插件炸掉，
			 * 整页 `Failed to load plugins`，App 直接进救援模式并无限重启：
			 *
			 * ```
			 * 首帧正文="HARNESS Failed to load plugins dsh-jiuli"
			 * 救援：启动层级 = rescue 原因=浏览器侧插件加载失败
			 * 引擎已退出…准备自动重启（第 1 次）
			 * ```
			 *
			 * 用户的原话是「你他妈想让我手机死机是吧」—— 这个兜底就是为此加的。
			 *
			 * **兜底原则：本插件只是「多一个电脑页签」的增强件，
			 * 它坏了绝不能把整个界面带走。** 任何一步失败都只放弃那一步。
			 */
			const guard = (label, fn, fallback) => {
				try {
					return fn();
				} catch (error) {
					// 诊断出口②：被吞掉的异常必须留痕，否则「改了没效果」永远查不出原因。
					try {
						window.__dshLinkGuardError = String(label) + ': ' + String(error);
					} catch (probeError) {
						/* 诊断失败绝不影响主流程 */
					}
					// 只打日志，绝不外抛：外抛 = 整页加载失败。
					try {
						if (ctx.logger && typeof ctx.logger.warn === 'function') {
							ctx.logger.warn('[dsh-link] ' + label + ' 失败（已忽略）: ' + error);
						}
					} catch (ignored) {
						/* 连日志都打不出来也不能炸 */
					}
					return fallback;
				}
			};

			const injected = () => ({
				listDirectory: (path, signal) => ctx.uiWorkspace.listDirectory(path, signal),
				createDirectory: (path, name) => ctx.uiWorkspace.createDirectory(path, name),
				openSession: (sessionId) => ctx.uiWorkspace.openSession(sessionId),
				/**
				 * 把宿主刚建好的会话登记进本地列表。
				 *
				 * 走官方 client 的 `sessions.create({sessionId, cwd})`：
				 * `SessionManager.create()` 在 RPC 回执后立刻
				 * `recordMutation({kind:'placeholder'})` 把这一行写进列表快照，
				 * 于是 `openSession()` 当场就能解析到这个 id。
				 * **不登记就直接 `openSession()` 是竞态**，会抛
				 * `sessions.retain: unknown session` 并被静默吞掉
				 * （详见组件里 `settleLocal` 的注释）。
				 *
				 * 传 `cwd`（宿主回执里的**手机本地**路径）而不是 `workspaceId`：
				 * 宿主侧已经把这个会话挂进工作区了，这里只需要让客户端列表
				 * 认识它；带上 cwd 才能让列表把它分进正确的工作区分组。
				 *
				 * 宿主侧已建过该 id ⇒ `createOrAdopt` 看到活着的 agent 直接返回，
				 * 不会重复建。
				 *
				 * @param sessionId - 会话 id。
				 * @param cwd - 宿主回执里的本地 cwd（两端只在 id 上对齐）。
				 */
				registerLocal: (sessionId, cwd) => {
					const options = { sessionId };
					if (cwd !== undefined && cwd !== '') options.cwd = cwd;
					return ctx.sessions.create(options);
				},
				/** 兜底：拉一次全量会话列表。 */
				refreshSessions: () => ctx.sessions.refresh(),
				/**
				 * 官方的模型目录服务（`super(ctx, "modelDirectories")`）。
				 *
				 * 「刷新」按钮要让它失效重载 —— 官方目录**带缓存**，光把宿主那边的
				 * 数据换掉，前端仍然显示旧值（见 `refreshAll` 的注释）。
				 * `ctx.get` 拿不到就返回 `undefined`，组件里会跳过这一步。
				 */
				modelDirectories: ctx.get === undefined ? undefined : ctx.get('modelDirectories'),
				/**
				 * 把一个会话标记成「跑在电脑上」。
				 *
				 * 建完远程会话**当场**登记，用户不必等下一次全量拉取就能看到
				 * 正确的模型列表（见 `remoteSessionIds` 的注释）。
				 *
				 * @param sessionId - 会话 id。
				 */
				markRemote: (sessionId) => {
					if (typeof sessionId === 'string' && sessionId !== '') remoteSessionIds[sessionId] = true;
				},
				/**
				 * 重拉一次「电脑镜像工作区 slug 集合」。
				 *
				 * ⚠️ **必须在「刚给某个电脑目录建好工作区」之后调**：宿主
				 * `ensureDesktopWorkspace()` 每碰到一个新的电脑目录就往 `workspaceMap`
				 * 里加一条 slug，而前端这份集合是**快照**。不重拉的话，新加的镜像工作区
				 * 在侧边栏里点进去仍会被判成「本地」—— 正是用户报的那个 bug。
				 */
				refreshMirrorSlugs: () => loadMirrorSlugs(),
				/** 解绑后把所有会话退回「本地」（电脑已经不在了）。 */
				clearRemote: () => {
					remoteSessionIds = {};
					mirrorSlugs = {};
				},
			});

			// 拉一次全量远程会话清单（重启 App 后已有会话也要能正确识别）。
			guard('loadRemoteSessionIds', () => loadRemoteSessionIds());
			// 拉一次镜像工作区 slug 集合（隔离的**真正判据**，见 `mirrorSlugs`）。
			guard('loadMirrorSlugs', () => loadMirrorSlugs());

			// 把「按工作区筛模型目录」接到官方服务上。
			guard('patchModelDirectories', () =>
				ctx.effect(
					() => patchModelDirectories(ctx, makeCwdOf(ctx)),
					'dsh-link: workspace-scoped model catalog',
				),
			);

			// 把「按工作区筛预设名单」接到官方 RPC 上。
			//
			// ⚠️⚠️ **必须走 `ctx.inject([...], cb)` 子作用域，不能直接用外层 `ctx`。**
			//
			// `remote.agentPresets` 是 `dsh-api-remotes` 动态 provide 的**子命名空间**。
			// 本插件的 `inject` 只声明了父服务 `'remote'`，于是外层 `ctx` 上读
			// `ctx.remote.agentPresets` 会**直接抛**：
			//
			//     Error: cannot get property "remote.agentPresets" without inject
			//
			// 而这句话被 `guard` 吞掉后，`patchAgentPresets` 的第一行就 return 了 ——
			// `list` 一次都没被包过。真机取证（1.0.34，`window.__dshLinkGuardError`）：
			//
			//     patchAgentPresets: Error: cannot get property "remote.agentPresets" without inject
			//
			// 这才是 1.0.25→1.0.33 九个版本「改了没效果」的**唯一**根因。之前注释里
			// 归因的「Proxy 没解包」「roster 没人重请求」都不是主因 —— 那些代码压根
			// 没跑到过。
			//
			// ⚠️ 但**也不能把 `'remote.agentPresets'` 写进 `export const inject`**：
			// 那是**静态**声明，子服务在未配对/未挂载时不存在 ⇒ `Fiber._refresh()`
			// 里 `epoch = INACTIVE` ⇒ **整个插件一次都不激活**（连目录选择器都没了）。
			// `ctx.inject()` 是**运行期**动态作用域：子服务就绪才回调，不阻塞本插件。
			// 「加载更早」按钮已在 0.18.33 撤掉：真机上按钮能渲染但点击无反应
			//（slot 里拿不到当前会话 id，而我放在 apply 作用域的 `currentSessionId`
			// 其实在嵌套作用域里，够不着），且用户判断「这个入口没必要」——
			// 官方列表顶部的「加载更早」已经覆盖本地窗口内的翻页。
			// 跨窗口的历史交给 V2-A（重启时按档位补深），不再做第二套 UI。

guard('patchAgentPresets', () =>
				ctx.inject(['remote.agentPresets', 'uiWorkspace', 'sessions', 'workspaces', 'slots'], (scope) => {
					scope.effect(
						() => patchAgentPresets(scope, makeCwdOf(scope)),
						'dsh-link: workspace-scoped agent presets',
					);
				}),
			);

			// ⚠️ 2026-10-29 重做：**不再注册 directoryFlow**。
			// 旧版用 priority:-1 抢占了官方「添加工作区」选择器，把它替换成
			// 自家的「手机/电脑」对话框 —— 用户明确不要这种劫持。
			// 手机端改为：配对后自动同步电脑勾选的工作区（adoptWorkspaces）。
			guard('subscribe', () =>
				ctx.effect(() => subscribe(ctx), 'dsh-link: assistant stream bridge'),
			);

			// 「同步对话」：把菜单项接进工作区行的「⋯」菜单。
			//
			// ⚠️ 必须先拉一次镜像工作区清单：菜单项要按工作区标题反查电脑路径，
			// 清单为空时那一项会静默不出现（不报错，但功能等于没有）。
			guard('refreshMirrorWorkspaces', () => {
				ctx.effect(() => {
					refreshMirrorWorkspaces();
					// ⚠️⚠️ **原来这里有一个 `setInterval(refreshMirrorWorkspaces, 5000)`**
					// —— 每 5 秒打一次隧道，**7×24 不停**，一小时 720 次。
					//
					// 这是纯隐形浪费，理由：
					//   · 这个清单只在**用户选了/新增了电脑工作区**之后才会变；
					//   · 而那种操作一定伴随一次工作区列表变化，宿主会推事件；
					//   · 就算事件漏了，用户打开「⋯」菜单时再拉一次也来得及
					//    （菜单是点出来的，不是常驻的）。
					//
					// 所以改成**事件驱动 + 极低频兜底**：
					//   · 主路：`api-workspace/added` 之类的工作区事件（见下面的订阅）；
					//   · 兜底：每 10 分钟一次，只为覆盖「事件没覆盖到的边角」。
					//
					// 用户第一准则是「不费流量」，720 次/小时 vs 6 次/小时，
					// 差的不是一点。而功能上没有任何损失：菜单点开前清单一定是新的。
					const timer = setInterval(refreshMirrorWorkspaces, 10 * 60 * 1000);
					// 工作区真的变了就重拉（这是唯一真正需要的时机）。
					//
					// ⚠️ 事件名必须用官方的 `domain/changed`（见
					// `dsh-api-workspace-controller/lib/index.js:48`）。官方**没有**
					// `api-workspace/added` 这种事件 —— 那是 `api-session/*` 那一套的
					// 命名习惯，套到工作区上是我猜错了，订阅会静默收不到任何东西。
					//
					// 判据与官方 `changed()` 一致：
					//   · `change.domain === 'workspace'` ⇒ 工作区集合/顺序变了；
					//   · `change.table === 'workspaces'` ⇒ 某条工作区记录变了。
					const off = ctx.on('domain/changed', function (change) {
						if (change === null || typeof change !== 'object') return;
						if (change.domain !== 'workspace' && change.table !== 'workspaces') return;
						refreshMirrorWorkspaces();
					});
					return () => {
						clearInterval(timer);
						if (typeof off === 'function') off();
					};
				}, 'dsh-link: mirror workspace index');
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	},
});
