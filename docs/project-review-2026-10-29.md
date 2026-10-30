# LinkSpace 项目审查报告（2026-10-29 · 第二次全项目审查）

> 审查基线：commit `f423ea4`（阶段 3 合并）。增量对照：`4083353`（上次审查报告 docs/desktop-review-2026-10-29.md 对应提交）→ HEAD。
> 范围：全项目——桌面端自上次审查以来的全部增量（约 1.5 万行）、**Android 客户端（约 3300 行，首次审查）**、文档与验收声明一致性、仓库自身全部无头校验套件的运行结果。
> 方法：4 路并行只读子审查（Android / 键鼠+剪贴板 / 传输发现增量 / 文档一致性）+ 主会话对全部 P0 与关键 P1 逐条亲核代码 + 实际运行 typecheck 与 11 个无头 verify 套件。详细证据见 `review-tmp/` 下四份子报告（android.md、desktop-input-clipboard.md、desktop-core-delta.md、docs-consistency.md）。

---

## 1. 结论摘要

**整体判断**：桌面端在阶段 2 修复后确立的安全门禁本体全部保持完好（token 三合一、块摘要、TLS 锚定、revoke 校验、路径清洗等九项逐一核对未被回退），阶段 3 的键鼠共享与剪贴板同步的应用层状态机质量很高。但本轮发现：

| 级别 | 桌面端 | Android 端 | 文档 | 合计 |
|---|---|---|---|---|
| P0 | 1 | 3 | — | **4** |
| P1 | 1 | 5 | — | **6** |
| P2 | 5 | 6 | 9 | 20 |
| P3 | 8 | 8 | — | 16 |

四个 P0 中三个在 Android（该端上次审查时「未提交的在途工作」被明确排除在外，本次证实其**尚未达到桌面端 2.4 修复后的安全基线**），一个在桌面端（无证书连接可冒充已信任设备，剪贴板与挂起文件内容可被任意局域网主机窃取）。**在 P0 修复前，不建议两端继续配对使用。**

最严重的一条攻击链（已逐行核实）：**任意局域网主机连接一次目标设备即可采集其完整 deviceId+指纹，随后无证书冒充该已配对设备——剪贴板内容无条件外泄；若存在挂起的等待传输任务，攻击者还能通过自附 token + GET 下载方向拿到文件全文。** 该链同时暴露了桌面端（指纹回退无告警）与 Android（服务端完全不校验身份）两处的同一根因：**身份声明与 TLS 会话没有强制绑定**。

---

## 2. 桌面端发现

### 2.1 P0 —— 无证书连接可冒充已信任设备（剪贴板无条件外泄；挂起文件全文可被窃取）

**这是本次审查最重要的发现。** 攻击链每一环都有代码依据（主会话逐行核实）：

1. **指纹可采集**：任何连接完成 announce 后，本机都会回送自己的 announce（含完整 deviceId 与指纹）——`pairing.ts:381-389`。攻击者连一次目标设备即可拿到其身份二元组。
2. **peerId 取自自报信封**：`pairing.ts:346` `const peerId = msg.from`；`deviceIdOfCert()`（identity.ts:40-44）存在但从未用于核对连入方。
3. **无证书时第一道比对被跳过**：`pairing.ts:352` `if (actualFp && claimedFp && ...)` —— `actualFp` 为 null（客户端拒不出示证书，`requestCert: true` 只索取不强制，control/node.ts:154-155）时整个条件短路。
4. **已知设备路径退化为「自报值 vs 库存值」且无告警**：`pairing.ts:365` `const presented = actualFp ?? claimedFp` —— 攻击者自报受害者的指纹即通过，随后 `conn.peerId = peerId` 注册为受害者。上次审查报告 2.4 声称该回退「记告警」，代码中实际只有 `log.info('已在信任清单中')`，**协议文档 4.1 承诺的告警不存在**。
5. **冒充连接顶掉真连接**：`host.ts:287` `this.peers.set(conn.peerId, conn)`（Map 覆盖同键）。
6. **剪贴板外泄**：`host.ts:676` 广播按 `hasScope(peerId,'clipboard')` 过滤——已配对设备默认持有该 scope（`pairing.ts:31`），文本全部流向冒用连接。**无需任何等待条件。**
7. **挂起文件全文外泄**（需存在 waiting 发送任务）：announce 触发 `flushWaitingOffers`（`host.ts:295`）→ 攻击者收到 offer（含 transferId 与文件名）→ 回 `transfer.accept` 自附 token（处理器只核对连接身份==任务对端，`host.ts:543`）→ `attachToken` 生效（`host.ts:545`）→ 数据面 GET：三闸 `isKnown(受害者)✓ + hasScope✓ + verifyToken(任务键, 自附token)✓`（`host.ts:242-245`）全部通过，`resolveOutgoing` 对 send 任务返回本地源文件（`manager.ts:168-171` 在任务创建时即登记全部源文件路径）→ **文件字节流向攻击者**。推送方向因入站连接无端点登记会失败（`host.ts:547-551`），但 GET 方向不受影响。

