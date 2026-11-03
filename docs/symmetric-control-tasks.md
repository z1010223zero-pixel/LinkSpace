# 对称互控任务清单：线 2 电脑控平板/手机、线 3 平板当扩展屏

> 差异点（2026-11-02 用户定）：**任一设备可以控制其他设备——对称互控、带画面，不分主控/被控方向。**
> 区别于 TwinDesk（Remote 是无屏纯输入，电脑控平板需无线调试配对门槛）和 ToDesk / RustDesk（以远程桌面为主线）。
> 现状（master 68ad37b）：平板控电脑已实现（带画面 + 键鼠）；电脑控平板在自有协议里为零；平板当扩展屏产品里为零。
> 实测口径以用户实测为准：联想小新平板 Pro GT——TwinDesk Remote 页的游戏手柄模式和触控板 + 键盘模式都不展示电脑屏幕，操作时看电脑自己的显示器；Screen 页 Mirror / Extend 才是另一条线；电脑控平板需无线调试配对。
> 本清单只含线 2 / 线 3 与二者的前置项，线 1（平板控电脑）不在此列。任务按依赖顺序排列，前置未完成不得开工后续。

---

## 完成状态（2026-11-03，线 3 的 3.2-1/3.2-3、反向流确认框修复、FGS 根因修复、h264 A/B、触控板重排已合进本分支，头 `a8491ae`；线 3 的 3.1 PoC 入库已完成，见⑦）

> 只标状态，不改各节原文的任务表述。真机走查（2.6）部分已跑，见⑭。

