# 线 3：复用开源 Virtual Display Driver（VDD）路线

> 日期：2026-11-03（UTC+8）｜分支：`decision/line2-accessibility-first`
> 用户决策：线 3（平板当扩展屏）复用开源 VDD，**不买 EV 证书、不走 attestation**。
> 自研 IddCx 驱动（`native/virtual-display/`，含 `.cat` + `.cer` 自签测试证书）**留仓备查，不删**，不再投时间。
> 本文档只记录 VDD 路线 ①② 的验证结论；任务清单、交接文档、`mvp-acceptance`
> 的路线改写由协调人在验证线收工后统一做。

## ① 上游核实：许可证与签名（结论：通过）

### 来源与版本

- 上游：`github.com/VirtualDrivers/Virtual-Display-Driver`
- 最新 Release：**25.7.23**（"Beta: Virtual Driver Control (25.7.23)"），
  发布于 2025-07-23T15:50:20Z，`prerelease: false`，即当前最新版。
- 本次采用的包（驱动-only，x64，不含控制应用）：
  - 文件：`VirtualDisplayDriver-x86.Driver.Only.zip`
  - 官方链接：`https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip`
  - 大小：**132,118 字节**（与 GitHub API 返回的 asset 大小一致）
  - SHA-256（2026-11-03 在 zero 上从官方链接下载后本地实测）：
    `E24210692B442B39AF763536330CE78B423F19342B7A7792C26DE3944E418B3A`

### 哈希缺口（诚实记录）

- 上游 Release 页（25.7.23 与 24.12.24 的 release notes 全文）**没有公布 SHA-256**，
  GitHub Releases 本身也不附文件哈希，所以**不存在“发布页给出的哈希”可供直接比对**。
- 本次的校验链是：官方 Releases 直链下载 → 大小与 API 一致（132,118 字节）→
  解包后 `MttVDD.inf` 的 `DriverVer = 12/24/2024,11.30.4.434` 与 zero 驱动库中已暂存的
  `oem116.inf`（同版本、同提供者）完全一致 → `.cat` / `.dll` 的 Authenticode
  签名校验均为 `Valid`。三者互相印证，未发现不一致。
- 后续（⑤）钉版本时就以本文件记录的版本号 + 上述 SHA-256 为准；
  若上游将来公布官方哈希，再补一次比对。

### 许可证：MIT（Route B 兼容，允许再分发）

- 已通过 GitHub API 读取仓库根目录 `LICENSE` 全文：标准 MIT License，
  `Copyright (c) 2024 Virtual Display`，含“use, copy, modify, merge, publish,
  distribute, sublicense, and/or sell”授权，条件仅为保留版权声明与许可声明。
- 结论：permissive 许可证，与 Route B（保留闭源商业发行选项）兼容；
  再分发/随 LinkSpace 安装包捆绑驱动文件时，须附带该 LICENSE 文本。
- 注意： companion 应用仓库 `VirtualDrivers/Virtual-Driver-Control` 的许可状态与驱动仓库不同，
  本路线**不引用、不移植该仓库的代码**，只用它发布的驱动包。

### 框架与签名

- 框架：IddCx（Indirect Display Driver，UMDF）。官方 Wiki 对照表：IddCx **1.10**，
  Signed ✅，支持 SDR/HDR、自定义 EDID、ARM64、浮点刷新率。
- 签名：`MttVDD.dll` + `mttvdd.cat` 经 **SignPath Foundation** Authenticode 签名，
  本地校验 `Status: Valid`，签名者 `CN=SignPath Foundation, O=SignPath Foundation,
  L=Lewes, S=Delaware, C=US`。
- 不是 Microsoft/WHQL 签名。含义：驱动加载不需要改测试签名（见 ②），
  但首次安装时 Windows 会弹出发布者信任提示，需把 SignPath 证书加入本机
  `TrustedPublisher`（静默安装见“后续接流 ⑤”；上游 issue #315 有同类讨论）。
- 旧版对照：24.12.24 发布的 `Signed-Driver-v24.12.24-x64.zip`（134,079 字节）
  内含同一驱动版本 11.30.4.434；25.7.23 的 driver-only 包内含驱动**仍是
  11.30.4.434，无版本差**，故本次验证直接以已暂存的同版本驱动为准，不再重复装包。

## ② 在 zero 上验证：建一块虚拟显示器（结论：通过）

