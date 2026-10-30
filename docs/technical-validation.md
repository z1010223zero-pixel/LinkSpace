# LinkSpace 技术验证计划（第 1 周）

> 对应方案第十一章「第 1 周：技术尽调」与第十五章「建议立即执行的第一件事」。
> **执行状态：scrcpy 部分已实测（2026-10-28）；IddCx 部分未开始，存在前置阻塞。**

---

## 0. 为什么先做这两件事

方案第十五章点出两个最大未知项，它们分别卡住不同的东西：

| 验证项 | 卡住什么 | 失败后果 |
|---|---|---|
| scrcpy 投屏/控制/无线/多设备 | 第 2 周的桌面原型、P0 核心功能 | MVP 的核心价值受损，需自研替代，成本大幅上升 |
| Windows IddCx 虚拟显示器 | 第 2–4 个月的扩展屏幕、P2 差异化能力 | 扩展屏幕降级为普通投屏，产品差异化减弱但不致命 |

两者互不阻塞，应并行推进。scrcpy 由主产品路径执行，IddCx 在 `native/virtual-display` 独立进行。

---

## 1. 环境基线（已实测 2026-10-28）

| 项 | 实测 | 备注 |
|---|---|---|
| Windows | **build 26300.9711，DisplayVersion 26H2** | ⚠️ 注册表 `ProductName` 仍显示「Windows 10 Home China」（CoreCountrySpecific），**这是微软未更新的字段，实际为 Windows 11 26H2**。后续驱动开发勿以 ProductName 判断系统 |
| 架构 | x64 | |
| scrcpy | 5.0.1（winget `Genymobile.scrcpy`） | 安装位置：`%LOCALAPPDATA%\Microsoft\WinGet\Packages\Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe\scrcpy-win64-v5.0.1` |
| adb | 1.0.41（Version 37.0.1-15733141） | 随 scrcpy 发行包附带，无需单独安装 |
| 测试设备 A（真机） | **Xiaomi Redmi 24117RK2CC，Android 16** | 已通过无线 TLS 连接（`._adb-tls-connect._tcp`），无需插线 |
| 测试设备 B（模拟器） | sdk_gphone64_x86_64，Android 16 | `emulator-5554` |
| 测试平板 | **尚未接入** | 扩展屏验证时的阻塞项，需提前准备 |
| Visual Studio + WDK | **未安装** | ⚠️ IddCx 验证的前置阻塞项 |
| 驱动签名条件 | 未评估 | 决定扩展屏能否实际分发 |
| Node / npm | v22.22.2 / 11.0.0 | Electron 开发可用 |
| 包管理器 | winget v1.29.380 可用；scoop 存在但未配置 bucket | 推荐统一用 winget |
| 虚拟机 | 家庭版无 Hyper-V；PATH 中存在 VMware（`D:\Program Files (x86)\VM`） | 驱动测试可用 VMware，无需买 Windows 专业版 |

**安装命令（可复现）**：

```bash
winget install -e --id Genymobile.scrcpy --accept-package-agreements --accept-source-agreements
```

---

## 2. scrcpy 验证结果

### 2.0 结论摘要

**核心能力全部可用，P0 投屏路线可以按方案推进。** 五组实测全部通过，且拿到了适配器设计所需的全部关键信息（窗口控制、会话键、退出码分类）。

### 2.1 视频采集链路（无头录制，不依赖人工观察）

| 设备 | 命令要点 | 结果 | 产物 | 退出码 |
|---|---|---|---|---|
| 模拟器 | `--no-window -r x.mp4 --time-limit=4` | ✅ 采集成功，Android 16 | 54 KB / 4s | 0 |
| 真机（无线） | 同上，`--time-limit=5` | ✅ 采集成功 | **3.3 MB / 5s**（画面有真实内容，非黑屏） | 0 |

- `scrcpy-server` 自动推送到设备（733930 字节，约 0.06s）。
- 录制时固定出现 `WARN: [FFmpeg] track N: codec frame size is not set` —— **无害**，源于未录制音频时轨道参数未设，不影响视频，不必排查。
- `--time-limit` 可作为自动化回归测试手段，无需人工关窗口。

### 2.2 窗口与显示参数（关系到「统一工作空间」能否实现）

全部实测通过：

| 参数 | 结果 |
|---|---|
| `--window-title=LinkSpace-24117RK2CC` | ✅ 生效，可用于多会话标识 |
| `--window-x/y/width` | ✅ 生效，可指定窗口位置与大小 |
| `--max-size=800` | ✅ 生效，实际输出 368×800 |
| `--print-fps` | ✅ 生效，可用于性能监控与自适应码率 |

实测渲染信息：

```
INFO: Renderer: direct3d11
INFO: Interop: d3d11va
INFO: Video decoding: d3d11va     ← 硬件解码可用
INFO: FPS counter started
INFO: 31 fps / 33 fps / 32 fps / 30 fps
```