- **① mvp-acceptance.md 线 2 验收组**：已补（`d71c45d`），第 10 组 10.1–10.16，与 2.6 一一对应；线 2 门限是否纳入第一版发布门限待定。
- **② screen.stream.stop 方向位**：已实现（`9488134`）：stop payload 加 `direction?: "forward" | "reverse"`，缺失按旧版本规则解析，接收方只在确实停掉一路时才回发确认；协议 §4.7 + protocol.json 已登记；并发停流行为待 2.6 真机走查。
- **③ 左右键映射**：已实现（`b175615`）：右键返回、中键 Home（抬起时触发），左键不变；`b` 端到端早已透传，塌陷只在 Android 注入端；协议 §4.6 + protocol.json 已登记；真机语义待 2.6 走查。
- **④ scrcpy 收敛（2.5）**：已实现（`7a738cf`）：2.5-1 设备模型统一（adb 设备并 LinkSpace 身份，preload 暴露绑定入口，DeviceCard 可绑/解绑）+ 2.5-2 反向流优先（反向流在跑时拒 scrcpy 同设备启动、发起成功后停同设备 scrcpy）+ 断开恢复（枚举失败保旧列表、连续两次不见约 10 秒才停会话）；退役条件写进 `modules/scrcpy-adapter/README.md`（反向流通 2.6 走查且用户确认后下线 scrcpy 启动入口）。
- **⑤ 中文输入通道（2.3-3）**：方案已定 + 已实现（`8b36ed4`）：调研见 `docs/chinese-input-research.md`，B1 拼音直通（默认）+ B2 `input.text` → `commitText` + C `screen.paste` 补桌面→平板接收侧，降级链 B1→B2→C→A；`input.error` 五类失败回传；协议 §4.9 + protocol.json 已登记；**B1 能否成立取决于平板自带输入法是否响应 `sendKeyEvent` 组字，待 2.6 真机走查**。
- **⑥ from-to 身份绑定 + id 去重**：已实现（`f5a9af7`）：from 绑定 fail-closed（丢弃 + 记告警，不断连；首条 announce 登记后固定）+ id 去重每连接最近 1024 条；protocol.md §3 缺口已关闭；端到端行为待 2.6 走查。
- **验证基线（合并树 a9436b1，协调人独立重跑）**：桌面 build + typecheck 0 + verify:input/binding 全过 + verify:protocol 112 项 0 失败 4 警告；Android builder assembleDebug 成功、单测 100 项 0 失败、APK 42,188,968 字节（`/data/home/linkspace-build-final`）。
- **⑦ 线 3 PoC 入库（3.1）**：已收进仓（2026-11-03）：`native/virtual-display/` 收到 IddCx PoC 全套源码（驱动 8 文件与上游微软示例 SHA-256 逐文件一致、零改动；App 侧 `main.cpp` + 新增 `capture.cpp/h`）+ `evidence/capture-report-2026-10-30.jsonl`；README 重写（构建方法、签名方式、与主进程的接线点、2026-10-30 验证结果全表），状态改为“已收进仓”；仓内 EWDK 28000.2526 复跑 Release x64 构建成功（0 错误，22 秒）。诚实缺口：DISPLAY10 首帧全黑（`lumMin=lumMax=0`，原因未定位，见 README §4）；`.zwork/a/poc/` 的 10-29 草稿副本未采用，以 10-30 验证版为准。3.1-2 解耦已满足：驱动构建不进主构建（独立 EWDK 构建，产物由 .gitignore 排除）。
- **⑧ 线 3 display-extend 真会话类型（3.2-2）**：已实现（2026-11-03）：协议 §4.3 + §4.7 + protocol.json 登记（sessionTypes / streamSources / `source?`）；桌面端 `extend/session.ts`（被控端 Coordinator + 控制端 Controller，与 input 同构、槽位独立）+ host 路由（session.start 按类型分流，accept/reject/stop 按 sessionId 各自匹配）+ ipc `extend:state/approve/deny/terminate` + `extend:changed` 广播；Android 端 `DisplayExtendController.kt` + LinkSpaceService 接线（双分发环路 fan-out、requestDisplayExtend、stopDisplayExtend、stopAll、断连清理）+ 设备详情“扩展屏”入口（EXTENDING 状态 + 结束扩展按钮）；check-protocol 新增第 10 节钉死三处一致。验证：`verify:extend`（纯逻辑 + 双 Host 环路，含 input 并行/结束不影响扩展）+ verify 全套；Android 单测 `DisplayExtendControllerTest` 12 项待 builder 跑。诚实缺口：桌面主动发起的 extend（extend:request/exit IPC）本批不暴露——平板侧尚无被控端扩展状态机，桌面发起会被平板以 'bad request' 拒绝，待 Android 补被控端分支后再开；虚拟显示器创建出口缺省为不可用（3.2 的 VirtualDisplayManager 接线后才真建屏）；真机行为（创建/触控/画面）待 3.2-1 + 2.6 走查。
- **⑨ 线 3 dd-capture/swd-host 入仓 + VirtualDisplayManager 接线（3.2-1，`3c6f2f1` + `97c5c9f`）**：`native/dd-capture/`（Desktop Duplication 持续取帧，stdout 原始 BGRA 喂 ffmpeg rawvideo；协议 DD-READY/计数/退出码 0/2/3/4）与 `native/swd-host/`（SwDeviceCreate 创建 IddSampleDriver 设备；协议 SWD-READY/SWD-DISPLAY-APPEARED/SWD-DISPLAY-TIMEOUT/SWD-CLOSED）是 3.2-1 的半成品，已接完入仓（只入源码/README/build.cmd，产物由 .gitignore 排除）。swd-host 修了一个真 bug：`SnapshotOutputCount` 在 EnumOutputs 返回 `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE`（会话 0）时对空指针调 GetDesc，直接 AV（0xC0000005）。桌面接线：`VirtualDisplayManager`（spawn swd-host，等 SWD-READY 10s / SWD-DISPLAY-APPEARED 25s，创建前后显示器差分挑屏）+ `screen-stream.ts` 的 `startDd`（DD 帧 → ffmpeg rawvideo BGRA → 编码 → WS）+ `extend/session.ts`（创建异步化、创建期间取消、批准后 TTL 停表）+ `host.ts`（按 source 分流、锁屏停流/解锁恢复）。验证：dd-capture 交互会话出帧（2 帧 = 21,659,168 字节，退出 0）；swd-host 会话 0 修复后 SWD-READY → SWD-DISPLAY-TIMEOUT → SWD-CLOSED 退出 0，交互会话 SwDeviceCreate 报 0x80070005（需管理员）；桌面 typecheck 0 + verify:extend/input/binding/transfer/pairing/heartbeat/clipboard/net/layout 全过 + verify:protocol 128 项 0 失败 4 警告 + build 通过。诚实缺口：SWD-DISPLAY-APPEARED 至今未在真机上出现（Secure Boot 开 + testsigning 关，驱动无法加载）；DISPLAY10 首帧全黑原因未定位；打包 extraResources 未补；startDd 的真实 DD 帧 → ffmpeg 编码管道端到端未跑。
- **⑩ 线 3 Android 扩展屏画面流接线（3.2-3，`edc414f`）**：`requestScreenStream` 加 source/force 参数（source='virtual-display' 时不选屏、发 source 字段；force 跳过去重）；displayExtend 会话一建立就自动请求虚拟显示器画面流；扩展屏流断线重连（断连时 display-extend 会话已结束，重连只会先弹 input 确认再报错）；换档不把扩展屏流悄悄切回镜像流；ScreenPage 扩展屏占位文案更新。触控映射链无需改 tablet 侧代码（ScreenMirrorScreen letterbox + 桌面 `localScreen()` 在 streamRegion 设定时返回 streamRegion，`streamRegion=virtualScreen` 是 3.4 触控映射的关键）。限制：扩展屏画面本身不需要 input 会话，但画面上的触控回传要经过 input 会话（`sendEvents` 无活动 input 会话时是安全空操作），点按需先建立键鼠控制。
- **⑪ 反向流确认框修复 + 前台服务根因修复（`eb3ea7a` + `126012d`）**：⑪-1 反向投屏确认框在触控板页弹不出（MainScreen 在 input active 时整屏切触控板并 return，挂在后面的两个 Dialog 永远到不了组合；平板先控电脑再收反向请求时 90 秒超时过期）：两个确认框提到 early return 之前，盖在触控板之上。⑪-2 前台服务停止超时根因：`LinkSpaceForegroundService` 是 START_STICKY 且永不停，系统后台重起后限时要求停止 → `ForegroundServiceDidNotStopInTimeException` → 进程被杀 → 无障碍服务跟着死、dumpsys 进 Crashed 列表；修为 START_NOT_STICKY + onTaskRemoved 停服务 + null-intent 守卫 + onDestroy 停前台。⑪-3 无障碍假阳性检测：`isEnabled()` 不再把 Settings 的已启用列表当充分条件，改以 `instance != null` 或 `AccessibilityManager.getEnabledAccessibilityServiceList` 含本服务为准，列表只记 warn 日志。⑪-4 端口日志：TransferServer 监听地址由错的 `0.0.0.0:$port` 改印实际绑定地址（双栈通配符 `::`，端口临时、每次服务重起都变；/proc/net/tcp6 里 uid 10331 的 `::` 监听，Test-NetConnection 证实可达）。验证：builder BUILD SUCCESSFUL（35s），11 套件 111 项单测 0 失败；警告仅基线 4 条，改动文件 0 警告；平板复核 dumpsys：Bound services 含“LinkSpace 远程输入”、Crashed 为空、accessibility_enabled=1。
- **⑫ h264 编码器注释 A/B 核实（`87aa546`）**：2026-11-03 真机 A/B（小新平板 Pro GT，正向投屏，显示器 1 3841x2160 → 1920p/8Mbps）：libx264 画面干净锐利、无绿块、无下半帧全零；h264_mf（`LINKSPACE_STREAM_ENCODER=h264_mf`）能出流、无绿块，但同等设置下明显比 libx264 软。2026-10-31 记录称“MF 全绿、libx264 下半帧全零”在当前构建上双向均未复现，该记录作废；代码默认 libx264 是对的，注释已改一致；h264_mf 只留作排障覆盖。
- **⑬ 触控板页视觉重排（`a8491ae`，用户追加）**：只改视觉，不动行为。TouchpadScreen 按 LinkSpaceTheme 重排：标题进 titleLarge（20sp）+ 在线绿点、“结束控制”改危险红描边按钮、按键/输入框/灵敏度字号进 token、间距进 LinkSpaceSpacing、触控区包 DarkStreamScheme 深色、“按住拖拽”激活态由默认 M3 tertiary（紫）改品牌深蓝 BrandPressed；MainActivity 把触控板包进 LinkSpaceTheme（early return 在 AppNavShell 的主题之外，触控板此前一直吃默认 M3 紫色；只包主题，不动 early return 的条件与 return 逻辑、不动 eb3ea7a 的确认弹窗逻辑）；LinkSpaceTheme 的 LightScheme 补 secondary/secondaryContainer 为品牌浅蓝（#EAF0FF），FilledTonalButton 不再发紫。验证：真机截屏目视确认品牌蓝全套；Esc 键注入桌面 vk=27 正常；单测 111 项 0 失败；clean 编译警告仅基线 4 条，改动文件 0 警告。
- **⑭ 2.6 走查部分结果（2026-11-03，真机，小新平板 Pro GT）**：反向流 E2E 已打通（请求 → 同意 → MediaProjection 系统框“截屏/录屏” → 桌面反向窗口 1920x1200 解码启动；反向输入控制已建立，input.state='active'）。通过：10.1 单击（点 LinkSpace 图标回前台、点 Chrome 图标打开 Chrome）、10.4 拖拽/滑动（右滑切主屏页）、10.6 右键返回（Chrome → 主屏）、10.7 中键 Home（触控板页 → 主屏）、键盘英文（地址栏打 "hello"、退格、Ctrl+A 全选 + Backspace 清空）、B2 成品输入（"你好"上屏）、C 粘贴（"你好世界"上屏，需点确认）、剪贴板平板→桌面（桌面剪贴板收到 SYNCCHECK999）、桌面→平板同步（桌面日志“剪贴板已同步到 1 台设备”）、断开恢复（点“断开”后反向窗口关闭、平板发 screen.stream.stop + session.stop、桌面日志“反向投屏已停：本机停止反向投屏”）。混合/未定论：B1 拼音直通（URL 地址栏里输入法响应注入、组字下划线、切中文模式后曾出候选“你好/美女”，但空格不选词、候选栏跟随不可靠；纯文本字段未测）。失败：Ctrl+V 粘贴（反向输入的 Ctrl+V 组合键不触发平板粘贴；同步本身已传到，粘贴键未生效）。**新发现的重大阻塞项：反向流画面冻结——反向窗口 canvas 只解出首帧（framesDecoded 恒为 1），但 bytesReceived 持续增长（1.9MB → 102MB）；桌面 ffmpeg 无报错、droppedBytes=0；故障在平板编码输出还是桌面 ffmpeg 未定位，需 h264 落盘 + 离线解码定论。输入通道独立可用，手势改用平板截屏验证。**
- **⑮ Bug 1 失焦修复 + Bug 2 信任清单 + 2.6 补课（2026-11-03 晚，头 `7adbb45`，已推决策分支，master 未动）**：Bug 1（桌面 `5234d47`）：反向窗口失焦/最小化时 `inputPaused=true`，采集切 suspended（不转发、不喂边缘穿越），恢复焦点继续；窗口顶部黄色横条「窗口未获得焦点，输入已暂停」、画布变暗；IPC 第二道门防竞态；线 1 不受焦点门限制。Bug 2（Android `7adbb45`）：确认框加「信任此设备，以后不再询问」，信任存 `TrustStore` 的 `control.no-confirm` scope（默认永久有效），设置页可查看/撤销单个/一键清空；受信后跳过 LinkSpace 自己的确认框，系统 MediaProjection 授权框仍要用户点。桌面验证（2026-11-03 晚，zero 本地）：typecheck 0 错误、`verify:input` 全过（含新增 `decideCaptureMode` 决策矩阵 8 项断言）、`verify:protocol` 128 项 0 失败 4 警告、`npm run build` 通过；APK（42,477,625 字节，2026-11-03 20:40:59，含 Bug 2）已在 zero 上。mvp-acceptance 第 10 组新增 10.17–10.21（本节 2.6 补课），线 2 门限改为 10.1–10.21 全部打勾。真机走查待平板无线调试恢复后做（2026-11-03 20:50 核实：平板 IP 通、无线调试 mDNS 旧广播已过期、重扫无服务，adb 连不上）。
- **仍阻塞**：2.6 剩余项（双击/长按/滚轮/回车/组合键/特殊字符、切窗口不乱、断网/息屏/重启/长挂机恢复、多设备不串流、换分辨率档位、退后台录屏、B1 纯文本字段复测、Ctrl+V 组合键）、反向流画面冻结 bug、PC 锁屏抓屏应用级验证（ffmpeg 级 gdigrab error 5 已复现，见下）、线 3 的 3.3（热插拔/睡眠恢复/驱动卸载/attestation）与 3.4 联动验证、软编软解优化。**PC 锁屏抓屏**：ffmpeg 级已复现——会话 0 下 `ffmpeg -f gdigrab -i desktop` 报 `Failed to capture image (error 5)`（无可抓桌面时 Access Denied，锁屏同理）；应用级锁屏停流/解锁恢复代码已在 `97c5c9f`（handleSessionLock/Unlock），真机锁屏/解锁各一次尚未验证（需用户解锁配合，放 zero 侧工作末尾）。**attestation**：尚未走通，需 EV 代码签名证书与硬件开发人员中心账号，均未采购/注册；测试签名 + 关 Secure Boot 只是验证手段，不是发行方案。**Secure Boot 阻塞**：当前机器 Secure Boot 开 + testsigning 关，IddSampleDriver 无法加载，SWD-DISPLAY-APPEARED 未出现，3.3/3.4 的真机验证均被阻塞。

