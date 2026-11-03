# swd-host — 虚拟显示器的会话级宿主进程

线 3（3.2-1）：`VirtualDisplayManager`（主进程
`apps/desktop/src/main/extend/virtual-display.ts`）spawn 这个进程来
创建虚拟显示器，会话结束时杀掉它来销毁。

## 为什么不用 PoC 的 IddSampleApp.exe

PoC 的 App 是交互式验证程序：启动后跑 8 秒取帧验证、写 BMP/jsonl、
再等键盘按 `x` 才退出。会话宿主不需要这些：swd-host 只创建设备、
报状态、等退出信号。创建参数（硬件 ID、实例 ID、CapabilityFlags）
与 PoC `main.cpp` 一字不差，驱动侧行为一致。

## 协议

- **stdout**：`SWD-READY`（设备已创建）、
  `SWD-DISPLAY-APPEARED <n>`（新输出已出现，n 为当前输出总数）或
  `SWD-DISPLAY-TIMEOUT`（20s 内新输出未出现——驱动未装/签名问题时
  会出现；进程继续活着，主进程按自己的超时判失败并杀进程）、
  `SWD-CLOSED <before> <after>`（正常关闭后的输出集合计数）。
- **退出**：Ctrl-C / stdin EOF → 正常关闭（`SwDeviceClose`）；
  被杀（TerminateProcess）时句柄由系统关闭，PnP 同样摘掉设备。
- **退出码**：0 正常关闭；1 `SwDeviceCreate` 失败或创建回调超时。

## 构建

与 dd-capture 同一套 EWDK 流程：

```
E:\BuildEnv\SetupBuildEnv.cmd
call SetupVSEnv
cd /d D:\test\testforai\LinkSpace\native\swd-host
build.cmd
```

产物 `x64\Release\swd-host.exe` 不进仓。

## 验证记录

- **2026-11-03 会话 0（SSH）**：修复前 `SnapshotOutputCount` 在
  `EnumOutputs` 返回 `DXGI_ERROR_NOT_CURRENTLY_AVAILABLE` 时对空指
  针调 `GetDesc`，直接 AV（`0xC0000005`，退出码 -1073741819）。
  已修复：`EnumAdapters1` / `EnumOutputs` 任何失败都跳出，adapter
  每轮先 `Reset()`（与 dd-capture 同批加固）。修复后会话 0 表现：
  `SWD-READY` → `SWD-DISPLAY-TIMEOUT`（20s）→ stdin EOF 后
  `SWD-CLOSED 0 0`，退出 0。
- **2026-11-03 交互会话（非管理员计划任务）**：`SwDeviceCreate`
  失败 `0x80070005`（E_ACCESSDENIED），退出 1。创建 SW 设备需要
  管理员权限，主进程 spawn 时须保证提权上下文；未提权时按失败处理，
  不要静默重试。
- **当前环境限制**：Secure Boot 开启 + testsigning 关闭，IddSampleDriver
  设备在设备管理器里存在但 `Disconnected`（驱动因签名无法加载），
  因此 `SWD-DISPLAY-APPEARED` 至今未在真机上出现过——须用户在 UEFI
  关 Secure Boot + `bcdedit /set testsigning on` 并重启后才能验证
  出现路径（见 `native/virtual-display/README.md` §3 方案 A）。

## 待实测（驱动装上后才能验证）

- kill 进程后输出集合是否回到创建前（`SWD-CLOSED` 只覆盖正常关闭
  路径；被杀路径靠 PnP 摘设备，需真机确认无残留）。
- 请求尺寸与 Driver.cpp 预置模式的匹配：目前创建的是一组固定模式，
  管理器按“最接近请求尺寸”挑已出现的显示器；按请求尺寸选模式
  以后再加（需要改 IddSampleApp/Driver 的模式表或给 swd-host
  加 `--mode` 参数）。
