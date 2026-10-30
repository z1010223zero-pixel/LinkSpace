# LinkSpace 架构设计

> 状态：主体已实现（2026-10-30 修订：进程模型 koffi 化、ADR-008、输入共享状态）
> 本文件是《LinkSpace 完整技术方案》的技术展开，定义了分层、进程边界、端口规划和适配层接口。
> 方案本身不在此重复，两份文档冲突时以本文件的细化结论为准，并在方案中回写。

---

## 1. 设计约束

以下约束来自方案第二节和第五节，是本架构不可违背的前提：

| 编号 | 约束 | 影响 |
|---|---|---|
| C1 | 不依赖云服务器完成核心功能 | 无中心服务，无账号体系，设备身份本地生成 |
| C2 | 文件、控制、媒体三类通道分离设计 | 三类通道独立演进，互不阻塞 |
| C3 | UI 不直接管理底层系统逻辑 | 渲染进程禁止 spawn 子进程、禁止直接调 Win32 |
| C4 | scrcpy / 键鼠 / 虚拟显示器经适配层接入 | 每个外部能力必须有可替换的接口 |
| C5 | 高权限操作必须显式授权 | 配对、控制、文件接收、无线 ADB 均有独立授权点 |
| C6 | 第一版不引入 Redis / K8s / 微服务 | 单机桌面进程 + 局域网直连 |

---

## 2. 分层架构

```
┌──────────────────────────────────────────────────────────┐
│  L1 表现层   apps/desktop (Electron Renderer, Vue 3 + TS)  │
│             设备卡片 / 布局拖拽 / 传输任务 / 会话状态        │
├──────────────────────────────────────────────────────────┤
│  L2 会话层   modules/device-management                    │
│             设备注册表 / 信任关系 / 会话生命周期 / 状态机     │
├──────────────────────────────────────────────────────────┤
│  L3 通信层   modules/protocol + modules/file-transfer      │
│             mDNS 发现 / TLS 控制通道 / HTTPS 分块传输       │
├──────────────────────────────────────────────────────────┤
│  L4 适配层   modules/scrcpy-adapter                        │
│             modules/input-sharing                          │
│             modules/clipboard                              │
│             native/windows-helper                          │
│             native/virtual-display（独立验证，暂不接入）      │
└──────────────────────────────────────────────────────────┘
```

**依赖方向严格向下。** L1 通过 IPC 调用 L2，L2 调用 L3/L4，禁止反向依赖和跨层直连。

L4 的每个适配器对外暴露统一形状（见第 6 节），使上层在替换实现（如 scrcpy → 自研引擎，Input Leap → 自研）时无需改动 L2。

---

## 3. 进程模型（桌面端）

```
electron main process
 ├── 设备注册表 + 会话管理器（L2，常驻）
 ├── 本地 HTTPS 服务（控制通道 + 文件通道，L3）
 ├── mDNS 服务注册与浏览（L3）
 ├── IPC 网关（给 renderer 的唯一入口）
 └── 子进程池
      ├── scrcpy.exe（每个投屏会话一个，独立生命周期）
      └── adb.exe（按需调用，短生命周期）

（Win32 原生能力经 koffi FFI 进程内承载，无辅助子进程，见 ADR-008）

electron renderer process（可多个窗口）
 └── Vue 应用，只做展示 + 通过 IPC 发指令
```

规定：

1. **渲染进程不得创建子进程。** 所有 spawn 走主进程，违反 C3 会让窗口崩溃时遗留孤儿进程。
2. **每个 scrcpy 会话一个进程，会话 ID 与进程 PID 绑定。** 主进程维护 `Map<sessionId, ChildProcess>`，退出时统一 kill，避免断线后残留。
3. **Win32 原生能力进程内承载（ADR-008）。** 输入注入与光标采集经 koffi FFI 直接调用 user32（`input/win32/native.ts`），没有独立辅助进程。原生模块加载失败一律返回 null 降级（键鼠入口隐藏），绝不抛异常打断主进程启动。
4. **进程退出必须清理。** main process 的 `before-quit` 钩子负责：停会话 → 关监听 → 注销 mDNS。

---

## 4. 端口与通道规划

| 通道 | 传输 | 端口策略 | 说明 |
|---|---|---|---|
| 设备发现 | mDNS (`_linkspace._tcp`) | UDP 5353（系统 mDNS 服务） | TXT 记录携带真实端口、设备 ID、能力位、协议版本 |
| 控制通道 | WebSocket over TLS | 随机高位 TCP，由 mDNS 通告 | 复用文件通道的 HTTPS 服务 |
| 文件通道 | HTTPS 分块传输 | 与控制通道同一端口 | 减少防火墙规则和端口冲突 |
| 剪贴板 | 复用控制通道 | — | 不单独开端口 |
| scrcpy 媒体/输入 | scrcpy 自有协议 | 经 adb 隧道，本地回环 | 不经 LinkSpace 控制通道，见 6.2 |
| ADB 无线调试 | TCP 5555 | 仅在用户显式授权后启用 | 默认关闭，见 threat-model |