---

## 前置 P0：把协议与会话状态机抽成共享层

**为什么先做**：`modules/` 下 6 个模块目前只有 README 占位，真实现在 `apps/desktop/src/main/` 与 `apps/android/.../service/` 各写一份，协议 TS / Kotlin 靠注释手工同步（`protocol.md` 自认信封级校验、`transfer.progress` 两端均未实现）。每加一条线都要在两端各写一份且迟早写岔。

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| P0-1 抽协议常量与编解码：消息类型、信封字段（v / to / ts）、错误码，一份定义两端共用 | `modules/protocol/`（新建真实现，替换 README 占位） | 不改 wire 格式，已有真机链路不回归 | TS 与 Kotlin 同一份定义生成/引用；改一处定义，两端编译即跟随，无手工同步步骤 |
| P0-2 抽会话状态机：`session.start / accept / reject / stop` 与 `input` 会话的 idle / control / suspended / error，桌面 `InputSessionCoordinator` 与 Android 端复用同一份状态机 | `modules/device-management/` | 状态机与 UI 解耦，可无头测试 | 线 1 的既有会话行为无头测试全过；线 2 的 Android 被控分支直接复用，不另写一份状态机 |
| P0-3 补齐协议自认的缺口：信封级校验、`transfer.progress` 按协议实现或从协议中删除 | `docs/protocol.md` + 两端实现 | 定义与实现一致，不留“保留未用” | `protocol.md` 中每一项都有实现对应，或明确标注删除；无定义与实现对不上的条目 |

