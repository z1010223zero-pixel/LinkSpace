# LinkSpace 桌面端阶段 3 审查报告：键鼠共享 + 剪贴板同步

- 日期：2026-10-29（主会话基线 commit f423ea4，阶段 3 合并提交）
- 范围：`apps/desktop/src/main/input/`（edge/layout/protocol/session + win32/capture/native/sink）、`src/main/clipboard.ts`、host/ipc/preload/App.vue 相关接线、`verify-input.ts`、`verify-clipboard.ts`；对照 `docs/protocol.md` 4.3/4.4/4.6、`docs/threat-model.md`、上次审查 `docs/desktop-review-2026-10-29.md`
- 方法：只读审查。所有结论落到 file:line；行为断言优先引用无头测试（verify-input/verify-clipboard）；ws 库行为核查了 `apps/desktop/node_modules/ws` 源码。未运行 npm 验证套件（基线由主会话跑）。

---

## 1. 结论摘要

键鼠共享与剪贴板同步的**应用层状态机、事件收敛、回环抑制质量很高**：三层门禁（已配对 → 用户确认 → 注入前三重校验）齐备且顺序正确，五条终止路径全部触发 releaseAll，回环抑制窗口语义正确并被无头测试钉死。SendInput 手工打包经独立重算核对无误。

但发现 **1 处信任边界绕过（P1）**：对端不出示证书时，announce 的指纹校验退化为「自报值 vs 库存值」比对且无告警，配合恶意 mDNS 服务预收集身份，可冒充任意已配对设备接管其在 peers 表中的位置——剪贴板广播将静默发给攻击者。另有 4 项 P2：剪贴板开关不持久化、被控+控制并存时本机沦为输入中继、心跳超时不清会话（卡键最长约 45s）、控制通道无 maxPayload 与频率限制（威胁模型 T4 声称的缓解未落地）。

整体置信：代码事实为**确定**（全部有一手代码引文）；P1 攻击链两个前提（指纹可被收集、无证书客户端被接受）均在代码中核实，链路本身为**高置信推断**。

---

## 2. 发现列表

### P1-1 已配对设备身份可被「无证书连接 + 自报指纹」冒充（剪贴板静默外泄 / 以受害者名义发起控制请求）

**事实链**（每步均有代码依据）：

1. **peerId 取自自报信封字段，未与证书派生 id 核对**。
   `pairing.ts:346`：`const peerId = msg.from`
   `deviceIdOfCert()`（identity.ts:40-44，`dev_` + SHA-256 前 16 hex）存在但从未用于校验连入方。
2. **无证书时自报 vs 证书的比对被跳过**。
   `pairing.ts:352`：`if (actualFp && claimedFp && actualFp !== claimedFp)` —— `actualFp` 为 null（未出示证书）时整个条件短路。
3. **已信任设备的指纹核对在无证书时退化为「自报值 vs 库存值」**。
   `pairing.ts:365`：`const presented = actualFp ?? claimedFp`
   `pairing.ts:366-371`：`if (!presented || presented !== normalizeFingerprint(known)) { ...断开 }` —— 自报指纹与库存一致即放行并 `conn.peerId = peerId`。
4. **无证书客户端被服务端接受**。
   `transfer/server.ts:149`：`createServer({ key, cert, requestCert: true, rejectUnauthorized: false }, ...)` —— requestCert 只索取不强制；`control/node.ts:57-66` 对空证书返回 null。
5. **通过 announce 的连接立即占据 peers 表**。
   `host.ts:285-287`：`this.control!.on('device.announce', (conn) => { if (!conn.peerId) return; this.peers.set(conn.peerId, conn) ...})`。同一 deviceId 重入会**顶掉**真连接的映射。
6. **被冒用身份直接命中剪贴板门禁**。
   `host.ts:673-677`：`broadcastClipboard` 按 `trust.hasScope(peerId, 'clipboard')` 过滤——已配对设备默认持有该 scope（`pairing.ts:31` `DEFAULT_GRANT_SCOPE = ['file', 'clipboard']`），广播文本全部发给冒用连接。
7. **控制请求同样以受害者名义出现**。
   `host.ts:725`：`isPeerAuthorized: (peerId) => this.trust.isKnown(peerId)` —— 冒用连接的 `session.start` 过门禁进入 pending，App.vue:546 的确认条显示的是受害者 displayName。注入仍需被控端用户点「同意」，状态机本身不失守。