**为什么不固定端口**：固定端口在多实例、端口被占用、企业网络策略下都会出问题。mDNS 通告真实端口是标准做法，代价是需要防火墙放行应用本身而非某个端口。

**防火墙**：安装版首次启动走 Windows 系统标准授权弹窗（应用首次监听时触发），不预置提权规则、不静默修改。调试场景提供手动放行指引。

---

## 5. 核心状态模型

### 5.1 设备信任状态机

```
                pair.request
   unpaired ─────────────────► pending
       ▲                          │ 双方确认
       │      reject / timeout    ▼
       └──────────────────────  trusted
                                  │ 用户撤销
                                  ▼
                               revoked ──► (可重新配对，生成新指纹)
```

- `pending` 必须有超时（建议 120s），超时回落 `unpaired`。
- `revoked` 是终态，不自动回到 `unpaired`，避免撤销后被自动重连。
- 证书/公钥指纹在 `pending → trusted` 时确认并持久化。

### 5.2 连接状态机

```
offline ──discover──► discovering ──connect──► connecting ──handshake ok──► online
   ▲                       │                       │                          │
   └───────────────────────┴───────────────────────┴────── heartbeat timeout ─┘
```

- `online` 依赖心跳（建议 5s 间隔，15s 无响应判定丢失）。
- **连接状态与布局无关**：设备离线后布局保留（方案 2.2 要求），因此 `layout` 独立存储，不随 `connectionState` 清理。

### 5.3 会话状态机（投屏 / 传输 / 控制通用形状）

```
idle → starting → running → stopping → idle
         │          │
         ▼          ▼
       error ────► (清理后回 idle，保留错误原因供 UI 展示)
```

- `stopping` 必须能处理子进程不响应的情况（超时后强制 kill）。
- 任何进入 `error` 的会话都要记录可展示给用户的错误分类，而非原始堆栈。

---

## 6. 适配层接口

L4 各适配器实现统一接口，L2 只依赖接口。以下为 TypeScript 形状草案。

### 6.1 通用能力接口

```ts
export type SessionId = string;

export interface CapabilityAdapter<TConfig, TStatus> {
  /** 适配器支持的能力标识，用于协商 */
  readonly capability: string;
  /** 启动会话，返回会话 ID。必须在超时内返回或抛错 */
  start(config: TConfig): Promise<SessionId>;
  /** 停止会话。必须保证资源释放，可重复调用 */
  stop(id: SessionId): Promise<void>;
  /** 查询会话状态，供 UI 轮询或事件补帧 */
  status(id: SessionId): TStatus;
  /** 异常上抛通道，L2 统一转成会话错误事件 */
  onError(handler: (id: SessionId, err: AdapterError) => void): void;
}

export interface AdapterError {
  /** 稳定错误码，UI 据此选择文案 */
  code: 'DEVICE_OFFLINE' | 'AUTH_REQUIRED' | 'PORT_BUSY' | 'UNKNOWN';
  /** 可展示给用户的原因，不得含凭据或剪贴板内容 */
  message: string;
  /** 是否建议重试 */
  retryable: boolean;
}
```

### 6.2 scrcpy 适配器

第一版只做**进程编排**，不嵌入窗口、不修改底层（方案 3.1 / 7.1）。

- 输入：设备序列号（USB 或 `host:port`）、启动参数（分辨率上限、码率、是否显示触摸、窗口标题）。
- 输出：会话 ID、进程状态、退出码。
- 职责边界：不解析视频流，不接管输入事件。投屏窗口由 scrcpy 自己创建。
- 无线路径：无线 ADB 的开启、配对码流转由本适配器与 `windows-helper` 协作完成，且必须显式授权。

**已知限制（写死在注释里，避免后人误判）**：scrcpy 的 Android 虚拟显示 ≠ Windows 虚拟显示器，不能用于实现第九节的扩展屏幕。

### 6.3 输入共享适配器

分两个子实现，对应方案第八章：

| 子实现 | 场景 | 状态 |
|---|---|---|
| `win2win` | Windows ↔ Windows 边缘穿越 | **已自研实现**（阶段 3）：koffi SendInput 注入 + 轮询采集 + 边缘穿越。Input Leap 已归档不复用（license-inventory 1.1） |
| `android2win` | Android → Windows | **已实现**（协议 4.6）：Android 端作触控板控制端，桌面被控端会话状态机 |
| `win2android` | Windows → Android | 未启动；第一阶段复用 scrcpy 窗口内输入 |

