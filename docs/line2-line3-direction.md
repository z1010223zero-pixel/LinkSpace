# 线 2 / 线 3 方向文档

> 分支：`decision/line2-accessibility-first`（本文档只存在于本分支，不动 master）
> 审视基准：分支头 89a41b9（代码与 master 73a61fa 一致）；审视日期 2026-11-02
> 审视范围：`apps/desktop/src/main/`（host.ts、screen-stream.ts、scrcpy-adapter.ts、input/session.ts、control/node.ts、pairing.ts、device-manager.ts、adb.ts）、`apps/android/.../service/`（LinkSpaceService.kt、Protocol.kt、InputController.kt）、docs/protocol.md、docs/architecture.md §9、modules/*/README.md
> 已定方向（不可推翻）：对称互控 C7/ADR-009；线 2 选 A（AccessibilityService 为主、scrcpy 只当过渡）、每次控制平板端确认、无人值守先不做、scrcpy 不嵌窗口。

---

## 0. 审视结论摘要

- **线 1 的质量高于预期，不用重写。** `input/session.ts` 是不依赖 Electron/ws 的纯逻辑状态机：被控端 `InputSessionCoordinator`（门禁、30s TTL、断连清理、撤销掐断、releaseAll 防卡键）+ 控制端 `InputController`（请求/accept/reject/stop 全套），且有无头测试覆盖。线 2 的桌面控制端**复用 `InputController` 即可，不另写一套状态机**；Android 端缺的是与之对称的被控分支，不是桌面端缺状态机。
- **两个设备模型互不相认，这是 scrcpy 绕过授权的根因。** adb 模型只有 `serial/model/state/wireless`（`device-manager.ts` 的 `DeviceView`），LinkSpace 模型只有 `deviceId`（`peers` 表 + `TrustStore`），两者之间**没有任何 join key**。`scrcpy:startFor`（`ipc.ts:123`）只校验 serial 是非空字符串就放行，`host.ts` 的撤销处理只掐 input 会话、不碰 scrcpy 会话。不是某个 handler 漏了一行检查，是缺一层映射（见 §4 W2 设计）。
- **信封校验的旧结论已过期。** protocol.md §3 的注记（2026-10-30）说“`v` / `to` / `ts` 的信封级校验两端均未实现”，现已不属实：桌面端 `control/node.ts` 已有结构校验（`isEnvelope`）+ `to` 校验 + `ts` ±60s 校验；Android 端 `LinkSpaceService.kt` 的两处收消息入口（主读循环约 895 行、传输等待循环约 1369 行）已有 `v` / `to` / `ts` 三项过滤。真正缺的只是其中几项（见 §4 W3 设计）。
- **媒体通道已有实测可用的平面。** `screen-stream.ts` 的 WS 二进制帧 + ffmpeg 抓屏编码已在真机上走通（B-1/B-3），且绕开了“平板入站 TCP 全拒、唯有平板连出的链路可双向”这个实测约束。

---

## 1. Q7 媒体通道选型：统一走自研 WS+H.264，方向无关化；WebRTC 暂不引入

**结论：线 2 的反向画面流、线 3 的虚拟屏帧流，都复用现有自研平面——同一条控制连接上的 WS 文本帧（控制消息）+ WS 二进制帧（裸 H.264 Annex-B），方向只是角色互换。WebRTC 暂不引入。**

理由：

1. **局域网场景下 WebRTC 解决的问题我们没有。** WebRTC 的核心价值是 NAT 穿透（ICE/STUN/TURN）与浏览器互通。LinkSpace 是纯局域网、无账号、无浏览器端，设备直连即可；桌面↔平板的连通性问题早已被“平板主动连出、TCP 全双工复用”解决，再引 ICE 是多余复杂度。
2. **自研平面已在目标真机上验证过，WebRTC 没有。** 画面推流、码率档位、IDR 自愈、解码器相性（libx264/MF 之争，见 §3 另记）都是在联想小新平板 Pro GT 上实测过的结论。WebRTC 在这台设备上的表现是未知数，重走一遍验证的成本高于复用。
3. **Android 端今天零原生依赖，WebRTC 会打破这一点。** 桌面端 Electron 内置 WebRTC 不难，但 Android 端要引入 libwebrtc（体积大、ABI 与版本管理都是新负担），而现有 Android 端是纯 Kotlin + MediaProjection + 软解。线 2/线 3 的目标是补齐方向，不是换技术栈。
4. **真正的问题是方向锁定，不是传输协议。** `screen.stream.*` 今天寄生在 `input` 会话内（无活动 input 会话即拒绝）、`display-extend` 只是协议里的字符串、scrcpy 是协议外的第二平面。把 `session.* + screen.stream.*` 改成方向无关、把 scrcpy 收敛掉，解决的是架构问题；换 WebRTC 解决不了其中任何一条。
5. **软编软解保留，硬编以后再说。** 桌面 gdigrab + libx264 软编、平板软解是当前已验证的组合。硬编（桌面 h264_mf/QSV/NVENC、平板 MediaCodec）是性能优化项，等线 2/线 3 打通、有了真机延迟/画质数字再评估，不在本批做。

**复审条件（任一成立即重评）：** 需要跨网段/公网中继、需要浏览器端直接接入、或自研平面在真机上出现无法解决的延迟/画质瓶颈。

---

## 2. P0 共享层：不共享运行时代码，共享一份机器可读定义 + 两端一致性检查

**结论：TS 与 Kotlin 无法共享运行时代码，老实承认这一点。P0 的做法是三件套，不假装存在一个共享模块。**

1. **单一机器可读定义：`modules/protocol/protocol.json`。** 一份 JSON，写清消息类型、信封字段（v/to/ts/from/id/payload 的类型与必填）、错误码、以及数值约束（`SESSION_ID_RE`、`MAX_EVENTS_PER_MESSAGE=64`、`MAX_COORD=32768`、`MAX_CHUNK_BODY=32MiB`、剪贴板 512 KiB、配对码 6 位 60s/5 次等）。它是 `docs/protocol.md` 的机器可读版，**不是**第二份规范：两者冲突时以 `protocol.md` 为准，JSON 只负责让机器能比对。
2. **TS 侧一致性测试：** 在桌面端 verify 套件里加一项，断言 `input/protocol.ts`、`control/node.ts` 等处的常量与 `protocol.json` 一致（跑通才算过，`npm run verify` 覆盖）。
3. **Kotlin 侧静态对照：** Android 端无 Android SDK 编译不了，改用一个无依赖的 node 脚本（`scripts/check-protocol.mjs`）解析 `Protocol.kt` 的常量并与 `protocol.json` 逐项比对；脚本本身不依赖 Electron/Android，可在 a1 上直接跑。**不做代码生成**（生成器本身是新的维护负担，且两端语言差异大，生成收益低）；**不改 wire 格式**（P0 只定性，不动线上行为）。

**不做的事：** 不把 `modules/protocol/` 的 README 占位一次性改成真实现（那是分层重构，不在本批）；不把协议常量抽成 npm 包或 Kotlin multiplatform 模块；不碰 `modules/` 其余 5 个占位模块。

---

## 3. 修复优先级清单

按此排序，P0–P2 在本批的四个工作流里解决，P3–P6 不在本批动手，只记录。

| 优先级 | 问题 | 定性与归属 |
|---|---|---|
| **P0（安全，最高）** | scrcpy 绕过配对/会话授权：任意 adb 可见设备可直接投屏，撤销信任不断开 scrcpy 会话 | W2。根因是两设备模型无 join key，见 §4 |
| **P1（协议）** | 信封级校验缺口：桌面缺 `v` 等值校验、两端缺 `from` 与连接身份的绑定、失败处理是静默丢弃而非协议要求的断开+告警；protocol.md §3 注记已过期 | W3。先补桌面 `v` 校验与失败分级，再改文档注记 |
| **P2（协议一致性）** | `transfer.progress` 两端均未实现、无消费方；发送方进度早已来自数据面 `committedOffset` 与 409 偏移对账 | W3：**删除**（见 §5 方向调整声明）。不实现 |
| **P3（架构）** | `modules/` 6 个模块只有 README 占位，真实现在两个 app 各写一份，协议靠注释手工同步 | 本批只填实 `modules/protocol/` 的定义文件（W1），不做分层重构。全面重构等线 2/线 3 打通后再排期 |
| **P4（功能）** | 中文输入只有 `screen.paste` workaround（剪贴板 + Ctrl+V，无 IME 候选栏） | 本批不动。正确修复是线 2 的中文输入通道（任务清单 2.3-3），属于线 2 设计任务，不是对 workaround 打补丁 |
| **P5（已知限制）** | PC 锁屏抓不到（gdigrab error 5） | 本批不动。需换采集面（Desktop Duplication 等），与线 3 的 DD 取帧一并评估，单独排期 |
| **P6（性能）** | 软编 + 软解 | 本批不动，见 §1 第 5 条 |

**审视中发现的额外问题（不修，只记录，待 Windows 真机核实）：** `screen-stream.ts` 的注释称 2026-10-31 真机排障定论“换 h264_mf 直接绕开 libx264 与该 ROM 解码器的相性问题”，但代码里编码器仍是 `-c:v libx264`。注释与代码漂移，二者必有一处过时。a1 不是 Windows 且无平板，无法核实；不要在本批凭猜测改编码器，记入线 2/线 3 的真机验证清单。

---

## 4. 各工作流设计要点、边界与文件归属

**合并规则（防冲突）：** 四个工作流各用独立克隆，只动下面列出的文件；`docs/protocol.md` 由 W3（§3、§4.5、§5）与 W4（§4.3、§4.6）分段改，合并时按顺序 cherry-pick，不同段落不冲突。任何工作流不得动 master、不得改发布流程、不得改 `modules/` 其余占位模块。

### W1 — P0 共享协议定义

- 落 `modules/protocol/protocol.json`（消息类型、信封字段、错误码、数值约束全量）+ `scripts/check-protocol.mjs`（无依赖 node 脚本：比对 `Protocol.kt` 常量与 JSON）。
- TS 侧：加一致性断言进 verify 套件（`npm run verify` 能跑到）。
- 验证：JSON 本身跑脚本比对 + TS 测试跑通；Kotlin 侧只做静态对照并标注未编译验证。
- 不动 `docs/protocol.md` 正文（只可在文件头加一行指向 `protocol.json` 的说明）。

### W2 — 安全修复：scrcpy 会话走配对与会话授权

- **设计（方向已定，实现细节由 W2 定）：** 门禁必须放在 main 进程（`ipc.ts` 的 `scrcpy:startFor` 调用点），不在渲染层；`ScrcpyAdapter` 保持纯进程编排，不直接读 `TrustStore`（保持可测试），授权判定以回调/参数注入。
- **join key 方案：** 无线 adb 的 serial 本身就是 `host:port`——用 LAN IP 做 join：adb 主机 IP == 该设备 LinkSpace 控制连接的 `remoteAddress`，且该连接的对端已配对。USB 有线 adb 没有 IP 可 join，**fail closed**：未绑定过的 USB 设备拒绝启动 scrcpy；绑定关系由用户在桌面端显式建立一次、存本地（与信任条目同处，不进协议），不要用型号/显示名模糊匹配。
- **撤销级联：** `host.ts` 的 `revoked` 处理里，除现有 input 会话掐断外，停止所有映射到该 `deviceId` 的 scrcpy 会话，并删除其绑定。
- **改动面：** `ipc.ts`（门禁）、新增 `device-binding.ts`（serial↔deviceId 映射，含 IP-join 与显式绑定）、`host.ts`（撤销级联）、`scrcpy-adapter.ts`（仅在确需时加最小改动）。不要重构整个桌面端，不要改协议。
- **验证：** 桌面端无头测试覆盖三条：未配对设备启动被拒、已配对设备可启动、撤销后会话被停。无真机时用桩/假 adapter 验证逻辑，不编造真机结果。

### W3 — 协议缺口：信封校验落地 + `transfer.progress` 删除

- **桌面 `control/node.ts`（唯一入口）：** 补 `v === PROTOCOL_VERSION` 等值校验；失败处理分级——`v` 不合断开连接并告警（版本不兼容无继续意义），`to` 不合静默丢弃（不是发给本机的消息），`ts` 超偏丢弃并告警（时钟漂移可能是误配，不断连）；`from` 不在信封层绑定（announce 之前对端身份未知，各 handler 保留现有来源核对）。
- **Android 端：** 两处入口已有 `v`/`to`/`ts` 过滤，**不动代码**，只在提交说明里写清已核实。不要为对称而对称地改 Android。
- **`transfer.progress` 删除：** 从 protocol.md §4.5 表格与 §5 流程第 4 步删除，并加注删除原因（见 §5）。确认无任何代码引用该消息（审视已 grep：除文档外无收发代码）。
- **文档同步：** protocol.md §3 的“实现现状”注记按新现实改写——桌面：结构+`to`+`ts` 已有，本批补 `v`；Android：两处入口已有 `v`/`to`/`ts`；`from` 绑定与 `id` 去重两端均未实现，列为已知缺口（不隐瞒）。
- **验证：** 桌面端加无头测试（坏 `v` 被拒/断连、坏 `to` 丢弃、超偏 `ts` 丢弃）；`npm run verify` 相关项跑通。

### W4 — 线 2 协议骨架（只做骨架，不做完整功能）

- **Android 端：** `LinkSpaceService.kt` 的收消息分发里新增被控分支骨架——收到 `session.start`（`sessionType: 'input'`）时走与桌面 `InputSessionCoordinator` 对称的门禁+pending+用户确认流程（先以 TODO/桩实现确认 UI 回调，不接 AccessibilityService）；`input.event` 接收与分发骨架（会话匹配校验先行，注入点留空桩，明确标注未接无障碍服务）。新增独立文件放骨架（如 `ControlledInputSession.kt`），不要把 200 行逻辑塞进 `LinkSpaceService.kt`。
- **桌面端：** 复用现有 `InputController`（控制端）向 Android 发起；`host.ts` 的 `session.accept/reject/stop` 路由已是通用的，核实其对 Android 被控端同样生效，不另写状态机。**不做** App.vue 的控制入口（那是任务清单 2.3-1，另排）、**不做**反向 screen.stream（2.2-2，另排）。
- **协议登记冻结：** protocol.md §4.3（`sessionType: 'input'` 的被控方向）与 §4.6 按 `[PROTOCOL]` 日期登记，写清 Android 被控分支的存在与骨架状态；`display-extend` 不在本批动。
- **验证：** 桌面 TS 部分能跑的跑通；Android 部分无法编译（a1 无 Android SDK），只做静态对照并在提交信息里标注未编译验证，不编造。

---

## 5. 方向调整声明

- **本次审视没有推翻已定方向。** Q7 选自研统一（§1）、P0 三件套做法（§2）、修复优先级（§3）都是对任务清单的细化，不是改向。
- **唯一锁死的二选一（显目标注）：`transfer.progress` 定为删除，不实现。** 任务清单 P0-3 原文是“实现或删除二选一”，现锁定为删除。同时推翻 2026-10-30 两端会签的“保留未用、冻结定义、将来节流上报时启用”——理由：① 发送方进度早已来自数据面 `committedOffset` 与 409 偏移对账，该消息无消费方；② 将来真需要节流上报，应按节流语义新设计一条消息，而不是复用这条只有 `receivedBytes` 的形状；③ v1 未发布，无兼容成本，现在删最便宜。删除的决定与理由同时写进 protocol.md 注记与 W3 提交信息。
- **环境说明修正（不算方向调整，但影响验证口径）：** 任务书说 a1“无 Java/Maven”，实测 a1 有 Java 21（openjdk 21.0.12）与 Maven，有 Node 24/npm 11；缺的是 Android SDK、Docker、gradle。因此 Android 应用仍无法编译（无 SDK），但“无 Java”的说法是错的，特此纠正。

---

## 6. 未决与阻塞（本批不解决）

- 中文输入通道怎么做（任务清单 2.3-3）：待线 2 实现验证后定，`screen.paste` workaround 继续保留。
- 信任设备自动放行（无人值守 opt-in）是否做/何时做：待用户以后定。
- PC 锁屏抓屏、软编软解优化：见 §3 P5/P6。
- `screen-stream.ts` 的 h264_mf 注释与 libx264 代码漂移：待 Windows 真机核实。
