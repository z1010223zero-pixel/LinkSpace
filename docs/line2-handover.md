# 线 2 交接文档：`decision/line2-accessibility-first`

> 面向接手者：用户本地 Windows 工作区（`d:\test\testforai\LinkSpace`）的 agent。
> 写于 2026-11-02，对应分支头 `9726dcd`。目标：**只读本文 + 文中引用的文档，不用再问，就能开工。**
>
> 与 `docs/HANDOVER.md` 的关系：那份是 **2026-10-29 的旧快照**（阶段 3 合并前，文件头自己标了过时），里面的许可证说法（GPL）已被 2026-10-30 的路线 B 推翻、阶段 3 状态、验证脚本数量都过期了。**不要用它接手线 2**，线 2 的交接只认本文。

---

## 0. 接手起点：先做这三步

### 0.1 分支与版本

| 项 | 值 |
|---|---|
| 开发分支（只动它） | `decision/line2-accessibility-first`，头 `9726dcd`（2026-11-02） |
| master（不动，不合并） | `73a61fa`，与本分支的共同祖先；本分支的全部工作都不在 master 上 |
| 线 2 的含义 | 电脑控平板/手机：电脑窗口里看到平板画面并用键鼠操作 |

### 0.2 Windows 工作区切过来

本地工作区目前落后，先同步再切分支，**不要在 master 上开发**：

```powershell
cd d:\test\testforai\LinkSpace
git fetch origin
git status          # 有未提交的改动先处理（stash 或提交），再切分支
git checkout decision/line2-accessibility-first
git pull --ff-only origin decision/line2-accessibility-first
git log --oneline -1   # 应为 9726dcd
```

切完先核对：`git log --oneline 73a61fa..HEAD` 应列出 9 个提交（89a41b9、1212163、7e3ded3、85fa40f、16a2d65、1effd24、545d428、374834b、9726dcd）。

### 0.3 先读文档的顺序

1. 本文（起点、清单、下一步、构建手册）
2. `docs/symmetric-control-tasks.md` —— 任务清单总纲（线 2 是 2.1–2.6，线 3 是 3.1–3.4）
3. `docs/line2-line3-direction.md` —— 方向锁死文档（Q7、P0 做法、修复优先级 P0–P6）
4. `docs/protocol.md` §3、§4.3、§4.6、§4.7 —— 协议现状与登记
5. 需要时再读 `docs/architecture.md`（C7/ADR-009）、`docs/agent-division.md` §4（协议契约，仍有效）、`docs/roadmap.md` 阶段 3.5

---

## 1. 项目与方向（5 分钟版）

- **差异点（2026-11-02，用户定，`architecture.md` C7 / ADR-009）**：任一设备可以控制其他设备——**对称互控、带画面，不分主控/被控方向**。区别于 TwinDesk（Remote 是无屏纯输入，电脑控平板需无线调试配对门槛）和 ToDesk/RustDesk（以远程桌面为主线）。
- **现状**：线 1 平板控电脑已实现（带画面 + 键鼠）；线 2 电脑控平板做到“能控起来”（见 §2，W1–W7），但**真机联调全部未验证**；线 3 平板当扩展屏产品里为零，IddCx PoC 通过但代码在仓外。
- **线 2 选型（已定，记在分支，不在 master）**：
  - 注入选 **A：AccessibilityService 为主**，scrcpy 只当过渡；回退条件写死：A 在联想小新平板 Pro GT 真机验证中任一硬指标不过（输入延迟、中文输入、剪贴板、断网恢复），则回退重评 B（adb/scrcpy 产品化）。
  - **无人值守先不做，每次控制平板端确认**；以后可加“信任设备自动放行”opt-in（未决）。
  - **scrcpy 不嵌窗口**，做自己的反向 screen.stream 画面窗口；scrcpy 只在反向流跑通前当临时顶班。
- **Q7 媒体通道（已定，`line2-line3-direction.md` §1）**：统一走**自研 WS+H.264，方向无关化**；WebRTC 暂不引入（局域网无 NAT 穿透需求、Android 端零原生依赖、自研平面已在真机验证过）。复审条件：需跨网段/公网中继、需浏览器端接入、或自研平面出现无法解决的延迟/画质瓶颈。
- **P0 共享层（已定，同文档 §2）**：TS 与 Kotlin **不共享运行时代码**，不假装存在共享模块。做法是三件套：`modules/protocol/protocol.json` 一份机器可读定义 + TS 一致性测试 + Kotlin 静态对照脚本（`apps/desktop/scripts/check-protocol.mjs`）。不做代码生成、不改 wire 格式。`protocol.json` 与 `docs/protocol.md` 冲突时以 `protocol.md` 为准。
- **发行路线**：路线 B（保留闭源商业发行选项），只复用宽松许可组件，GPL 系代码仅作设计参考；LICENSE 文件在公开发布门限前落地。**RustDesk 是 AGPL-3.0，只能当设计参考，不能复用代码。**
- **实测口径**：真机结论以用户实测为准，README/官方文档宣称不算数（TwinDesk 已有两次被用户实测纠正的先例）。