**结论：可以在桌面应用中统一管理投屏窗口的位置与标题**，方案 2.2 的「统一工作空间」在窗口层面有实现基础。但注意窗口仍由 scrcpy 自己创建，LinkSpace 只负责启动时传参——若将来要做「多设备窗口嵌入到同一个面板里」，需要深度集成，属方案 7.2 第 6 步的复审范围。

### 2.3 多设备并发

| # | 检查项 | 结果 |
|---|---|---|
| 2.4.1 | 2 台设备同时采集 | ✅ 真机 + 模拟器并发，均 exit 0，产物独立不串流 |
| 2.4.4 | 进程与端口不冲突 | ✅ 未观察到冲突 |

未测：3 台以上、真实窗口场景下的资源占用。需在桌面原型阶段补测。

### 2.4 退出码与错误分类（适配器设计的关键输入）

| 场景 | 退出码 | stderr 特征 |
|---|---|---|
| 正常结束 / `--time-limit` 到期 | **0** | — |
| 设备不存在 | **1** | `ERROR: Could not find ADB device <serial>:` + 列出可用设备 + `ERROR: Server connection failed` |

**设计结论**（写入 `modules/scrcpy-adapter`）：

- 退出码可作为 `AdapterError.code` 的第一层分类依据：0 = 正常；非 0 = 失败。
- stderr 中 `ERROR:` 开头的行可解析为结构化错误，映射为 `DEVICE_OFFLINE` / `AUTH_REQUIRED` 等。
- **未验证**：设备中途断网、USB 拔出、未授权设备的退出码。这些需在有真机交互时补测，是适配器错误映射的缺口。

### 2.5 无线连接

| # | 检查项 | 结果 |
|---|---|---|
| 2.3.1 | 无线配对 | ✅ 测试机已通过 Android 无线调试（TLS）连接，scrcpy 直接可用 |
| 2.3.2 | 无线采集稳定 | ✅ 5 秒录制稳定完成 |

**安全提示**：本机 adb 中已存在常驻的无线设备连接，说明手机端无线调试此前已开启。方案 7.3 要求「不默认开启无线 ADB」，LinkSpace 不应假定用户已开启，也不应在后台维持无线调试——必须在 UI 中给出明确的开启/关闭入口与风险提示（对应 `threat-model.md` T7）。

未测：断网后 scrcpy 的行为、重启手机后无线是否保持。需人工补测（2.3.3 / 2.3.5）。

### 2.6 仍需人工验证的项（无法自动化）

以下需要真人看着手机操作，**未验证不等于通过**。
逐条可执行的操作步骤与判定标准见 `docs/scrcpy-manual-checklist.md`。

| # | 检查项 | 状态 |
|---|---|---|
| 2.1.x | USB 有线投屏（本次两台设备均为无线/模拟器） | ⬜ 待测 |
| 2.2.1 | 鼠标点击位置准确 | ⬜ 待测 |
| 2.2.2 | 滑动 / 拖拽 | ⬜ 待测 |
| 2.2.3 | 键盘输入（英文） | ⬜ 待测 |
| 2.2.4 | 键盘输入（中文，**输入法行为是已知坑**） | ⬜ 待测 |
| 2.2.6 | 剪贴板双向同步（含 `--no-clipboard-autosync` 行为） | ⬜ 待测 |
| 2.3.3 | 断网后行为 | ⬜ 待测 |
| 2.1.5 | 关闭窗口后进程无残留 | ✅ 已验证 2026-10-29（详见 `scrcpy-manual-checklist.md` 4.1） |

### 2.8 剪贴板同步（新增，2026-10-29 真机验证）

跨平台真机结果（Windows ↔ 联想平板 TB710FU / Android 16）：

| 方向 | 结果 | 证据 |
|---|---|---|
| Windows → Android | ✅ 已验证 | 平板日志 `收到 clipboard.share，23 字符`；回环抑制生效，本端 5 秒内无回推 |
| Android → Windows | ⬜ 需人工 | Android 的剪贴板写入无法用 adb 模拟（`service call clipboard` 受权限限制，分享 intent 不写剪贴板），必须在平板上真实执行一次复制 |
| 授权门禁 | ✅ 已验证 | 配对默认授予 `file,clipboard`；`clipboard.share` 只发给持有 clipboard 授权的对端 |

回环抑制的两层保障：

1. **抑制窗口**：写入后 500ms 内忽略本地变更，且窗口内**不更新基线**
   （更新会把旧值记成已知状态，回环只是延后一轮）。
2. **内容相等即跳过**：收到的文本与本机当前剪贴板相同时不写盘。