**修复方向**（一次修复同时闭合 2.2 的 P1）：
- 已在信任清单的 deviceId：announce 必须出示证书且指纹与库存一致，无证书一律断开（自报回退仅允许未知设备——它们拿不到任何授权）；
- 有证书时用 `deviceIdOfCert(对端证书)` 派生 id，要求 `msg.from == 派生 id`；
- 回退路径补告警；补无头测试「无证书连接 announce 已知 deviceId 必须被断开」。

### 2.2 P1 —— 撤销信任不清挂起任务，补发链对已撤销设备开放

子审查判 P0，主会话核实后**按实际可达性下调为 P1**，条件如下：

- 撤销只删 peers 不清任务（`host.ts:304-307`）；`flushWaitingOffers` 不复查信任与授权（`host.ts:437-447`）；`transfer.accept` 处理器无 `hasScope` 检查（`host.ts:536-570`）。
- 被撤销设备持原证书重连即可通过声明门禁（`pairing.ts:343-390`），收到挂起任务的 offer 并完成 accept/token 交换。
- **字节级交付受两道既有闸限制**：数据面 `verifyTransfer` 的 `isKnown(已撤销id)` 为 false（GET/POST 均被拒，`host.ts:242-245`）；推送方向还需发送方存在对该端点的外连登记（入站重连无端点，`host.ts:547-551`）。因此实际影响 = offer 元数据（文件名/大小）泄露 + accept/token 握手对已撤销设备开放 + 特定条件（发送方存在外连端点且对端仍信任本机）下文件字节外流。
- 与 2.1 叠加时（攻击者冒充的是**未撤销**设备），数据面闸门全部放行——2.1 已覆盖最坏情况。

**修复方向**：`flushWaitingOffers` 补发前复查 `isKnown + hasScope('file')`；`onRevoked` 取消该 peer 全部未完成任务；accept 处理器补 `hasScope`。三层建议全做。

### 2.3 P2（5 项）

| # | 问题 | 位置与要点 |
|---|---|---|
| P2-1 | 剪贴板开关不持久化，重启强制回开 | `index.ts:289` 无条件 `enableClipboardSync`；用户关闭的选择重启即失效，恢复静默双向同步。两路子审查独立发现。开关落盘 + 默认值建议取「关」 |
| P2-2 | waiting→offered 后对端掉线，任务永久卡死 | `manager.ts:183-186` markOffered 只吃 waiting，无 offered→waiting 回退；4.9「上线自动补发」在半路断连场景静默失效 |
| P2-3 | 被控+控制并存时本机沦为输入中继 | `index.ts:281` 采集模式只看控制角色；B 控制本机期间注入事件被二次转发给 A，B 无需 A 侧授权即可借本机驱动 A。受控期间应强制退出采集/锁定边缘触发 |
| P2-4 | 心跳超时不直接终止会话：断网卡键最长约 45s | `host.ts` onTimeout 只删 peers；releaseAll 依赖 close 事件（ws closeTimeout 默认 30s）+ 心跳 15s ≈ 45s。威胁模型 T4 要求「立即恢复本机输入」。修法：onTimeout 里直接 `onPeerDisconnected`（一行） |
| P2-5 | 控制通道无 maxPayload、无消息频率限制 | `node.ts:137/157` 未设 maxPayload（ws 默认 100MiB），单条 clipboard.share 可携 ~100MiB 文本阻塞主进程；T4「消息频率上限，超限断开」未落地。建议 maxPayload≈1MiB + input.event/clipboard.share 限频 |

### 2.4 P3（8 项，摘要）

`sanitizeDisplayName` 不清 C1 控制符与 U+202E（显示层欺骗）；`device.rename` 无频率限制；挂起任务无上限无超时；来源门禁对 CGNAT/VPN overlay（100.64/10）放行且与发现层判定矛盾（建议文档写明）；`resolveBindAddress` 仅 IPv4；accept 处理器校验前入 peers 表；MOUSEINPUT 布局注释与 x64 实际不符（extra@+20 vs 实际 union+24，当前双写 0 掩盖）；KEYUP 缺 EXTENDEDKEY 位、writeText 无 try/catch、多显示器副屏贴边误触发、控制端 pending 请求不随断连清理、`contentDigest()` 死代码、`String(p.text ?? '')` 类型收紧、默认目录落 `process.cwd()`。完整清单见 review-tmp 两份桌面报告。

