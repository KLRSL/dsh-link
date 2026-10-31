/**
 * dsh-link —— client 半边（两端 UI + 角色门）。
 *
 * ## 这次是重做，不是补丁（2026-10-29 用户定版）
 *
 * 1. **不再有 iframe 配置页**：设置里的「局域互联」就是真正的设置面板
 *    （原生控件，地址/配对码/设备/工作区/通知都在这里），没有「打开配置页面」。
 * 2. **不再劫持官方目录选择器**：手机端不注册 `directoryFlow`，不会再把
 *    「添加工作区」替换成自家的「手机/电脑」对话框；配对后电脑勾选的工作区
 *    自动同步到手机（`adoptWorkspaces`）。
 * 3. **连接状态以真实握手为准**：手机端「已连接」= 带设备凭据向电脑校验成功；
 *    电脑白名单里没有这台设备（unknown-device）或连不通，一律显示「未连接」。
 * 4. 一次性引导保留，但改成**原生弹层**（同一套样式与 REST 接口），不跳页。
 *
 * ## 语法约束
 *
 * 手机 App 前端按 chrome73 降级编译：不用可选链、空值合并、`Object.fromEntries`、
 * `Array.flat`；本文件同时跑在电脑 Web 与手机 WebView。
 *
 * @module dsh-link/client
 */

