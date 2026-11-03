# 随包节点创建助手（线 3，设备节点创建）

本目录随 LinkSpace 安装包分发（electron-builder `extraResources`：
`resources/winhelper` → `winhelper`），供 `VddDriverManager`
（`src/main/extend/vdd-driver.ts`）在设备节点缺失时调用。

## 文件

- `linkspace-rootdev.exe`——节点创建助手（x64，143,360 字节）
  - SHA-256：`87B151B7A0B6A09F50526EC112C0C56DD8DD73FDFF5BFA6624560900949DC17C`
  - 源码：`native/winhelper/linkspace-rootdev.cpp`（自有代码，约 200 行）
  - 构建：EWDK 28000.2526，见 `native/winhelper/build.cmd`
  - 构建时间：2026-11-03，zero 上构建通过（0 错误 0 警告），`--help` /
    无参数 / 参数不足均返回用法退出码 2、INF 不存在返回 16（均未碰设备）
- 构建产物在 `native/winhelper/`（不进版本库）；本目录的 exe 是随包分发的拷贝，
  更新源码重编后须同步拷贝并更新此处的 SHA-256。

## 用法

`linkspace-rootdev.exe install <infPath> <hardwareId>`，例如：

```
linkspace-rootdev.exe install C:\...\MttVDD.inf Root\MttVDD
```

先按硬件 ID 查 Display 类现存节点，已存在则跳过创建只装驱动（幂等）；
否则建节点、注册、装驱动并启动。退出码：0 成功；2 用法错误；
10 建设备信息集失败；11 建设备信息失败；12 写硬件 ID 失败；
13 注册设备失败；14 装驱动失败；15 硬件 ID 非法；16 INF 不存在。
须管理员权限。不碰 Secure Boot、不开 test signing。

详见 `native/winhelper/README.md`（选型、代价、活体验证清单）与
`docs/line3-vdd.md` ⑥。