### 动手前条件检查（2026-11-03 20:5x CST）

- 桌面 LinkSpace 应用**未在运行**：`tasklist` 无 `LinkSpace.exe` / `electron.exe`；
  在跑的 5 个 `node.exe` 均为 OpenAI Codex 运行时，与 LinkSpace 无关。
- 平板：adb 无线调试当时连不上（`adb connect 192.168.101.111:44311` 报
  connection refused 10061，`adb devices` 为空），无法直接确认平板前台状态；
  但桌面端应用未运行即无控制会话的另一端，故判定**无进行中的会话**，可以动手。
- 验证线最近活动：`review-tmp/` 最新文件 `reverse-window.png` 写于 12:27 UTC
  （约动手前 25 分钟），桌面应用当时已关闭。为不干扰其下一轮验证，
  本次采用“启用 → 验证 → 立即禁用恢复原状”的方式，不留拓扑变化。

### zero 事前状态（动手前已存在，非本次安装）

- 驱动包已在驱动库：`oem116.inf`，原始名 `mttvdd.inf`，提供者 `MikeTheTech`，
  类 Display，版本 **11.30.4.434**（2024/12/24），签名者 **SignPath Foundation**。
- 设备节点 `ROOT\DISPLAY\0001`（"Virtual Display Driver"）事前状态为
  `Error / CM_PROB_DISABLED`（已禁用，非故障）。
- 配置 `C:\VirtualDisplayDriver\vdd_settings.xml`（2026/10/28 写入）：
  `<count>1</count>`，分辨率含 1920×1080@30 等 6 档，全局刷新率 60–244 Hz。
- 另有一块既存的第三方虚拟显示适配器 `ROOT\DISPLAY\0000`
  （"Todesk Virtual Display Adapter"，OK），与本次无关，**未动**。
- 安全基线：`Confirm-SecureBootUEFI` 为 **True**（Secure Boot 开）；
  `bcdedit /enum {current}` 无 `testsigning` 项（测试签名关）。**本次未改基线，未重启。**

### 验证过程与结果

1. `Enable-PnpDevice -InstanceId 'ROOT\DISPLAY\0001'`（管理员会话，无重启提示）。
2. 10 秒后复查：
   - 设备节点：`Virtual Display Driver`，`Status: OK`，`Problem: CM_PROB_NONE`。
   - 监视器枚举（`Win32_PnPEntity`，`PNPClass = Monitor`）：由 2 块变为 **3 块**，
     新增 **`Generic Monitor (VDD by MTT)`，Status: OK**；
     另两块仍为 `Generic Monitor (Mi Monitor)` 与 `Integrated Monitor (MNE007ZA3-2)`。
3. 恢复原状：`Disable-PnpDevice -InstanceId 'ROOT\DISPLAY\0001'` 后复查，
   节点回到 `CM_PROB_DISABLED`，监视器枚举回到 2 块物理屏，与动手前完全一致。

### 结论

- **Secure Boot 开 + testsigning 关的基线不变、不用重启，VDD 驱动可正常加载，
  虚拟显示器可出现。** 线 3 之前卡在“IddSampleDriver 加载不了”的阻塞点，
  在 VDD 路线上不存在。
- 安装动作本身已是既成事实（驱动包 2026-10-28 前后已暂存，节点已建），
  本次验证的是“启用即用”，未重复执行 `pnputil /add-driver`。

### 未验证 / 限制（诚实记录）

- SSH 是非交互会话：`QueryDisplayConfig` 返回 0 路径、`System.Windows.Forms.Screen`
  只能看到会话内虚拟屏，**拿不到虚拟屏的分辨率与扩展位置的程序化读数，
  也截不到控制台“显示设置”界面的图**。虚拟屏“出现”以 PnP 监视器枚举为准。
- 未在控制台会话里把虚拟屏设为“扩展这些显示器”、拖窗口上去实测，
  也未验证 LinkSpace 抓屏虚拟屏并推到平板（那是 ③④）。
- 平板 adb 当时连不上，平板侧状态未直接核实；复核以桌面端无进程 + 恢复原状为准。

## 后续接流（③④⑤）待办

- **③ 控制台会话验证**（待用户本人在场）：用户在电脑前操作，把 VDD 虚拟屏设为扩展，
  确认显示设置里出现第 3 块屏、分辨率/位置符合预期、窗口可拖过去；
  重新启用只需 `Enable-PnpDevice -InstanceId 'ROOT\DISPLAY\0001'`（管理员），
  用完可再 `Disable-PnpDevice` 恢复。