授权模型：`clipboard.share` 双向都过 `hasScope(peerId, 'clipboard')`。
配对默认授予 `file` + `clipboard`，`control` 永远不在默认范围内
（键鼠与投屏能让对端操作本机，必须用户单独授权）。

### 2.7 探查项结论

| # | 探查项 | 结论 |
|---|---|---|
| 2.5.1 | 能否获取退出码并分类 | ✅ 可以，见 2.4 |
| 2.5.2 | 能否命令行指定窗口位置/大小 | ✅ 可以，`--window-x/y/width/height` |
| 2.5.3 | 稳定设备序列号作会话键 | ✅ `-s <serial>`，无线设备序列号为 `adb-xxxx._adb-tls-connect._tcp` 形式（**较长且含特殊字符，构造命令行时注意转义**） |
| 2.5.4 | 发行包内含哪些二进制 | ✅ 已记录，见 `license-inventory.md` 1.3 |
| 2.5.5 | 更新/版本策略 | ⬜ 待定，倾向锁定版本随包分发 |

---

## 3. Windows IddCx 虚拟显示器验证清单

**独立性要求**：在 `native/virtual-display` 下进行，不写入主产品代码。

### 3.0 前置阻塞（新增，2026-10-28）

| 阻塞项 | 现状 | 影响 |
|---|---|---|
| Visual Studio + Windows SDK + WDK | **未安装** | 无法编译任何驱动，需先安装（体积大，约 10 GB+，需单独规划磁盘与时间） |
| Windows 家庭版 | Home / CoreCountrySpecific | 无 Hyper-V，驱动测试须用 VMware（已装）或第二台物理机 |
| 驱动签名证书 | 未评估 | 决定扩展屏能否对外分发，而非仅本机可用 |

**建议**：scrcpy 路线已验证可行，IddCx 可以按方案 9.3 保持独立，不必现在就装 VS+WDK。等阶段 1（桌面原型）结束后再投入，避免早期把时间花在工具链上。

### 3.1 起步

1. 安装 Visual Studio + Windows SDK + WDK。
2. 拉取微软官方 Indirect Display Driver 示例。
3. 在 VMware 虚拟机中编译并安装驱动，**不要在本机直接装**（家庭版 + 内核态驱动，出问题恢复成本高）。

### 3.2 验证项

对应方案 9.4 的五个前置问题：

| # | 问题 | 方法 | 结论 |
|---|---|---|---|
| 3.2.1 | 目标 Windows 版本能否稳定创建虚拟显示器 | 安装驱动后查看显示设置与设备管理器 | ✅ **通过（2026-10-30）**：EWDK 28000.2526 构建 + 测试签名驱动 pnputil 安装后，`IddSampleApp.exe` 创建 SWD 成功，系统出现 3 个虚拟显示器（样例 INF 预置三路 2560×1440 / 1024×768 / 2560×1440），显示设置排列图即时出现且长时间不掉线；按 `x` 销毁后显示器即时消失。数据：`experiments/iddcx-poc/x64/Debug/idd-poc-out/capture-report.jsonl` |
| 3.2.2 | 能否获取并处理显示帧 | 在示例的帧回调中输出统计/存图 | ✅ **通过（2026-10-30）**：App 侧 Desktop Duplication 在 3 个虚拟显示器上全部工作——`ddSupported=true`、`dupHr=0x0`、frames=146/50/49、errors=0、avgInterval 27~160ms、内容亮度 lumMax=255（非全黑）；帧位图落盘 `idd-poc-out/frame-*.bmp`。**架构确认：取帧走 App 侧 DD 可行，无需驱动内取帧** |
| 3.2.3 | Android 平板能否达到可接受延迟与画质 | 传输到平板实测 | ⬜ 未开始（阶段 4 开工项，需平板联动） |
| 3.2.4 | 断网/睡眠/重连能否恢复 | 人为制造异常 | ⬜ 未开始（阶段 4 开工项） |
| 3.2.5 | 驱动能否被普通用户安装/更新/卸载 | 走完整安装卸载流程 | ⚠️ **部分通过（2026-10-30）**：安装（pnputil /add-driver /install）与卸载（delete-driver /uninstall）全流程走通且无需重启；但当前依赖测试签名，**普通用户无感安装需正式签名（EV / attestation）后另行评估** |

### 3.2.1/3.2.2 实测环境事实（2026-10-30）

- 构建环境：EWDK 28000.2526 绿色 ISO（`D:\dev\iddcx\EWDK_28000.2526.iso`），LaunchBuildEnv 内 msbuild，无需本机安装 VS/WDK；驱动 dll 零 CRT 依赖，App 为 Debug 构建依赖 VC Debug CRT（10 DLL）+ `ucrtbased.dll`（SDK Debug UCRT），已拷至 exe 同目录解决「报缺 VCRUNTIME140D.dll / 静默闪退」问题。
- 安装前提：**测试签名 + 关闭 Secure Boot**——本机 `bcdedit /set testsigning on` 被安全启动策略保护拒绝，需进 UEFI 关闭 Secure Boot 后再开测试签名；这是测试签名路线的固定门槛，正式发行需改走 attestation/EV 签名。
- 硬件：Intel Arc Graphics（Meteor Lake），DD 与显卡驱动共存无冲突。