---

## 2. 已完成清单：W1–W7

> 状态：全部已推到决策分支，master 未动。验证结果只写实跑过的；没跑过的写“未验证”，不编。

### W1 — P0 共享协议定义（`7e3ded3`）

- **做了什么**：新建 `modules/protocol/protocol.json`（33 条消息类型，不含已删除的 `transfer.progress`；信封 7 字段；§7 错误码 9 条；数值约束全量）+ 无依赖检查脚本 `apps/desktop/scripts/check-protocol.mjs`（解析两端常量逐项比对）+ `package.json` 加 `verify:protocol`；更新 `modules/protocol/README.md`。未动 `protocol.md` 正文、未改 wire 格式。
- **验证**：`npm run verify:protocol` 实跑通过 **75 项、0 失败、4 项预期内警告**；反向测试（改常量后脚本正确报错）通过。

### W2 — 安全修复：scrcpy 走配对授权（`85fa40f`）

- **做了什么**：新建 `apps/desktop/src/main/device-binding.ts`（serial↔deviceId 映射：无线 adb 用 LAN IP 做 join，serial 本身就是 `host:port`，对照 LinkSpace 连接的 `remoteAddress`；USB 未绑定直接 fail closed，显式绑定存本地 `device-bindings.json`）；`ipc.ts` 的 `scrcpy:startFor` 在 main 进程加门禁（未配对返回 `AUTH_REQUIRED`；`scrcpy-adapter.ts` 零改动）；新增 `devices:bindings/bind/unbind` 入口；`host.ts` 撤销处理追加级联（停会话 + 删绑定）。新增无头测试 `verify-binding.ts` + 打包脚本 + `verify:binding`。
- **根因**：两个设备模型互不相认（adb 模型只有 serial，LinkSpace 模型只有 deviceId），此前 `scrcpy:startFor` 只校验 serial 非空就放行，撤销信任也不碰 scrcpy 会话。
- **验证**：`npm run verify:binding` 全部通过（未配对拒、已配对放行、撤销级联停会话）；`typecheck` 0 错误；`verify:input` 回归全过。
- **未验证**：无真机（会话停止是用假会话 + 注入 hook 验证的）；`devices:bind` 只有 IPC channel，**渲染层 UI 未接**。

### W3 — 协议缺口：信封校验 + `transfer.progress` 删除（`16a2d65`）

- **做了什么**：桌面 `control/node.ts` 唯一入口补 `v === PROTOCOL_VERSION` 等值校验；失败分级：`v` 不合断连 4007 并告警，`to` 不合静默丢弃，`ts` 超偏丢弃并告警；`from` 不在信封层绑定（announce 之前对端身份未知）。`transfer.progress` 从 `protocol.md` §4.5 与 §5 删除并加注原因（**定为删除，不实现**，推翻 2026-10-30 两端会签的“保留未用、冻结定义”：发送方进度早已来自数据面 `committedOffset` 与 409 偏移对账，该消息无消费方；将来真需节流上报应按节流语义新设计一条消息；v1 未发布，无兼容成本）。§3“实现现状”注记按新现实改写。Android 端未改代码（两处收消息入口已核实有 `v/to/ts` 过滤）；删除前 grep 全仓确认代码零引用。
- **验证（a1 实跑）**：`npm run verify:input` 全部通过（含新增 9 项信封断言）；`verify:transfer / pairing / heartbeat / clipboard / net / layout` 全部通过；`typecheck` 通过。
- **已知缺口（未实现，不隐瞒）**：`from` 与连接身份的绑定、`id` 去重，两端均未实现，已写入 `protocol.md` §3 注记。

### W4 — 线 2 协议骨架（`1effd24`）

- **做了什么**：新建 `apps/android/.../service/ControlledInputSession.kt`（约 316 行）：与桌面 `InputSessionCoordinator` 对称的被控分支骨架——pending/active 双态、30s TTL、approve/deny、onEvent 会话双核对先行；注入点留空桩，未接 AccessibilityService；确认 UI 未接时默认回 `session.reject`（绝不自动批准）。`LinkSpaceService.kt` 两处入站分发接上被控分支，出站路由抽成共用方法（行为未变），断连/撤销/stopAll 均掐断被控会话。`protocol.md` §4.3/§4.6 各加一条 `[PROTOCOL] 2026-11-02 登记`。桌面端核实无需改代码（`host.ts` 的 `requestInputControl` 只校验在线与已配对、无设备类型限制）。
- **验证**：提交时标注**未编译验证**（a1 无 Android SDK）；随后 W5–W7 与合并树在 builder 上编过，覆盖了 W4 的文件（见 §2 末尾合并树验证）。