- **④ LinkSpace 接流**（代码侧已完成，见下「④ 实现」一节；真机验证待平板无线调试恢复）：
  桌面 screen-stream 抓取虚拟屏画面并推到平板呈现，输入回路与线 2 的信任清单/失焦暂停逻辑配合；
  虚拟屏无物理输入，注意鼠标/触控落点与显示拓扑的对应关系。
- **⑤ 驱动生命周期进桌面应用**（已完成，见下「⑤ 实现」一节）：首次安装流程（官方 Releases 直链下载 →
  验大小与签名 → `pnputil /add-driver` → 建设备节点 →
  SignPath 证书进 `TrustedPublisher` 才可静默）、卸载/禁用清理、
  版本钉死 **25.7.23 + SHA-256 `E24210…B3A`**（见上）、`vdd_settings.xml`
  的生成与管理；安装包内附带 VDD 的 MIT LICENSE 文本。
  - 别用 winget 的 `VirtualDrivers.Virtual-Display-Driver`：那只是控制应用的便携包，**不装驱动**。
  - 别用仓库里的社区脚本安装：有杀软误报先例，只用官方 driver-only 包。
- **待补：全新机器上的设备节点创建**：`pnputil /add-driver` 只暂存驱动包，从未装过 VDD 的机器上
  设备节点（硬件 ID `Root\MttVDD`）还需另一步创建（devcon 或 SwDeviceCreate 小助手）；`create` 失败文案已能识别并指明，未实现。

## 复现命令（zero，管理员 PowerShell）

```powershell
# 状态
Confirm-SecureBootUEFI
pnputil /enum-drivers | Select-String -Pattern 'mttvdd' -Context 0,6
Get-PnpDevice -FriendlyName '*Virtual Display*' | Format-List FriendlyName, InstanceId, Status, Problem
Get-CimInstance Win32_PnPEntity | Where-Object { $_.PNPClass -eq 'Monitor' } | Select-Object Name, Status

# 启用 / 禁用（验证用，用完恢复）
Enable-PnpDevice -InstanceId 'ROOT\DISPLAY\0001' -Confirm:$false
Disable-PnpDevice -InstanceId 'ROOT\DISPLAY\0001' -Confirm:$false
```

## ⑤ 实现：驱动生命周期进桌面应用（2026-11-03）

> 分支 `decision/line2-accessibility-first`。实现文件见下；验证全部走
> fake 命令执行器，不动真实设备状态（zero 上驱动已装好，也不需要动）。

### 文件

- `apps/desktop/src/main/extend/vdd-driver.ts`——`VddDriverManager`：
  钉死常量（版本 25.7.23、SHA-256 `E24210…B3A`、132,118 字节、官方直链、
  `ROOT\DISPLAY\0001`、`mttvdd.inf`、驱动版本 11.30.4.434、
  `C:\VirtualDisplayDriver\vdd_settings.xml`）；命令执行层可注入
  （`CommandRunner`，默认 execFile，测试用 fake）；`status()` /
  `ensureInstalled()` / `setDeviceEnabled()` / `ensureSettings()` /
  `uninstall()`；全程经 `log.ts` 打日志（只记 basename，不记全路径）。
- `apps/desktop/src/main/verify-vdd-driver.ts`——无头测试（`npm run verify:vdd-driver`）：
  status 解析（英文/中文 pnputil 标签各一、已装/未装）、哈希不符与
  非管理员拒绝安装（且不发出任何安装命令）、安装 happy path（fake，
  断言 Expand-Archive → 信任导出 → certutil → pnputil /add-driver →
  复核的每一步命令）、已装直接 ok、enable/disable 命令、settings
  读/写（临时目录）、uninstall 门禁。共 51 项断言，全部通过。
- `apps/desktop/src/main/platform.ts`——`locateVddPackageZip()`：
  环境变量 `LINKSPACE_VDD_ZIP` → 打包资源 `<resourcesPath>/vdd/` →
  开发期仓内 `resources/vdd/`；找不到返回 null，不抛错。
- `apps/desktop/src/main/index.ts`——构造管理器并传给 `registerIpc`；
  只构造，不自动安装。