**门限**：P0-1 ~ P0-3 完成，线 1 回归（发现 → 配对 → 投屏 → 键鼠 → 文件 → 剪贴板）无变化，方可开工线 2。

---

## 线 2：电脑控平板/手机

**目标**：电脑能像平板控电脑一样，带画面控制平板/手机——在电脑窗口里看到平板画面并用键鼠操作。入口在桌面设备卡片的“控制”动作上，门槛在 LinkSpace 配对/会话授权内显性完成，不得把无线调试等系统门槛当作唯一路径。

### 2.1 注入方案选型（先定，不写应用代码）

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 2.1-1 以联想小新平板 Pro GT 真机为准，对比两条路线：A. AccessibilityService（无障碍服务注入） B. adb / scrcpy 产品化（scrcpy server 驱动） | 真机 + `docs/technical-validation.md` 新增一节 | 真机为准，不以 README 宣称定论；TwinDesk 的 adb + scrcpy 路线只作参考 | 输出选型结论与理由：注入延迟、中文输入、剪贴板、断网恢复、授权步骤数、是否需无线调试；未选中的路线写明弃用原因 |
| 2.1-2 选定路线后定授权流：配对后首次控制是否需平板端确认、每次控制是否需确认、无人值守是否做（与线 1 的会话级授权口径一致） | `docs/threat-model.md` | 高权限操作必须显式授权（架构 C5） | 授权流写入 `docs/protocol.md` 与本清单；无授权的输入注入在任何路径下都不可达 |