window.__ModuleLoader__.load({
	id: 'dsh-link',
	factory: (require) => {
		var exports = {};
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' });

		var BRIDGE_ROUTE = '/api/dsh-remote/rpc';
		var LINK_ROUTE = '/api/dsh-remote/link';
		var BRIDGE_TIMEOUT_MS = 8000;

		/* ───────────────────────── 角色判定 ───────────────────────── */

		function bridge(method, params) {
			var controller = null;
			var timer = null;
			if (typeof AbortController === 'function') {
				controller = new AbortController();
				timer = setTimeout(function () { controller.abort(); }, BRIDGE_TIMEOUT_MS);
			}
			var done = function () { if (timer !== null) clearTimeout(timer); };
			var init = {
				method: 'POST',
				cache: 'no-store',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ method: method, params: params || {} }),
			};
			if (controller !== null) init.signal = controller.signal;
			return fetch(BRIDGE_ROUTE, init).then(
				function (res) {
					done();
					if (!res || res.ok !== true) return null;
					return res.json().then(function (payload) { return payload; }, function () { return null; });
				},
				function () { done(); return null; },
			);
		}

		function probeMobile() {
			return bridge('role', {}).then(function (payload) {
				if (payload && payload.ok === true && payload.result && payload.result.role === 'mobile') return 'mobile';
				return null;
			});
		}

		function probeDesktop() {
			return fetch(LINK_ROUTE + '/role', { cache: 'no-store', headers: { accept: 'application/json' } }).then(
				function (res) {
					if (!res || res.ok !== true) return null;
					return res.json().then(function (payload) {
						return payload && payload.role === 'desktop' ? 'desktop' : null;
					}, function () { return null; });
				},
				function () { return null; },
			);
		}

		function detectRole() {
			return probeMobile().then(function (hit) {
				if (hit !== null) return hit;
				return probeDesktop().then(function (desktop) { return desktop === null ? 'unknown' : desktop; });
			});
		}

		var role = 'unknown';
		var settingsRegistered = false;

		/* ───────────────────────── 数据接口 ───────────────────────── */

		function request(method, url, body) {
			var init = { method: method, cache: 'no-store', headers: {} };
			if (body !== undefined) {
				init.headers['content-type'] = 'application/json';
				init.body = JSON.stringify(body);
			}
			var controller = null;
			var timer = null;
			if (typeof AbortController === 'function') {
				controller = new AbortController();
				init.signal = controller.signal;
				timer = setTimeout(function () { controller.abort(); }, 10000);
			}
			return fetch(url, init).then(function (res) {
				if (timer !== null) clearTimeout(timer);
				return res.json().then(function (payload) { return payload; }, function () { return null; });
			}, function () {
				if (timer !== null) clearTimeout(timer);
				return null;
			});
		}
		function getState() {
			return request('GET', LINK_ROUTE + '/setup/state').then(function (payload) {
				return payload && payload.ok === true ? payload.state : null;
			});
		}
		function postSetup(action, body) {
			return request('POST', LINK_ROUTE + '/setup/' + action, body || {}).then(function (payload) {
				return payload && payload.ok === true ? payload : { ok: false, reason: payload && payload.reason ? payload.reason : '请求失败' };
			});
		}

		/* ───────────────────────── 原生样式（两端共用） ───────────────────────── */

		var C = {
			brand: '#2F5D50',
			brandOn: '#FFFFFF',
			bad: '#A6432F',
			line: 'rgba(127,127,127,0.28)',
		};
		function stateSummary(state) {
			if (!state) return '读取中…';
			if (state.localRole === 'mobile') {
				if (state.connected === true) return '已连接';
				if (state.configuredAt) return '已配对 · 未连接';
				if (state.reason === 'unknown-device') return '未连接：电脑不认识这台手机（需重新配对）';
				if (state.reason === 'unreachable') return '未连接：连不上电脑';
				return '未连接';
			}
			if (state.configuredAt) return '已配置';
			return '未完成配置';
		}

		/* 2026-10-29 用户要求：删除首次安装的配置弹窗。配置全部在「设置 → 局域互联」里完成，不再自动弹任何窗口。 */

/* ───────────────────────── 原生设置分区 ───────────────────────── */

				function registerSettingsSection(ctx) {
			try {
				if (settingsRegistered) return;
				if (!ctx || !ctx.slots || typeof ctx.slots.inject !== 'function') return;
				settingsRegistered = true;
				var react = require('react');
				var h = react.createElement;
				var useState = react.useState;
				var useEffect = react.useEffect;

				var cardStyle = { border: '1px solid ' + C.line, borderRadius: '12px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '8px' };
				var titleStyle = { fontSize: '15px', fontWeight: 600 };
				var labelStyle = { fontSize: '13px', opacity: 0.65, flex: '0 0 72px' };
				var valueStyle = { fontSize: '14px', wordBreak: 'break-all' };
				var btnStyle = { border: '1px solid ' + C.line, background: 'rgba(127,127,127,0.10)', borderRadius: '8px', padding: '5px 11px', fontSize: '12px', cursor: 'pointer', color: 'inherit' };
				var primStyle = { border: '1px solid ' + C.brand, background: C.brand, color: C.brandOn, borderRadius: '8px', padding: '5px 11px', fontSize: '12px', cursor: 'pointer' };
				var inputStyle = { border: '1px solid ' + C.line, borderRadius: '8px', padding: '5px 8px', fontSize: '12px', background: 'rgba(127,127,127,0.10)', color: 'inherit', fontFamily: 'ui-monospace, monospace', minWidth: '0' };

				function Card(props) {
					return h('div', { style: cardStyle }, h('div', { style: titleStyle }, props.title), props.children);
				}
				function Row(props) {
					return h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
						h('span', { style: labelStyle }, props.k),
						h('span', { style: valueStyle }, props.v));
				}
				/**
				 * 跳过原因码 → 人话（`syncAll` 的 `skipped` 字段可能逗号分隔多个）。
				 *
				 * @param reason - `'not-shared'` / `'new-sync-off'` / `'expired'`，可逗号分隔。
				 * @returns 可读文案；没有原因时是空串。
				 */
				function skippedLabel(reason) {
					if (typeof reason !== 'string' || reason === '') return '';
					var map = { 'not-shared': '目录未在电脑勾选', 'new-sync-off': '新建互见已关', expired: '超过保留期' };
					var parts = [];
					var keys = reason.split(',');
					for (var i = 0; i < keys.length; i++) {
						var key = keys[i].trim();
						if (key === '') continue;
						parts.push(map[key] || key);
					}
					return parts.join('、');
				}

				/**
				 * 把手机端回报的同步结果拼成一行文案。
				 *
				 * 数据来源：`lib/mobile/index.js` 的 `lastSyncState`（经 setup 服务读出）。
				 *
				 * @param status - `{ ok, count, error, expired?, skipped? }`。
				 * @returns 显示文本。
				 */
				function syncSummary(status) {
					if (status.ok !== true) return '失败：' + (status.error || '未知');
					var text = '成功 ' + (Number(status.count) || 0) + ' 个';
					var expired = Number(status.expired) || 0;
					var notes = [];
					if (expired > 0) notes.push(expired + ' 个超过保留期');
					var skipped = skippedLabel(status.skipped);
					if (skipped !== '') notes.push(skipped);
					return notes.length > 0 ? text + '（跳过 ' + notes.join('；') + '）' : text;
				}

				function Seg(props) {
					return h('div', { style: { display: 'inline-flex', border: '1px solid ' + C.line, borderRadius: '8px', overflow: 'hidden' } },
						props.options.map(function (option) {
							var active = props.value === option.v;
							return h('button', {
								key: option.v, type: 'button', disabled: props.disabled,
								onClick: function () { props.onPick(option.v); },
								style: {
									border: 0, padding: '6px 14px', fontSize: '13px', cursor: 'pointer',
									background: active ? C.brand : 'rgba(127,127,127,0.10)', color: active ? C.brandOn : 'inherit',
								},
							}, option.t);
						}));
				}

				function LinkSettingsSection() {
					var pair = useState(null);
					var state = pair[0];
					var setState = pair[1];
					var busyPair = useState('');
					var busy = busyPair[0];
					var setBusy = busyPair[1];
					var notePair = useState('');
					var note = notePair[0];
					var setNote = notePair[1];
					var tonePair = useState('bad');
					var tone = tonePair[0];
					var setTone = tonePair[1];
					var familyPair = useState('');
					var family = familyPair[0];
					var setFamily = familyPair[1];

					var reload = function () { getState().then(function (next) { if (next) setState(next); }); };
					useEffect(function () { reload(); }, []);
					// 手机端：刚开机/刚连上时状态可能一次探测失败；每 15 秒重试，
					// 连上后自动停止。避免界面永远停在「未连接」。
					useEffect(function () {
						if (!state || state.localRole !== 'mobile' || state.connected === true) return undefined;
						var timer = setInterval(reload, 15000);
						return function () { clearInterval(timer); };
					}, [state && state.localRole, state && state.connected]);
					useEffect(function () {
						if (state && state.gateway && typeof state.gateway.addressFamily === 'string') setFamily(state.gateway.addressFamily === 'dual' ? 'ipv6' : state.gateway.addressFamily);
					}, [state]);

					var act = function (action, body, okText) {
						if (busy !== '') return;
						setBusy(action);
						setNote('');
						setTone('ok');
						postSetup(action, body).then(function (res) {
							setBusy('');
							if (res.ok !== true) { setTone('bad'); setNote(res.reason || '操作失败'); }
							else if (okText) { setTone('ok'); setNote(okText); }
							reload();
						}, function (error) {
							// 请求本身失败（断网/超时/页面被卸载）：必须清 busy，
							// 否则按钮永远禁用、整页像“灰掉”了一样。
							setBusy('');
							setTone('bad');
							setNote(String((error && error.message) || error || '请求失败'));
						});
					};

					/* 手机端两段式配对：发起 → 显示同一组数字 → 轮询电脑是否允许（框架 §4） */
					var pairPoll = null;
					var pairModal = null;

					function closePairModal() {
						if (pairPoll !== null) { clearInterval(pairPoll); pairPoll = null; }
						if (pairModal !== null && pairModal.parentNode !== null) pairModal.parentNode.removeChild(pairModal);
						pairModal = null;
					}

					function showPairModal(code) {
						closePairModal();
						var wrap = document.createElement('div');
						wrap.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;';
						var card = document.createElement('div');
						card.style.cssText = 'width:100%;max-width:320px;background:#fff;color:#1d1d1b;border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.35);font-size:14px;line-height:1.6;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;text-align:center;';
						var t = document.createElement('div');
						t.textContent = '在电脑上确认这组数字';
						t.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:8px;';
						var c = document.createElement('div');
						c.textContent = code;
						c.style.cssText = 'font-family:ui-monospace,monospace;font-size:34px;letter-spacing:10px;padding:12px 0;background:#f4f2ee;border-radius:10px;margin:6px 0 10px;';
						var d = document.createElement('div');
						d.textContent = '和电脑上弹出的数字一致，就在电脑上点「允许」。';
						d.style.cssText = 'font-size:12px;color:#666;margin-bottom:14px;';
						var cancel = document.createElement('button');
						cancel.type = 'button';
						cancel.textContent = '取消';
						cancel.style.cssText = 'border:1px solid #d8d4cc;background:#fff;color:#333;border-radius:8px;padding:8px 18px;font-size:14px;cursor:pointer;';
						cancel.onclick = function () { closePairModal(); setNote('已取消配对'); };
						card.appendChild(t); card.appendChild(c); card.appendChild(d); card.appendChild(cancel);
						wrap.appendChild(card);
						document.body.appendChild(wrap);
						pairModal = wrap;
					}

					function startMobilePair(h0, p0) {
						if (busy !== '') return;
						setBusy('pair');
						setNote('');
						setTone('ok');
						bridge('lanPairStart', { host: h0, port: p0 }).then(function (payload) {
							setBusy('');
							var r = payload && payload.ok === true ? payload.result : null;
							if (!r || r.ok !== true) {
								setTone('bad');
								// 文案要说清「是谁没应答」：通常是电脑端的 8899 没在监听
								//（DSH 没开 / 插件被停用），而不是手机网络问题。
								setNote(r && r.error ? r.error : '配对请求没发出去：电脑端没有应答，先确认电脑上的 DSH 开着、dsh-link 已启用');
								return;
							}
							showPairModal(r.code);
							var deadline = Number(r.expiresAt) || 0;
							pairPoll = setInterval(function () {
								if (deadline > 0 && Date.now() > deadline) {
									closePairModal();
									setTone('bad');
									setNote('电脑没在 60 秒内确认，请重试');
									return;
								}
								bridge('lanPairStatus', { pendingId: r.pendingId, host: r.host, port: r.port }).then(function (payload2) {
									var s = payload2 && payload2.ok === true ? payload2.result : null;
									if (!s) return;
									if (s.state === 'approved') {
										closePairModal();
										// 批准之后还要真的连一次：走 setup 的 pair 动作（= lanConnect），
										// 它会用已授权的凭据做签名 ping、把设置页状态标成已配对/已连接，
										// 并同步工作区。少了这一步，界面会停在“已配对 · 未连接”。
										act('pair', { family: 'ipv4', host: r.host, port: r.port }, '配对成功');
									} else if (s.state === 'expired' || s.state === 'rejected') {
										closePairModal();
										setTone('bad');
										setNote(s.state === 'rejected' ? '电脑拒绝了这次配对' : '配对请求已过期，请重试');
									}
								}, function () {});
							}, 2000);
						}, function (error) {
							setBusy('');
							setTone('bad');
							setNote(String((error && error.message) || error || '请求失败'));
						});
					}

					if (!state) return h('div', { style: { fontSize: '13px', opacity: 0.7 } }, '读取中…');

					var isMobile = state.localRole === 'mobile';
					var host = typeof state.host === 'string' && state.host !== '' ? state.host : '';
					var shownHost = isMobile ? host : (state.localAddress ? state.localAddress : host);
					var port = String(state.gatewayPort || state.port || '');
					var gw = state.gateway && typeof state.gateway === 'object' ? state.gateway : {};
					var devices = Array.isArray(state.devices) ? state.devices : [];
					var workspaces = Array.isArray(state.workspaces) ? state.workspaces : [];
					var available = Array.isArray(state.availableWorkspaces) ? state.availableWorkspaces : [];
					var synced = Array.isArray(state.syncedWorkspaces) ? state.syncedWorkspaces : [];
					var hides = state.hides && typeof state.hides === 'object' ? state.hides : {};
					var sync = state.sessionSync && typeof state.sessionSync === 'object' ? state.sessionSync : {};
					var notify = state.notify && typeof state.notify === 'object' ? state.notify : {};

					var saveGateway = function () {
						var portEl = document.getElementById('dsh-link-gw-port');
						// 2026-10-29：IPv6 / 公网 / DDNS 已删；绑定地址固定 0.0.0.0（所有网卡），
						// 不再暴露「监听地址」输入框 —— 手机上填的是局域网地址，不是绑定地址。
						act('gateway', {
							addressFamily: 'ipv4',
							listen: '0.0.0.0',
							port: portEl ? portEl.value : undefined,
							allowGlobal: false,
							ddns: { enabled: false },
						}, '已保存，重启 DSH 后生效');
					};
					var chips = function (group, options, current, apply) {
						return h('div', { style: { display: 'flex', gap: '6px', flexWrap: 'wrap' } },
							options.map(function (option) {
								var on = current === option.v;
								return h('button', {
									key: String(option.v), type: 'button', disabled: busy !== '',
									onClick: function () { apply(option.v); },
									style: { border: '1px solid ' + (on ? C.brand : C.line), background: on ? C.brand : 'rgba(127,127,127,0.10)', color: on ? C.brandOn : 'inherit', borderRadius: '999px', padding: '4px 10px', fontSize: '12px', cursor: 'pointer' },
								}, option.t);
							}));
					};

					return h('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '14px', lineHeight: 1.6, width: '100%', boxSizing: 'border-box' } },
						h('div', { style: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' } },
							h('strong', { style: { fontSize: '15px' } }, 'dsh-link 局域互联' + (typeof state.version === 'string' && state.version !== '' ? ' · ' + state.version : '')),
							h('span', { style: { opacity: 0.7 } }, (isMobile ? '手机 / 平板' : '电脑端') + ' · ' + stateSummary(state))),
						!state.configuredAt ? h('div', { style: { fontSize: '12px', opacity: 0.8 } }, '这台设备还没完成连接配置。') : null,

						h(Card, { title: '连接' },
							isMobile ? h('div', {},
								h(Row, { k: state.connected === true ? '电脑地址' : '上次地址', v: shownHost !== '' ? shownHost + ':' + port + (state.connected === true ? '' : '（未连接）') : '未设置' }),
								// 不走任何弹窗：地址、端口、验证码直接填在设置里，一步连上。
								h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
									h('input', { id: 'dsh-link-m-host', defaultValue: host, placeholder: '电脑 IP', style: inputStyle }),
									h('input', { id: 'dsh-link-m-port', defaultValue: port, placeholder: '端口', style: { ...inputStyle, width: '72px' } }),
									h('button', {
										type: 'button', style: primStyle, disabled: busy !== '',
										onClick: function () {
											var hostEl = document.getElementById('dsh-link-m-host');
											var portEl = document.getElementById('dsh-link-m-port');
											startMobilePair(hostEl ? hostEl.value : host, portEl ? portEl.value : port);
										},
									}, '开始配对')))
							: h('div', {},
								h('div', { style: { fontSize: '13px' } }, '手机要填的地址：' + (shownHost !== '' ? shownHost : '（电脑地址）') + ':' + String(state.port || '')),
								h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
									h('span', { style: labelStyle }, '端口'),
									h('input', { id: 'dsh-link-gw-port', defaultValue: String(gw.port || ''), style: inputStyle }),
									h('button', { type: 'button', style: primStyle, disabled: busy !== '', onClick: saveGateway }, '保存'),
									h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '改端口后需重启 DSH')))),
						h(Card, { title: isMobile ? '配对' : '配对码' },
							isMobile
								? h('div', {}, h(Row, { k: '状态', v: state.connected === true ? '已连接（已验证）' : (state.configuredAt ? '已配对 · 当前未连通' : '未连接，点「开始配对」后到电脑上确认') }), state.syncStatus ? h(Row, { k: '最近同步', v: syncSummary(state.syncStatus) }) : null)
								: h('div', {},
									h('div', { style: { fontSize: '13px', opacity: 0.8 } }, devices.length > 0
										? '已配对 ' + devices.length + ' 台设备。手机点「开始配对」后，电脑会弹出居中确认窗。'
										: '还没有配对的手机。手机点「开始配对」后，电脑会弹出居中确认窗。'),
									h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
										h('button', { type: 'button', style: btnStyle, disabled: busy !== '', onClick: function () { act('pairing/reset', {}, '已断开全部配对（白名单已清空）'); } }, '断开全部配对'),
										h('span', { style: { fontSize: '12px', opacity: 0.6 } }, '立即撤销所有已配对设备的访问权限')),
									devices.length > 0 ? h('div', {},
										h('div', { style: { fontSize: '12px', opacity: 0.65 } }, '已配对设备（手机未连接时也会显示，可解绑后重新配对）'),
										devices.map(function (device) {
											return h('div', { key: device.id, style: { display: 'flex', alignItems: 'center', gap: '8px', padding: '3px 0' } },
												h('span', { style: { flex: '1 1 auto', fontSize: '12px' } }, (device.name || '设备') + ' · ' + (device.shortId || String(device.id).slice(0, 8))),
												h('button', { type: 'button', style: btnStyle, disabled: busy !== '', onClick: function () { act('device/unbind', { id: device.id }, '已解绑'); } }, '解绑'));
										})) : null)),

						h(Card, { title: '工作区' },
							isMobile
								? h('div', {}, synced.length === 0
									? h('div', { style: { fontSize: '12px', opacity: 0.7 } }, '还没有同步过来的工作区（电脑端勾选后自动出现）。')
									: synced.map(function (path) { return h('div', { key: path, style: { fontFamily: 'ui-monospace, monospace', fontSize: '12px', wordBreak: 'break-all' } }, path); }))
								: h('div', {}, available.length === 0
									? h('div', { style: { fontSize: '12px', opacity: 0.7 } }, '电脑上还没有工作区')
									: available.map(function (item) {
										var path = typeof item === 'string' ? item : item && item.path;
										if (!path) return null;
										var hide = hides[path];
										var hideKey = hide ? hide.ttl + ':' + hide.scope : '';
										var label = hideKey === '' ? '同步' : hideKey === 'once:both' ? '这次·两端' : hideKey === 'forever:both' ? '永久·两端' : hideKey === 'once:local' ? '这次·本机' : '永久·本机';
										return h('div', { key: path, style: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', padding: '3px 0' } },
											h('input', { type: 'checkbox', checked: workspaces.indexOf(path) !== -1, disabled: busy !== '', onChange: function (event) { act('workspace', { kind: event.target.checked ? 'add' : 'remove', path: path }); } }),
											h('span', { style: { flex: '1 1 220px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', wordBreak: 'break-all', opacity: hide ? 0.5 : 1 } }, path),
											h('button', { type: 'button', style: btnStyle, disabled: busy !== '', onClick: function () {
												var order = ['', 'once:both', 'forever:both', 'once:local', 'forever:local'];
												var next = order[(order.indexOf(hideKey) + 1) % order.length];
												if (next === '') act('hide/clear', { path: path }, '已恢复同步');
												else { var parts = next.split(':'); act('hide', { path: path, ttl: parts[0], scope: parts[1] }, '已设置隐藏方式'); }
											} }, label));
									}))),

						!isMobile ? h(Card, { title: '会话同步' },
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: labelStyle }, '同步范围'),
								chips('scope', [{ v: 'all', t: '全部会话' }, { v: 'workspace', t: '仅工作区内' }], sync.scope, function (v) { act('config', { sessionSync: { scope: v } }, '已保存'); })),
							h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap' } },
								h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
									h('input', { type: 'checkbox', checked: sync.newSync !== false, disabled: busy !== '', onChange: function (e) { act('config', { sessionSync: { newSync: e.target.checked } }, '已保存'); } }), '新建会话互见'),
								h('label', { style: { display: 'inline-flex', gap: '6px', alignItems: 'center', fontSize: '12px' } },
									h('input', { type: 'checkbox', checked: sync.delSync !== false, disabled: busy !== '', onChange: function (e) { act('config', { sessionSync: { delSync: e.target.checked } }, '已保存'); } }), '删除会话互见')),
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: labelStyle }, '删除保留'),
								chips('keep', [{ v: 7, t: '7 天' }, { v: 30, t: '30 天' }, { v: 90, t: '90 天' }, { v: -1, t: '不限' }], Number(sync.keepDays), function (v) { act('config', { sessionSync: { keepDays: v } }, '已保存'); }))) : null,

						!isMobile ? h(Card, { title: '通知推送' },
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: labelStyle }, '推到手机'),
								h('button', { type: 'button', style: btnStyle, disabled: busy !== '', onClick: function () { act('notify', { on: !state.notifyEnabled }); } }, state.notifyEnabled ? '已开启（点击关闭）' : '已关闭（点击开启）')),
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: labelStyle }, '触发条件'),
								chips('when', [{ v: 'all', t: '每轮完成' }, { v: 'error', t: '仅出错' }, { v: 'long', t: '仅长任务' }], notify.when, function (v) { act('config', { notify: { when: v } }, '已保存'); })),
							h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
								h('span', { style: labelStyle }, '长任务阈值'),
								chips('longMin', [{ v: 2, t: '2 分钟' }, { v: 5, t: '5 分钟' }, { v: 15, t: '15 分钟' }], Number(notify.longMin), function (v) { act('config', { notify: { longMin: v } }, '已保存'); }))) : null,

						note !== '' ? h('div', { style: { color: tone === 'bad' ? C.bad : 'inherit', fontSize: '12px' } }, note) : null);
				}

				ctx.effect(function () {
					return ctx.slots.inject('settings.section', function () {
						return ctx.slots.register(
							{ name: 'settings.section', id: 'dsh-link-settings', order: 65, label: function () { return '局域互联'; } },
							LinkSettingsSection,
						);
					});
				}, 'dsh-link: settings section');
			} catch (ignored) {
				/* 没有 slots / react：不影响主流程 */
			}
		}

		/* ───────── 电脑端：配对请求居中弹窗（框架 §4） ─────────
		 * 用原生 DOM 而不是 React：不依赖 slots，任何页面都能盖上来。
		 * 每 2 秒问一次本机 `/claim-info`，有 pendings 就弹第一台。
		 */
		var pairingPoll = null;
		var pairingBox = null;
		var pairingId = '';

		function closePairingBox() {
			if (pairingBox !== null && pairingBox.parentNode !== null) pairingBox.parentNode.removeChild(pairingBox);
			pairingBox = null;
			pairingId = '';
		}

		function sendPairingDecision(pendingId, action) {
			var url = LINK_ROUTE + '/pairing?action=' + action + '&pendingId=' + encodeURIComponent(pendingId);
			closePairingBox();
			fetch(url, { method: 'POST', cache: 'no-store' }).then(function () {}, function () {});
		}

		function showPairingBox(pending) {
			if (pairingBox !== null && pairingId === pending.id) return;
			closePairingBox();
			pairingId = pending.id;
			var wrap = document.createElement('div');
			wrap.style.cssText = 'position:fixed;top:0;right:0;bottom:0;left:0;z-index:2147483000;background:rgba(0,0,0,0.45);display:flex;align-items:center;justify-content:center;padding:16px;';
			var card = document.createElement('div');
			card.style.cssText = 'max-width:360px;width:100%;background:#fff;color:#1d1d1b;border-radius:16px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,0.35);font-size:14px;line-height:1.6;font-family:-apple-system,"PingFang SC","Microsoft YaHei",sans-serif;';
			var title = document.createElement('div');
			title.textContent = '有一台手机请求连接';
			title.style.cssText = 'font-size:16px;font-weight:600;margin-bottom:6px;';
			var desc = document.createElement('div');
			desc.textContent = (pending.name || '一台手机') + ' · ' + (pending.ip || '') + ' 正请求配对。手机上显示的应该是下面这组数字：';
			desc.style.cssText = 'font-size:13px;color:#555;';
			var code = document.createElement('div');
			code.textContent = pending.code || '------';
			code.style.cssText = 'font-family:ui-monospace,monospace;font-size:34px;letter-spacing:10px;text-align:center;margin:14px 0;padding:10px;background:#f4f2ee;border-radius:10px;';
			var hint = document.createElement('div');
			hint.textContent = '数字一致再点允许；不一致就是有人冒充。';
			hint.style.cssText = 'font-size:12px;color:#777;margin-bottom:14px;';
			var row = document.createElement('div');
			row.style.cssText = 'display:flex;gap:10px;justify-content:flex-end;';
			var no = document.createElement('button');
			no.type = 'button';
			no.textContent = '拒绝';
			no.style.cssText = 'border:1px solid #d8d4cc;background:#fff;color:#333;border-radius:8px;padding:8px 16px;font-size:14px;cursor:pointer;';
			no.onclick = function () { sendPairingDecision(pending.id, 'reject'); };
			var yes = document.createElement('button');
			yes.type = 'button';
			yes.textContent = '允许';
			yes.style.cssText = 'border:1px solid #2F5D50;background:#2F5D50;color:#fff;border-radius:8px;padding:8px 18px;font-size:14px;cursor:pointer;';
			yes.onclick = function () { sendPairingDecision(pending.id, 'approve'); };
			row.appendChild(no);
			row.appendChild(yes);
			card.appendChild(title);
			card.appendChild(desc);
			card.appendChild(code);
			card.appendChild(hint);
			card.appendChild(row);
			wrap.appendChild(card);
			document.body.appendChild(wrap);
			pairingBox = wrap;
		}

		function startPairingWatch() {
			if (pairingPoll !== null) return;
			var tick = function () {
				fetch(LINK_ROUTE + '/claim-info', { cache: 'no-store', headers: { accept: 'application/json' } }).then(function (res) {
					if (!res || res.ok !== true) return null;
					return res.json().then(function (payload) { return payload; }, function () { return null; });
				}, function () { return null; }).then(function (payload) {
					if (!payload || payload.ok !== true) return;
					var list = Array.isArray(payload.pendings) ? payload.pendings : [];
					if (list.length === 0) { closePairingBox(); return; }
					showPairingBox(list[0]);
				}, function () {});
			};
			tick();
			pairingPoll = setInterval(tick, 2000);
		}

		/* ───────────────────────── 入口 ───────────────────────── */

		function apply(ctx) {
			return detectRole()
				.then(function (detected) {
					role = detected;
					try { window.__dshLinkRole = detected; } catch (ignored) { /* 诊断位 */ }
					// 2026-10-29 用户要求：**不再自动弹配置窗口**。配置只在
					// 「设置 → 局域互联」里做；README 会说明怎么配。
					registerSettingsSection(ctx);
					// 电脑端：等手机来配对，弹居中确认框（框架 §4）。
					if (detected === 'desktop') startPairingWatch();
					if (detected !== 'mobile') return undefined;
					return require.async('./client.mobile.js').then(function (mobile) { return mobile.apply(ctx); });
				})
				.then(null, function (error) {
					try {
						if (ctx && ctx.logger && typeof ctx.logger.warn === 'function') {
							ctx.logger.warn('[dsh-link] client 门判定失败（按不注入处理）: ' + String(error));
						}
					} catch (ignored) { /* 不炸页面 */ }
					return undefined;
				});
		}

		exports.apply = apply;
		exports.inject = ['slots', 'uiWorkspace', 'sessions', 'workspaces', 'remote'];
		exports.role = function () { return role; };
		return exports;
	},
});
