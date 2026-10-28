# modules/scrcpy-adapter — Android 投屏与控制适配

架构 L4 层。实现 `CapabilityAdapter` 接口（见 `docs/architecture.md` 6.1）。

## 职责（第一阶段：只做进程编排）

- 发现可用设备序列号（USB 与 `host:port`）
- 组装 scrcpy 命令行参数并启动进程
- 监听进程生命周期，退出码映射为稳定错误码
- 停止时确保进程退出、端口释放

## 明确不做

- 不解析视频流
- 不接管输入事件
- **不修改 scrcpy 源码**（方案 3.1 第 3 条）
- **不用于实现 Windows 扩展屏幕** —— scrcpy 的 Android 虚拟显示 ≠ Windows 虚拟显示器

## 关键实现要求

- 会话 ID 与子进程 PID 绑定，主进程维护映射表
- `stop` 必须可重复调用；子进程不响应时超时强制 kill
- 应用退出时统一清理，杜绝孤儿进程
- 日志不得包含剪贴板内容或认证信息

## 无线连接

开启无线 ADB 必须显式授权，默认关闭。优先 Android 11+ 的配对码方式，而非直接开放 5555。

## 状态

未开始。启动前须完成 `docs/technical-validation.md` 第 2 节验证。

## 许可证

scrcpy 为 Apache-2.0。**随发行版分发的二进制与其依赖（FFmpeg、SDL2、libusb、ADB）需逐个核实构建选项与再分发条件**，见 `docs/license-inventory.md`。
