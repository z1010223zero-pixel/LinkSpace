# LinkSpace 文档与实现一致性核查报告

- 核查日期：2026-10-29（HEAD = `f423ea4`，基线 = `4083353`，即上次审查报告对应提交）
- 方法：只读审查。文档不可信、代码为准；未运行任何 npm 验证套件（基线由主会话在跑），只核对脚本内容与文档声称是否匹配。`exec` 仅用于只读命令（git log/show/diff、目录列举）。
- 证据约定：每条结论给出两侧证据（文档行号 vs 代码 file:line）。标注【确定】的结论两侧证据均已直接读到；标注【推断】的是由证据合理推出但未逐行复核的部分。

---

## 一、结论摘要

协议新增章节（`device.rename`、`clipboard.share`、4.6 键鼠共享）与两端实现**高度一致**，验收文档声称的自动化脚本**全部真实存在且是硬断言**（未发现「只打日志不断言」的虚标）。主要问题集中在**文档滞后**：根 README、apps/desktop/README、apps/android/README 三处的「当前状态/已知限制」仍停留在旧阶段，与 git log 事实直接矛盾；protocol.md 漏掉两端都已实现的 `pair.submit` 消息、心跳 payload 与实现不符；architecture.md 自 4083353 起零更新，进程模型仍写「输入注入由 windows-helper.exe(.NET) 承载」而实际是 koffi 进程内 FFI；threat-model 只补了 T0，键鼠/改名/离线补发的新攻击面未同步；roadmap 阶段 2/3 无状态标注。

---

## 二、不符项

### P1-1 根 README「当前状态」与 git 事实矛盾（多处）
**文档**：[README.md](../../README.md)
- :21 「阶段 2：文件共享与配对 —— 进行中」；无阶段 3 条目。
- :31 「Android 客户端（Kotlin）尚未开始，目前只能 Windows ↔ Windows」
- :30 「[ ] 传输服务仅绑定局域网网卡（…）」未勾选，但括号内文字自述「已实现自动收窄」
- :28 「四组无头验证全部通过」

**代码/事实**：
- Android 主体已合入并有真机验证：git log `ceefcf6 feat(android): 接收端主体与 Windows↔Android 真机跨平台验证`、`27e2df6 feat(android): 主动发送文件到桌面端（任务 #22）`；`apps/android/` 全套实现（MainActivity 478 行、LinkSpaceService 821 行等）。
- 绑定收窄已实现：`apps/desktop/src/main/transfer/server.ts:77-105`（resolveBindAddress：LINKSPACE_BIND_IP > 唯一局域网 IPv4 > 0.0.0.0+来源门禁）、`apps/desktop/src/main/net-scope.ts`（来源地址门禁，91 行）。
- 阶段 3 已收尾：git log `08bb271`（剪贴板）、`42f24d4/58093c1/fe5bdae/f423ea4`（键鼠共享与合并）；另有心跳（`d133273`）、重命名（`d8ed12c`）、离线补发（`7829fcf`）、NSIS+SBOM（`a2b35f2`）。
- 验证脚本现为 10 个：`apps/desktop/package.json` scripts 含 verify / transfer / pairing / e2e / layout / net / heartbeat / clipboard / input / mdns。

**结论**：【确定】不符。README 状态区整体停留在「阶段 2 中段」，未反映阶段 3 与 Android 主体。置信：高（多项独立证据同向）。

### P1-2 apps/android/README.md 声称「文件只做接收方、无发送入口」，与代码相反
**文档**：[apps/android/README.md](../../apps/android/README.md)
- :3 「**文件是接收方**（通告自身、接受配对、接收文件）」
- :106 「**文件只做接收方**：不主动连接桌面端推送文件」
- :108 「界面没有发送文件的入口」
- :29 「**接收端主体已实现（2026-10-29）**，等待真机联调」