**攻击链**（前提均已核实）：① 攻击者在局域网架设恶意 LinkSpace 服务（mDNS 可自由广播），诱导受害设备 V 对它发起配对——V 的 `device.announce` 携带完整 deviceId（`msg.from`）与指纹，WSS 的机密性对「攻击者即 TLS 端点」无效，明文可得；② 攻击者连接任意已与 V 配对的主机 H，**不携带客户端证书**，announce 声称 `from=V.id`、`fingerprint=V指纹`；③ handleAnnounce 走已知分支回退比对通过，`peers[V.id]` 换成攻击者连接；④ H 的剪贴板广播（常含密码/令牌，威胁模型 A3）静默流向攻击者；攻击者可以 V 的名义刷控制请求（社会工程面）。

**与文档的冲突**：`docs/protocol.md` 4.1 写明「对端无法出示证书的互操作场景，退化为自报指纹比对**并记录告警**」——代码在该回退路径只打 `log.info('对端 ... 已在信任清单中')`（pairing.ts:371 附近），无告警；且回退不区分「无法出示」与「拒绝出示」，攻击者永远选择后者。

**影响**：绕过上次审查（2.4 节）确立的 TLS 指纹锚定，剪贴板外泄（高价值资产 A3）；控制注入因用户确认层仍在而未被直接攻破，故评 P1 而非 P0。该缺陷源自阶段 2 配对代码，但阶段 3 的剪贴板广播把利用价值显著放大。

**修复方向**：
- 已在信任清单的 deviceId：announce 必须**出示证书**且 `tlsFingerprint` 与库存一致，无证书一律断开（自报回退只允许给未知设备——它们拿不到任何授权）；
- 有证书时用 `deviceIdOfCert(对端证书)` 派生 id，要求 `msg.from == 派生 id`；
- 回退路径补告警日志；
- 补无头测试：无证书连接 announce 已知 deviceId 必须被断开。

---

### P2-1 剪贴板开关不持久化，每次启动强制回到开启

**证据**：
- `index.ts:289`：`startClipboardSync()` 在 `app.whenReady` 中无条件调用；
- `index.ts:148-163`：直接 `host.enableClipboardSync({...})`；
- `host.ts:639-647`：`enableClipboardSync` 置 `clipboardEnabled = true` 并 `start()`；
- `App.vue:418`：`clipboardOn.value = await window.linkspace.clipboardEnabled().catch(() => true)` —— 读回的就是主进程强制开启后的状态；仓库内无任何持久化读取（ProfileStore 只存 displayName）。

**影响**：6.6 的用户关闭选择重启即失效，对持有 clipboard scope 的已配对设备恢复静默双向同步（A3 资产）。与「关闭同步 → 完全不传输」的产品意图（host.ts:651-654 注释）在跨重启维度上不符。

**修复方向**：开关落盘（ProfileStore 或独立 settings），启动时读回并尊重；或默认关闭。

---

### P2-2 「被控」与「控制」并存时，注入输入被二次转发——本机沦为输入中继

**证据**：
- `index.ts:281`：`inputCapture?.setMode(host.controllingPeer() ? 'control' : 'idle')` —— 采集模式只看本机作为**控制端**的角色，完全不看 `controlledByPeer()`；
- `host.ts:833-841`：`requestInputControl` 不检查本机是否正被控制；
- 边缘穿越在受控期间照常武装（idle 模式持续 `edgeSwitcher.feed`，index.ts:86-93 的 onSwitch 直接发起请求）——对端可把本机光标停在边缘自动触发对第三台设备的控制请求；
- `capture.ts:96-131`：控制态采集对「光标/按键的来源」无任何概念，注入产生的事件与物理事件不可区分。

**影响**：B 控制本机期间，注入的光标移动/按键被 capture 采集并经本机已有的对 A 会话转发注入到 A——B 无需 A 侧任何授权即可借本机中继驱动 A；A 用户批准的是「本设备」，实际操作者是 B。capture.ts 头注只声明了「本机输入不被屏蔽」，未覆盖这条跨会话路径。

**修复方向**：`controlledByPeer()` 非空时强制 capture 退出 control 模式（或暂停转发并在 UI 提示）；受控期间锁定边缘触发（与 P3-5 同根，一并修）。

---

### P2-3 心跳超时不直接终止会话：断网时卡键最长约 45s，违背 8.1「立即恢复」

