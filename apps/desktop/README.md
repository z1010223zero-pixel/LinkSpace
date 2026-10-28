# apps/desktop — LinkSpace Windows 桌面端

Electron + Vue 3 + TypeScript。当前是**可运行的原型**：能扫描局域网 Android 设备、启动/停止投屏会话，并内置了局域网文件传输服务（发现与配对尚未实现）。

---

## 运行方式

```bash
cd apps/desktop

# 1. 安装依赖。--ignore-scripts 是必要的：electron 的 postinstall 下载
#    二进制很慢且容易中断，改为下一步手动下载。
npm install --ignore-scripts

# 2. 下载 electron 二进制（国内镜像，约 13 秒）
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js

# 3. 启动
npm run dev
```

其他命令：

```bash
npm run typecheck          # vue-tsc 类型检查
npm run build              # electron-vite 构建
npm run verify             # 无头验证：adb 枚举 + 会话启动/停止 + 进程清理
npm run verify:transfer    # 无头验证：文件传输环路（加 -- --large 跑 1GB）
npm run verify:pairing     # 无头验证：配对与信任清单（13 项）
npm run verify:e2e         # 无头验证：发现→配对→传输→取消 端到端
npm run clean              # 删除 out/
```

**四个 `verify` 都不需要 GUI**，可重复运行并给出断言结果，是回归测试的主要手段。

### 跨平台验证（Windows ↔ Android 真机）

`scripts/xplat-probe.ts` 是跨平台探测器：以真实 Host 连接 Android 真机，
走完整「连接 → 配对 → 传输 → 落盘校验」链路。设备侧操作（点「接收」按钮）
由 `.toolchain/run-xplat-verify.sh` 用 uiautomator 定位并真实点击，不注入测试代码。

```bash
npm run probe:xplat        # 打包探测器
bash ../../.toolchain/run-xplat-verify.sh   # 一键跑完整跨平台验证
```

探测器的目标与身份可经环境变量覆盖：

| 变量 | 作用 |
|---|---|
| `LINKSPACE_TARGET_HOST` / `LINKSPACE_TARGET_PORT` | 对端 IP 与端口（应用重启后端口会变） |
| `LINKSPACE_PROBE_HOME` | 探测器身份与信任的持久化目录，默认 `/tmp/linkspace-probe-home` |
| `LINKSPACE_PAIR_CODE_FILE` | 配对码文件路径，驱动脚本从 logcat 读到后写入 |

已验证（2026-10-29，联想平板 TB710FU / Android 16）：
配对成功 → offer → 点击接收 → 分块推送 → 整体 SHA-256 校验一致 → 落盘 6400 字节，
连续多轮 `completed`，设备 ID 跨轮稳定。

传输测试的可选参数：

```bash
npm run verify:transfer -- --large              # 追加 1 GB 大文件用例
npm run verify:transfer -- --chunk=4194304      # 用生产默认 4MiB 块大小
```

---

## 目录结构

```
src/
├── main/                  主进程
│   ├── index.ts           入口：窗口、单实例、生命周期清理
│   ├── platform.ts        定位 scrcpy / adb 可执行文件
│   ├── adb.ts             adb 设备枚举（只读）
│   ├── scrcpy-adapter.ts  投屏会话适配器（L4）
│   ├── device-manager.ts  设备与会话聚合（L2）
│   ├── ipc.ts             IPC 网关（channel 白名单）
│   ├── log.ts             脱敏日志
│   ├── verify-entry.ts    无头验证入口（投屏）
│   ├── verify-transfer.ts 无头验证入口（文件传输环路）
│   └── transfer/          文件传输
│       ├── identity.ts    设备身份证书与指纹（自签，持久化到 userData）
│       ├── chunker.ts     分块读写、摘要、.part 路径、不覆盖命名
│       ├── server.ts      HTTPS 数据面服务与客户端（含连接复用）
│       └── manager.ts     传输任务状态机与编排
├── preload/index.ts       渲染进程桥，只暴露白名单 API
├── renderer/              Vue 3 界面
│   ├── App.vue
│   ├── components/DeviceCard.vue
│   └── style.css
└── shared/types.ts        主进程与渲染进程的类型契约
scripts/
├── dev.mjs                启动包装（见踩坑 1）
├── build-verify.mjs       打包并运行投屏无头验证
└── build-verify-transfer.mjs  打包并运行传输无头验证
```

---

## 踩坑记录（本机环境，均已解决）

### 1. `ELECTRON_RUN_AS_NODE=1` 会让 electron.exe 退化成 Node

**现象**：启动即崩，报 `TypeError: Cannot read properties of undefined (reading 'requestSingleInstanceLock')`，且栈里是 `Node.js v24.22.1`。

**原因**：宿主环境（WorkBuddy 本身是 Electron 应用）会向子进程传递 `ELECTRON_RUN_AS_NODE=1`，`electron.exe` 收到后表现为纯 Node，`require('electron')` 返回的是 npm 包里的路径字符串，`app` 等 API 全部 undefined。

**注意**：把这个变量设成空字符串**无效**，Electron 判断的是变量是否存在。

**解法**：`scripts/dev.mjs` 在启动前 `delete process.env.ELECTRON_RUN_AS_NODE`。`npm run dev` 已改为走这个包装脚本。

### 2. GPU 子进程必然崩溃，拖垮整个应用

**现象**：主进程正常工作（scrcpy 定位、IPC 注册、adb 枚举都成功），随后
`GPU process exited unexpectedly: exit_code=-1073741819` 反复出现，最后
`FATAL: GPU process isn't usable. Goodbye.` 整个应用退出。