**代码**：
- 发送链路完整：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceService.kt:526`（`suspend fun sendFiles(peer, files)`）、:542/:680（registerOutgoing 登记任务）、:547-560（发送期间心跳保活）、`LinkSpaceClient.kt:19`（「主动连接对端的客户端（Android 作为发送方时使用）」）。
- UI 入口存在：`MainActivity.kt:309`（按钮 `Text("发送文件")`）、:122-131（SAF OpenMultipleDocuments 选文件）、:326-370（发送确认对话框）。
- 对应提交：`27e2df6 feat(android): 主动发送文件到桌面端（任务 #22）`；真机联调已做：`ceefcf6`、`docs/technical-validation.md` §2.8（Windows↔Android 剪贴板真机验证）。

**附带**：该 README :9「职责：文件传输的接收**与发送**端」与 :106 自相矛盾。架构清单（「架构」小节 7 个文件）也漏了已存在的 `ClipboardSync.kt` 与 `LinkSpaceClient.kt`。

**结论**：【确定】不符（README 落后于 #22 提交）。置信：高。

### P1-3 apps/desktop/README.md「已知限制」整节过期，与本文件新章节自相矛盾
**文档**：[apps/desktop/README.md](../../apps/desktop/README.md)
- :5 「当前是**可运行的原型**…（**发现与配对尚未实现**）」
- :221 「**设备发现与配对未实现**：…`isKnownDevice` 恒为 false」
- :224/:231 「传输服务绑定 0.0.0.0，应改为仅局域网网卡」
- :226 「`transfer.cancel` 未接入控制通道」
- :228 「块级摘要只在发送侧计算：接收侧未校验（验收项 4.6 未完成）」
- :230 「只能 Windows ↔ Windows：Android 客户端（Kotlin）尚未开始」
- :232 「设备布局拖拽、剪贴板同步未实现」

**代码/事实**：配对实现于 `pairing.ts`（PairingCoordinator 完整状态机）；取消跨端传播在 `host.ts` wireTransferBridge（`transfer.cancelRequested` → `conn.send('transfer.cancel', …)`）且 `verify-e2e.ts` 第 5 节断言「B 侧收到取消并进入 cancelled、.part 已清理」；接收侧块摘要校验在 `transfer/server.ts`（X-Chunk-Digest 不符 400）且 `verify-transfer.ts` 第 9 节断言；其余同 P1-1 证据。

**结论**：【确定】不符——同一文件上部（mDNS 网卡选择、监听地址与来源门禁等章节）已更新，下部「已知限制」未清，读者会得到完全相反的结论。置信：高。

### P2-4 protocol.md 缺 `pair.submit` 消息定义，而代码注释声称「已回写」
**文档**：[docs/protocol.md](../../docs/protocol.md) §4.1 消息表（device.announce / pair.request / pair.challenge / pair.approve / pair.reject / pair.revoke / pair.error / device.rename）——**无 `pair.submit` 行**（4083353 版同样没有，`git show 4083353:docs/protocol.md` 搜 "submit" 无命中）。
**代码**：
- 桌面：`apps/desktop/src/main/pairing.ts:146`（`.on('pair.submit', …)`）、:337（`conn.send('pair.submit', { code })`）。
- Android：`Protocol.kt:27`（`TYPE_PAIR_SUBMIT = "pair.submit"`）。
- `apps/desktop/src/main/control/node.ts:12` 注释明确写「由 pair.submit 送回。**已回写到 docs/protocol.md**」——与事实不符。

**结论**：【确定】不符（文档缺口，消息语义本身两端一致：码只显示在接收方、人工抄录后由发起端 submit，challenge 不携带码——这一意图文档已写，缺的是消息行本身）。置信：高。

### P2-5 protocol.md 心跳 payload「{ sessions: [...] }」未实现（两端都发空对象）
**文档**：[docs/protocol.md:94](../../docs/protocol.md) 「`device.heartbeat` | 双向 | `{ sessions: [...] }` | 建议 5s 一次，**携带会话摘要用于状态对账**」
**代码**：
- 桌面：`apps/desktop/src/main/control/node.ts:316` `conn.send('device.heartbeat', {})`。
- Android：`LinkSpaceService.kt:556` `envelope(Protocol.TYPE_HEARTBEAT, peerFullId) {}`（空 payload）。