### 2.2 协议补齐

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 2.2-1 Android 端实现被控分支：`session.start`（`sessionType: 'input'`）接收、`session.accept / reject`、`input.event` 接收与注入，与桌面 `InputSessionCoordinator` 对称 | `apps/android/.../service/LinkSpaceService.kt` 的控制消息分发、`InputController.kt` 的被控端 | 复用 P0-2 的共享状态机，不另写一份 | 电脑发 `session.start` 后平板端弹确认，确认后电脑的 `input.event`（move / down / up / wheel / key）能在平板上落点；拒绝后电脑侧收到 `session.reject` |
| 2.2-2 反向 screen.stream：平板画面进电脑窗口（`screen.stream.*` 的反向，源是平板屏幕，目标是电脑窗口），与线 1 的桌面推流复用同一套 `screen.stream.*` 语义 | `docs/protocol.md` §4.7 + 桌面 `screen-stream.ts` 的接收端 + Android 推流端 | 方向无关：同一套消息，角色互换 | 电脑窗口里看到平板实时画面（分辨率档位与码率自适应与线 1 同口径）；平板画面延迟、断线重连与线 1 同标准 |
| 2.2-3 协议登记冻结：`sessionType: 'input'` 的被控方向、`screen.stream.*` 的反向、中文输入通道，一并写入 `docs/protocol.md` 并标注 `[PROTOCOL]` 日期 | `docs/protocol.md` | 动手前先登记，见 `docs/agent-division.md` §4 | 协议文档与两端实现一致；无实现先行、文档后补的条目 |

### 2.3 桌面控制端 UI

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 2.3-1 `App.vue` 对 Android 设备开放控制入口（现只在 `deviceType === 'win'` 时渲染键鼠控制） | 桌面设备卡片（Android 设备行） | 入口只在已配对且已授权控制的设备上出现 | 点击后进入 2.3-2 的平板画面窗口；未授权设备点击后给出明确的授权引导，不静默无反应 |
| 2.3-2 电脑窗口看平板画面：嵌入的平板画面窗口（不是 scrcpy 自建窗口），带工具栏（分辨率档位、断开、剪贴板） | 桌面新窗口 / 设备详情页 | 窗口归 LinkSpace 管理，随会话结束关闭，无残留进程 | 窗口内点按、滑动、滚轮、键盘均落到平板对应位置；关闭窗口即结束控制会话 |
| 2.3-3 中文输入：电脑键盘在平板画面窗口里打中文能上屏（候选栏、逐字上屏），不只用 `screen.paste` 粘贴 workaround | 平板画面窗口的输入通道 | 方案已定（2026-11-03，实现见本分支）：B1 拼音直通（默认，`input.event` → `sendKeyEvent`，平板自带输入法组字）+ B2 文本直通（`input.text` → `commitText`）+ C 粘贴回退（`screen.paste` 补桌面→平板接收侧），降级链 B1→B2→C→A，见 `docs/chinese-input-research.md` §6–§9 与协议 §4.9；用户侧门槛：平板零新增（复用已开的无障碍服务），电脑侧 B1 须切英文输入法；B1 与 B2/C 同一输入框内不混用（画面窗口输入模式开关） | 在平板自带输入法界面输入中文，候选栏跟随、组词不丢字、切窗口不乱；写入人工走查清单 |