### W5 — Android 无障碍注入 + 确认 UI（`545d428`，任务清单 2.4-1 / 2.2-1 收尾）

- **做了什么**：
  - 新建 `LinkSpaceAccessibilityService.kt`（`dispatchGesture` 注入手势：点按/拖拽/滚轮近似滑动）、`ControlledInputInjector.kt`（纯逻辑解码/映射，坐标按线 1 同式比例映射）；`ControlledInputSession` 接真注入，非法批次整批拒绝，注入失败带明确原因上报（`Listener.onInjectError`），不静默丢掉；会话结束抬起全部按键防卡键。
  - **门禁三**：无障碍服务未开启时 `session.start` 直接回 `session.reject`（reason `accessibility disabled`），不进 pending、不弹 UI；approve 时复核，防点允许前服务被关的竞态。
  - 确认 UI：MainActivity 收到 `session.start` 弹确认弹窗（允许/拒绝，划掉按拒绝），30s 超时会话层自动回落拒绝；正被控制时首页常驻提示 + 随时终止；授权状态在“被控设置”可见，一键跳系统无障碍设置页，含 Android 13+ 侧载“受限设置”引导文案。
  - `AndroidManifest.xml` 声明无障碍服务 + `res/xml/accessibility_service_config.xml`；`protocol.md` 两处 W4 登记更新为 W5，补按键平台口径。
  - 新增 JVM 单测：`ControlledInputInjectorTest`（8/8）、`ControlledInputSessionW5Test`（7/7）。
- **平台核实（W5 新发现，见 §5）**：AccessibilityService **没有 `dispatchKeyEvent`**（查过 android-35 的 `android.jar`，对照过 RustDesk InputService 源码）。按键分三档公开路线：系统键走全局动作/音量，其余走 API 33+ 输入连接 `sendKeyEvent`（须 `FLAG_INPUT_METHOD_EDITOR`），只在有获得焦点的输入框时才有连接。
- **验证（builder 实跑）**：`:app:testDebugUnitTest :app:assembleDebug` BUILD SUCCESSFUL（33s）；APK 41,966,162 字节；警告 4 条全是旧代码（Discovery.kt Nsd 废弃 ×3、LinkSpaceService.kt:1358 ByteArray 类型不匹配 ×1），W5 新增文件 0 警告；单测 **65/65 通过 0 失败**，其余 5 套无回归。
- **未验证**：真机联调（手势落点/拖拽/滚轮方向/按键输入连接均未验证）；修过两轮编译错：重复 companion object、`dispatchKeyEvent` 不存在。

### W6 — 反向 screen.stream（`374834b`，任务清单 2.2-2）

- **做了什么**：
  - Android 推流端：新建 `service/ReverseScreenStreamer.kt`（949 行，不塞 LinkSpaceService.kt）：MediaProjection 抓屏，**MediaCodec 优先、失败回落 JavaCV/libx264 软编**；WS 二进制帧裸 H.264 Annex-B 回推，复用平板连出的控制连接；分辨率/码率档位与线 1 同口径（720p/1080p/1440p/2160p、t0/t1/t2/t3）；发送积压超 3MB 丢到最近关键帧、2s 采样码率自适应（>1MB 计分 +1、<100KB 计分 -1，连续 3 次拥塞降档/-8 升档），与线 1 同阈值。`LinkSpaceClient.ClientConnection` 新增 `sendBinary`（掩码二进制帧，与 `sendText` 同款帧格式）。与 input 会话解耦：反向流启停**不以活动 input 会话为前提**，授权门是平板端 MediaProjection 系统录屏授权；确认 UI 未接时默认回 `screen.stream.error`，不自动开录。
  - 桌面接收端：`screen-stream.ts` 新增 `ScreenStreamReceiver`（`start/feed/setExpectedSize/stop/status`，帧为 RGBA 回调）；`control/node.ts` 加 `onBinary`（此前二进制帧会被当 JSON 解析失败而静默丢弃）；`host.ts` 加 `requestReverseScreenStream / stopReverseScreenStream / reverseStreamStatus` + `reverseStreamFrame/Changed` 事件；断线重连 5/10/20/30s×4（线 1 同口径），观看方重发请求。
  - 协议：`docs/protocol.md` §4.7 + `protocol.json` 按 `[PROTOCOL] 2026-11-02` 登记反向流；未动 display-extend、scrcpy、线 1 推流代码。
