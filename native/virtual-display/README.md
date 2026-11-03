# native/virtual-display — Windows 虚拟显示器（线 3，阶段 4）

> **状态：已收进仓（2026-11-03）**。PoC 源码此前只在磁盘工作区
> `D:\test\testforai\LinkSpace-desktop\experiments\iddcx-poc\`，现已收进本仓。
> 构建已在仓内复现（见 §2）。与主构建解耦：驱动构建不进主构建，失败不拖垮主进度（ADR-005）。
>
> 高风险实验项目，独立于主产品推进，失败不得拖垮主进度。

## 目标

让 Windows 识别一块虚拟显示器，用户可把窗口拖到 Android 平板上——是**真正的扩展屏**，不是普通投屏。

## 1. 工程来源与改动原则

基于微软官方 [IndirectDisplay 示例](https://github.com/microsoft/Windows-driver-samples)（MIT，`video/IndirectDisplay`）。

- `IddSampleDriver`（UMDF / IddCx，单虚拟显示器）：**原样保留，未改动**——2026-11-03 以 SHA-256 逐文件核对，与磁盘上的上游副本
  `D:\dev\iddcx\Windows-driver-samples\video\IndirectDisplay` 字节一致（Driver.cpp / Driver.h / Trace.h / .inf / .rc / .vcxproj / .filters / .sln 共 8 个文件）。
  保持驱动二进制为微软原始代码，把「OS 能否稳定跑 IddCx」与「我们自己的驱动改动是否引入问题」两个变量隔离。
- 唯一的代码改动在 `IddSampleApp`：
  - `main.cpp`：SWD 创建前后对 DXGI 输出集合做快照 diff（锁定虚拟显示器），退出后复核无残留；
  - `capture.cpp`（新增）+ `capture.h`（新增）：对新增输出做 **Desktop Duplication 抓帧** 8s，统计帧数 / 间隔，落首帧 BMP 并计 CRC32 与亮度范围（证明内容非空非全黑）。
- 取帧走 App 侧 DD 而非驱动内 SwapChainProcessor，因为阶段 4 的产品架构是「应用层抓帧 → 编码 → 发往平板」，驱动保持薄。

## 2. 构建（EWDK，免装 VS）

C 盘空间不足（<10GB），VS + SDK + WDK 全家桶装不下，改用 EWDK 绿色 ISO（自带 VS Build Tools + SDK + WDK，免安装）。
ISO 在磁盘上：`D:\dev\iddcx\EWDK_28000.2526.iso`（对应 Win11 26H1，可构建面向 26H2 的驱动）。

```powershell
# 1. 挂载 EWDK ISO（本 PoC 用 28000.2526）
Mount-DiskImage -ImagePath D:\dev\iddcx\EWDK_28000.2526.iso
# 2. 进入构建环境（盘符按实际挂载点，本机为 E:）
#    注意：LaunchBuildEnv.cmd 是 `%comspec% /k ...`，会挂起等交互；
#    非交互构建直接调它里面的 SetupBuildEnv.cmd
call E:\BuildEnv\SetupBuildEnv.cmd
# 3. 环境内编译 x64 Release
call SetupVSEnv
cd D:\test\testforai\LinkSpace\native\virtual-display
msbuild IddSampleDriver.sln /p:Configuration=Release /p:Platform=x64
# 4. 生成目录：x64\Release\（IddSampleApp.exe + IddSampleDriver.dll/inf/cat）
#    构建产物（x64/、*.sys、*.pdb 等）由 .gitignore 排除，不进仓
```

**仓内复现记录**：2026-11-03 在本目录以 EWDK 28000.2526 复跑 Release x64 构建成功（0 错误，22 秒；产物 `IddSampleApp.exe` 59,392 字节、`IddSampleDriver.dll` 49,208 字节、`iddsampledriver.cat` 2,705 字节）。
此前 2026-10-30 验证用的是同一源码的 Debug 构建（`x64\Debug`，磁盘原 PoC 目录）。
构建产物不进仓；调试期需要的 VC Debug CRT（`ucrtbased.dll` 等）只留在磁盘原 PoC 目录，不随仓分发。

## 3. 安装 / 运行 / 卸载（测试签名，验证用）

> 以下流程是 **PoC 验证流程**，不是发行安装流程。发行签名见 §5（attestation，仍是阻塞项）。

```powershell
# 0. 前置（管理员）：测试签名与 Secure Boot 互斥，二选一
#    2026-10-30 实测走方案 A：进 UEFI 关 Secure Boot（改前先 Suspend-BitLocker 防恢复密钥询问），再：
bcdedit /set testsigning on
Restart-Computer
# 1. （管理员）安装驱动包
pnputil /add-driver .\IddSampleDriver\x64\Debug\IddSampleDriver\IddSampleDriver.inf /install
# 2. （管理员）运行 App 创建 SWD，等 20s，「设置 → 系统 → 屏幕」应出现新显示器
.\IddSampleDriver\x64\Debug\IddSampleApp.exe
# 3. App 自动做 8s DD 抓帧，结果见 idd-poc-out\capture-report.jsonl
# 4. App 窗口内按 x 销毁 SWD，虚拟显示器消失
# 5. （管理员）清理并恢复正常状态
pnputil /enum-drivers          # 找到 IddSampleDriver 对应的 oem##.inf 编号
pnputil /delete-driver oem##.inf /uninstall
bcdedit /set testsigning off
Restart-Computer
```

测试签名期间桌面右下角出现「测试模式」水印，纯提示性，验证完关闭即消失。

## 4. 验证结果（2026-10-30，真机 Windows 11 26H2 Home build 26300.9711）

结论回写 `docs/technical-validation.md` §3.2。停止判据已解除：3.2.1 与 3.2.2 一并通过，阶段 4 定向 IddCx 真实第二屏路线。

| 判据 | 通过标准 | 结果 |
|---|---|---|
| 3.2.1 创建 | SWD 创建后 20s 内出现 1 个新 DXGI 输出；显示设置可见新显示器 | ✅ 通过。系统出现 3 个新输出（INF 预置模式 2560×1440 / 1024×768 / 2560×1440） |
| 3.2.1 稳定 | 保持 10 分钟无消失 / 重连风暴；设备管理器无黄叹号 | ✅ 通过 |
| 3.2.1 退出 | 按 `x` 键销毁 SWD 后输出集合恢复原状，无残留 | ✅ 通过 |
| 3.2.2 取帧 | `DuplicateOutput` 成功（hr=0）；8s 内 frames > 0 | ✅ 通过。3 个输出 `ddSupported=true`、`dupHr=0x0`、`frames=146/50/49`、`errors=0`、`avgInterval` 27~160ms |
| 3.2.2 内容 | BMP 非空（亮度范围 > 0，非全黑）；CRC32 随内容变化 | ⚠️ 部分通过。DISPLAY8（1024×768）与 DISPLAY9（2560×1440）首帧 `lumMax=255` 非全黑；DISPLAY10（2560×1440）首帧 `lumMin=lumMax=0`，全黑——该输出的画面在采样窗口内无内容，原因未定位（静态空桌面 / 合成未刷新均可能），记为待查观察，不影响“DD 能从虚拟输出取到帧”的结论 |
| 3.2.5 安装/卸载 | 普通用户可安装/卸载 | ❌ 不通过（仅测试签名流程走通）。`pnputil /add-driver /install` 与 `/delete-driver /uninstall` 全程走通，但前提是测试签名；普通用户无法安装未正式签名的驱动，须走 EV / attestation（见 §5） |

原始取帧证据：`evidence/capture-report-2026-10-30.jsonl`（3 行，与磁盘原 PoC 目录 `x64\Debug\idd-poc-out\capture-report.jsonl` 同内容）。
首帧 BMP（`frame-DISPLAY*.bmp`）体积大未进仓，留磁盘原目录备查。

实测环境坑（2026-10-30）：`bcdedit testsigning` 遇 Secure Boot 策略保护需先关安全启动；Debug 版 App 需 VC Debug CRT `ucrtbased.dll`（已从 EWDK ISO 拷至 exe 目录，见 §2）。

## 5. 签名：发行路线（阻塞项，3.3-4）

测试签名 + 关 Secure Boot **只是验证手段，不是发行方案**。发行须走 **attestation 签名**（微软硬件开发人员中心提交，替代测试签名 + 关 Secure Boot）。
截至 2026-11-03：attestation 流程尚未走通——需要 EV 代码签名证书与硬件开发人员中心账号，两者均未采购/注册，无法在本批内完成提交验证。
记为线 3 剩余阻塞项（任务清单 3.3-4），不得把测试签名当正式方案。

前车之鉴：TwinDesk 的 VDD 在 Windows ARM64 上因非微软签名被拒。

## 6. 与主进程的接线点（阶段 4 产品化，3.2 进行中）

主产品只通过进程间接口调用本目录，不直接链驱动代码：

- **虚拟显示器生命周期**：主进程（`apps/desktop/src/main/`）在 `display-extend` 会话 accept 后拉起一个常驻的虚拟显示器宿主进程（以本目录 `IddSampleApp` 的 SWD 创建 / 销毁逻辑为底，`main.cpp` 的交互式按 `x` 退出改为受控启停）；会话结束 / 断连 / 撤销信任时销毁 SWD（对应热插拔 3.3-1）。
- **帧源**：`apps/desktop/src/main/screen-stream.ts` 的 `ScreenStreamService` 增加虚拟显示器 DD 帧源（`capture.cpp` 的 `CaptureNewOutputs` 逻辑改为持续取帧 → 编码 → WS 二进制帧），替代 gdigrab 抓真实桌面；gdigrab 路径保留作镜像投屏（`screen.stream` 降级），不混用。
- **会话门**：`display-extend` 是独立会话类型（协议 §4.3，`sessionType: 'display-extend'`），与 `input` 会话解耦——无活动 `input` 会话也能开扩展屏，`input` 会话结束不终止扩展屏推流。
- **触控**：平板触控映射进虚拟显示器自己的坐标空间（协议 §4.7 `screen.stream.start` 的 `w/h` 为虚拟屏尺寸），不映射回真实屏。

## 7. 文件清单

| 文件 | 说明 |
|---|---|
| `IddSampleDriver.sln` | 解决方案（驱动 + App） |
| `IddSampleDriver/Driver.cpp`、`.h`、`Trace.h`、`.inf`、`.rc`、`.vcxproj`、`.filters` | 微软官方示例原样，未改动 |
| `IddSampleApp/main.cpp` | SWD 创建 / 销毁 + 3.2.1 判定（改动：输出快照 diff） |
| `IddSampleApp/capture.cpp`、`.h` | 新增：DD 抓帧验证（8s 采样 + BMP + JSONL） |
| `IddSampleApp/IddSampleApp.vcxproj`、`.filters` | App 工程（改动：纳入 capture.cpp/h） |
| `evidence/capture-report-2026-10-30.jsonl` | 2026-10-30 真机取帧原始记录 |

未进仓（留磁盘原 PoC 目录备查）：`x64/` 构建产物（exe/dll/sys/cat/pdb/CRT DLL）、`frame-DISPLAY*.bmp` 首帧图、`pp-out.xml`（0 字节空文件）。
`.zwork/a/poc/` 里另有一份 2026-10-29 的 App 草稿副本（capture.cpp/h、main.cpp 注释措辞与本仓收录的 10-30 版略有不同），以本仓收录的 10-30 验证版为准。

## 8. 风险

驱动运行在内核态（`docs/threat-model.md` T8）：缺陷可致蓝屏或被利用提权。必须解决签名、安装、卸载、回滚与恢复方案后才可分发。