- `apps/desktop/src/main/ipc.ts`——新增 `vdd-driver:status`（只读快照）
  与 `vdd-driver:install`（用户显式动作）；`src/shared/types.ts` 与
  `src/preload/index.ts` 按现有模式补暴露。**不设任何自动调用点**，
  启动与会话流程里都不调安装；渲染层 UI（设置页按钮）待后续接。
- `apps/desktop/resources/vdd/`——随包驱动：官方 driver-only zip
  （已验大小 + SHA-256）、上游 MIT `LICENSE.txt` 全文、README
  （来源 URL、版本、哈希、信任前提、已知缺口）。`package.json`
  `extraResources` 已接线（`resources/vdd` → `vdd`）。

### 信任方法（选定：从 .cat 实时取签名者证书）

安装流程：已装且版本符合直接 ok → 管理员检查 → 随包 zip 验大小 +
SHA-256 → `Expand-Archive` 解到临时目录 → 信任 → `pnputil /add-driver
<inf> /install` → 再查 `status()` 复核版本。每步失败返回可操作的
reason（`not-admin` / `package-missing` / `hash-mismatch` /
`extract-failed` / `trust-failed` / `install-failed` / `verify-failed` 等）。

信任步骤选了**从 `.cat` 实时取签名者证书**，不用随包附带 `.cer`：

1. 上游 driver-only 包里只有 `.inf` / `.dll` / `.cat`，没有 `.cer`——
   证书只能从包里现取；现取还把信任锚定在刚验过哈希的同一份包上，
   不存在“附带的 .cer 与驱动包漂移”的风险。
2. 只导叶子证书（签名者本人）：`Get-AuthenticodeSignature -LiteralPath
   mttvdd.cat` → 验 `Status -eq Valid` 且 `SignerCertificate.Subject`
   含 `SignPath Foundation` → `Export('Cert')` 写临时 `.cer` →
   `certutil -addstore -f TrustedPublisher <cer>`。
   整条链的根（SignPath → GlobalSign R45）早已在 Windows 受信根里
   （TwinDesk issue #14 实测佐证：链构建 OK、根在 LocalMachine\Root），
   本步只需补“发布者可信”这一环；绝不往 Root 里加任何东西。
3. 机制是微软官方文档的做法：非 WHQL 的 Authenticode 签名驱动，发布者
   进了 TrustedPublisher 即可静默预装（Microsoft Learn《Digital
   Signatures and PnP Device Installation》）；上游同类讨论见
   Virtual-Display-Driver issue #315。
4. 不碰 Secure Boot、不开 test signing、不装自签测试证书。
   卸载时不清理 TrustedPublisher 里的 SignPath 证书（整机维度的发布者
   信任，其他 SignPath 签名驱动也可能依赖；卸载只拆驱动包）。

### 已知缺口：新机器上的设备节点创建

`pnputil /add-driver` 只把驱动包暂存进驱动库并装到已存在的匹配设备上；
在一台从未装过 VDD 的机器上，设备节点本身（INF 硬件 ID `Root\MttVDD`，
见 `MttVDD.inf` 的 `[Standard.NTamd64]` 节）还需另一步创建
（`devcon install MttVDD.inf Root\MttVDD`，或 SwDeviceCreate 小助手，
如 TwinDesk 的 `macshare-winhelper --add-root-device`）。本版本不自带
devcon、不写 P/Invoke 助手——`ensureInstalled()` 成功后若 `status()` 仍
报 `devicePresent=false`，即节点未建，属待补的后续工作，不是安装失败的
误报。zero 上节点 2026-10-28 前后已建好，不受影响。

另：ARM64 Windows 只接受微软签名的驱动包，VDD 25.7.23 是 SignPath 签名，
装不上（`0x800B0109`，见 TwinDesk issue #14 / 上游 #465）；管理器在
`install-failed` 的 detail 里会点出这一可能。zero 是 x64，不受影响。

## ④ 实现：VDD 后端虚拟显示器管理器（2026-11-03）

### 文件

- `apps/desktop/src/main/extend/vdd-display.ts`（新建，233 行）——`VddVirtualDisplayManager`，
  与旧 `VirtualDisplayManager`（swd-host 后端）完全相同的接口形状
  （`create` / `destroy` / `active` / `currentScreen` / `available`），后端是 VDD 设备节点 + `VddDriverManager`。