- **验证**：桌面 a1：`verify:input` / `verify:binding` 全部通过、`typecheck` 0 错误、`verify:protocol` 75 项 0 失败 4 警告。Android builder：`:app:assembleDebug` BUILD SUCCESSFUL（28s，35 个任务），APK 41,964,588 字节；警告 4 项全部是基线已有（与 1effd24 同为 4 项）。
- **未验证**：MediaCodec 在该 ROM 上的实际编码表现、Annex-B/AVCC 形态、画面延迟、码率自适应效果；录屏后台保活（W6 未动 manifest，W7 已补）；录屏授权 UI 接线（W7 已接）；真机联调不在本批。

### W7 — 桌面控制端 UI + 反向流 Android 接线（`9726dcd`，任务清单 2.3-1 / 2.3-2）

- **做了什么**：
  - 桌面：`App.vue` 已信任 Android 设备行新增「键鼠控制」入口（文案与 Win 同口径；未配对/不在线/缺 ffmpeg 时主进程回明确的授权引导，不静默无反应）。新建 `reverse-window.ts`（平板画面窗口管理器，流结束随之关窗）+ `ReverseStreamView.vue`（RGBA 帧画 canvas，工具栏：分辨率档位/断开/剪贴板开关）。窗口内点按/滑动/滚轮/键盘经 IPC 走 `input.event`，画布坐标→流尺寸 `mapPoint` 映射；流开始后自动以流尺寸声明 input 会话（平板每次确认），流停即停依附的键鼠会话。`verify-input.ts` 新增 6.5 节（13 项断言）。
  - Android：MainActivity 发 MediaProjection 系统授权框，授权后调 `startReverseStreamWithProjection()`；拒绝/取消回 `screen.stream.error`（`denied by user`）；30s 无人确认 TTL 自动拒绝。targetSdk 35 下退后台承接：`AndroidManifest.xml` 前台服务加 `dataSync|mediaProjection` + `FOREGROUND_SERVICE_MEDIA_PROJECTION` 权限，授权后服务升级双类型。
  - 任务清单 2.6 新增 7 条 W7 走查项，**全部未打勾**。
- **验证**：桌面 a1：`verify:input` 全部通过（含新增 6.5 节 13 项断言）、`verify:binding` 全部通过、`typecheck`（vue-tsc）通过、`verify:protocol` 75 项 0 失败 4 警告、`npm run build` 通过。Android builder：`:app:testDebugUnitTest :app:assembleDebug` BUILD SUCCESSFUL（28s），APK 41,971,624 字节；Kotlin 警告 4 条全是旧代码，本次改动文件 0 警告。
- **未验证**：画面窗口与平板的真实联调、落点、退后台录屏、系统授权框实测。

### 合并树验证（分支头 9726dcd，独立于各线自报）

- a1：`verify:input` 全部通过、`verify:protocol` 75 项 0 失败 4 警告（已独立重跑核实）。
- builder 合并树（`/data/home/linkspace-build-coord2`，头 9726dcd）：`:app:testDebugUnitTest :app:assembleDebug` **BUILD SUCCESSFUL（40s，41 个任务）**，APK **41,997,106 字节**，单测 **65 项 0 失败**，构建日志 **0 警告**。最新 APK 就在这个目录：`/data/home/linkspace-build-coord2/apps/android/app/build/outputs/apk/debug/app-debug.apk`。
- 注意：builder 上 `/data/home/linkspace-build` 那个检出还停在 1effd24（旧 APK），不要用它；合并树在 `linkspace-build-coord2`。

---

## 3. 下一步任务（按顺序，含依赖）

> 顺序即依赖顺序。2.6 真机走查可以、也应当尽早并行——它验证 W5–W7，也直接决定回退条件是否触发。

### 3.1 中文输入通道（任务清单 2.3-3）——第一优先

- **为什么先做**：W5 已证实按键注入走不通中文输入（见 §5），这是线 2 相对线 1 最大的功能缺口；不解决它，电脑控平板在中文场景下不可用。
- **入口文件**：桌面 `apps/desktop/src/renderer/components/ReverseStreamView.vue`（输入通道）、`apps/desktop/src/main/input/session.ts`；Android `apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceAccessibilityService.kt`、`ControlledInputInjector.kt`；协议 `docs/protocol.md` §4.6（先登记再动手，`[PROTOCOL]` 标签，见 §6）。
- **约束（不要走弯路）**：不能靠按键注入（`dispatchKeyEvent` 不存在）；线 1 的 `screen.paste` 粘贴 workaround（剪贴板 + Ctrl+V，无 IME 候选栏）只能当兜底，不能当正解。候选方向自行评估后定：Android 输入法通道（InputConnection `commitText` / `setComposingText`，需焦点输入框）、或自研输入法、或候选栏同步方案。
- **验收标准**：在平板自带输入法界面输入中文，候选栏跟随、组词不丢字、切窗口不乱；写入 2.6 走查清单并真机打勾。

