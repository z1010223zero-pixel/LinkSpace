# dd-capture — Desktop Duplication 持续取帧工具

线 3（3.2-1）：把帧源从 gdigrab 换成虚拟显示器的 DD 帧。主进程
（`apps/desktop/src/main/screen-stream.ts` 的 `startDd`）spawn 它，
它的 stdout（原始 BGRA）喂给 ffmpeg 的 rawvideo 输入再编码发 WS。

## 用法

```
dd-capture --rect <x> <y> <w> <h> [--fps <n>] [--frames <n>]
```

`--rect` 是目标输出的桌面绝对坐标（与 `session.accept` 回的
`virtualScreen` 一致）。验证时可传真实显示器的矩形——DD 对任何
输出都可用，不需要装驱动就能验证整条 DD → 编码 → WS 管道。

## 协议

- **stdout**：纯二进制，每帧 `w*h*4` 字节 BGRA、行紧排，无帧头。
  ffmpeg 以 `-f rawvideo -pix_fmt bgra -s WxH -i pipe:0` 读入。
- **stderr**：诊断。`DuplicateOutput` 成功后立即打
  `DD-READY <w> <h>`（主进程 10s 超时判失败）；每 300 帧打计数。
- **退出码**：0 采满 `--frames`；2 找不到匹配 rect 的输出；
  3 DuplicateOutput/AcquireNextFrame 失败；4 stdout 写失败。

## 构建

EWDK 环境（见 `native/virtual-display/README.md` 的构建一节）：

```
E:\BuildEnv\SetupBuildEnv.cmd
call SetupVSEnv
cd /d D:\test\testforai\LinkSpace\native\dd-capture
build.cmd
```

产物 `x64\Release\dd-capture.exe` 不进仓。

## 已知成本与限制

- **每帧一次全帧 CPU 拷贝**：staging 纹理 → Map → 逐行写 stdout，
  2560×1440 每帧约 14.7MB。局域网管道够用，但 CPU 占用高于 gdigrab；
  以后可走 NV12 / 共享纹理零拷贝或 h264_mf 的 D3D 输入再优化。
- **静态桌面不出帧**：DD 只在内容变化时产帧，不出帧 = 不占带宽，
  是期望行为。产品里刻意不晃鼠标（PoC 的 1px 微抖只用于验证）。
- **AccessLost 不自动重建**：`AcquireNextFrame` 失败（输出被拔、
  模式切换等）直接退出码 3，由主进程决定重建或结束流。
- **帧率不固定**：DD 出帧间隔随内容变化（PoC 实测 27~160ms）；
  ffmpeg 按到达顺序计时间戳，平板端按到达播放，不做补帧。

## 验证记录

- **2026-11-03 真机（Windows 11 26H2，交互会话）**：`--rect 0 0 2194 1234
  --frames 2`，光标移动触发内容变化，stdout 精确 `2×2194×1234×4
  = 21,659,168` 字节，`DD-READY 2194 1234`，退出 0。`--rect` 与任
  何输出都不匹配时退出 2 并列出全部输出（`DISPLAY2 2194×1234`、
  `DISPLAY1 1440×900`）。
- **会话限制**：SSH 会话（会话 0）里 DXGI 枚举不到任何输出
  （`EnumAdapters1` 直接 `NOT_FOUND`），dd-capture 只能在交互会话
  （或主进程 spawn）里跑；`EnumerateOutputs` 对 `EnumAdapters1` /
  `EnumOutputs` 的任何失败都跳出，不残留旧 adapter、不对空指针调
  `GetDesc`（2026-11-03 与 swd-host 同批加固）。