- `apps/desktop/src/main/index.ts`——Host 的 `extendCreateVirtualDisplay` / `extendDestroyVirtualDisplay`
  已换成 VDD 后端管理器；swd-host 的 `VirtualDisplayManager` 构造已去掉（类文件保留未删，测试仍用它）；
  启动日志改报 `虚拟显示器帧源：dd-capture=…`，并明确打一条
  `[extend] 扩展屏后端已切换到 VDD（Virtual Display Driver 25.7.23）`。
  `locateVirtualDisplayBinaries()` 仍保留（dd-capture 帧源还要用）。
- `apps/desktop/src/main/verify-extend.ts`——新增 21 项 VDD 断言（见下）。

### 行为

- `create(preferred)`：先查 driver `status()`，未安装直接返回可操作失败，**会话创建时绝不自动安装驱动**
  （安装只在设置页显式触发）；已装但 `devicePresent=false` 返回覆盖⑤已知缺口的文案
  （设备节点未创建，需另一步创建根设备）；`ensureSettings(1, preferred)`；记录会话前设备是否已启用；
  未启用时 `setDeviceEnabled(true)`；轮询 `listDisplays()` 差分等新显示器出现（默认 30s 超时，
  按最接近 preferred 挑一块）；超时失败时若本次会话启用过节点，恢复回禁用，不留残留。
- `destroy()`：只有本次会话是我们启用了节点时才发禁用（fire-and-forget，失败只记日志）；
  会话前已启用的保持启用；无活动显示器时是安全空操作。
- `available`：最近一次 `status()` 的 `installed` 快照（`create` 刷新，未查过时保守为 false）。

### startDd 矩形流向核实（已通，无代码改动）

行号按 LF 计数（host.ts 纯 LF 共 2027 行）：

- `host.ts:1212–1225`：`screen.stream.request`（`source='virtual-display'`）先校验
  `extendCoordinator.activeSession` 与请求方是同一 peer（无活动扩展会话直接回 error），
  然后 `startForwardStream(peerId, STREAM_SOURCE_VIRTUAL_DISPLAY, { ...ext.virtualScreen }, scaleWidth)`——
  region 就是活动扩展会话的 `virtualScreen`。
- `host.ts:1593–1602`：`startForwardStream` 里 `this.streamRegion = region`，
  随后 `screenStream.startDd({ ..., rect: region, ... })`。
- `screen-stream.ts:252–277`：`startDd` 用 `--rect x y w h` 起 dd-capture；
  `screen-stream.ts:451–458`：码率换档重启复用同一 `ddRect`。
- 锁屏解锁恢复同口径：`host.ts:1666–1672`，按原会话的 `ext.virtualScreen` 重起流。

### 触控映射核实（3.4 结论属实，只核实未重做）

- `host.ts:1067–1072`：input 会话的 `localScreen` 回调优先用 `this.streamRegion` 的 w/h 作映射目标。
- `host.ts:1078–1092`：`inject` 回调对 move 事件按 `streamRegion` 的 origin 平移回虚拟屏相对坐标。
- 扩展屏推流时 `streamRegion = virtualScreen`（见上 `host.ts:1593`），所以触控映射基准就是虚拟显示器矩形；
  断连兜底 `host.ts:451` 会清 `streamRegion`。无代码改动。

### 测试与验证（全部在 zero 上跑过）

- `npm run build`（electron-vite）通过；`npm run typecheck`（vue-tsc --noEmit）通过，无报错。
- `npm run verify:extend` 全部通过，含 21 项新增 VDD 断言（fake driver manager + fake listDisplays：
  happy path、驱动未装时 create 失败且未尝试 enable、设备节点未建时失败文案点出缺口、
  会话前已启用时不重复 enable 且 destroy 不禁用、destroy 空操作零驱动命令、超时后恢复禁用；
  开头一条 bonjour `Service name is already in use` 是 E2E 段的既有环境噪音，测试本身全绿）。
- `npm run verify:vdd-driver` 全部通过（⑤ 的 51 项断言未动）。
- 全程未做真实设备 Enable/Disable，未碰平板；zero 上 VDD 节点真实状态未动。

### 仍阻塞的活体验证

- ④ 真机验证：需平板无线调试恢复（2026-11-03 20:50 已断，44311 拒绝，疑似休眠）+ 扩展屏推流到平板实测。
- ③ 控制台扩展实测：须用户本人在场，显示设置里把虚拟屏设为扩展、拖窗口实测。
- 全新机器设备节点创建（devcon / SwDeviceCreate 小助手）未实现，只做了失败识别。