**证据**：
- `control/node.ts:301-314`：心跳超时回调先 `onTimeout(conn)` 再 `conn.close(4000, 'heartbeat timeout')`；
- `host.ts:258-261`：Host 的 onTimeout 只做 `this.peers.delete(conn.peerId)`，**不**终止键鼠会话；
- 会话清理依赖 close 事件：`host.ts:782-785` `control.onClosed((conn) => { this.inputCoordinator?.onPeerDisconnected(...) ... })` → `session.ts:218-225` → `endSession` → `releaseAll`；
- 拔网线/对端断电时 TCP 无 RST，close 握手等不到回应；ws 库以 `closeTimeout`（默认 30000ms）兜底 destroy：`apps/desktop/node_modules/ws/lib/websocket.js:652-653`（`@param [options.closeTimeout=30000] Duration ... to wait for the closing handshake to finish`）、1323-1328（`setCloseTimer` 到时 `socket.destroy()`）。

**影响**：合计 ≈15s（心跳判定）+ 30s（close 超时）≈ **45s** 内 releaseAll 不执行，被控端按住态（Ctrl/Win 等）不抬起，「正在被控制」横幅不消失。`docs/threat-model.md` T4 写明「断网时的输入恢复：键鼠共享断开必须**立即**恢复本机输入」。

**修复方向**：onTimeout 回调里直接调用 `inputCoordinator.onPeerDisconnected(conn.peerId)`（一行），不等 close 事件；或 host 在心跳回调里显式收会话。

---

### P2-4 控制通道无 maxPayload、无消息频率限制：T4 声称的缓解未落地

**证据**：
- `control/node.ts:137`、`157`：`new WebSocketServer({ noServer: true })` 未设 maxPayload；ws 服务端默认 **100MiB**（`node_modules/ws/lib/websocket-server.js:50` `@param [options.maxPayload=104857600]`、`:74` `maxPayload: 100 * 1024 * 1024`）；
- `control/node.ts:246-253`：JSON.parse 全量发生在主进程线程，先于任何业务校验；`clipboard.ts:112-118` 的 512KiB 上限在解析**之后**才生效——单条 `clipboard.share` 可携带 ~100MiB 文本，主进程卡顿/内存尖峰；
- `input.event` 无每连接频率上限：64 条/消息的解码限制（protocol.ts:44）不约束消息条数，洪泛时逐条解析+注入；
- `docs/threat-model.md` T4「心跳与消息有频率上限，超限断开」——代码中无对应实现（node.ts 全文无频率逻辑）。

**影响**：任意持有 clipboard scope 的已配对设备（或 P1-1 的冒用连接）可打瘫主进程（Electron 主线程被 parse 阻塞，UI 全冻结）。

**修复方向**：`maxPayload ≈ 1MiB`（512KiB 剪贴板 + 信封余量）；`input.event` / `clipboard.share` 加最小间隔或令牌桶，超限断连并回写 threat-model 落地状态。

---

### P3（加固建议）

**P3-1 handlePairApprove 的 scope 白名单包含 control**
`pairing.ts:507-508` 按 `ALL_SCOPES` 过滤（`trust.ts:17` 含 `'control'`）——对端 approve 载荷可把 control 位写进发起方 TrustStore；而接收方自己的 `grantScope()` 强制剔除（`pairing.ts:118-121`）。当前无消费者（键鼠门禁只查 `isKnown`，host.ts:725），属潜伏不一致。修复：与 grantScope 同样剔除 'control'。

**P3-2 sink.ts MOUSEINPUT 布局注释与 x64 实际不符（维护陷阱）**
`sink.ts:16` 注释「MOUSEINPUT：dx@+0 dy@+4 mouseData@+8 dwFlags@+12 time@+16 **extra@+20**」。x64 实际：ULONG_PTR 8 字节对齐，`dwExtraInfo` 在 union 内偏移 **24**（time 后有 4 字节填充）。`sink.ts:85-88` 的双写 0 恰好落在填充（UNION_OFF+20 → abs 28）与 extra 低半（+24 → abs 32），高半（abs 36-39）靠 `Buffer.alloc` 清零——**当前字节布局正确**（独立重算核对；verify-input 钉死关键偏移），但注释会把后续维护者引向错误偏移：一旦写非零 extraInfo 就会写进填充。修复：修正注释、显式写满 8 字节字段。