### 3.2 scrcpy 收敛（任务清单 2.5）

- **已完成的部分**：2.5-1 的核心（W2）：scrcpy 启动走配对授权、撤销信任级联断开、设备绑定模型（`device-binding.ts`）。
- **剩下的事**：
  - `devices:bind` 的**渲染层 UI 未接**（只有 IPC channel）：用户在桌面端显式建立 USB 绑定关系要有入口，否则 USB 设备永远 fail closed。
  - 2.5-2 收尾：scrcpy 明确标为**过渡方案**并写清下线条件（反向流已跑通，下线条件是 2.6 走查通过后移除 scrcpy 控制路径，只保留过渡期开关）；用户在 LinkSpace 窗口内完成全部操作，无需感知 scrcpy 进程。
- **入口文件**：`apps/desktop/src/main/device-binding.ts`、`apps/desktop/src/main/scrcpy-adapter.ts`（只在确需时最小改动）、`apps/desktop/src/main/ipc.ts`、`apps/desktop/src/renderer/App.vue`。
- **验收标准**：未配对设备无法启动 scrcpy（已做）；撤销信任即断开 scrcpy 会话（已做）；USB 绑定有 UI 入口且绑定关系与信任条目同处；过渡方案有明确的下线条件（写进文档，不只口头）。

### 3.3 `screen.stream.stop` 加方向位（`protocol.md` §4.7 已知局限）

- **问题**：`screen.stream.stop` 目前是 `{}`，没有方向位；双向流同时在跑时一方停流会把另一方也停掉。
- **入口文件**：`docs/protocol.md` §4.7、`modules/protocol/protocol.json`（先登记，`[PROTOCOL]` 标签）、`apps/desktop/src/main/screen-stream.ts`、`apps/android/.../service/ReverseScreenStreamer.kt`、`LinkSpaceService.kt`。
- **验收标准**：双向流并发时停一方不影响另一方；`verify:input` 新增对应断言并通过；协议登记与两端实现一致。

### 3.4 左右键映射（W5 已知局限）

- **问题**：目前左/右/中键都落成同一种点按（见 W5 提交记录与 2.6 清单）。
- **入口文件**：`apps/android/.../service/ControlledInputInjector.kt`、`LinkSpaceAccessibilityService.kt`（`dispatchGesture` 的手势语义区分）。
- **验收标准**（按 2.6 清单）：左键点按、**右键返回、中键 Home**、滚轮方向正确；JVM 单测覆盖映射关系；真机打勾。

### 3.5 其余未完成项（同属线 2，不要漏）

- **2.4-2 断线恢复**：控制链路断开后平板侧恢复本机输入、不卡键、不残留注入状态；断网/息屏/锁屏后恢复本机输入正常。入口：`ControlledInputSession.kt` + `LinkSpaceService.kt` 断连路径；验收：`verify:heartbeat` 级别的断线用例有无头或真机记录。
- **2.4-3 剪贴板防回环**：电脑与平板两套剪贴板同步不互推回环（scrcpy 与 LinkSpace 两套同步并存时的风险见 `docs/scrcpy-manual-checklist.md` §3.6）。验收：双向各复制一次，内容各到对端一次，不循环放大；超 512 KiB 按线 1 口径处理。
- **`mvp-acceptance.md` 新增线 2 验收组**：任务清单的线 2 门限要求与 2.6 一一对应，目前**还没加**（文件里搜不到“线 2”）。做 2.6 之前先把这组补上，否则门限无处打勾。

### 3.6 人工走查 2.6（真机：联想小新平板 Pro GT）