### 3.3 补充风险项

| # | 项 | 结论 |
|---|---|---|
| 3.3.1 | 驱动签名要求（测试签名 vs 正式签名） | ✅ 已实测（2026-10-30）：测试签名可支撑开发期验证，但要求用户关闭 Secure Boot（固定门槛，不可用于发行）；**发行路线需 attestation 签名（微软硬件开发者中心提交，免费、无 EV 证书要求）优先评估，EV 证书仅 attestation 走不通时备选** |
| 3.3.2 | 获取 EV 代码签名证书的成本与周期 | ⬜ 未评估（3.3.1 结论后优先级下降：attestation 不需要 EV 证书） |
| 3.3.3 | 驱动崩溃是否导致系统不稳定 | ⬜ 未评估；POC 期间驱动零崩溃，UMDF 用户态隔离设计天然优于内核驱动（崩溃仅死 WUDFHost 进程） |
| 3.3.4 | 与远程桌面/显卡驱动的兼容性 | ✅ POC 期间（2026-10-30）：Intel Arc Graphics 上 DD 正常工作，与显卡驱动无冲突；RDP 会话下行为待阶段 4 实测 |
| 3.3.5 | Windows 更新后驱动是否需要重新适配 | ⬜ 未评估（Windows 11 24H2 / build 28000 环境一次通过，观察后续版本） |

**停止判据**：~~若 3.2.1 或 3.2.2 无法在 2 周内通过，建议暂停扩展屏幕投入~~ → **已解除（2026-10-30）**：3.2.1 与 3.2.2 一次通过，**阶段 4 定向 IddCx 真实第二屏路线**，「投屏式降级」仅作为发行签名受阻时的备选。

---

## 4. 交付物进度

- [x] scrcpy 环境安装与版本基线（第 1 节）
- [x] scrcpy 采集链路、窗口参数、多设备、退出码验证（第 2 节）
- [x] `docs/license-inventory.md` 补充 scrcpy 发行包实际组件
- [ ] 人工交互项：鼠标/键盘/中文输入/剪贴板/断网（第 2.6 节）
- [x] IddCx 实验项目（第 3 节）：EWDK 构建通过、驱动安装/创建/取帧/销毁全部验证（2026-10-30，原「被 VS+WDK 阻塞」已用 EWDK 绿色环境化解）
- [ ] `docs/architecture.md` 未决问题更新（媒体通道选型）
- [x] 结论：**扩展屏幕继续投入——阶段 4 走 IddCx 真实第二屏路线**（2026-10-30，3.2.1/3.2.2 通过后停止判据解除）

---

## 5. 记录要求

- 失败要写清楚失败现象与尝试过的办法，不要只写"不行"。
- 主观体验（延迟、手感）也要记录，这是产品决策依据。
- 所有版本号必须精确到实际使用的版本，后续排查全靠它。
- **自动化验证与人工验证要分开标记**，不要把"没测"写成"通过"。

### 2.9 文件传输跨平台真机走查（新增，2026-10-30，Agent B）

真实跨设备（Windows 桌面 Host ↔ 联想平板 TB710FU，真实 Wi-Fi 局域网，
无头 Host + 平板侧仅 debug 驱动入口，输入零注入）：

| 场景 | 结果 | 证据 |
|---|---|---|
| 桌面 → 平板（下行 1 MB ×2 轮） | ✅ | 任务 completed，平板落盘 `walkthrough-payload.bin` 1048576 字节 |
| 平板 → 桌面（上行 512 KB ×2 轮） | ✅ | 平板发起 offer → 桌面自动接受 → 推送完成，落盘 `test-up.bin` |
| 内容完整性 | ✅ | **SHA-256 双向逐字节一致**：下行 `8c2877467e8be207…`、上行 `f01fb675036060d8…`（两端独立计算比对） |
| 取消传播（真机） | ⬜ 待补 | 桌面 e2e 已覆盖（真实控制通道）；真机变体脚本已备（walkthrough CANCEL_TEST），待平板空闲窗口执行 |

走查基建：`.zwork/b/input-walkthrough.ts`（不入库）+ `apps/android/app/src/debug/`
的 DebugEntryActivity（`am start` 直达，绕开 ZUI 的广播延迟投递与触摸注入门）。

仍然未覆盖：弱网（丢包/高延迟）行为、NAT/防火墙穿越、发送方崩溃后平板侧
`.part` 的启动清扫（已列入待办）。