### 2.4 Android 被控端

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 2.4-1 无障碍服务声明与授权流（若选型 2.1-1 定为 AccessibilityService 路线）：`AndroidManifest.xml` 声明、系统设置引导、授权状态在 App 内可见 | 平板 App 设置 / 被控确认页 | 用户手动授权，Play Protect 受限设置按官方路径处理 | 未授权时控制请求被明确拒绝并引导授权，不静默落掉；授权后重启 App 仍有效 |
| 2.4-2 断线恢复：控制链路断开后平板侧恢复本机输入、不卡键、不残留注入状态；重连后按上次会话恢复或明确提示重连 | 被控端会话状态机 | 复用 P0-2 的共享状态机 | 断网、息屏、平板锁屏后恢复，本机输入正常；`verify:heartbeat` 级别的断线用例有无头或真机记录 |
| 2.4-3 剪贴板防回环：电脑与平板两套剪贴板同步不互推回环（scrcpy 与 LinkSpace 两套同步并存时的风险见 `docs/scrcpy-manual-checklist.md` §3.6） | 剪贴板同步（双向） | 写入后抑制窗口、来源标记，二选一 | 双向各复制一次，内容各到对端一次，不循环放大；超 512 KiB 按线 1 口径处理 |

### 2.5 scrcpy 外挂收敛

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 2.5-1 统一设备模型：scrcpy 的 adb 序列号列表与 LinkSpace 的 mDNS 发现/配对并为一套，scrcpy 会话走配对与会话授权 | 桌面设备列表 + `scrcpy-adapter.ts` | 不再有两套设备模型并存；scrcpy 不绕过配对 | 未配对设备无法启动 scrcpy；撤销信任即断开 scrcpy 会话 |
| 2.5-2 嵌入窗口或退为过渡：平板画面窗口归 LinkSpace 管理（2.3-2），scrcpy 只作视频/输入引擎；若嵌入不可行，scrcpy 明确标为过渡方案并写清替代时间点 | 桌面窗口管理 | 不以“调起第三方窗口”充当产品功能 | 用户在 LinkSpace 窗口内完成全部操作，无需感知 scrcpy 进程；过渡方案有明确的下线条件 |

### 2.6 人工走查清单（线 2 验收前必做）

以 `docs/scrcpy-manual-checklist.md` 为底版，逐项在联想小新平板 Pro GT 真机上走查，全部打勾方可算线 2 通过：

- [ ] 鼠标：单击 / 双击 / 长按 / 拖拽 / 滑动 / 右键返回 / 中键 Home / 滚轮，缩放后坐标仍准
- [ ] 键盘：英文 / 回车 / 退格 / 组合键 / 特殊字符
- [ ] 中文输入：候选栏跟随、组词不丢字、切窗口不乱（见 2.3-3）
- [ ] 剪贴板：双向各一次，无回环（见 2.4-3）
- [ ] 断网 / 息屏 / 重启 / 长挂机：断线恢复本机输入，无残留进程
- [ ] 多设备：两台平板同时被控不串流、不串输入

**W7 新增走查项（2.3-1/2.3-2 已实现，未验证——无真机，全部不打勾）**：

- [ ] 桌面已信任 Android 设备行出现「键鼠控制」入口（文案与 Win 同口径）；未配对设备无入口
- [ ] 点控制后平板弹确认框，同意后弹系统录屏授权框；拒绝后桌面主窗口显示原因、画面窗口关闭
- [ ] 画面窗口出现平板实时画面；换分辨率档位后画面跟随、不断流
- [ ] 窗口内点按 / 滑动 / 滚轮 / 键盘落点与平板一致；换分辨率后落点仍准
- [ ] 断开按钮与关窗口均结束会话：窗口关闭、无残留 ffmpeg 进程
- [ ] 平板退后台后录屏继续（targetSdk 35 mediaProjection 承接）；锁屏后录屏按系统行为停止
- [ ] 90 秒无人确认：平板侧自动拒绝，桌面主窗口显示原因、画面窗口关闭

**2026-11-03 晚补课走查项（Bug 1 / Bug 2 / 真实使用场景，对应 mvp-acceptance 10.17–10.21，全部不打勾）**：

- [ ] 控制窗口最小化／失焦后输入暂停（Bug 1，桌面 `5234d47`）：反向会话中最小化控制窗口或点电脑上别的窗口，电脑上移动鼠标、按键，平板收不到输入（logcat + 截屏为证）；窗口顶部出现黄色横条「窗口未获得焦点，输入已暂停」、画布变暗；点回窗口后横条消失、输入恢复；线 1 边缘穿越不受影响
- [ ] 连续两次会话的授权流程（Bug 2，Android `7adbb45`）：第 1 次确认框勾选「信任此设备，以后不再询问」并允许 → 断开 → 第 2 次发起无 LinkSpace 确认框（系统录屏框仍会出现，如实记录）→ 设置页撤销该信任 → 第 3 次发起确认框回来；设置页可查看、撤销单个、一键清空，信任默认永久有效
- [ ] 反向流持续 5 分钟以上、帧数持续前进（Bug 3 跟踪）：连续跑 5 分钟以上，每分钟记 `framesDecoded` / `bytesReceived`，帧数持续前进、画面实时跟随；依赖 Bug 3 冻结修复，未修好前不打勾；活体取证需电脑未锁屏且用户空闲，否则记「待解锁＋用户空闲后做」，不硬上
- [ ] 电脑端多任务切换：控制中切去电脑上别的窗口操作 30 秒再切回，切走期间平板收不到输入，切回后输入与画面恢复、无需重建会话、不丢会话；切窗口不触发线 1 边缘穿越误控
- [ ] 断开重连后输入与画面恢复：断开后立即重建完整会话（确认 → 录屏授权 → 操作），画面与输入与首会话一致；另做一次会话中断网 10 秒再恢复，平板恢复本机输入、不卡键