- **底版**：任务清单 2.6（6 大组）+ W7 新增 7 条，见 `docs/symmetric-control-tasks.md` 2.6 节，**全部未打勾**。以 `docs/scrcpy-manual-checklist.md` 为底版逐项走查。
- **先走的顺序**：W5 的注入落点（单击/双击/长按/拖拽/滑动/右键返回/中键 Home/滚轮）→ W7 的画面窗口（入口出现、确认框、系统录屏授权框、换档位、断开/关窗口）→ W6 的码率自适应与延迟 → 断网/息屏/重启/长挂机 → 多设备不串流。
- **真机调试现成工具**（见 `docs/agent-division.md` §3.1，仍有效）：
  - 平板无线调试端口随重连变化：`adb connect <ip>:<当前端口>`。
  - debug 广播链：`am broadcast -a cn.linkspace.DEBUG_REQUEST_CONTROL`（发起控制）→ 桌面确认 → `am broadcast -a cn.linkspace.DEBUG_SCREEN_STREAM`（发起投屏）→ `adb exec-out screencap -p > cap.png` 验画面。
  - logcat：`adb logcat -s LinkSpace/Service LinkSpace/Transfer LinkSpace/WS LinkSpace/Identity LinkSpace/Discovery`（另加 `LinkSpace/Stream` 看解码器/帧分流）。
  - 桌面 GUI 实例：**任何时候只跑一个**（同 userData 起双实例会 mDNS 通告互踢）；CDP 9222 主用。
- **回退触发**：走查中任一硬指标不过（输入延迟、中文输入、剪贴板、断网恢复），按 §1 的回退条件重评 B 路线，不硬上。

---

## 4. 构建与验证手册

### 4.1 环境总表

| 环境 | 能干什么 | 不能干什么 |
|---|---|---|
| **a1-free-sg**（Tailscale，`ubuntu`，gh 已登录） | 桌面端全部验证（§4.2）；打 git bundle 中转 | **无 Android SDK、无 Docker、无 gradle**，Android 编不了；无 mDNS 环境，`verify:e2e` 在干净 HEAD 上同样失败；`npm run verify` 主项因无 adb 设备失败（0 台在线）——都是环境限制，不是代码问题 |
| **InstaBox builder**（`m_agqwzic66hiyg72z25qnpnwayy`） | Android 编译（§4.3） | gh **未登录**、无任何 GitHub 凭证，私有仓拉不下来；`/` 根分区 **100% 满只剩 150M**，所有东西必须放 `/data/home` 下；无平板，编过 ≠ 真机验证 |
| **Windows 本地**（`d:\test\testforai\LinkSpace`） | **首选**：桌面 + Android 都能编能跑，真机联调只能在这里做 | 工具链在 `.toolchain/`（见 §4.3），**不在仓内**（已加入 `.gitignore`），换机器要重装 |

> 更正一条旧说法：方向文档 §5 已纠正，a1 实有 **Java 21 与 Maven**、Node 24/npm 11；缺的是 Android SDK、Docker、gradle。

### 4.2 桌面端（a1 或 Windows 都可）

```bash
cd apps/desktop
npm install
npm run typecheck            # vue-tsc --noEmit，0 错误
npm run verify:input         # 含 W7 新增 6.5 节 13 项断言，全部通过
npm run verify:binding       # scrcpy 门禁与撤销级联，全部通过
npm run verify:protocol      # 75 项通过、0 失败、4 项预期内警告
npm run build                # electron-vite build，通过
# 回归（改协议/传输/配对/剪贴板/心跳后加跑）：
npm run verify:transfer && npm run verify:pairing && npm run verify:heartbeat \
  && npm run verify:clipboard && npm run verify:net && npm run verify:layout
# verify:e2e 与 npm run verify 主项：只在有真机/mDNS 的 Windows 本地跑，
# 在 a1 上失败是环境原因（见 §4.1），先核对干净 HEAD 是否同样失败再报 bug
```

### 4.3 Android 端

**首选：Windows 本地**（工具链在工作区 `.toolchain/`，不在仓内；命令见 `apps/android/README.md`“构建环境”一节，Git Bash）：

```bash
export JAVA_HOME="/c/Program Files/Java/jdk-22"      # JDK 17+ 即可，AGP 8.7.2 要求
export ANDROID_HOME="/d/test/testforai/LinkSpace/.toolchain/android-sdk"
export ANDROID_SDK_ROOT="$ANDROID_HOME"              # 两个变量必须指向同处，否则 Gradle 拒绝构建
export GRADLE_USER_HOME="/d/test/testforai/LinkSpace/.toolchain/gradle-home"  # 默认指向不可写目录会报 journal-1.lock 拒绝访问
/d/test/testforai/LinkSpace/.toolchain/gradle-8.10.2/bin/gradle \
  -p d:\test\testforai\LinkSpace\apps\android :app:testDebugUnitTest :app:assembleDebug
# 安装到已连接设备：
/d/test/testforai/LinkSpace/.toolchain/android-sdk/platform-tools/adb.exe install -r \
  app/build/outputs/apk/debug/app-debug.apk
```