**结论**：【确定】不符（字段级）。间隔/超时声明（5s/15s、15s 判离线）与实现一致（`control/node.ts:41-42`，`HEARTBEAT_INTERVAL_MS=5000`、`HEARTBEAT_TIMEOUT_MS=15000`，任意消息刷新 lastSeen，语义等价）。置信：高。

### P2-6 protocol.md 4.6 `input.event` payload 漏写 sessionId 字段
**文档**：[docs/protocol.md](../../docs/protocol.md) §4.6 表：「`input.event` | 控制方 → 被控方 | `{ events: [...] }`」
**代码**：`apps/desktop/src/main/input/session.ts:380` `send(this.active.peerId, 'input.event', { sessionId: this.active.sessionId, events })`；接收端 `session.ts:194-196` 依赖 `payload.sessionId` 做会话匹配（文档自己的「三重校验」也要求 sessionId 匹配）。
**结论**：【确定】不符（表格与正文自相矛盾，字段级缺口）。置信：高。

### P2-7 architecture.md 自 4083353 零更新：进程模型与键鼠注入实现冲突，koffi 决策无 ADR
**文档**：[docs/architecture.md](../../docs/architecture.md)
- :62 「└── windows-helper.exe（.NET 辅助进程，按需拉起）」、:72 「它承载需要 Win32 / .NET 的能力（**输入注入**、显示器枚举）」
- :90 「防火墙：首次启动时**通过 windows-helper** 请求入站规则」
- `git diff --stat 4083353 HEAD -- docs/` 中 **architecture.md 无任何改动**；ADR 表（:218-226）止于 ADR-007，无键鼠/koffi 相关决策。

**代码**：
- 注入实际为 **koffi 进程内 FFI**：`apps/desktop/src/main/input/win32/native.ts:1-15`（「Win32 原生绑定（koffi FFI）」；注释说明弃用钩子/辅助进程的理由）；`apps/desktop/package.json` dependencies 含 `"koffi": "^3.3.5"`。
- `native/windows-helper/` 目录仅有 README 占位，无实现。
- 防火墙实际路径：安装包/首启授权（mvp-acceptance 1.3 记录 `linkspace.exe` 入站规则），非 windows-helper。

**结论**：【确定】不符。键鼠共享的设计细节（协议、状态机、安全收敛）在 `docs/design/input-sharing.md` 与 protocol.md 4.6 有记录，但架构文档的进程模型/适配层描述未随之修正，且 koffi 选型没有 ADR（只在代码注释）。置信：高。

### P2-8 threat-model.md 新能力攻击面未同步（仅补了 T0）
**文档**：[docs/threat-model.md](../../docs/threat-model.md)
- 4083353→HEAD 的 diff 仅新增：边界 0（来源地址门禁）+ T0「端口暴露到局域网之外」（:59 起）。
- 键鼠注入相关只有旧文的 T4 尾条（:112「断网时的输入恢复」）与资产 A1；**无**以下新面的条目：
  - `input.event` 注入滥用（已实现缓解：整批拒绝、mapPoint 钳制、peerId/sessionId/解码三重校验、releaseAll——只写在 protocol.md 4.6 与 `input/session.ts`）；
  - `device.rename` 伪造改名（缓解：仅信任清单内生效——protocol.md 4.1、`host.ts:688-701`、`LinkSpaceService.kt:248-259`）；
  - `clipboard.share` 授权门禁（缓解：`hasScope('clipboard')`——`host.ts:621-627`、:676）;
  - 离线 waiting 队列（缓解：未配对设备直接拒绝——`verify-e2e.ts` 第 8 节断言）。

