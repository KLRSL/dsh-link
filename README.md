# dsh-link

**在同一局域网里，把手机上的 DSH 和电脑上的 DSH 直连起来。** 手机接着用电脑的会话、看实时输出；电脑每轮跑完，把结果推回手机──无隧道、无第三方域名、无公网中继。

- 手机端不另开会话：直接驱动电脑上那一台，模型、工作区、文件都在电脑那边；
- 流量只走局域网（跨网络可选 DDNS，见下文）；
- 一个包，两端都装：启动时读 `<DSH_HOME>/dsh-remote/role.json` 的 `role`，只加载对应那一半实现。

## 它是什么、不是什么

| 是 | 不是 |
|---|---|
| 手机 ↔ 电脑 的局域网直连桥 | 远程桌面 / 投屏 |
| 手机接着用**电脑的** DSH 会话 | 手机自己跑模型推理 |
| 自签证书 + 指纹 pin 的加密链路 | 依赖任何第三方账号或云端 |
| 每轮结束把结果推回手机 | 全量会话云同步 |

## 结构

```
dsh-link/
├─ package.json            name=dsh-link，main=lib/host.js
├─ cordis.patch.yml        profile 的 loader insert 行（name 必须与包名一致）
├─ locale/                 插件卡片文案（zh/en 各写 meta.title/description）
├─ lib/
│  ├─ host.js              外壳：定 role → 只 import 对应的那一半
│  ├─ client.js            client 门：非手机端不注入任何 UI
│  ├─ client.mobile.js     生成的包内 chunk（prepack 自动重建，git 忽略）
│  ├─ desktop/             电脑端：网关 / 通知 / 设备白名单 / 配对
│  ├─ mobile/              手机端：网关 / 桥 / 插件安装 / 记忆合并
│  └─ shared/              两端共用：地址层 + 网关内核 + 发现 + DDNS
├─ scripts/                构建 chunk / 电脑给手机装插件
└─ tests/                  node 自检（npm test）
```

## 工作原理

1. **配对**：手机先发起，电脑弹卡片确认（卡上 6 位数字与手机端一致）。确认后手机进入设备白名单，拿到一把 `pairKey` 用于反向通道。
2. **通道**：两端各起一个 TLS 网关（电脑 8899 / 手机 8898），自签证书 + **指纹 pin**，不信任系统 CA。手机 → 电脑走 RPC 与 SSE 实时流；电脑 → 手机走 `agent-message` / `plugin-install`，凭 `x-link-key` + 时间戳 + **一次性 nonce**。
3. **同步**：工作区、会话镜像、实时事件、记忆条目按期同步；隐藏策略与保留天数可配。

所有运行时数据都在 `<DSH_HOME>/dsh-remote/`（默认 `~/.dsh/dsh-remote/`），不进仓库、不上传。

## 安装

两端装**同一个版本**的 tgz（版本不一致时反向通道会因 nonce 缺失而 401）：

```bash
# 1) 安装（电脑、手机各一次）
dsh plugin add --offline file:dsh-link-0.18.36.tgz

# 2) 确认/写角色：电脑 desktop，手机 mobile
#    <DSH_HOME>/dsh-remote/role.json  →  {"role": "desktop"}
#    <DSH_HOME>/dsh-remote/role.json  →  {"role": "mobile"}

# 3) 重启 DSH
```

首次启动按平台预填角色（Windows / macOS → `desktop`，其余 → `mobile`），可随时改。也可用插件配置 `{ role }` 或环境变量 `DSH_LINK_ROLE` 覆盖。

## 配对（只做一次）

1. 电脑：`设置 → 局域互联`，确认监听地址与端口（默认 `0.0.0.0:8899`）；
2. 手机：`设置 → 局域互联` → 填电脑局域网 IP 与端口 → 「测试连接」（显示证书指纹前 8 位与耗时）→「保存并连接」；
3. 电脑弹出确认卡片：卡上的 6 位数字应与手机端显示的一致，核对后点「允许」；
4. 手机状态变为「已连接」，电脑勾选的工作区自动同步过来。

> 手机连不上、提示「电脑不认识这台手机」：说明它不在白名单里 —— 重新走一次第 2~3 步。

## 日常用法