### 2.5 桌面端验证无误的方面（择要）

- 九项既有安全门禁本体全部未回退：token 三合一（`server.ts:224-228` + `host.ts:242-246`）、块摘要（`server.ts:287-293`）、TLS 指纹锚定（持证路径）、revoke 来源校验、配对上限 8、offer 门禁、accept/reject/cancel/complete 身份核对、sanitizeFileName、32MiB 上限。
- 键鼠共享：三层门禁（未配对直接拒绝不弹窗 → 用户确认 → 注入前三重校验+整批拒绝解码+双重坐标钳制）齐备；五条终止路径全部 releaseAll；control 授权会话级内存态不落盘；SendInput 手工打包经独立重算核对无误；采集为轮询方案，无钩子/句柄泄漏面。
- 剪贴板：收发双向 scope 门禁、512KiB 上限、回环抑制窗口语义正确并被测试钉死。
- 心跳超时真正关连接；rename 只能改自己条目；IPC 白名单参数全校验，渲染层无注入面；退出路径全量清理（含 globalShortcut.unregisterAll）。

---

## 3. Android 端发现（首次审查）

**总体判断**：功能链路完整（发现→配对→收发→剪贴板），数据面 token/偏移/落盘策略与桌面对齐良好，上次审查遗留的「发送方补 digest 头」已完成（LinkSpaceClient.kt:130）。但**上次审查确立的信任机制在 Android 端整体缺席**，三个 P0 全部成立（主会话逐行核实）。

### 3.1 P0（3 项，均经主会话亲核）

**P0-1 发送方 TLS 盲信任**（LinkSpaceClient.kt:41-58）：`BlindTrust` 空实现信任一切证书，全文件无一处读取 `peerCertificates` 比对指纹。ARP/假 mDNS 把连接引向攻击者即可整体接管控制通道，截获文件全文、身份指纹与数据面 token。威胁模型 T3 要求的「指纹绑定，不符即断开」在客户端方向完全缺失。修法：握手后取 `session.peerCertificates[0]` 算 SHA-256 与 TrustStore 比对，不符断开。

**P0-2 服务端身份可伪造 + token 广播 + revoke 无校验**（TransferServer.kt:66,399,406-412；LinkSpaceService.kt:242-244,752-770）：
- TLS 不索证（无 `setWantClientAuth/setNeedClientAuth`）；连接身份 = 自报 `from`（`TransferServer.kt:399`）；
- `transfer.accept` **连 token 一起 `sendControl` 广播给所有未认证连接**（`LinkSpaceService.kt:765-773`，信封 `to` 还暴露任务对端完整 deviceId）——注意 `sendControlTo` 定向发送方法已存在（TransferServer.kt:414-424）却未用于此；
- `pair.revoke` 仅凭自报 `from` 即删信任（`LinkSpaceService.kt:242-244`），协议 §4.1 明确要求的双校验完全缺失；
- 攻击者收割 token + deviceId 后：可读写在传文件分块、无条件删除本机对任意桌面端的信任、定向接收剪贴板。
- 修法：`setWantClientAuth(true)` + announce 指纹三道闸（桌面 `pairing.ts:347-369` 可移植）+ accept 定向发送 + revoke/cancel/complete 绑定 `conn.peerId`。

**P0-3 未认证远程 DoS**（TransferServer.kt:533-560）：`val body = ByteArray(contentLength)`（上限 2^31-1）在**任何鉴权之前**分配；头行逐字节拼接无长度上限；`handleConnection` 无 catch，`OutOfMemoryError` 直接杀死进程。同网段任何设备单个报文即可令应用崩溃且可反复触发。协议 §5 的 32MiB 上限未实现。修法：先鉴权后限长读体、头行限长 32KB、体超 32MiB 回 413、并发与速率上限。

### 3.2 P1（5 项）

