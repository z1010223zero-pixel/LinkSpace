# apps/desktop — LinkSpace Windows 桌面端

Electron + Vue 3 + TypeScript。当前是**可运行的原型**：mDNS 发现、配对与信任管理、双向文件传输、剪贴板同步、跨设备键鼠共享（Win↔Win 边缘穿越，亦被安卓端远控）、投屏会话管理。

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
npm run verify:layout      # 无头验证：设备卡片顺序持久化
npm run verify:net         # 无头验证：局域网范围判定表
npm run verify:heartbeat   # 无头验证：心跳超时与控制通道洪泛防护
npm run verify:clipboard   # 无头验证：剪贴板回环抑制
npm run verify:input       # 无头验证：键鼠共享全链路（编解码/会话/持久化/心跳超时）
npm run verify:mdns        # mDNS 互通验证（需 Android 真机在线）
npm run clean              # 删除 out/
```

**前九个 `verify` 都不需要 GUI**，可重复运行并给出断言结果，是回归测试的主要手段。
`verify:mdns` 例外：它必须有 Android 设备在同一局域网，否则必然 FAIL，
单独跑而不进全套回归。

### 双向免确认控制与低延迟画面传输（2026-11-05 最新）

- **免确认控制有效期**：桌面端 `host.ts` 与 `transfer/trust.ts` 支持设备级免确认控制有效期（`仅本次` / `1天` / `3天` / `7天` / `30天` / `永久`）；控制请求横幅支持一键授权对应时长，设备详情卡提供有效期管理。
- **锁屏显示器自动唤醒**：在 `input/win32/native.ts` 中通过 `SetThreadExecutionState` 与零位移输入唤醒休眠显示器，反向控制获批时自动执行。
- **4K 极速切片推流**：在 `screen-stream.ts` 中使用多线程 `fast_bilinear` 硬件下采样与 x264 零缓冲切片参数（`threads=4:sliced-threads=1:rc-lookahead=0:sync-lookahead=0:bframes=0:aud=1`），消除 4K 推流瓶颈；控制通道全链路启用 `TCP_NODELAY`。
- **反向投屏亮屏解锁**：在 `ReverseStreamView.vue` 顶栏增加「亮屏解锁」按钮，一键发送上滑手势解除平板锁屏。

### mDNS 组播网卡选择

组播网卡必须显式指定，不能交给库自己选。`multicast-dns` 的
`allInterfaces()` 不排除回环地址，`defaultInterface()` 在 Windows 上返回
`0.0.0.0` 让系统自选——多网卡机器上选中的往往不是局域网那张，
结果是「能收到突发通告但查询发不出去」。

选择顺序：`LINKSPACE_BIND_IP` > 192.168.x > 10.x > 172.16–31.x。
**CGNAT 段（100.64/10）被刻意排除**：`resolveBindAddress()` 放行它是因为
它不可公开路由，但组播不能用它跑。这两处判据不同是故意的，改前先读注释。

### 监听地址与来源门禁

数据面与控制面共用同一个 TLS 端口，默认按以下顺序选监听地址：

1. 环境变量 `LINKSPACE_BIND_IP`
2. 唯一的局域网 IPv4（自动挑）
3. 多个局域网地址时监听 `0.0.0.0`
4. 一个都没有时只监听回环（此时本设备对局域网不可见）

无论最终绑到哪个地址，**入站一律校验来源地址**：不属于 RFC1918 / 链路本地 /
IPv6 ULA 范围的连接在 TLS 握手阶段直接断开。设 `LINKSPACE_ALLOW_WAN=1`
可放行（跨网段调试用，日志会留痕）。理由见 `docs/threat-model.md` T0。

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
│   ├── host.ts            控制节点组装：连接/信任/传输/剪贴板/输入（对应 Android LinkSpaceService）
│   ├── pairing.ts         配对码流程与信任门禁（announce 指纹锚定）
│   ├── discovery.ts       mDNS 发现（原始应答监听 + 周期补查）
│   ├── profile.ts         设备名与剪贴板开关等本地档案
│   ├── clipboard.ts       剪贴板同步与回环抑制（纯逻辑，可无头测试）
│   ├── net-scope.ts       局域网范围判定（来源地址门禁）
│   ├── layout.ts          设备卡片顺序持久化
│   ├── control/
│   │   └── node.ts        WebSocket over TLS 控制通道（心跳、maxPayload、限频）
│   ├── input/
│   │   ├── session.ts     键鼠共享会话状态机（确认弹窗驱动、TTL）
│   │   ├── protocol.ts    事件编解码（整批拒绝、坐标钳制）
│   │   ├── edge.ts        边缘穿越触发
│   │   ├── layout.ts      屏幕布局
│   │   └── win32/
│   │       ├── native.ts  koffi FFI：SendInput/GetCursorPos（ADR-008）
│   │       ├── capture.ts 轮询采集（含挂起模式）
│   │       └── sink.ts    事件注入
│   ├── transfer/          文件传输
│   │   ├── identity.ts    设备身份证书与指纹（自签，持久化到 userData）
│   │   ├── trust.ts       信任清单与 scope 门禁
│   │   ├── chunker.ts     分块读写、摘要、.part 路径、不覆盖命名
│   │   ├── server.ts      HTTPS 数据面服务与客户端（含连接复用）
│   │   └── manager.ts     传输任务状态机与编排（含离线 waiting 补发）
│   └── verify-*.ts        十套无头验证入口
├── preload/index.ts       渲染进程桥，只暴露白名单 API
├── renderer/              Vue 3 界面
│   ├── App.vue
│   ├── components/DeviceCard.vue
│   └── style.css
└── shared/types.ts        主进程与渲染进程的类型契约
scripts/
├── dev.mjs                启动包装（见踩坑 1）
├── build-verify*.mjs      各无头套件的打包入口
├── stage-scrcpy.mjs       随安装包分发 scrcpy（vendor/scrcpy）
└── generate-sbom.mjs      SBOM 生成
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
- 配对与信任清单 13 项（`verify:pairing`）：配对码流程、指纹锚定、撤销、重命名
- 端到端（`verify:e2e`）：发现 → 配对 → 传输 → 取消 → 剪贴板；
  对端掉线任务回 waiting、重连自动补发、多连接幸存者
- 剪贴板回环抑制全套（`verify:clipboard`）
- 键鼠共享（`verify:input`）：事件编解码、坐标钳制、会话确认、
  采集挂起、断连 releaseAll、剪贴板开关持久化、心跳超时即终止会话
- 心跳超时与控制通道洪泛防护（`verify:heartbeat`）：超频断开、超大载荷断开

**未验证（需真机人工走查）**：
- 阶段 3 真机清单见 `docs/manual-walkthrough-stage3.md`（大部分已由双 Agent 执行）
- scrcpy 窗口内鼠标键盘 / 中文输入法 / 断网恢复（`docs/scrcpy-manual-checklist.md`）
- 启动投屏后直接退出应用（会话清理的 GUI 路径）

---

## 已知限制

- 多显示器副屏贴边可能误触发边缘穿越（边缘判定以主屏为基准，见审查报告 P3）
- 控制端 pending 请求不随对端断连即时清理（有 30s 超时兜底，见审查报告 P3）
- 界面里的「发送文件」用系统文件选择框，尚无拖拽发送
- `platform.ts` 中保留了「已知 winget 安装路径」作为开发期兜底，**正式分发时必须移除**，改为随安装包提供 scrcpy（`scripts/stage-scrcpy.mjs` 已具备该能力）
- 设置项有限：剪贴板开关已持久化（`profile.json`），其余参数仍硬编码
- 日志只输出到控制台，未落盘（脱敏规则已写在 `log.ts` 注释中）
- 无线 ADB 引导方式待定（当前需手动开启）
