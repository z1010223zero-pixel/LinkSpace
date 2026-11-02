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

## 过渡定位与退役条件（线 2 选 A，2026-11-02 用户定）

scrcpy 只是过渡方案，不是产品功能：

- 正路是反向 screen.stream——平板用 MediaProjection 推画面，电脑在
  自己的画面窗口里看并控制；scrcpy 窗口不嵌入（已定：嵌完还是 scrcpy
  的窗口，迁就窗口句柄/输入路由/工具栏不值得）。
- 过渡期 scrcpy 只留必需能力：启动/停止/生命周期跟踪/错误分类，
  不扩新功能，不接管输入，不解析视频流。
- 衔接规则（代码见 `apps/desktop/src/main/ipc.ts`）：反向流在跑时
  `scrcpy:startFor` 拒绝同设备启动；反向流发起成功后停掉同一设备的
  scrcpy 会话；反向流仅发起未确认时仍允许 scrcpy（免得平板拒绝后
  两边都没有）。
- 退役条件（须同时满足）：① 反向流在联想小新平板 Pro GT 上通过
  2.6 人工走查（输入延迟、中文输入、剪贴板、断网恢复四项硬指标）；
  ② 用户确认。满足后下线 scrcpy 启动入口（屏幕页投屏卡片），
  适配器本身可随版本移除。退役前不删代码、不停维护门禁。

## 断开恢复语义（2.5）

- adb 断开（USB 拔出/断网）：scrcpy 进程自己退出，适配器按退出码与
  stderr 分类为 `DEVICE_NOT_FOUND`（可重试），用户在屏幕页重新点
  「启动投屏」即可；重连时无线走 IP-join 重算、USB 走持久化显式绑定。
- 设备下线（LinkSpace 对端断连）≠ 撤销信任：scrcpy 不自动停
  （adb 通道独立于 LinkSpace 控制连接，信任还在）。
- 信任撤销：级联停掉该设备全部 scrcpy 会话并删除其绑定（W2，
  `host.ts` 的 `onRevoked` + `ipc.ts` 的 `setScrcpyRevokedHandler`）。
- 进程僵死：设备连续两次成功枚举都不见（约 10 秒）而会话还挂着，
  `DeviceManager.refresh()` 主动停掉（见 `device-manager.ts`
  `reconcileStaleSessions`）；枚举失败时保留上次列表，不误删会话。

## 关键实现要求

- 会话 ID 与子进程 PID 绑定，主进程维护映射表
- `stop` 必须可重复调用；子进程不响应时超时强制 kill
- 应用退出时统一清理，杜绝孤儿进程
- 日志不得包含剪贴板内容或认证信息

## 无线连接

开启无线 ADB 必须显式授权，默认关闭。优先 Android 11+ 的配对码方式，而非直接开放 5555。

## 实测结论（2026-10-28，scrcpy 5.0.1）

以下为实测通过的能力，可直接作为实现依据：

### 可用的命令行控制

```
scrcpy -s <serial> \
  --window-title="LinkSpace-<deviceId>" \
  --window-x=120 --window-y=100 --window-width=420 \
  --max-size=800 --print-fps
```

- `--window-title` / `--window-x|y|width|height` 均可指定 → **统一窗口布局可行**
- `--max-size` 生效（实测输出 368×800）
- `--print-fps` 输出实时帧率，可用于性能监控与自适应码率
- 渲染走 `direct3d11`，解码走 `d3d11va`（硬件解码），实测 30–33 fps

### 无头验证手法（回归测试用）

```
scrcpy -s <serial> --no-window -r out.mp4 --time-limit=5
```

无需人工关窗口，适合放进自动化测试。录制时固定出现
`WARN: [FFmpeg] track N: codec frame size is not set`，**无害**，不必排查。

### 退出码映射

| 场景 | 退出码 | stderr |
|---|---|---|
| 正常结束 / `--time-limit` 到期 | 0 | — |
| 设备不存在 | 1 | `ERROR: Could not find ADB device <serial>:` … `ERROR: Server connection failed` |

实现 `AdapterError.code` 时以退出码为第一层分类，再解析 stderr 中 `ERROR:` 开头的行做细分。

**缺口**：设备中途断网、USB 拔出、未授权设备的退出码未测，需人工补测后才能完成错误映射表。

### 序列号注意事项

无线设备的序列号为 `adb-xxxx._adb-tls-connect._tcp` 形式，**含点号与下划线且较长**，构造命令行时注意转义与引号。可用作会话键（`-s`）。

### 已验证场景

- ✅ 真机（Xiaomi Redmi 24117RK2CC / Android 16）无线 TLS 采集
- ✅ 模拟器（Android 16）采集
- ✅ 两台设备并发，互不串流，均正常退出
- ⬜ 鼠标键盘控制、中文输入、剪贴板、断网恢复 —— 需人工验证

## 状态

环境已就绪，自动化验证部分通过。人工交互项（控制/输入/剪贴板）待补测后即可开始编码。
验证清单见 `docs/technical-validation.md` 第 2 节。

## 许可证

scrcpy 本体为 Apache-2.0。但**发行包内的 FFmpeg（avcodec/avformat/avutil/swresample）、SDL3、libusb 需单独履行义务**，且官方包内只附了 Apache-2.0 一份 LICENSE.txt，其余组件的许可证需自行补齐。详见 `docs/license-inventory.md` 1.3。