踩坑（同 README）：Gradle 官方源 TLS 吊销检查失败用腾讯云镜像（`https://mirrors.cloud.tencent.com/gradle/gradle-8.10.2-bin.zip`）；项目**没有 gradlew**（仓库无 wrapper），用 `.toolchain` 里的 Gradle 8.10.2；compileSdk/targetSdk 35、minSdk 26，AGP 8.7.2、Kotlin 2.0.21。

**备选：InstaBox builder**（Windows 本地编不了时用；上次验证就是走这条路）：

```bash
# 环境（已就绪，不用重装）：
#   Gradle 8.10.2：/data/home/gradle-8.10.2
#   SDK 副本：/data/home/android-sdk（含 platforms android-34 + android-35，
#     compileSdk 35 必须有 android-35；/opt/android-sdk 只有 android-34，别用它）
#   GRADLE_USER_HOME=/data/home/.gradle
# 构建（在 builder 上执行）：
cd /data/home/linkspace-build-coord2/apps/android
ANDROID_HOME=/data/home/android-sdk GRADLE_USER_HOME=/data/home/.gradle \
  /data/home/gradle-8.10.2/bin/gradle :app:testDebugUnitTest :app:assembleDebug --no-daemon
# 产物：app/build/outputs/apk/debug/app-debug.apk（9726dcd 是 41,997,106 字节）
```

**代码更新到 builder 的流程**（builder 上 gh 未登录，私有仓拉不下来，不要绕路去登录——走 bundle 中转）：

1. a1 上：`gh repo clone z1010223zero-pixel/LinkSpace /tmp/linkspace-x -- --branch decision/line2-accessibility-first`，再 `git bundle create /tmp/linkspace.bundle HEAD`（约 1MB）。
2. 本地中转：`scp` 下来。传包脚本在 Muse 本地 `~/workspace/upload_bundle.py`（按需复用）：把 bundle 拆成 50KB 一段 base64，经 InstaBox exec API 传到 builder（**exec 单条命令上限 65536 字节**，超了会报 400）。
3. builder 上：`base64 -d` 还原后 `git clone /data/home/linkspace.bundle <新目录>`（bundle 只带 HEAD 一个提交、没有分支名，克隆后 `git checkout -b decision/line2-accessibility-first`）。
4. 注意：`/data/home/linkspace-build` 那个检出还停在 1effd24，别用它；每次新建一个带后缀的目录（如 `linkspace-build-coord2`），不要覆盖正在用的。

### 4.4 验证通过的标准

- 桌面改动：§4.2 的 typecheck + verify:input + verify:binding + verify:protocol 全过，改了协议/传输/配对/剪贴板/心跳的加跑回归六项。
- Android 改动：`:app:testDebugUnitTest :app:assembleDebug` BUILD SUCCESSFUL，单测 0 失败；Kotlin 警告只接受基线已有的 4 条（Discovery.kt Nsd 废弃 ×3、LinkSpaceService.kt pendingVideo 空类型 ×1），**本次改动文件 0 警告**。
- 真机结论：只有在小新平板 Pro GT 上实测过的才写“通过”，其余一律“未验证”。

---

## 5. 已知短板与未决项（不要重复踩）

| 项 | 内容 | 影响 |
|---|---|---|
| **AccessibilityService 没有 `dispatchKeyEvent`** | 查过 android-35 的 `android.jar`，对照过 RustDesk InputService 源码。按键分三档：系统键走 `performGlobalAction`，其余走 API 33+ 输入连接 `sendKeyEvent`（只在有获得焦点的输入框时才有连接），音量键等走全局动作。**非文本场景的通用按键不在公开 API 能力内**，全量按键须走 scrcpy/adb（B 路线） | 选 A 已知的短板；中文输入不能靠按键注入（见 §3.1）；线 2 的键盘故事比线 1 窄 |
| **`screen.stream.stop` 无方向位** | `protocol.md` §4.7 已登记：双向流并发时一方停流会停掉另一方；真要并发需给 stop 加流标识 | 见 §3.3 |
| **左右键未映射** | 目前左/右/中键都落成同一种点按；右键返回、中键 Home 未映射 | 见 §3.4 |
| **h264_mf 注释与 libx264 代码漂移** | `screen-stream.ts` 的注释称 2026-10-31 真机排障定论“换 h264_mf 绕开 libx264 与该 ROM 解码器的相性问题”，但代码里编码器仍是 `-c:v libx264`。二者必有一处过时 | 待 Windows 真机核实；**不要凭猜测改编码器** |
| **中文输入通道未定** | 2.3-3，见 §3.1 | 线 2 第一优先 |
| **信任设备自动放行未定** | 无人值守的 opt-in 形态，是否做/何时做，需用户以后定 | 不在本批动手 |
| **from 绑定与 id 去重未实现** | `protocol.md` §3 已登记为两端均未实现的已知缺口 | 不隐瞒，不谎称已实现 |
| **mvp-acceptance.md 无线 2 验收组** | 任务清单的线 2 门限要求与 2.6 一一对应，目前文件里搜不到“线 2” | 见 §3.5，做 2.6 前先补 |