**线 2 门限**：2.1 ~ 2.6 全部通过；`mvp-acceptance.md` 新增线 2 验收组（与 2.6 一一对应），全部打勾；TwinDesk 对照项：电脑控平板不再依赖无线调试配对作为唯一路径（无线调试可作备选，不得作唯一路径）。

---

## 线 3：平板当扩展屏

**目标**：平板是 Windows 真正的第二块显示器——显示设置里多出一块显示器，窗口能拖上去，分辨率、热插拔、睡眠恢复都有扩展屏语义。投屏式第二屏（screen.stream 镜像）明确标为降级方案，不是本阶段的交付物。

### 3.1 PoC 代码收进仓

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 3.1-1 把 IddCx PoC 代码收进 `native/virtual-display/`（驱动 INF、App 侧 Desktop Duplication 取帧），替换目前只有 README 的状态 | `native/virtual-display/` | PoC 已通过（EWDK 构建 + 测试签名、虚拟显示器创建 + DD 取帧，`technical-validation.md` §3.2），代码在仓外磁盘上 | 仓内可复现构建；`native/virtual-display/README.md` 状态改为“已收进仓”，不再写“未开始” |
| 3.1-2 PoC 与主构建解耦：驱动构建不进主构建，失败不拖垮主进度（架构 ADR-005） | 构建脚本 | 独立验证，独立构建 | 主构建不依赖驱动构建；驱动构建失败时主产品仍可编译交付 |

### 3.2 帧传输与会话类型

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 3.2-1 帧传输复用 `screen.stream`：编码 + WS 通道复用线 1 的推流链路，源从 gdigrab 抓真实桌面换成虚拟显示器的 DD 帧 | `apps/desktop/src/main/screen-stream.ts` | 方向无关的 `screen.stream.*`（架构 §9 Q7） | 虚拟显示器上的画面能推到平板，分辨率档位与码率自适应与线 1 同口径；gdigrab 路径保留作镜像投屏，不混用 |
| 3.2-2 `display-extend` 从协议占位变成真正会话类型：`session.start`（`sessionType: 'display-extend'`）的完整生命周期，并与 `input` 会话解耦——扩展屏不以“我正在被控制”为前提 | `docs/protocol.md` §4.3 + 两端会话状态机 | 复用 P0-2 的共享状态机 | 无活动 `input` 会话时也能开扩展屏；`input` 会话结束不终止扩展屏推流；`display-extend` 在协议外只剩 0 处占位引用 |
| 3.2-3 Android 接收端：分辨率同步、触控映射进虚拟屏独立坐标系（不是映射回被镜像的真实屏） | 平板 Screen 页 / `StreamView` | 触控坐标系以虚拟显示器为准 | 在平板上点扩展屏里的窗口，落点与 Windows 侧一致；黑边 clamp 与 letterbox 几何与线 1 同标准 |

### 3.3 Windows 侧收尾

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 3.3-1 热插拔：平板断连后再连，显示器正确移除与重建，不蓝屏 | Windows 显示设置 + 驱动 | 对应 `mvp-acceptance.md` 8.5 | 断连/重连各 3 次，显示器状态与平板画面一致，无残留设备 |
| 3.3-2 睡眠恢复：电脑睡眠后唤醒，扩展屏恢复或给出明确提示 | 同上 | 对应 8.6 | 睡眠唤醒后扩展屏自动恢复，或 UI 明确提示需手动重连，不静默黑屏 |
| 3.3-3 驱动卸载：卸载后系统回到初始状态，无残留设备 | 安装/卸载流程 | 对应 8.7 | 卸载后设备管理器无残留虚拟显示器，显示设置恢复单屏 |
| 3.3-4 attestation 签名：发行签名走 attestation，替代测试签名 + 关闭 Secure Boot（`technical-validation.md` §3.3.1）；TwinDesk 的 VDD 在 Windows ARM64 上因非微软签名被拒是前车之鉴 | 驱动签名流程 | 发行前必须落地 | 在开启 Secure Boot 的干净 Windows 机器上安装成功，无需关闭 Secure Boot |

### 3.4 联动验证与验收

