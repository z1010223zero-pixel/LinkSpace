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

- **③ 控制台会话验证**：用户在电脑前操作，把 VDD 虚拟屏设为扩展，
  确认显示设置里出现第 3 块屏、分辨率/位置符合预期、窗口可拖过去；
  重新启用只需 `Enable-PnpDevice -InstanceId 'ROOT\DISPLAY\0001'`（管理员），
  用完可再 `Disable-PnpDevice` 恢复。
- **④ LinkSpace 接流**：桌面 screen-stream 抓取虚拟屏画面并推到平板呈现，
  输入回路与线 2 的信任清单/失焦暂停逻辑配合；虚拟屏无物理输入，
  注意鼠标/触控落点与显示拓扑的对应关系。
- **⑤ 驱动生命周期进桌面应用**：首次安装流程（官方 Releases 直链下载 →
  验大小与签名 → `pnputil /add-driver` → 建设备节点 →
  SignPath 证书进 `TrustedPublisher` 才可静默）、卸载/禁用清理、
  版本钉死 **25.7.23 + SHA-256 `E24210…B3A`**（见上）、`vdd_settings.xml`
  的生成与管理；安装包内附带 VDD 的 MIT LICENSE 文本。
  - 别用 winget 的 `VirtualDrivers.Virtual-Display-Driver`：那只是控制应用的便携包，**不装驱动**。
  - 别用仓库里的社区脚本安装：有杀软误报先例，只用官方 driver-only 包。

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