**已排除的可能**：
- Electron 版本：37 和 45 都复现（**不是版本问题**）
- userData 路径：package.json 的 name 原为 `@linkspace/desktop`，导致路径含 `@` 和 `/`；改成干净路径后仍复现
- 沙箱：非沙箱启动同样复现
- 命令行开关：`--disable-gpu`、`--disable-gpu-compositing`、`--single-process` 均无效或引发新问题（single-process 会静默退出）

**当前解法**：`--in-process-gpu`，让 GPU 服务跑在主进程内，不再单独拉起 GPU 子进程。**这是针对本机图形环境的规避，不是通用配置。**

**怀疑的根因**：本机装有 ToDesk 远程控制软件，其 `Todesk Virtual Display Adapter` 与第三个状态为 Error 的 `Virtual Display Driver` 可能干扰 Chromium 的 GPU 初始化。未最终确认——如果在没有装 ToDesk 的机器上正常，即可证实。

**后续**：拿到干净机器上的表现后，应移除该开关并恢复多进程 GPU。届时把结论回写到本文件。

### 3. electron 二进制需要手动下载

`npm install` 不会自动下载 electron 二进制（postinstall 被跳过或超时被杀）。必须显式执行：

```bash
ELECTRON_MIRROR="https://npmmirror.com/mirrors/electron/" node node_modules/electron/install.js
```

默认源（GitHub）在本机会被超时中断，务必用国内镜像。

### 4. electron 必须保持 external

`electron.vite.config.ts` 中若未显式声明 `rollupOptions.external: ['electron']`，electron 会被打进 bundle，`require('electron')` 变成读 `node_modules/electron/index.js`（返回路径字符串），同样导致 API 全 undefined。这与踩坑 1 现象相同但原因不同，排查时注意区分。

### 5. package.json 的 name 不要带 npm scope

`@linkspace/desktop` 会让 `userData` 变成 `%APPDATA%\@linkspace/desktop`（含 `@` 和 `/`），其下的 `GPUPersistentCache` 会报「另一个程序正在使用此文件」。已改为 `linkspace-desktop`，并在 `index.ts` 中额外 `app.setPath('userData', ...)` 双保险。

---

## 实测数据（2026-10-28）

| 项 | 数值 |
|---|---|
| Electron | 37.10.3 |
| 启动后进程 | 3 个（main / renderer / utility） |
| 内存合计 | 约 340 MB（主进程 180 MB + 62 MB + 101 MB） |
| 空闲 CPU | 极低（累计 1.5s / 0.4s / 0.5s） |
| 主窗口 | 标题 `LinkSpace`，正常创建 |
| 退出清理 | electron 0 残留、scrcpy 0 残留 |
| adb 枚举 | 2 台设备（真机无线 + 模拟器） |
| 文件传输 | 本机监听端口 2040，1 GB ≈ 68.5 MB/s（4 MiB 块） |

**ADR-001 复审依据**：内存 340 MB 对 Electron 应用属正常水平，空闲 CPU 可忽略，**继续采用 Electron，不转向 Tauri**。若后续加入文件传输、WebRTC 等重负载后内存显著增长，需重新评估。

---

## 已验证 / 未验证

**已验证（自动化）**：
- adb 设备枚举与解析
- 投屏会话启动（无窗口模式）、状态流转
- 同设备重复启动被拒绝（`SESSION_EXISTS`）
- 会话停止、进程树清理、无残留
- 错误场景：设备不存在 → 退出码 1 且 stderr 可解析
- 窗口标题/位置参数、硬件解码（见 `modules/scrcpy-adapter/README.md`）
- 文件传输环路 21 项断言：内容一致性、0 字节文件、中文/空格/`#` 文件名、
  同名重命名、多块、断点续传、传输中取消并清理 `.part`、
  未授权设备 403、并发、1 GB 大文件

**未验证（需人工操作手机）**：
- 鼠标键盘控制、中文输入法、剪贴板同步
- 断网恢复
- UI 上的按钮点击（界面已能显示，但交互未人工走查）
- 启动投屏后直接退出应用（会话清理的 GUI 路径）

---

## 已知限制

- **设备发现与配对未实现**：传输服务已监听，但 `isKnownDevice` 恒为 false，
  即当前不接受任何对端。这是刻意留的，不是 bug——配对建立后才有可信设备清单。
- **传输服务绑定 `0.0.0.0`**：应改为仅绑定局域网网卡，否则会暴露到非目标网络
  （方案 14.4「仅监听必要的接口和端口」）。配对实现时一并处理。
- **`transfer.cancel` 未接入控制通道**：发送方取消时通过 `cancelRequested`
  事件抛给上层，接收方清理依赖这条消息送达。真实链路上需经控制通道传输。
- **块级摘要只在发送侧计算**：接收侧未校验，目前靠整体 SHA-256 兜底
  （验收项 4.6 未完成）。
- **只能 Windows ↔ Windows**：Android 客户端（Kotlin）尚未开始
- 设备布局拖拽、剪贴板同步未实现（属后续阶段）
- 传输服务绑定 `0.0.0.0`，应改为仅局域网网卡
- 界面里的「发送文件」用系统文件选择框，尚无拖拽发送
- `platform.ts` 中保留了「已知 winget 安装路径」作为开发期兜底，**正式分发时必须移除**，改为随安装包提供 scrcpy
- 无设置界面，所有参数硬编码
- 日志只输出到控制台，未落盘（脱敏规则已写在 `log.ts` 注释中）
