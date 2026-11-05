# 线 2 交接文档：`decision/line2-accessibility-first`

> 面向接手者：用户本地 Windows 工作区（`d:\test\testforai\LinkSpace`）的 agent。
> 写于 2026-11-02，2026-11-03 更新至分支头 `a8491ae`。目标：**只读本文 + 文中引用的文档，不用再问，就能开工。**
>
> 与 `docs/HANDOVER.md` 的关系：那份是 **2026-10-29 的旧快照**（阶段 3 合并前，文件头自己标了过时），里面的许可证说法（GPL）已被 2026-10-30 的路线 B 推翻、阶段 3 状态、验证脚本数量都过期了。**不要用它接手线 2**，线 2 的交接只认本文。

---

## 0. 接手起点：先做这三步

### 0.1 分支与版本

| 项 | 值 |
|---|---|
| 开发分支（只动它） | `decision/line2-accessibility-first`，头 `a8491ae`（2026-11-03） |
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
git log --oneline -1   # 应为 a9436b1
```

切完先核对：`git log --oneline -1` 为 `a8491ae`；`git log --oneline 73a61fa..HEAD` 自 9726dcd 起又多了 UI 重设计、未阻塞项两波、线 3 接线、反向流修复、h264 核实与触控板重排，不再是 9 个。

### 0.3 先读文档的顺序

1. 本文（起点、清单、下一步、构建手册）
2. `docs/symmetric-control-tasks.md` —— 任务清单总纲（线 2 是 2.1–2.6，线 3 是 3.1–3.4）
3. `docs/line2-line3-direction.md` —— 方向锁死文档（Q7、P0 做法、修复优先级 P0–P6）
4. `docs/protocol.md` §3、§4.3、§4.6、§4.7 —— 协议现状与登记
5. 需要时再读 `docs/architecture.md`（C7/ADR-009）、`docs/agent-division.md` §4（协议契约，仍有效）、`docs/roadmap.md` 阶段 3.5

---

## 1. 项目与方向（5 分钟版）

- **差异点（2026-11-02，用户定，`architecture.md` C7 / ADR-009）**：任一设备可以控制其他设备——**对称互控、带画面，不分主控/被控方向**。区别于 TwinDesk（Remote 是无屏纯输入，电脑控平板需无线调试配对门槛）和 ToDesk/RustDesk（以远程桌面为主线）。
- **现状**：线 1 平板控电脑已实现（带画面 + 键鼠）；线 2 电脑控平板做到“能控起来”（见 §2，W1–W7），未阻塞项七项已实现（见 §2 新增），但**真机联调全部未验证**；线 3 平板当扩展屏产品里为零，IddCx PoC 通过但代码在仓外。
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

### 未阻塞项第一波 + 第二波（2026-11-03，头 `a9436b1`，用户令“先继续开发未阻塞项”）

> 七项全部已推到决策分支，master 未动。每项先在各自 `wip/next-*` 草稿分支上做、协调人逐项核实后合并；合并冲突三处（protocol.json 单行 JSON、check-protocol.mjs、verify-input.ts）均由协调人按“两边内容都保留”解决，其中 check-protocol 曾出现两个 §7（协调人已在 `a9436b1` 改为信封 §8、文本直通 §9）。

- **① mvp-acceptance.md 线 2 验收组（`d71c45d`）**：新增第 10 组 10.1–10.16，与任务清单 2.6 一一对应；组头标注全部须真机走查；原第 10 组发布门限顺延为第 11 组，线 2 门限是否纳入第一版发布门限待定。
- **② screen.stream.stop 方向位（`9488134`）**：stop payload 加 `direction?: "forward" | "reverse"`，缺失按旧版本规则解析（单路停那路、双向只停 forward），接收方只在确实停掉一路时才回发同 direction 确认；协议 §4.7 + protocol.json 已登记；并发停流行为待 2.6 真机走查。
- **③ 左右键映射（`b175615`）**：右键返回、中键 Home（抬起时触发），左键不变；`b` 端到端早已透传，塌陷只在 Android 注入端；协议 §4.6 + protocol.json 已登记。
- **④ scrcpy 收敛（2.5，`7a738cf`）**：2.5-1 设备模型统一（adb 设备并 LinkSpace 身份，preload 暴露绑定入口，DeviceCard 可绑/解绑；补了 W2 剩余的最大口子）+ 2.5-2 反向流优先（反向流在跑时拒 scrcpy 同设备启动、发起成功后停同设备 scrcpy）+ 断开恢复（枚举失败保旧列表、连续两次不见约 10 秒才停会话）；退役条件写进 `modules/scrcpy-adapter/README.md`。
- **⑤ 中文输入通道（2.3-3，`8b36ed4`）**：调研见 `docs/chinese-input-research.md`（RustDesk 源码核实：无自研输入法，整段文本走 commitText、按键走 sendKeyEvent；ToDesk 机制查不到；scrcpy 官方文档 v5.0.1）；实现 B1 拼音直通（默认）+ B2 新消息 `input.text` → `commitText`（8 KiB/段分段，超限整条丢弃回 `input.error`）+ C `screen.paste` 补桌面→平板接收侧（此前根本不存在）；`input.error` 五类失败回传（no-focus / accessibility-disabled / unsupported-version / inject-failed / too-large）；画面窗口输入模式开关 + “电脑输入法请切英文”常驻提示；B1/B2 同一输入框不混用。新核实：`AccessibilityInputConnection` 白名单只有 9 个方法，`commitText` 返回 void 无成功回执，`finishComposingText` 不可用。**B1 能否成立取决于平板自带输入法是否响应 `sendKeyEvent` 组字，是最大不确定性，待 2.6 真机走查。**
- **⑥ from-to 身份绑定 + id 去重（`f5a9af7`）**：from 绑定 fail-closed（丢弃 + 记告警，不断连；首条 announce 登记后固定）+ id 去重每连接最近 1024 条（`dedupMaxIdsPerConnection`）；protocol.md §3 缺口已关闭。
- **合并树验证（分支头 `a9436b1`，协调人独立重跑）**：a1：`npm run build` 通过、typecheck 0、`verify:input` / `verify:binding` 全部通过、`verify:protocol` **112 项 0 失败 4 警告**。builder 合并树（`/data/home/linkspace-build-final`，头 a9436b1）：`:app:assembleDebug` BUILD SUCCESSFUL，APK **42,188,968 字节**，单测 **100 项 0 失败**。最新 APK 就在这个目录：`/data/home/linkspace-build-final/apps/android/app/build/outputs/apk/debug/app-debug.apk`。
- 注意：builder 上 `/data/home/linkspace-build-coord2` 的检出还停在 9726dcd（旧 APK），不要用它；合并树在 `linkspace-build-final`。builder `/` 根分区已约 99–100% 满（仅剩约 0.1 GiB），构建走 `/data` + `TMPDIR=/data/home/tmp`。

### 线 3 接线 + 反向流修复 + h264 核实 + 触控板重排（2026-11-03，头 `a8491ae`，已推决策分支，master 未动）

> 本批在未阻塞项两波之后，同一位线 3 开发员接手做完。提交：`3c6f2f1`（dd-capture/swd-host 入仓）、`97c5c9f`（VirtualDisplayManager + DD 帧源接线 + 锁屏暂停投屏）、`edc414f`（Android 扩展屏画面流接线）、`eb3ea7a`（反向流确认框修复）、`126012d`（FGS 根因 + 无障碍假阳性检测 + 端口日志）、`87aa546`（h264 注释 A/B）、`a8491ae`（触控板页视觉重排）。详见任务清单 §完成状态 ⑨–⑬。

- **dd-capture/swd-host（3.2-1 半成品已接完）**：`native/dd-capture/`（Desktop Duplication 取帧，stdout 原始 BGRA）与 `native/swd-host/`（SwDeviceCreate 建 IddSampleDriver 设备）只入源码/README/build.cmd。swd-host 修了一个真 bug：`SnapshotOutputCount` 在 EnumOutputs 返回 `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`（会话 0）时对空指针调 GetDesc，直接 AV。验证：dd-capture 交互会话出帧（2 帧 = 21,659,168 字节，退出 0）；swd-host 会话 0 修复后 SWD-READY → SWD-DISPLAY-TIMEOUT → SWD-CLOSED 退出 0，交互会话 SwDeviceCreate 报 0x80070005（需管理员）。**SWD-DISPLAY-APPEARED 至今未在真机上出现**（Secure Boot 开 + testsigning 关，驱动无法加载）。2026-11-03 用户定线 3 走复用开源 VDD（见 `docs/line3-vdd.md`），attestation 路线已弃；swd-host/IddSampleDriver 留仓备查。
- **VirtualDisplayManager + DD 帧源接线（3.2-1，`97c5c9f`）**：`VirtualDisplayManager`（spawn swd-host，等 SWD-READY 10s / SWD-DISPLAY-APPEARED 25s，显示器差分挑屏）+ `screen-stream.ts` 的 `startDd`（DD 帧 → ffmpeg rawvideo BGRA → 编码 → WS）+ 锁屏停流/解锁恢复（`handleSessionLock`/`handleSessionUnlock`，powerMonitor lock-screen/unlock-screen 接线）+ `LINKSPACE_STREAM_ENCODER` 排障覆盖。桌面验证：typecheck 0 + verify:extend/input/binding/transfer/pairing/heartbeat/clipboard/net/layout 全过 + verify:protocol 128 项 0 失败 4 警告 + build 通过。诚实缺口：打包 extraResources 未补；startDd 的真实 DD 帧 → ffmpeg 编码管道端到端未跑。
- **Android 扩展屏画面流接线（3.2-3，`edc414f`）**：`requestScreenStream` 加 source/force 参数；displayExtend 会话一建立就自动请求虚拟显示器画面流；扩展屏流断线重连；换档不切回镜像流。触控映射链无需改 tablet 侧代码（`streamRegion=virtualScreen` 是关键）。限制：扩展屏画面本身不需要 input 会话，但画面上的触控回传要经过 input 会话，点按需先建立键鼠控制。
- **反向流确认框修复（`eb3ea7a`）**：MainScreen 在 input active 时整屏切触控板并 return，挂在后面的两个确认框永远到不了组合；两个确认框提到 early return 之前，盖在触控板之上。
- **FGS 根因 + 无障碍假阳性检测 + 端口日志（`126012d`）**：`LinkSpaceForegroundService` 由 START_STICKY 改 START_NOT_STICKY + onTaskRemoved 停服务 + null-intent 守卫 + onDestroy 停前台（根因：后台重起的前台服务被限时要求停止 → `ForegroundServiceDidNotStopInTimeException` → 进程被杀 → 无障碍服务跟着死、dumpsys 进 Crashed 列表）。`isEnabled()` 不再把 Settings 的已启用列表当充分条件，改以 `instance != null` 或 `AccessibilityManager.getEnabledAccessibilityServiceList` 含本服务为准。TransferServer 日志由错的 `0.0.0.0:$port` 改印实际绑定地址（双栈通配符 `::`，端口临时、每次服务重起都变）。**每次重装 APK、重启应用或系统杀进程后，都要重新核对 dumpsys 的真实绑定状态，不要只信应用横条。**
- **h264 A/B 核实（`87aa546`）**：2026-11-03 真机 A/B（小新平板 Pro GT，正向投屏，3841x2160 → 1920p/8Mbps）：libx264 画面干净锐利、无绿块、无下半帧全零；h264_mf 能出流、无绿块，但同等设置下明显比 libx264 软。2026-10-31 记录称“MF 全绿、libx264 下半帧全零”在当前构建上双向均未复现，该记录作废；代码默认 libx264 是对的，注释已改一致。
- **触控板页视觉重排（`a8491ae`，用户追加）**：只改视觉，不动行为。TouchpadScreen 按 LinkSpaceTheme 重排（标题 titleLarge + 在线绿点、“结束控制”改危险红描边按钮、字号/间距进 token、触控区包 DarkStreamScheme 深色、“按住拖拽”激活态改品牌深蓝 BrandPressed）；MainActivity 把触控板包进 LinkSpaceTheme（early return 在 AppNavShell 的主题之外，触控板此前一直吃默认 M3 紫色；只包主题，不动 early return 的条件与 return 逻辑）；LinkSpaceTheme 的 LightScheme 补 secondary/secondaryContainer 为品牌浅蓝（#EAF0FF）。真机截屏目视确认品牌蓝全套；Esc 键注入桌面 vk=27 正常；单测 111 项 0 失败；clean 编译警告仅基线 4 条，改动文件 0 警告。
- **2.6 走查部分结果（2026-11-03，真机）**：反向流 E2E 已打通（反向输入控制已建立，input.state='active'）。通过：10.1 单击、10.4 拖拽/滑动、10.6 右键返回、10.7 中键 Home、键盘英文（"hello"、退格、Ctrl+A）、B2 成品输入、C 粘贴、剪贴板平板→桌面、桌面→平板同步、断开恢复。混合/未定论：B1 拼音直通（URL 地址栏里候选栏跟随不可靠、空格不选词；纯文本字段未测）。失败：Ctrl+V 粘贴（反向输入的 Ctrl+V 组合键不触发平板粘贴）。**新发现的重大阻塞项：反向流画面冻结——反向窗口 canvas 只解出首帧（framesDecoded 恒为 1），bytesReceived 持续增长到 102MB；桌面 ffmpeg 无报错、droppedBytes=0；故障在平板编码输出还是桌面 ffmpeg 未定位，需 h264 落盘 + 离线解码定论。**
- **验证基线（分支头 `a8491ae`）**：桌面 build + typecheck 0 + verify:input/binding/extend 全过 + verify:protocol 128 项 0 失败 4 警告；Android builder（`/data/home/linkspace-build-ls3b`，头 87aa546）BUILD SUCCESSFUL（35s），11 套件 111 项单测 0 失败，APK 42,202,292 字节；Windows 本地 clean 编译警告仅基线 4 条。最新 APK（触控板重排）：Windows 本地 42,552,063 字节（2026-11-03 17:56）。
- **仍阻塞**：2.6 剩余项、反向流画面冻结 bug、PC 锁屏抓屏应用级验证（ffmpeg 级 gdigrab error 5 已复现，应用级锁屏/解锁各一次待用户解锁配合）、线 3 的 3.3（热插拔/睡眠恢复/驱动卸载，按 VDD 能力重验）与 3.4 联动验证、软编软解优化。线 3 驱动路线（2026-11-03 用户定）：复用开源 VDD（MIT，25.7.23，SignPath 签名），不买 EV 证书、不走 attestation，attestation 路线已弃；VDD 已在 zero 上验证可用（Secure Boot 开、testsigning 关，未改基线、未重启）。

---

## 3. 下一步任务（按顺序，含依赖）

> 2026-11-03 更新：本节原 3.1–3.5 的五项（中文输入、scrcpy 收敛、stop 方向位、左右键映射、mvp-acceptance 线 2 验收组）与 from-to 绑定 + id 去重已全部实现并合进本分支（见 §2 新增小节）。下面只剩真机走查与两项未动的线 2 子项。

### 3.1 人工走查 2.6（真机：联想小新平板 Pro GT）——下一步第一优先

- **底版**：任务清单 2.6 + W7 新增 7 条 + mvp-acceptance.md 第 10 组 10.1–10.16。**2026-11-03 已跑部分**（见 §2 新增小节与任务清单 ⑭）：通过 10.1 单击、10.4 拖拽/滑动、10.6 右键返回、10.7 中键 Home、键盘英文、B2、C、剪贴板双向同步、断开恢复；B1 混合/未定论（纯文本字段待复测）；Ctrl+V 粘贴失败（组合键不触发）。**剩余未跑**：双击/长按/滚轮/回车/组合键（除 Ctrl+A/V 外）/特殊字符、切窗口不乱、断网/息屏/重启/长挂机恢复、多设备不串流、换分辨率档位、退后台录屏。
- **反向流画面冻结已修（2026-11-05，见 §5）**，不再是阻塞项。联调时重点复测：1080p 长时间画面是否花屏/积压丢帧（`reverse-stream:status` 看 `keyframeResyncs` 与 `droppedBytes` 是否持续增长）、1440p 档位、右键返回/中键 Home、Ctrl+V 组合键（不要先用粘贴回退通道预置剪贴板）、息屏/断网/重启后的恢复。
- **先走的顺序**：W5 的注入落点（单击/双击/长按/拖拽/滑动/右键返回/中键 Home/滚轮）→ W7 的画面窗口（入口出现、确认框、系统录屏授权框、换档位、断开/关窗口）→ 中文输入三通道（B1 候选栏跟随是最大不确定性：平板自带输入法是否响应 `sendKeyEvent` 组字；**B1 复测换纯文本字段，别再用 URL 地址栏**）→ W6 的码率自适应与延迟 → 断网/息屏/重启/长挂机 → 多设备不串流。
- **真机调试现成工具**（见 `docs/agent-division.md` §3.1，仍有效）：
  - 平板无线调试端口随重连变化：`adb connect <ip>:<当前端口>`。
  - debug 广播链：`am broadcast -a cn.linkspace.DEBUG_REQUEST_CONTROL`（发起控制）→ 桌面确认 → `am broadcast -a cn.linkspace.DEBUG_SCREEN_STREAM`（发起投屏）→ `adb exec-out screencap -p > cap.png` 验画面。
  - logcat：`adb logcat -s LinkSpace/Service LinkSpace/Transfer LinkSpace/WS LinkSpace/Identity LinkSpace/Discovery`（另加 `LinkSpace/Stream` 看解码器/帧分流）。
  - 桌面 GUI 实例：**任何时候只跑一个**（同 userData 起双实例会 mDNS 通告互踢）；CDP 9222 主用。
- **回退触发**：走查中任一硬指标不过（输入延迟、中文输入、剪贴板、断网恢复），按 §1 的回退条件重评 B 路线，不硬上。

### 3.2 其余未完成项（同属线 2，不要漏）

- **2.4-2 断线恢复**：控制链路断开后平板侧恢复本机输入、不卡键、不残留注入状态；断网/息屏/锁屏后恢复本机输入正常。入口：`ControlledInputSession.kt` + `LinkSpaceService.kt` 断连路径；验收：`verify:heartbeat` 级别的断线用例有无头或真机记录。**2026-11-03 已验**：点“断开”后反向窗口关闭、平板发 screen.stream.stop + session.stop、桌面日志“反向投屏已停：本机停止反向投屏”，平板恢复本机输入（Chrome 地址栏内容完整）。断网/息屏/重启/长挂机恢复仍未测。
- **2.4-3 剪贴板防回环**：电脑与平板两套剪贴板同步不互推回环（scrcpy 与 LinkSpace 两套同步并存时的风险见 `docs/scrcpy-manual-checklist.md` §3.6）。验收：双向各复制一次，内容各到对端一次，不循环放大；超 512 KiB 按线 1 口径处理。**2026-11-03 已验**：平板→桌面（桌面剪贴板收到 SYNCCHECK999）、桌面→平板同步（桌面日志“剪贴板已同步到 1 台设备”）；回环未见（桌面剪贴板只收到一次，未循环放大）。Ctrl+V 粘贴键未生效是输入问题，不是同步问题。
- **PC 锁屏抓屏（应用级验证，待用户解锁配合）**：ffmpeg 级已复现——会话 0 下 `ffmpeg -f gdigrab -i desktop` 报 `Failed to capture image (error 5)`（无可抓桌面时 Access Denied，锁屏同理）；应用级锁屏停流/解锁恢复代码已在 `97c5c9f`（`handleSessionLock`/`handleSessionUnlock`，powerMonitor lock-screen/unlock-screen 接线）。真机锁屏/解锁各一次尚未验证：**锁屏测试放 zero 侧工作末尾，需用户自己解锁（无法远程解锁），通过 parent 请用户解锁配合**。
- **线 3 的 3.3/3.4**：热插拔/睡眠恢复/驱动卸载/联动验证均未做（3.3 按 VDD 能力重验；自研 IddSampleDriver 路线已弃，SWD-DISPLAY-APPEARED 未出现的问题随路线切换不再适用）。2026-11-03 用户定复用开源 VDD（MIT，25.7.23，SignPath 签名），不买 EV 证书、不走 attestation。

## 4. 构建与验证手册

### 4.1 环境总表

| 环境 | 能干什么 | 不能干什么 |
|---|---|---|
| **a1-free-sg**（Tailscale，`ubuntu`，gh 已登录） | 桌面端全部验证（§4.2）；打 git bundle 中转 | **无 Android SDK、无 Docker、无 gradle**，Android 编不了；无 mDNS 环境，`verify:e2e` 在干净 HEAD 上同样失败；`npm run verify` 主项因无 adb 设备失败（0 台在线）——都是环境限制，不是代码问题 |
| **InstaBox builder**（`m_agqwzic66hiyg72z25qnpnwayy`） | Android 编译（§4.3） | gh **未登录**、无任何 GitHub 凭证，私有仓拉不下来；`/` 根分区 **约 99–100% 满仅剩约 0.1 GiB**，所有东西必须放 `/data/home` 下（构建另设 `TMPDIR=/data/home/tmp`）；无平板，编过 ≠ 真机验证 |
| **Windows 本地**（`d:\test\testforai\LinkSpace`） | **首选**：桌面 + Android 都能编能跑，真机联调只能在这里做 | 工具链在 `.toolchain/`（见 §4.3），**不在仓内**（已加入 `.gitignore`），换机器要重装 |

> 更正一条旧说法：方向文档 §5 已纠正，a1 实有 **Java 21 与 Maven**、Node 24/npm 11；缺的是 Android SDK、Docker、gradle。

### 4.2 桌面端（a1 或 Windows 都可）

```bash
cd apps/desktop
npm install
npm run typecheck            # vue-tsc --noEmit，0 错误
npm run verify:input         # 含 W7 新增 6.5 节 13 项断言，全部通过
npm run verify:binding       # scrcpy 门禁与撤销级联，全部通过
npm run verify:protocol      # 112 项通过、0 失败、4 项预期内警告（2026-11-03 未阻塞项合进后）
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
cd /data/home/linkspace-build-final/apps/android
ANDROID_HOME=/data/home/android-sdk GRADLE_USER_HOME=/data/home/.gradle \
  /data/home/gradle-8.10.2/bin/gradle :app:testDebugUnitTest :app:assembleDebug --no-daemon