---

## 6. 关键约定（违反这些的提交不要推）

1. **只动决策分支 `decision/line2-accessibility-first`，不动 master、不合并进 master。** 后悔时直接删分支即可，master 上的任务清单仍保持未决状态。
2. **提交信息写清验证结果，不编造验证。** 格式沿用 W5/W6/W7 提交：改了什么 + 验证（命令与结果）+ 未验证项。Android 编不过就写“未编译验证”，不要写“通过”。
3. **真机结论以用户实测为准**，README/官方文档宣称不算数；没有证据的一律写成“未验证”。这是本项目文档的可信度基础。
4. **协议契约（`docs/agent-division.md` §4，仍有效）**：现有消息类型与字段语义冻结；新增消息类型先改 `docs/protocol.md`（提交信息打 `[PROTOCOL]` 标签），对端下一个迭代跟进；未跟进期间发送方可带、接收方忽略未知 type（两端 dispatch 均已是此语义）。`protocol.json` 是 `protocol.md` 的机器可读版，冲突时以 `protocol.md` 为准。
5. **许可证**：路线 B，只复用宽松许可组件；GPL 系代码（包括 RustDesk）仅作设计参考，不进代码库。
6. **安全红线**：控制授权永不随配对授予；无授权的输入注入在任何路径下都不可达；撤销信任必须级联断开全部会话（input + scrcpy + screen.stream）。
7. **中文沟通**：与用户全程用中文；拒绝、拦阻或纠正时只说结论加一句原因就打住，不展开讲道理。

---

## 7. 本次交接的审计说明（写文档时发现的问题）

写本文时按“新 agent 只读文档能否无缝开工”的标准审过一遍，发现以下缺口，处理方式如下：

| # | 缺口 | 处理 |
|---|---|---|
| 1 | `docs/HANDOVER.md` 是 2026-10-29 旧快照，已过时（许可证 GPL 说法被路线 B 推翻、阶段 3 状态过期、验证脚本 7 项变 12 项以上、“Android 无前台服务”已不实） | 不改写它（它是历史快照）；新建本文，并在 README 里指向本文；HANDOVER.md 顶部补一行指向本文的提示 |
| 2 | 根 `README.md`“当前状态”停在阶段 3 / 阶段 4 PoC，没有决策分支、没有 W1–W7；文档索引表缺 `symmetric-control-tasks.md`、`line2-line3-direction.md`、交接文档 | README 里补一行分支提示 + 索引表补三行（随本文同一提交） |
| 3 | `docs/mvp-acceptance.md` 没有线 2 验收组，任务清单的线 2 门限无处打勾 | 列入 §3.5，做 2.6 前先补；本文不代补（那是验收标准本身，需单独提交） |
| 4 | 任务清单 `symmetric-control-tasks.md` 未标 W1–W7 的完成状态（P0-1/P0-3、2.1、2.2-1/2.2-2/2.2-3、2.3-1/2.3-2、2.4-1 已完成，但文档里还是待办形态） | 状态表放在本文 §2，不改任务清单原文（避免与原文的“按依赖顺序”结构打架）；接手者以 §2 为准 |
| 5 | 任务清单 P0-2 的验收标准（“桌面与 Android 复用同一份状态机”）与方向文档的决定不一致：方向文档定的是**不共享运行时代码**，桌面复用 `InputSessionCoordinator`、Android 写对称分支 | 以方向文档为准（§1）；P0-2 的措辞问题记在这里，不改任务清单原文 |
| 6 | builder 上 `/data/home/linkspace-build` 检出还停在 1effd24，合并树在 `linkspace-build-coord2`；新 agent 容易拿错 APK | 本文 §2 末尾与 §4.3 显目标注；每次更新代码新建带后缀的目录 |
| 7 | `docs/agent-division.md` 是双 Agent 时代（A/B）的文档，§1–§3 的任务编号（B-1…B-10）已过期 | 只有 §4 协议契约仍有效（本文 §6 第 4 条引用它）；其余章节当历史资料读，不要按它的任务编号开工 |
| 8 | 任务清单 2.5-1 的门槛栏有一处显示异常（“不再有两套设备模型并存”在某些终端渲染成乱码） | 已核实文件本身是合法 UTF-8、无替换字符，是终端渲染问题，不是文件损坏；不改 |