两者不共用坐标系逻辑，避免把桌面边缘穿越的假设错误套到 Android 上。

### 6.4 虚拟显示器适配器

**接口先定义，实现留空。** 在方案第九节的五个前置问题（9.4）验证通过前，此适配器返回 `UNSUPPORTED`，且不得阻塞主功能交付。实现放在 `native/virtual-display` 独立仓库/目录，主产品通过进程间接口调用。

---

## 7. 持久化

第一版采用：`app.getPath('userData')` 下的本地文件存储。

| 数据 | 存储方式 | 说明 |
|---|---|---|
| 设备注册表、信任关系、公钥指纹 | `devices.json` | 不含任何凭据明文 |
| 设备布局 | `layout.json` | 与在线状态解耦，见 5.2 |
| 应用设置 | `settings.json` | 接收目录、端口策略、授权开关 |
| 传输历史 | 第一版不持久化 | 避免保存文件路径等敏感信息 |
| 日志 | `logs/` | 脱敏，见 threat-model |

密钥材料使用 Electron `safeStorage` 加密后落盘；明文密钥不写文件、不进日志。

后续若数据量或查询复杂度上升，再迁移到 SQLite（`better-sqlite3`），迁移成本由本节的单一存储入口收敛。

---

## 8. 技术决策记录（ADR）

| ID | 决策 | 理由 | 复审条件 |
|---|---|---|---|
| ADR-001 | 桌面端采用 Electron + Vue 3 + TS | 便于管理子进程、多窗口、系统托盘；生态成熟 | 已复审（2026-10-28）：内存 340 MB、空闲 CPU 可忽略，继续采用 Electron。若后续加入文件传输/WebRTC 后内存显著增长，再评估 Tauri |
| ADR-002 | 第一版投屏以子进程方式调用官方 scrcpy | 先验证功能闭环，避免重写视频与输入引擎 | 需要嵌入窗口、自定义 UI 或多路合屏时复审 |
| ADR-003 | 控制通道与文件通道复用同一 HTTPS 端口 | 减少防火墙规则与端口冲突 | 文件吞吐影响控制消息实时性时拆分 |
| ADR-004 | 发现用 mDNS，UDP 广播作为降级方案 | mDNS 是标准做法且携带 TXT 元数据 | 目标网络组播被禁时启用降级路径 |
| ADR-005 | 虚拟显示器独立于主产品验证 | 驱动层风险高，失败不应拖垮主进度 | 9.4 五个问题验证通过后方可并入主仓库 |
| ADR-006 | 第一版持久化用本地 JSON 文件 | 数据量小、依赖少、便于排查 | 数据量上升或需要复杂查询时迁 SQLite |
| ADR-007 | 第一版不引入任何云端服务与账号 | 符合 C1，降低隐私与合规负担 | 需要跨网段设备目录时复审 |
| ADR-008 | 输入注入用 koffi 进程内 FFI，放弃 .NET 辅助进程（windows-helper） | 单 exe 部署、无 IPC 与进程生命周期开销；原生调用收敛在 `input/win32/native.ts` 单模块，加载失败整体降级不阻断启动 | 注入层缺陷拖垮主进程（崩溃隔离需求）时复审子进程方案 |

---

## 9. 未决问题

在动手写代码前需要回答，答案回写到本文件：

1. ~~**发行许可证**~~ → **已定：路线 B（保留闭源商业发行选项）**（2026-10-30 拍板，决策记录见 `docs/license-inventory.md` §2）。只复用宽松许可组件，键鼠共享自研实现的现状与此一致，无返工；GPL 系代码仅作设计参考；LICENSE 文件在公开发布门限前落地。
2. ~~**Electron 是否最终采用**~~ → **已定：采用 Electron 37.10.3**。原型实测内存 340 MB、空闲 CPU 极低，且已验证能管理 scrcpy 子进程生命周期。踩坑与规避见 `apps/desktop/README.md`。
3. **媒体通道选型**：扩展屏幕若走 WebRTC，与 scrcpy 自有传输如何共存？还是统一走自研低延迟传输？
4. ~~**Android 端是否需要常驻前台服务**~~ → **已定：需要**。`LinkSpaceForegroundService`（dataSync 型）已实现保活 +「用户退出 = 彻底下线」语义。
5. ~~**mDNS 实现**~~ → **已定：Node 侧**。先 bonjour-service，后因 Browser 去重与一次性查询缺陷重写为原始 mDNS 应答监听 + 周期补查（`discovery.ts`）；windows-helper 方案随 ADR-008 取消。
6. **GPU 崩溃根因**：本机 Electron 的 GPU 子进程必然崩溃，已用 `--in-process-gpu` 规避。怀疑与 ToDesk 虚拟显示驱动有关，需在干净机器上验证后才能移除该开关。
