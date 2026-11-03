# 节点创建助手 linkspace-rootdev.exe（线 3，设备节点创建）

`pnputil /add-driver` 只把 VDD 驱动包暂存进驱动库；在一台从未装过 VDD
的机器上，设备节点本身（硬件 ID `Root\MttVDD`）还需另一步创建。
本目录的 `linkspace-rootdev.cpp` 就是这一步：单用途原生小助手，
由 `VddDriverManager.ensureInstalled()` 在节点缺失时调用。

## 选型（2026-11-03，结论：自研 SetupDi 助手）

| 方案 | 结论 |
| --- | --- |
| WDK `devcon.exe install` | 功能上就是正确做法，EWDK 里也有现成二进制（x64，121,288 字节）。但 devcon 是 WDK 样例工具，不在 WDK 可再分发清单里，塞进闭源发行包（Route B）是许可证灰区；且它是通用设备管理工具（可删/禁任意设备），随包带一个通用工具面太大。**不用**。 |
| `SwDeviceCreate` 小助手 | 出局（决定性）：Microsoft Learn 明确写 "After this handle is closed, PnP will remove the device"——一次性助手退出即删节点，节点也不随重启保留；要保住节点需常驻进程持句柄，等于给 LinkSpace 加一个后台守护进程，代价远超收益，且与“节点持久化、开关由设置页/会话控制”的设计冲突。**不用**。 |
| **自研 SetupDi 助手（本文件）** | **采用**：把 `devcon install` 的 API 序列（`SetupDiCreateDeviceInfo` + `SPDRP_HARDWAREID` + `DIF_REGISTERDEVICE` + `UpdateDriverForPlugAndPlayDevices`，见 Microsoft Learn "Using the DevCon Tool to Install a Driver Package"）写成约 200 行自有代码的单用途 exe，只建 `Root\MttVDD` 这一个节点。许可证干净（自有代码）、节点持久化（与 zero 现有 `ROOT\DISPLAY\0001` 同类根枚举节点，随重启保留）、同步确定性安装、无常驻进程。 |

## 代价

- 我们自己持有这段 SetupDi 代码（但序列是公开的 devcon 做法，风险低；活体验证仍待用户在新机器上跑一次，见下）。
- 构建需 EWDK（zero 上已有 ISO，见 build.cmd；换机/CI 需重新挂 ISO）。
- 助手只认 Display 类、只建 `Root\MttVDD`；换硬件 ID 须改源码重编（VDD 的硬件 ID 钉死在驱动 INF 里，不会变）。

## 行为

- `linkspace-rootdev.exe install <infPath> <hardwareId>`：先按硬件 ID 查 Display 类现存节点，已存在则跳过创建只装驱动（幂等，重跑安装不造重复节点）；否则建节点、注册、装驱动并启动。
- 注册出的节点实例 ID 由系统生成（全新机器上一般是 `ROOT\DISPLAY\0000`），管理器按硬件 ID 查找，不依赖实例 ID（见 `vdd-driver.ts` 的 `status()`）。
- 退出码：0 成功；2 用法错误；10 建设备信息集失败；11 建设备信息失败；12 写硬件 ID 失败；13 注册设备失败；14 装驱动失败；15 硬件 ID 非法；16 INF 不存在。失败时 stderr 有 `error 0x........ at <阶段>`。
- 须管理员权限（管理器调用前已检查；无权限时 SetupDi 报拒绝访问，映射为 `node-create-failed`）。
- 不碰 Secure Boot、不开 test signing、不写注册表信任项。
- 注意：装驱动后节点处于**已启用**状态（驱动已启动），即安装完会多一块虚拟显示器；启用/禁用由设置页与扩展会话流程管理（`setDeviceEnabled()`），安装本身不管。

## 构建

见 `build.cmd`：挂载 EWDK ISO → `build.cmd [盘符]`（默认 E:）。产物
`linkspace-rootdev.exe`（/MT 静态链接，目标机无需 VC 运行库）须拷到
`apps/desktop/resources/winhelper/` 才随包分发，并在该目录 README.md
里更新 SHA-256。本目录的 exe 是构建产物，不提交。

## 活体验证（待用户，SSH 会话里不做）

- 全新机器（无 VDD 节点）上跑一次安装：`ensureInstalled()` 应一路走到 `devicePresent=true`，且重启后节点仍在。
- 重跑安装：不应出现第二个节点（幂等）。
- 本任务只做了代码 + 桌面端 fake 验证，未在任何机器上真实创建节点。