| # | 问题 | 位置与要点 |
|---|---|---|
| P1-4 | 接收文件名不收敛 → 路径穿越写 / 接收必崩 | `TransferServer.kt:97,437` name 直接来自网络；`../../x` 可越界写（API 26-28 + 旧存储权限下可写公共存储），非法名令 `createNewFile` 抛异常且 acceptTransfer 无捕获 → 点「接收」即崩。对照协议 §4.5 与桌面 sanitizeFileName |
| P1-5 | 配对码可在线穷举 | `Math.random()` 非 CSPRNG（LinkSpaceService.kt:358）；错码不计数不销毁（:388-401，桌面为 5 次断连）；pending 无上限。多连接并行分钟级可破，命中即获 file+clipboard 授权 |
| P1-6 | 数据面不校验块摘要；整体摘要可缺省放行 | POST 分支无 `X-Chunk-Digest` 读取（TransferServer.kt:311-345）；`finalizeTransfer` 在 complete 不带 digests 时跳过整体校验（:156-163）。篡改分块静默落盘 |
| P1-7 | `transfer.cancel/complete` 不核对任务对端 | `LinkSpaceService.kt:299-315` 只取 transferId；未认证连接可取消他人任务、伪造 complete 删他人 `.part`（`TransferServer.kt:158-166`） |
| P1-8 | 发送方分块 URL 不编码组合键 | `LinkSpaceService.kt:622,633` 文件名含空格/中文/`?` 即发送必失败——SAF 文件名极常见，主流程对一大类文件必坏 |

### 3.3 P2（6 项，摘要）

监听 0.0.0.0 且无来源地址门禁（T0 在 Android 无对应物）；配对码明文写 logcat（T5 明确禁止，LinkSpaceService.kt:384）；offer 无文件数/大小上限（可磁盘耗尽）；GET `length` 无 32MiB 上限（已认证 OOM）；无前台服务——进程被杀即全部下线，与「随时可被发现」设计意图矛盾；信封 §3 语义校验（v/to/ts）两端均未实现（协议与两套实现的整体偏差）。

### 3.4 P3（8 项，摘要）

剪贴板无本地开关 + 抑制窗口共享变量无同步；Discovery 软过期未实现；错误响应无 Content-Length；finalize 部分成功不回滚；cancel 与 append 竞态可产孤儿 `.part`；Identity 密钥明文 PEM 存内部存储（建议 AndroidKeyStore）+ 非原子写损坏即启动崩溃循环；主线程 RSA 生成与 IO（首启 ANR 风险）；死字段/死权限/`transfer.progress` 从不发送/`URLDecoder` 把 `+` 解成空格/`renameTo` 返回值未检查。完整清单见 review-tmp/android.md。

### 3.5 Android 端验证无误的方面（择要）

明文流量关闭（无 usesCleartextTraffic，全 TLS）；数据面 token/409 偏移/探针/防覆盖/落盘双校验与协议一致；剪贴板 scope 门禁 + 512KiB + 防循环与桌面同款；配对码不出网（challenge 只带 expiresAt）；mDNS TXT 无密钥材料；信任存储 tmp+rename 原子写、`allowBackup=false`、默认 scope 不含 control；WS 帧长上限 16MB。

---

## 4. 文档与事实一致性

协议新增章节（rename/clipboard/4.6 键鼠）与两端实现**高度一致**；验收文档声称的自动化脚本**全部真实存在且是硬断言**（未发现「只打日志不断言」的虚标）。问题集中在**状态文档滞后**：

| 级别 | 不符项 | 要点 |
|---|---|---|
| P2 | 根 README「当前状态」整体过期 | 仍称「Android 尚未开始、仅 Windows↔Windows、四组验证、阶段 2 进行中」；实际 Android 主体+真机验证、10 个 verify 脚本、阶段 3 已合入；「仅绑定局域网网卡」未勾选但已实现 |
| P2 | apps/desktop/README「已知限制」整节过期 | 仍称「配对未实现、cancel 未接入、接收侧不校验块摘要」，全部已被实现与测试断言推翻，且与本文件上部新章节自相矛盾 |
| P2 | apps/android/README 与代码相反 | 称「文件只做接收方、无发送入口」，实际 sendFiles/「发送文件」按钮俱全，且与其自述职责矛盾 |
| P2 | protocol.md 三处字段级缺口 | 缺 `pair.submit` 消息行（node.ts:12 注释却称「已回写」）；心跳 payload `{sessions:[...]}` 未实现（两端发空对象）；4.6 `input.event` 漏写 sessionId 字段 |
| P2 | architecture.md 零更新 | 进程模型仍写「输入注入由 windows-helper.exe(.NET) 承载」，实际为 koffi 进程内 FFI，且 koffi 选型无 ADR（理由只在 native.ts 注释） |
| P2 | threat-model 新攻击面未同步 | 本批仅补了 T0；rename 伪造/注入滥用/剪贴板门禁/waiting 队列的缓解均已实现但未登记；T5「剪贴板只记录摘要」是废弃方案遗留措辞 |
| P2 | roadmap 阶段 2/3 无状态标注；docs/README.md 状态列过期（键鼠仍标「未实现」） | — |
| P2 | docs/manual-walkthrough-stage3.md 未纳入版本控制 | 与 HANDOVER 遗留债 #6 同类问题；建议 `git add` |
| P2 | HANDOVER「七项无头脚本」漏列当时已存在的 verify:clipboard | 快照文档建议加显式失效标注 |