**P3-3 抬起事件不带 KEYEVENTF_EXTENDEDKEY**
`sink.ts:93`：`const flags = (up ? KEYEVENTF_KEYUP : 0) | (extended && !up ? KEYEVENTF_EXTENDEDKEY : 0)` —— 扩展位只作用于 down。Win32 惯例 down/up 均应携带，缺位时部分应用把 up 匹配到非扩展键序列。verify-input 只钉了普通键 up（0x41），扩展键 up 未覆盖。

**P3-4 clipboard.writeText 无异常保护**
`index.ts:159`：`writeText: (t) => clipboard.writeText(t)`，与 readText 的 try/catch（index.ts:152-157）不对称。剪贴板被其他进程独占时抛错，靠 `node.ts:280-284` dispatch 兜底吞掉；receive 的基线/抑制窗口不更新，下一轮重试并刷错误日志。

**P3-5 被控期间边缘穿越未锁定**
`index.ts:281` 只按控制角色切模式，`edgeSwitcher.feed` 在被控中持续武装——对端可把光标停在边缘触发本机向第三方发起控制请求。与 P2-2 同根，建议一并处理。

**P3-6 本机多显示器：副屏坐标钳到主屏边界导致贴边误触发**
`capture.ts:84-88`：`const x = Math.max(0, Math.min(w - 1, raw.x))` —— 光标在右侧副屏（虚拟坐标 > 主屏宽）时被钳到 w-1，`edge.ts:94` `nearRight = x >= w - 1 - EDGE_BAND_PX` 恒真，移向副屏即触发边缘穿越。capture.ts 注释只声明「防负坐标」的 MVP 降级，未提误触发面。修复：副屏在线时按虚拟屏判定或禁用边缘触发。

**P3-7 控制端挂起请求不随断连清理**
`session.ts:369-374` onPeerDisconnected 只清 active；pending 请求在对端断开后仍占住「唯一会话槽」至 32s 超时（`session.ts:319-321`），期间新请求被拒。纯可用性。

**P3-8 minor 清理**
- `node.ts:443-446` `contentDigest()` 无调用方（回环抑制已改窗口法），删除；
- `host.ts:629-631`：`String(p.text ?? '')` 把非字符串强转（对象 → `"[object Object]"`）、`kind` 缺省放行——建议收紧为 `typeof p.text === 'string'` 与 `kind === 'text'`；
- `input/layout.ts:31`、`transfer/trust.ts:44` 默认目录落在 `process.cwd()`（生产路径 Host 总是传 dataDir，host.ts:142，仅测试直构时触雷）。

---

## 3. 验证无误的方面