**代码/事实**：以上缓解均已在实现中落地（引证见各条），缺的是威胁模型侧的登记。
**结论**：【确定】部分不符：文档声明「随设计细化持续更新」（:3），但本批新能力未做对应更新；T0 本身与实现一致（net-scope.ts、secureConnection+upgrade 双挂）。置信：高（「未写入」是可枚举的缺失）。

### P2-9 roadmap.md 阶段 2/3 无状态标注，与实际进度脱节
**文档**：[docs/roadmap.md](../../docs/roadmap.md)——只有阶段 1 有「**状态：已完成（2026-10-28）**」（:34）；阶段 2（:60 起，含「Windows 安装包」交付项）与阶段 3（:79 起，剪贴板/键鼠）无任何状态行。
**事实**：阶段 2 的安装包已交付（`a2b35f2`）、门限相关验收项大量 ✅（mvp-acceptance 第 1/2/4/5/9 组）；阶段 3 的剪贴板+键鼠已实现并随 `f423ea4`「阶段 3 收尾」合入。
**结论**：【确定】不符（缺状态标注，非错误陈述）。置信：高。

### P2-10 docs/README.md 状态列过期
**文档**：[docs/README.md:13](../../docs/README.md) 「`design/input-sharing.md` | 跨设备键鼠共享自研方案 | **设计完成，未实现**」
**事实**：键鼠共享已实现（阶段 3 合入，见 P1-1 证据链）。
**结论**：【确定】不符（单字段过期）。置信：高。

### P2-11 docs/manual-walkthrough-stage3.md 未纳入版本控制
**事实**：`git status` 显示 `?? docs/manual-walkthrough-stage3.md`（未跟踪）。该文件是阶段 3 的人工走查执行清单，含「已验证/未验证」判定规则与已知限制基线；不入库则接手者拿不到（`docs/HANDOVER.md` 遗留债 #6 记录过同类问题——mDNS 诊断脚本未入库，后由 `815cdcc` 修复入库）。
**结论**：【确定】流程性不符（文件存在但不被版本控制）。置信：高。

### P2-12 HANDOVER.md「七项无头脚本」清单漏掉当时已存在的 verify:clipboard
**文档**：[docs/HANDOVER.md:32-44](../../docs/HANDOVER.md) 列出 7 项（verify / transfer / pairing / e2e / layout / net / mdns），自称「测试是七项无头脚本」。
**事实**：HANDOVER 自标注对应提交 `69d236f`（:3）；而 `git show 69d236f:apps/desktop/package.json` 中 **已存在 `"verify:clipboard"`**（`verify-clipboard.ts` 也在该提交的树里）。当前 HEAD 又新增 verify:heartbeat / verify:input（`d133273`、`42f24d4` 起），共 10 个。
**结论**：【确定】轻微不符（快照文档内即少列一项；快照后未加「已被 XX 取代」标注）。置信：高。

---

## 三、存疑项（无法在只读审查中核实，非「不符」）