- **接续电脑会话**：手机上打开电脑页签，选工作区/会话，直接发消息，实时看输出。
- **回合结束通知**：只回投**手机发起**的那一轮（电脑本机聊天不推）；手机派活时可指定回投到哪条会话。触发条件（每轮 / 仅出错 / 仅长任务）、保留天数在 `设置 → 局域互联 → 通知推送` 里配。
- **手机 → 电脑 主动推消息**：给 agent / 本机调用方用的桥方法，无 UI：

  ```jsonc
  POST /api/dsh-remote/rpc        // 手机本地宿主桥（同源）
  { "method": "sendToDesktop", "params": { "text": "把今天的报告发我", "sessionId": "…（可选）" } }
  // { "ok": true, "sessionId": "…" } 或 { "ok": false, "error": "…" }
  ```

- **电脑给手机装插件**：`node <profile>/node_modules/dsh-link/scripts/link-install.mjs <插件.tgz>`，手机会弹一次确认卡片，点「允许」才解包安装。
- **手机给电脑推插件**：手机装了新版本而电脑还是旧的时，会自动把插件包推过去换装（电脑重启后生效）。
- **记忆同步**：同一条记忆在两端按指纹配对合并（同指纹正文变更以电脑为准；电脑侧归档会传到手机）。

## 配置

| 文件（`<DSH_HOME>/dsh-remote/`） | 用途 |
|---|---|
| `role.json` | 本机角色：`desktop` / `mobile` |
| `link.json` | 网关：`port` / `listen` / `upstreamPort` / `addressFamily` / `allowGlobal` / `discovery` / `ddns` |
| `link-peer.json`（电脑） | 反向通道：`url` / `key` / `certFp` / `notify` / `devices[]` |
| `link-client.json`（手机） | 电脑地址信任：`certFp` / `allowHost` / `allowSelfSigned` |
| `mobile.json`（手机） | 电脑端点、设备身份、`notifyTargetSession`、`resolveSources` |
| `devices.json`（电脑） | 设备白名单（**含 deviceKey，不要提交、不要外传**） |

端口：电脑网关 `8899`、手机网关 `8898`、本机中继 `17890`（电脑）/ 本机 DSH `3120`（手机）、局域网发现 `UDP 8897`。

### 网络选项

- **地址族**：`ipv4`（默认）/ `dual` / `ipv6`。IPv6 没有 NAT，全局地址默认**不监听、不写进证书**；要暴露必须显式开 `allowGlobal`（日志会告警）。
- **自动发现**：同一网段内点「自动查找」即可找到电脑（UDP 广播，约 0.1~2 秒）。**找到 ≠ 信任**，仍要走配对与 pin。广播不过路由器。
- **跨网络（可选）**：电脑把当前地址写到**你自己的**服务器（`ddns`），手机从 `resolveSources` 读回来。必须 https；不配就等于没有这一层。

## 安全边界

| 接触面 | 门槛 | 说明 |
|---|---|---|
| `GET /link/ping` | 无 | 只回 `{ok,name,ver,fp}`，供「测试连接」用 |
| 反代路径 | 电脑：设备白名单 + HMAC；手机：回环放行，非回环必须 `x-link-key` + 时间戳 + nonce | 验不过一律 403，绝不转发 |
| `POST /link/claim` | 手机发起 + 电脑卡片确认 | 桌面端确认只允许本机回环调用 |
| 电脑 → 手机通道 | `x-link-key` + 时间戳 + 一次性 nonce | nonce 缺失 401、重放 401 |

明确的取舍：

- **自签证书 + 指纹 pin，不用 CA**：首次配对没有第三方背书（TOFU），此后每次请求都严校指纹；
- **未 pin 就不发**：`link-peer.json` 没有 `certFp` 时通知直接放弃并记日志 —— 不发比发错人好；
- **`allowSelfSigned` 只决定传输方式，不决定信任谁**：主机是否可信只看配对时记下的 `allowHost`；
- **`listDirectory` 能浏览全盘目录树**（产品功能），但 `$DSH_HOME` 及其后代、`.ssh` / `.aws` / `AppData` 一类凭据目录列不出来；
- **证书 SAN 漂移只告警、不自动重签**（重签会换指纹 ⇒ 要重新配对）。