存疑项（只读审查无法复核，按「无法核实」处理而非不符）：安装包/防火墙/卸载/SBOM 的「实测通过」声明与配置侧一致；4.2 传输速率数值；6.7「日志出口」为间接断言覆盖。

---

## 5. 仓库自身校验运行结果（基线）

2026-10-29 在本机实际运行（HEAD = `f423ea4`，两台 adb 设备在线），**全部通过**：

| 套件 | 结果 |
|---|---|
| `npm run typecheck`（vue-tsc 全仓类型） | 通过（exit 0） |
| `npm run verify`（entry：adb 枚举、scrcpy 会话启停/并发拒绝/清理） | 通过 |
| `verify:transfer` / `verify:pairing` / `verify:e2e` | 通过 |
| `verify:layout` / `verify:net` / `verify:heartbeat` | 通过 |
| `verify:clipboard` / `verify:input` / `verify:mdns` | 通过（verify:input 结尾「全部通过」，日志无真实 FAIL 项） |

两点说明：
- **Android 编译未复跑**：本机 PATH 无 gradle（工程也未提交 wrapper），`mvp-acceptance` 5.4「assembleDebug 编译通过」离线无法复核（与第 4 节文档核查的存疑项 S-5 一致）。
- 校验结果与第 2/3 节发现不矛盾：全部套件均为绿，但 P0/P1 都在**套件未覆盖的路径**上——撤销后补发的授权复查、无证书冒充、Android 侧门禁，这正是本报告建议补无头用例的原因。

---

## 6. 跨端根因与修复优先级

四个 P0 与两个 P1 共享同一根因：**「身份声明」与「TLS 会话」的绑定存在缺口**——桌面端已知设备回退比对自报值（2.1）、Android 服务端不索证且身份=自报（3.1 P0-2）、Android 客户端盲信任（3.1 P0-1）、数据面 deviceId 来自可伪造的 `X-Device-Id` 头（放大 2.1 的利用面）。统一修法：

1. **身份锚定**：deviceId 一律从对端 TLS 证书派生（`deviceIdOfCert`），announce/from 自报值仅作展示；已知 deviceId 无证书即断开；Android 服务端 `setWantClientAuth(true)`、Android 客户端握手后指纹比对 TrustStore。
2. **授权复查前置**：flush 补发、accept 处理器补 `hasScope`；revoke 级联取消挂起任务（桌面）。
3. **Android 安全基线对齐桌面**：先鉴权后读体 + 32MiB 上限、文件名收敛、块摘要必校验、cancel/complete/accept 绑定连接身份、SecureRandom + 尝试上限、组合键 percent-encode。

建议修复顺序（按风险/成本比）：
1. 桌面 2.1 + 2.2 同一分支（改动集中在 pairing.ts/host.ts，桌面端有现成测试基建可立即补无头用例）；
2. Android P0-2 最小闭环（wantClientAuth + 三道闸 + accept 定向 + revoke/cancel/complete 绑定 conn）——桌面端有现成实现可对照移植；
3. Android P0-1 / P0-3 / P1-4 / P1-6（集中在 LinkSpaceClient.kt 与 TransferServer.kt 两个文件）；
4. 桌面 P2-1/P2-4/P2-5 与 Android P1-5/P1-8；
5. 文档批量刷新（第 4 节清单一次清完），`git add docs/manual-walkthrough-stage3.md`。

---

## 7. 审查方法与证据附注

- 4 路子审查报告（含全部 P2/P3 细节与「验证无误」完整清单）：`review-tmp/android.md`、`review-tmp/desktop-input-clipboard.md`、`review-tmp/desktop-core-delta.md`、`review-tmp/docs-consistency.md`。
- 全部 P0 与关键 P1 由主会话逐一打开源码核实（本报告第 2.1/2.2/3.1 节的引用行号均为核实后确认）；子审查结论与主会话核实不一致处（2.2 的定级）已按证据下调并注明理由。
- 仓库自身校验：typecheck + 11 个无头 verify 套件在本机实际运行，结果见第 5 节。
- 审查为只读，未修改任何项目文件。