| # | 事项 | 文档声称 | 已能核实的一侧 | 缺口 |
|---|---|---|---|---|
| S-1 | mvp-acceptance 1.1/1.3/1.4/1.6/9.6 安装包/防火墙/退出/卸载/SBOM 的「2026-10-29 实测通过」 | 具体到注册表项、防火墙规则数、进程残留数 | 配置与产物侧一致：`package.json` build.nsis `oneClick:true, perMachine:false`；`index.ts:177-186` buildAppMenu+Ctrl+Q；`apps/desktop/sbom/third-party-licenses.json` 存在（547 行）；`docs/license-inventory.md` 已同步 | 安装/注册表/防火墙/卸载是运行时结果，只读审查无法复现；按「无法核实」处理，非不符 |
| S-2 | mvp-acceptance 4.2「14.9s ≈ 68.5 MB/s」 | 运行数值 | `verify-transfer.ts` 第 10 节确有 `--large` 1GB 用例并输出 MB/s | 数值本身无法离线复核 |
| S-3 | mvp-acceptance 6.7「日志、丢弃原因、发送路径**三个出口**均断言无明文」 | 三出口 | `verify-clipboard.ts` §12 实际断言 onSkip 回调（即日志来源）与发送路径两处；无独立的 log 输出捕获 | 「日志」出口是间接覆盖（Host 将 onSkip 交给 log.warn），断言数量与措辞略有出入 |
| S-4 | threat-model :120「剪贴板只记录**摘要**，不记录内容」 | 记录摘要 | 实现记录的是**字节数与原因**（`clipboard.ts:97,112`），既不记摘要也不记内容 | 措辞是「摘要方案」遗留（摘要防循环已废弃，见 protocol.md 4.4 修正说明）；实际比文档更保守 |
| S-5 | mvp-acceptance 5.4「Android 端 assembleDebug 编译通过」 | 构建结论 | Android rename 收发实现完整（`LinkSpaceService.kt:248-259, 443-462`） | 编译过程无法复核 |
| S-6 | protocol.md 4.2/4.3 的 `device.capabilities` / `device.disconnect` / `session.state` | 消息表三行 | 桌面/Android 均无实现（grep 无命中） | 草案遗留（4083353 前即未实现），文档未标注「未实现」 |

---

## 四、已核实一致项（抽查为可证伪项，非穷举）

| 主题 | 文档一侧 | 实现一侧 | 结论 |
|---|---|---|---|
| `device.rename` 全链路 | protocol.md 4.1：信任门禁、改名方持久化+mDNS 注销重发、对端更新信任条目并持久化、双向重启保持 | `host.ts:168-186`（setDisplayName：profile.set→pairing→discovery.setDisplayName→广播）、`discovery.ts:255-258`（refreshAdvertisement 停掉重发）、`host.ts:688-701`+`transfer/trust.ts` rename（persist）、`LinkSpaceService.kt:248-259`（Android 接收，同门禁）、`:443-462`（Android 改名广播+重通告）、`verify-e2e.ts` §7 断言双向同步+空名拒绝+重启保持 | 【确定】一致 |
| `clipboard.share` | protocol.md 4.4：`{kind,text}`、仅 text、512 KiB 上限、500ms 抑制窗口且窗口内不更新基线、clipboard 授权门禁 | `clipboard.ts:44-124`（DEFAULT_MAX_BYTES=512*1024、SUPPRESS_MS=500、poll 窗口内直接 return 不动 lastSeen）、`host.ts:621-627`（hasScope 门禁）、:676（广播前再过滤 scope）、`verify-clipboard.ts` §1-13、`verify-input.ts` §4（双 Host 开关 e2e）、Android `ClipboardSync.kt` 同规则 | 【确定】一致 |
| 4.6 键鼠协议字段与收敛 | protocol.md 4.6：64 条/批、move 0..32768、b∈left/right/middle、wheel 钳±1000、vk 0..255、整批拒绝、sessionId `[A-Za-z0-9_-]{1,64}`、坐标映射在被控端、三重校验、control 会话级内存态、releaseAll 统一终止 | `input/protocol.ts`（MAX_EVENTS_PER_MESSAGE=64、MAX_COORD=32768、MOUSE_BUTTONS、wheel clamp、SESSION_ID_RE、mapPoint 钳制）、`input/session.ts`（onStart 门禁/TTL 30s/busy、onEvent 三重校验、endSession→releaseAll）、`verify-input.ts` 纯逻辑+双 Host 逐条断言 | 【确定】一致（payload 缺 sessionId 字段见 P2-6） |
| 心跳与 5.1 声称 | mvp-acceptance 5.1：TCP 断连立即感知、静默超时、间隔/超时可注入、产品值 5s/15s | `control/node.ts:295-318`（startHeartbeat：timeout 踢出 close(4000)、周期 send）、:41-42（5000/15000）、`verify-heartbeat.ts` 全部为 check() 硬断言 | 【确定】一致 |
| 验收 2.x/4.x/5.x 声称的脚本 | mvp-acceptance 2.1-2.7、4.1-4.10、4.9、5.2-5.4 逐项指名脚本与节号 | `verify-pairing.ts` §3/4/5/6（配对码/错码/撤销/重连/超时）、`verify-e2e.ts` §3（未配对拒绝+scope 剥夺）、§5（取消跨端+.part）、§7（改名）、§8（waiting 挂起/未配对仍拒/上线补发/落盘一致）、`verify-transfer.ts` §1-9、`verify-layout.ts` §1-6 | 【确定】脚本存在、节号对应、均为硬断言；未发现「只打日志不断言」的虚标 |
| stage3 走查清单「已知限制」 | manual-walkthrough-stage3.md：滚轮/侧键不跟随、极速敲击可能丢帧、12ms 轮询、解锁带约 24px、Ctrl+Alt+Space、确认条/状态条/徽标/方位下拉文案、6.1 心跳≤15s | `input/win32/capture.ts:13-16`（三条限制原文）、`index.ts:201`（INPUT_TICK_MS=12）、:145（CLIPBOARD_POLL_MS=800）、`edge.ts:24-30`（EDGE_BAND_PX=1、LEAVE_BAND_PX=24、COOLDOWN=800）、`index.ts:244`（Control+Alt+Space）、`App.vue:51-56/547-585/724-729`（方位下拉文案、拔掉/退出控制按钮、注入层不可用 tooltip）、`App.vue:285`（waiting「等待设备上线」） | 【确定】一致 |
| Android README 其余声明 | minSdk 26、剪贴板仅前台（onResume/onPause 挂载）、无前台服务、BouncyCastle 自签、保存目录 getExternalFilesDir | `build.gradle.kts`（minSdk=26）、`MainActivity.kt:74-91`（onResume enable + addPrimaryClipChangedListener / onPause 反向）、`AndroidManifest.xml`（无 `<service>`、无前台服务权限）、`build.gradle.kts`（bcpkix-jdk18on） | 【确定】一致（「只做接收方」除外，见 P1-2） |
| HANDOVER 快照主体 | 安全三道边界（net-scope/信任清单/任务令牌）、control 永不随配对授予、抑制窗口机制、真机脚本 | `net-scope.ts`、`verify-net.ts`、`pairing.ts`/`Protocol.kt` DEFAULT_GRANT_SCOPE（file+clipboard）、`clipboard.ts`、`.toolchain/run-xplat-verify.sh` 等均在位 | 【确定】一致（其「已验证/未验证」表与 self-标注提交 69d236f 相符；后续提交已补掉其「还没做的」清单，属快照正常老化） |