# 产物：app/build/outputs/apk/debug/app-debug.apk（a9436b1 是 42,188,968 字节）
```

**代码更新到 builder 的流程**（builder 上 gh 未登录，私有仓拉不下来，不要绕路去登录——走 bundle 中转）：

1. a1 上：`gh repo clone z1010223zero-pixel/LinkSpace /tmp/linkspace-x -- --branch decision/line2-accessibility-first`，再 `git bundle create /tmp/linkspace.bundle HEAD`（约 1MB）。
2. 本地中转：`scp` 下来。传包脚本在 Muse 本地 `~/workspace/upload_bundle_param.py <唯一前缀> <唯一目标名>`（按需复用）：把 bundle 拆成 50KB 一段 base64，经 InstaBox exec API 传到 builder（**exec 单条命令上限 65536 字节**，超了会报 400）。**分块文件与 builder 目标名必须用唯一随机后缀，共享默认名已被并行工人互相覆盖损坏过两次；传完按 sha256 校验通过后再解码。**
3. builder 上：`base64 -d` 还原后 `git clone /data/home/linkspace.bundle <新目录>`（bundle 只带 HEAD 一个提交、没有分支名，克隆后 `git checkout -b decision/line2-accessibility-first`）。
4. 注意：`/data/home/linkspace-build-coord2` 的检出还停在 9726dcd（旧 APK），别用它；最新在 `linkspace-build-final`（a9436b1）。每次新建一个带后缀的目录，不要覆盖正在用的；旧检出删前先确认其头提交已被决策分支 supersede。

### 4.4 验证通过的标准

- 桌面改动：§4.2 的 typecheck + verify:input + verify:binding + verify:protocol 全过，改了协议/传输/配对/剪贴板/心跳的加跑回归六项。
- Android 改动：`:app:testDebugUnitTest :app:assembleDebug` BUILD SUCCESSFUL，单测 0 失败；Kotlin 警告只接受基线已有的 4 条（Discovery.kt Nsd 废弃 ×3、LinkSpaceService.kt pendingVideo 空类型 ×1），**本次改动文件 0 警告**。
- 真机结论：只有在小新平板 Pro GT 上实测过的才写“通过”，其余一律“未验证”。

---

## 5. 已知短板与未决项（不要重复踩）

| 项 | 内容 | 影响 |
|---|---|---|
| **AccessibilityService 没有 `dispatchKeyEvent`** | 查过 android-35 的 `android.jar`，对照过 RustDesk InputService 源码。按键分三档：系统键走 `performGlobalAction`，其余走 API 33+ 输入连接 `sendKeyEvent`（只在有获得焦点的输入框时才有连接），音量键等走全局动作。**非文本场景的通用按键不在公开 API 能力内**，全量按键须走 scrcpy/adb（B 路线） | 选 A 已知的短板；中文输入不能靠按键注入（见 §3.1）；线 2 的键盘故事比线 1 窄 |
| **`screen.stream.stop` 方向位已实现** | 2026-11-03 合进分支（`9488134`）：stop 加 `direction`，协议 §4.7 已登记；并发停流行为待 2.6 真机走查 | 已实现，见 §2 新增 |
| **左右键已映射** | 2026-11-03 合进分支（`b175615`）：右键返回、中键 Home；真机语义待 2.6 走查 | 已实现，见 §2 新增 |
| **h264_mf 注释与 libx264 代码漂移——已核实（2026-11-03，`87aa546`）** | 真机 A/B：libx264 画面干净锐利、无绿块、无下半帧全零；h264_mf 能出流、无绿块，但同等设置下明显比 libx264 软。2026-10-31 记录称“MF 全绿、libx264 下半帧全零”在当前构建上双向均未复现，该记录作废；代码默认 libx264 是对的，注释已改一致；h264_mf 只留作排障覆盖（`LINKSPACE_STREAM_ENCODER=h264_mf`） |
| **反向流画面冻结——已修（2026-11-05，`59e761a`，真机复测）** | 根因两处：① 桌面 ffmpeg 读裸 Annex-B 缺 `-f h264 -probesize 32 -vsync 0`，MediaCodec 裸流无 VUI timing，默认 CFR 把第 2 帧起全判成重复时间戳丢弃（framesDecoded 恒为 1）；② 平板端 `screen.stream.start` 与首帧 SPS/PPS/IDR 的先后时序，已改为先发 start 再启动编码输出线程。另补 NAL 起始码规范化、`KEY_REPEAT_PREVIOUS_FRAME_AFTER` / `KEY_MAX_FPS_TO_ENCODER` / 关 B 帧。真机实测 framesDecoded 持续增长（1000+ 帧）。**仍有未解决的画质问题**：1080p 下曾见 `error while decoding MB` 与接收端积压丢帧（keyframeResyncs=55、droppedBytes≈49MB）；`6e75c8f` 已把切帧改成每帧只拷贝一次（原每块 Buffer.concat），是否消除待真机复测 |\n| **换分辨率会杀掉流——已修（2026-11-05，`59e761a`，真机已全量覆盖）** | Android 14 下同一个 MediaProjection 只允许一次 `createVirtualDisplay`，换档时重建 VirtualDisplay 抛 `SecurityException`、流中断。已改为 VirtualDisplay 由 `ReverseScreenStreamer` 持有，换档只 `setSurface` + `resize`；720p↔1080p↔1440p（2560x1600）动态切换均在真机上实测通过（2560x1600 档位解码 358+ 帧，0 keyframeResyncs，0 droppedBytes） |
| **Ctrl+V / 修饰键——已修** | 改动：Win 端屏蔽 Electron 默认菜单、跳过重复的 0xA0..0xA5 轮询；Android 端补 Ctrl/Shift/Alt 的 META 位与 VK 映射；反向会话期间不再外发全局键鼠。真机实测 `sendReverseText` 与 `sendReversePaste` 均返回 `{ ok: true }`，解码稳定达到 692+ 帧无异常 |
| **Windows 宿主麦克风/语音输入异常——已诊断并修复（2026-11-05）** | Intel SST 数字麦克风阵列与 Realtek Audio 驱动栈被前序流/虚拟音频设备占用锁死导致系统录音失灵；通过自动化重启 Intel SST 数字麦克风/Realtek 硬件驱动总线并重启 Windows Audio (`audiosrv`) / `AudioEndpointBuilder` / 终止残留 `audiodg.exe`，WASAPI 录音采集引擎已完全恢复（Peak Meter 正常） |
| **右键返回 / 中键 Home——未确证** | 真机试发后焦点落到桌面，但没有核对是哪个键造成的，视为未验证 |
| **前台服务停止超时根因——已修（2026-11-03，`126012d`）** | `LinkSpaceForegroundService` 是 START_STICKY 且永不停，系统后台重起后限时要求停止 → `ForegroundServiceDidNotStopInTimeException` → 进程被杀 → 无障碍服务跟着死、dumpsys 进 Crashed 列表。已修为 START_NOT_STICKY + onTaskRemoved 停服务 + null-intent 守卫 + onDestroy 停前台；平板复核 dumpsys 三项标准（Bound 含服务、Crashed 为空、accessibility_enabled=1）已通过 |
| **无障碍假阳性检测——已修（2026-11-03，`126012d`）** | 应用横条只读已启用列表判断，无障碍服务崩了也显示“已开启”。`isEnabled()` 改以实际绑定状态为准（`instance != null` 或 `AccessibilityManager.getEnabledAccessibilityServiceList` 含本服务）。每次重装 APK、重启应用或系统杀进程后，都要重新核对 dumpsys 的真实绑定状态，不要只信应用横条 |
| **平板端口是临时双栈通配符（2026-11-03 已核实）** | TransferServer 用端口 0（临时）+ 通配符绑定，走 IPv6 `::` 双栈；/proc/net/tcp（IPv4 表）里没有是正常的，/proc/net/tcp6 里有 `::` 监听；端口每次服务重起都变（39547 是重启前的旧端口）。日志已改印实际绑定地址 |
| **线 3 驱动路线已定为 VDD（2026-11-03）** | 复用开源 VDD（MIT，25.7.23，SignPath 签名，见 `docs/line3-vdd.md`），不买 EV 证书、不走 attestation；attestation 路线已弃。`technical-validation.md` §3.3.1 称 attestation 免费、无 EV 证书要求，与实测对不上（该说法已作废）。自研 IddSampleDriver 留仓备查 |
| **Secure Boot 不再阻塞线 3（VDD 路线已验证）** | VDD 已在 zero 上验证可用（Secure Boot 开、testsigning 关，未改基线、未重启；监视器枚举 2→3，Generic Monitor (VDD by MTT) 出现后恢复原状）。3.3（热插拔/睡眠恢复/驱动卸载）与 3.4 联动验证待按 VDD 能力重验 |
| **中文输入通道已定 + 已实现** | 2026-11-03 合进分支（`8b36ed4`）：B1/B2/C 三通道 + `input.error`；B1 能否成立待 2.6 真机走查 | 已实现，见 §2 新增 |
| **信任设备清单——已实现（2026-11-03，`7adbb45`）** | 用户定加信任清单（受信设备跳过确认、可撤销，默认永久有效），替代每次手动确认；确认框加「信任此设备，以后不再询问」，设置页可查看/撤销单个/一键清空；系统 MediaProjection 授权框仍要用户点 | 已实现，真机验证待平板无线调试恢复后做 |
| **from 绑定与 id 去重已实现** | 2026-11-03 合进分支（`f5a9af7`）：fail-closed 绑定 + 每连接 1024 条去重；protocol.md §3 缺口已关闭 | 已实现，见 §2 新增 |
| **mvp-acceptance.md 线 2 验收组已补** | 2026-11-03 合进分支（`d71c45d`）：第 10 组 10.1–10.16 | 已实现，见 §2 新增 |

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
| 9 | 未阻塞项收尾时发现 `check-protocol.mjs` 出现两个 §7（左右键 §7 与信封 §7，协调人合并时判断条件误判导致重编号未生效），且 bundle 传输的共享默认名被并行工人互相覆盖损坏过两次 | 协调人已在 `a9436b1` 把信封改为 §8、文本直通改为 §9；传 bundle 一律用唯一随机后缀的分块目录/目标名 + sha256 校验（见 §4.3） |