| 任务 | 入口 | 门槛 | 验收标准 |
|---|---|---|---|
| 3.4-1 打通 `technical-validation.md` 3.2.3（帧传到平板的延迟/画质）与 3.2.4（断网/睡眠恢复） | 真机联动（Windows + 联想小新平板 Pro GT） | 以真机为准，不以 PoC 单机取帧为准 | 延迟/画质有实测数字；断网/睡眠恢复有复现记录 |
| 3.4-2 验收用 `mvp-acceptance.md` 第 8 组 8.1–8.7：创建虚拟显示器、窗口拖入、分辨率、触控回传、热插拔、睡眠恢复、驱动卸载 | `docs/mvp-acceptance.md` 第 8 组 | 全部打勾方可算线 3 通过；此前第 8 组无一通过且不纳入第一版发布门限 | 8.1–8.7 逐项有真机记录；任一 Fail 需在发布说明中显式标注为已知问题并给出规避方式 |

**线 3 门限**：3.1 ~ 3.4 全部通过；第 8 组 8.1–8.7 全部打勾；投屏式第二屏在文档与 UI 中明确标为“降级方案”，不与真实扩展屏混用同一入口/文案。

---

## 依赖顺序总览

```
P0 共享层（协议/会话状态机）
 └─ 线 2：2.1 选型 → 2.2 协议 → 2.3 桌面 UI + 2.4 Android 被控端 → 2.5 scrcpy 收敛 → 2.6 人工走查
 └─ 线 3：3.1 PoC 收进仓 → 3.2 帧传输 + display-extend 会话 → 3.3 Windows 收尾 → 3.4 联动验证
    （线 2 与线 3 可并行，但都依赖 P0；3.2-2 与 2.2-3 同属协议登记，需一次对齐）
```

## 已选路线（2026-11-02 用户定，记在本分支，master 不受影响）

> 本节只记录选型决定，不动代码。后悔时直接删分支即可，master 上的任务清单仍保持未决状态。

- **线 2 注入选型：选 A，AccessibilityService 为主，scrcpy 只当过渡。** A 是 Android 原生、用户手动授权的路子，不用开无线调试、不走 adb，授权在 LinkSpace 内完成，对上对称互控的差异点。B（adb / scrcpy 产品化）成熟、延迟低，但无线调试配对是绕不开的门，且设备模型与 LinkSpace 配对是两套。佐证：RustDesk 控 Android 用的就是同一条路线——MediaProjection 录屏 + 名为 RustDesk Input 的无障碍服务注入，不用 adb、不用 root；但 RustDesk 是 AGPL-3.0，按路线 B 只能当设计参考，不能复用代码。A 的已知短板：部分安全窗口注不进去、延迟比 scrcpy 略高；中文输入两条路线都解决不了，须另设通道。
- **回退条件（写死，避免以后扯皮）：** 若 A 在联想小新平板 Pro GT 真机验证中任一硬指标不过（输入延迟、中文输入、剪贴板、断网恢复），则回退重新评估 B，不硬上。
- **无人值守：先不做，每次控制平板端确认。** 与线 1 的会话级授权口径一致。无人值守等于常驻授权加 PIN，攻击面和实现量都大一截；以后真要做，再加“信任设备自动放行”的 opt-in 开关。注：RustDesk 支持固定密码无人值守，所以这是口径选择，不是技术上做不到。
- **scrcpy 嵌窗口：不嵌，做自己的画面窗口。** 嵌 scrcpy 窗口要迁就窗口句柄、输入路由、工具栏，嵌完还是 scrcpy 的窗口。收尾路线是反向 screen.stream：平板用 MediaProjection 推画面，电脑窗口直接看这路流；scrcpy 只在那之前当临时顶班，流一通就下线。
- **参考数字（别人测的，非本机实测）：** RustDesk 局域网直连只比局域网本身多 1–2ms 开销，第三方对比表标的局域网输入延迟约 30ms；走公网中继 100ms 起步，差的 500ms 以上。RustDesk 因诈骗暂停了中国地区公网服务、屏蔽国内 IP，但拦的是它的公共服务器，局域网直连或自建服务器不受影响——LinkSpace 本来就是纯局域网，不存在这个问题。
- **中文输入通道：已定（2026-11-03，实现见本分支，待真机验证）。** B1 拼音直通（默认，`input.event` → 平板输入连接 `sendKeyEvent`，平板自带输入法组字、弹候选栏）+ B2 文本直通（新消息 `input.text` → `commitText` 直接上屏）+ C 粘贴回退（`screen.paste` 补桌面→平板接收侧，写剪贴板 + Ctrl+V + 回环抑制）；降级链 B1→B2→C→A（A 自研输入法须改验收标准才作备选）。用户侧门槛：平板零新增（复用已开的无障碍服务）；电脑侧 B1 须切英文输入法。B1 与 B2/C 同一输入框内不混用（画面窗口输入模式开关）。详见 `docs/chinese-input-research.md` §6–§9 与协议 §4.9。B1 能否成立取决于平板自带输入法是否响应 `sendKeyEvent` 组字，待小新平板 Pro GT 走查（清单 2.6 中文输入项）。

## 未决项（本分支未定，仍待定）

- 信任设备自动放行（无人值守的 opt-in 形态）是否做、何时做未定，需用户以后定。