---

## 五、待证项与建议的下一步

1. **优先**：把三处状态文档刷到 HEAD（README.md 当前状态、apps/desktop/README.md 已知限制、apps/android/README.md 状态/已知限制）——它们是接手者最先读的入口，当前给出与代码相反的结论。
2. protocol.md 补 `pair.submit` 行、修正 `device.heartbeat` payload（或实现 sessions 摘要，二选一对齐）、4.6 `input.event` payload 补 sessionId；`control/node.ts:12` 的「已回写」注释随之一并对齐。
3. architecture.md：进程模型改写为 koffi 方案（或补 ADR-008 记录「弃 windows-helper(.NET) 改进程内 FFI」的决策与理由——理由现在只在 `native.ts` 注释里）；防火墙章节按实际路径修正。
4. threat-model.md：为 device.rename 伪造、input.event 注入、clipboard.share 门禁、waiting 队列各补一条缓解登记（缓解均已实现，只差登记）；顺手修正 T5「只记录摘要」措辞。
5. 将 `docs/manual-walkthrough-stage3.md` 纳入版本控制（P2-11），并给 HANDOVER 加「快照截至 69d236f，此后变化见 XXX」的显式失效标注。
6. 真机走查（stage3 清单全部 ⬜）仍是发布门限缺口；本报告未复核也无法复核这些运行时项。