1. **三层信任门禁齐备且顺序正确**：① 未配对直接拒绝且**不弹 UI**（`session.ts:114-122`，防骚扰面；verify-input 测试 1）；② 用户显式 approve（`session.ts:180-196`；App.vue:546-561 确认条带风险提示与「拔掉」）；③ 注入前三重校验——`session.ts:191` `if (!active || peerId !== active.peerId)`、`:196` sessionId 匹配、`:199` decodeInputEvents 整批通过。control 为会话级内存态：配对授予时强制剔除（`pairing.ts:118-121`），verify-input 断言「配对默认无 control 授权」。
2. **无状态机绕过**：approve 前事件不注入（verify-input 测试 2「批准前的事件不注入」）；同时刻至多一个挂起/活动会话（`session.ts:160-176`，同会话重入/重传幂等区分，他人回 RESOURCE_BUSY）；TTL 过期自动拒绝（`session.ts:196-200`）；五条终止路径（对端 stop / 断连 / 撤销 / 本机终止 / app 退出）全部经 `endSession`（`session.ts:246-253`）触发 releaseAll——verify-input 测试 4/5/6/7 以 releasedB 计数逐一断言。
3. **来源核对与既有规则一致（持证前提下）**：消息路由用 `conn.peerId`（host.ts:748-778），信封自报 `from` 未被信用；`session.accept/reject` 核对发起时对端（`session.ts:342-360`「来源必须与请求的对端一致」）；旁观连接（含其他已配对设备）的事件被忽略（verify-input 测试 2/3，测试 3 用第三台真机 C 实证）。
4. **事件编解码收敛（protocol.ts）**：整批拒绝制（`protocol.ts:52-115`，未知类型/非法字段/越界坐标/NaN 任一即拒）；坐标 0..32768、wheel ±1000、vk 0..255、64 条/批（`MAX_EVENTS_PER_MESSAGE`）；`decodeScreenSize` ≥1 防除零（`protocol.ts:117-127`）；`mapPoint` round 后钳进 [0, to-1]（`protocol.ts:131-140`）。verify-input testProtocol 逐字段钉死边界。
5. **SendInput 层（sink.ts/native.ts）**：INPUT_SIZE 40（x64/arm64）/28（ia32）、UNION_OFF 8/4 与 Win32 布局一致（手工重算核对，含 union 对齐填充）；`normalizeAbsolute` 带虚拟屏偏移钳 0..65535（`sink.ts:56-65`，负偏移多屏用例在 verify-input）；`buildInputBatch` 按 events×2 分配（wheel 双轴拆条上限）、非法屏幕拒绝（`sink.ts:104-116`）；`buildReleaseBatch` 抬起并清空（`sink.ts:163-185`）；单批 ≤128 条 INPUT。轮询方案无钩子线程，native.ts 仅绑定 user32 函数、无句柄打开——**无钩子/句柄泄漏面**。加载失败全链路降级为 null 不打断启动（`native.ts:53-120`）。
6. **捕获方向（键盘记录器风险）**：idle 态只喂边缘检测不外发（`capture.ts:90-100`）；控制态才采集；采集模式由 `host.controllingPeer()` 驱动（`index.ts:281`），**被控端不采集本机输入**；模式切换清基线防瞬移/重放（`capture.ts:56-64` + verify-input 断言）；>64 条按协议分批（`capture.ts:139-143`）。轮询而非 LL 钩子的取舍及代价（滚轮不可见、极速敲击丢失）在 capture.ts 头注明确声明。
7. **剪贴板回环抑制**：抑制窗口内**不更新基线**（`clipboard.ts:85-92`，verify-clipboard 场景 4/6 专测该语义）；`start()` 建基线防启动瞬间广播存量（`clipboard.ts:71-75`）；开关关闭时 poll/receive 双向失效（running 检查，`clipboard.ts:83/102`；verify-input e2e 场景 4 双向验证 + 重开不广播存量）；512KiB 上限收发两侧（`clipboard.ts:96-100/108-112`）。
8. **剪贴板门禁**：接收侧 `hasScope(peerId,'clipboard')`（`host.ts:625-627`）、广播侧同过滤（`host.ts:676`）、用户开关三道闸；「配对默认授予 clipboard」是 protocol.md 4.4 明文设计而非缺陷。与传输桥「连接身份 == 任务对端」同一模式。
9. **撤销联动**：`revoked` 事件 → `onTrustRevoked` 立即掐断会话与挂起请求（`host.ts:787-792`、`session.ts:232-240`）；`pair.revoke` 的来源校验保持上次审查修复（`pairing.ts:592-616`：`deviceId == from == conn.peerId` + TLS 指纹比对）。
10. **IPC/preload/UI 面**：全 channel 白名单（`ipc.ts:19-56`）、preload 只暴露显式方法（preload/index.ts）、渲染层只拿快照；被控中横幅带「拔掉」（App.vue:565-575）、控制中带退出按钮 + 全局快捷键 Ctrl+Alt+Space（`index.ts:239`）；before-quit 先停采集循环再收会话，host.stop 键鼠先于通道关闭（`index.ts:322-341`、`host.ts:867-877`）。

---

## 4. 待证项

1. **Android 端能否出示客户端证书**（决定 P1-1 修复中「无证书即断开」是否破坏互操作）——查 modules/ 下 Android 工程的 WS 客户端实现；protocol.md 4.1 的回退条款暗示存在此类场景，需确认后再收紧。
2. **SendInput 对 UIPI（管理员窗口）的实际表现**——verify-input 头注明确把真实注入留给真机走查；核对 docs/manual-walkthrough-stage3.md 是否覆盖管理员窗口用例。
3. **45s 卡键上限的实测**——ws closeTimeout 兜底基于库源码推断（对 server accept 的连接同样装配，websocket-server.js:304-306），建议真机拔线实测确认。

## 5. 建议的下一步

1. P1-1 修复（announce 无证书 + 已知 deviceId → 断开；证书派生 id 核对 from）+ 配套无头测试，是唯一值得立即出修复分支的项。
2. P2-1（开关持久化）与 P2-2/P3-5（受控期间暂停采集/锁定边缘）都是 index.ts/会话层小改，可随同一分支落地。
3. P2-3/P2-4 落地后回写 threat-model.md T4 与 8.1 的缓解状态，消除「文档声称已缓解、代码未实现」的偏差。
