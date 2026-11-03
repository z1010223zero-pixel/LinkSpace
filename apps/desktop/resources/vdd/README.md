# 随包 VDD 驱动（线 3，⑤）

本目录随 LinkSpace 安装包分发（electron-builder `extraResources`：
`resources/vdd` → `vdd`），供 `VddDriverManager`（`src/main/extend/vdd-driver.ts`）
在用户显式点击安装时使用。

## 来源

- 上游：`github.com/VirtualDrivers/Virtual-Display-Driver`
- Release：**25.7.23**（"Beta: Virtual Driver Control (25.7.23)"，2025-07-23）
- 包：`VirtualDisplayDriver-x86.Driver.Only.zip`（驱动-only，x64，不含控制应用）
- 官方下载链接：`https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip`
- 大小：**132,118 字节**
- SHA-256：`E24210692B442B39AF763536330CE78B423F19342B7A7792C26DE3944E418B3A`
- 驱动版本：**11.30.4.434**（`MttVDD.inf` DriverVer 12/24/2024）
- 框架：IddCx 1.10；签名：SignPath Foundation Authenticode（非 WHQL）

> 上游 Release 页不公布 SHA-256，上述哈希是 2026-11-03 从官方直链下载后
> 实测的；校验链（大小 + INF 版本 + .cat/.dll 签名 Valid）见 `docs/line3-vdd.md` ①。
> 安装前 `VddDriverManager` 会重验大小与 SHA-256，不符即拒绝安装。

## 许可证

MIT（`Copyright (c) 2024 Virtual Display`），全文见旁边的 `LICENSE.txt`。
MIT 允许再分发，条件仅为保留版权声明与许可声明——本目录随包附带即满足。

## 包内文件

解包后为 `VirtualDisplayDriver/` 目录，含：

- `MttVDD.inf` / `MttVDD.dll` / `mttvdd.cat`（驱动本体）
- `vdd_settings.xml`（默认设置模板：count=1，含 1920×1080@30 等 5 档）

## 静默安装的信任前提

驱动是非 WHQL 的 Authenticode 签名，首次安装需把 SignPath 发布者证书
放进本机 `TrustedPublisher`，否则会弹发布者信任框。安装时管理器从
解包后的 `mttvdd.cat` 实时取签名者证书（验 Status=Valid 且主题含
`SignPath Foundation`），经 `certutil -addstore TrustedPublisher` 导入。
不碰 Secure Boot、不开 test signing、不装自签证书。详见
`src/main/extend/vdd-driver.ts` 的信任步骤注释与 `docs/line3-vdd.md` ⑤。

## 已知缺口

`pnputil /add-driver` 只把驱动包暂存进驱动库；在一台从未装过 VDD 的
机器上，设备节点本身（硬件 ID `Root\MttVDD`）还需另一步创建（devcon
或 SwDeviceCreate 小助手），本版本未包含——`status()` 会如实报
`installed=true, devicePresent=false`。zero 上节点已建好，不受影响。