## 刻意不做的事

- 不做公网中继 / 第三方隧道服务：跨网络只支持「写到你自己的服务器」；
- 不要求注册任何外部账号；
- 不做虚拟组网（Tailscale / WireGuard 那一类要额外装 App）；
- 不做网络层门禁（防火墙、单包授权属于操作系统与路由器）；
- 不做云端同步与托管。

## 排障速查

| 现象 | 原因 | 处理 |
|---|---|---|
| 手机连不上 | 不同网段 / 端口被占 | 确认同一局域网；看电脑端日志 `监听失败 … EADDRINUSE` |
| 「电脑不认识这台手机」 | 不在白名单 | 手机重新发起配对，电脑点「允许」 |
| 通知不推送 | 该轮不是手机发起的 / 手机没指定回投会话 / `notify=false` | 看电脑端日志 `notify 跳过（…）` 的具体原因 |
| 通知发不出（网络类） | 手机网关没起来 / 手机不在线 | 确认手机 DSH 在前台运行、8898 可达 |
| 日志 `未 pin 证书指纹` | `link-client.json` 缺 `certFp` | 重新配对，或手写指纹 |
| 日志 `证书指纹不符` | 对端重装后证书重生成 | 手机解绑后重新配对 |
| 本机 link 路由 503 | 引擎 `connection` 服务未就绪 | 刷新页面；持续出现看引擎日志 |
| 一律 401 | 两端版本不一致（旧版不带 nonce） | 两端升到同一版本 |

## 开发与测试

```bash
npm test        # 语法检查 + 行为自检（全绿才算过）
npm run build   # 由 lib/mobile/client.js 重建包内 chunk
```

改 client 半边时注意：`lib/client.js` 必须是经典脚本 bundle（不能写 `import`），手机 UI 是包内 chunk（`client.mobile.js`），由 `scripts/build-client-chunk.mjs` 生成。

## 版本历史

| 版本 | 变更 |
|---|---|
| 0.18.36 | 当前版本。局域网直连主链路：两段式配对（手机发起 → 电脑确认，不再手输码）、设备白名单 + HMAC + 一次性 nonce、IPv6 / 双栈、局域网发现、可选 DDNS、电脑 → 手机通知（只回投手机发起的回合）、手机 → 电脑 `sendToDesktop`、插件双向分发、记忆同步、会话镜像与预载、桌面配置向导。 |
| 0.18.x | 稳定性与真机问题收口：seq 平移与预载历史、镜像会话唤醒、归档会话处理、通知标题三级回落、pairKey 自愈、插件版本查询不依赖会话服务。 |
| 0.2.0 | 首次连接配置向导（`/api/dsh-remote/link/setup`），工作区多选与四档隐藏策略（两端 LWW 合并、删除优先、本机隐藏永不上传），验证码 5 分钟倒计时，配对状态 3 秒轻轮询；UI 去渐变/毛玻璃/emoji，改单一强调色。 |
| 0.1.5 | 记忆同步 `fp` 兜底：两端 `dsh-memory-layer` 版本错开时按归一正文配对，并回写指纹。 |
| 0.1.4 | 手机 → 电脑主动推消息（`agentMessage` / `sendToDesktop`）；通知收口目标 `notifyTargetSession`（首启固定、失效回退）。 |
| 0.1.3 | 记忆同步修正：同 `fp` 正文变更以电脑为准、归档/墓碑同步、手机独有按全量快照判断；合并决策抽成纯函数并补单测。 |
| 0.1.2 | 通知重试（20s 超时 / 重试 2 次 / 指纹缓存 5 分钟）；手机端 `/link/plugin-install` 与 `scripts/link-install.mjs`。 |
| 0.1.1 | 中继令牌单一事实来源；设备签名白名单。 |
| 0.1.0 | 单包：desktop/mobile 按 `role.json` 分半加载；局域网直连面板、设备白名单、通知。 |

## 来源与许可

MIT。衍生自 [`pht88888888/dsh-jiuling-remote-plugins`](https://github.com/pht88888888/dsh-jiuling-remote-plugins)（MIT），保留原作者版权；在此基础上移除公网隧道链路，改为局域网 TLS 直连，并补齐双向唤醒、通知、设备白名单与插件分发。
