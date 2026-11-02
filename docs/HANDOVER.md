# LinkSpace 交接报告

> 面向接手者。写于 2026-10-29，对应提交 `69d236f`。
> 目标是让下一个人**不必读代码就能接手**：先看本文，再按需深入。
>
> **⚠️ 快照提示（2026-10-30）**：本文是阶段 3 合并前的快照，此后进展未反映——
> 阶段 3（剪贴板 / 键鼠共享 / 安卓远控）已合入 master，两轮审查修复已落地，
> 无头脚本已扩到十套（本文 1.2 为七项，漏 `verify:clipboard`，其后新增
> `verify:heartbeat` / `verify:input`）。**现状以根 README「当前状态」与
> `docs/README.md` 为准**；本文的持久价值在第 1、5 节（环境坑与排查顺序）。
> 
> **线 2 交接不在本文**：电脑控平板的开发在决策分支 `decision/line2-accessibility-first` 上，见 [`docs/line2-handover.md`](line2-handover.md)。

---

## 0. 一句话现状

**局域网多设备协作工具已跑通核心链路**：Windows 桌面端 ↔ Android 平板之间
能发现（mDNS 双向互通）、配对、双向传文件（含校验/取消）、双向同步剪贴板。
约 9000 行代码（桌面 6800 + Android 2300）+ 1700 行设计文档，18 个提交。
阶段 2（文件共享与配对）主体完成，阶段 3（体验完善）开了个头。

**还没做的**：Android 主动发送文件、跨电脑键鼠共享、扩展屏（IddCx）、
安装包与许可证合规。许可证路线已由项目负责人拍定 GPL-2.0/3.0，
但尚未落实到 LICENSE 文件。

---

## 1. 五条最重要的信息

按重要性排序，其他都可以缓：

### 1.1 环境里有三个坑，不处理就跑不起来

| 坑 | 现象 | 解法 |
|---|---|---|
| `ANDROID_SDK_ROOT` 指向不存在的旧路径 | Gradle 报「多个路径指向同一个 SDK」 | `unset ANDROID_SDK_ROOT`，只留 `ANDROID_HOME` |
| `GRADLE_USER_HOME` 默认指向不可写目录 | `journal-1.lock (拒绝访问)` | 显式指到 `.toolchain/gradle-home` |
| Node 在 Windows 下解析 `/tmp/xxx` | 路径变成 `D:\tmp\xxx`，删的时候找不到 | 用绝对路径或 `os.tmpdir()`；调试时两边都查 |

第三条曾让我误判过一次「信任丢了」——文件其实在 `D:\tmp\linkspace-probe-home`，
而我一直在 Git Bash 的 `/tmp` 里找。**清理状态前先确认路径**。

### 1.2 测试是七项无头脚本，改动后必须全跑

```bash
cd apps/desktop
npm run typecheck          # vue-tsc
npm run verify             # adb 枚举 + scrcpy 会话生命周期
npm run verify:transfer    # 文件传输环路（分块/偏移/取消/恢复）
npm run verify:pairing     # 配对与信任清单
npm run verify:e2e         # 发现→配对→传输→取消→剪贴板 全链路
npm run verify:layout      # 设备顺序持久化
npm run verify:net         # 局域网范围判定表
npm run verify:mdns        # mDNS 互通（需 Android 真机在线）
```

**前七项都不需要 GUI、不需要真机**，可重复运行并给出 PASS/FAIL。
`verify:e2e` 是覆盖最全的一个，改了传输/配对/剪贴板一定跑它。
`verify:mdns` 例外，它必须有 Android 在同一局域网，单独跑。

### 1.3 安全边界有三道，缺一不可

```
边界 0  来源地址门禁  → net-scope.ts，非局域网来源在 TLS 握手阶段断开
边界 1  身份与授权    → 证书指纹 + 信任清单 + scope
边界 2  任务令牌      → transfer.accept 时签发，数据面唯一凭证
```

- 边界 0 的判据同时挂在 `secureConnection` **和** `upgrade` 上。
  `upgrade` 不经过普通请求链，漏掉它等于门禁形同虚设——这是最易错的一点。
- `control` 授权**永不随配对授予**，键鼠/投屏必须用户单独确认。
- 配对默认给 `file` + `clipboard`，两端常量需同步
  （桌面 `DEFAULT_GRANT_SCOPE`，Android `Protocol.DEFAULT_GRANT_SCOPE`）。

### 1.4 剪贴板的回环抑制是整个项目最反直觉的一段

收到远端文本 → 写入本机剪贴板 → 系统回调读到「变了」→ 又发回去 → 无限互推。

**解法是抑制窗口**（500ms 内忽略本地变更），关键在于**窗口内不能更新基线**：
窗口里读到的可能是写入尚未生效的旧值，把它记成基线，窗口结束后读到的真值
反而成了「新变更」——回环只是延后一轮，并没有消失。

这段逻辑刻意做成了不依赖 Electron/Android 的纯逻辑（读写注入），
所以能被 `verify:clipboard` 完整覆盖。改它之前先跑那个测试。

### 1.5 真机验证的设备与脚本

| 设备 | serial | 用途 |
|---|---|---|
| 联想平板 TB710FU / Android 16 | `adb-HA2CS105-NoeaQo._adb-tls-connect._tcp` | 主验证对象 |
| 小米 24117RK2CC | `adb-d745d9ec-wmv3Zb._adb-tls-connect._tcp` | 对照 |
| 模拟器 | `emulator-5554` | 破坏性测试 |

```bash
bash .toolchain/run-xplat-verify.sh   # 配对 + 传输 + 落盘校验
bash .toolchain/run-clip-verify.sh    # 剪贴板同步 + 回环检测
```

两个脚本都会自动重启应用、读端口、喂配对码、点「接收」按钮。
**注意**：Android 进程已在跑时 `am start` 不会重新打印端口日志，
所以脚本必须先 `force-stop` 再启动。

---

## 2. 目录与关键文件

```
LinkSpace/
├── docs/                       ← 先读这里，别先读代码
│   ├── architecture.md         系统分层、ADR（含 ADR-003 同端口）
│   ├── protocol.md             协议定义 + 三处实现期修正
│   ├── threat-model.md         信任边界、T0–T9 威胁
│   ├── roadmap.md              阶段划分与门限
│   ├── technical-validation.md scrcpy 实测数据
│   ├── scrcpy-manual-checklist.md  28 条人工验证项
│   ├── license-inventory.md    第三方依赖与 GPL 决策记录
│   └── design/input-sharing.md 键鼠共享自研方案（含协议草案）
├── apps/desktop/               Electron 37 + Vue 3.5 + TS 5.9
│   └── src/main/
│       ├── host.ts             组装节点（对应 Android LinkSpaceService）
│       ├── net-scope.ts        ★ 局域网范围判定（边界 0）
│       ├── clipboard.ts        ★ 剪贴板回环抑制
│       ├── layout.ts           设备顺序持久化
│       ├── transfer/           identity / trust / chunker / server / manager
│       ├── control/node.ts     WebSocket over TLS
│       ├── pairing.ts          配对码流程
│       ├── discovery.ts        mDNS（bonjour-service）
│       └── verify-*.ts         七项无头测试
└── apps/android/               Kotlin + Compose
    └── app/src/main/java/cn/linkspace/client/service/
        ├── LinkSpaceService.kt 编排层（对应桌面 host.ts）
        ├── ClipboardSync.kt    与桌面端判定规则逐条对应
        ├── TransferServer.kt   手写 HTTPS + WS（共用端口）
        ├── WebSocketConnection.kt  最小 RFC 6455 子集
        ├── Identity.kt         BouncyCastle 自签证书
        ├── TrustStore.kt
        ├── Discovery.kt        NsdManager
        └── Protocol.kt         协议常量，与桌面端逐字对应
```

标 ★ 的是本轮新增且改动风险最高的三个文件。

---

## 3. 已验证 / 未验证

### 已验证

| 项 | 证据 |
|---|---|
| Windows ↔ Windows 四组无头 | `verify` / `verify:transfer` / `verify:pairing` / `verify:e2e` 全绿 |
| Windows → Android 文件传输 | 真机，落盘 6400 字节，SHA-256 与源一致 |
| Windows → Android 剪贴板 | 真机，23 字符送达，无回环 |
| 配对默认授予范围 | 真机，`scope=file,clipboard`，无 `control` |
| scrcpy 关闭窗口进程无残留 | 模拟器实测，退出码 0 |
| 设备顺序持久化 | `verify:layout` 11 项 |

### 未验证（**不要写成「支持」**）

- Android → Windows 剪贴板方向：Android 的剪贴板写入无法用 adb 模拟
  （`service call clipboard` 受权限限制，分享 intent 不写剪贴板），
  **必须在平板上真实执行一次复制**。
- 大文件（>100 MB）、断点续传在 Android 侧的行为、传输中途杀应用的 `.part` 清理
- 多设备同时连接
- scrcpy 的鼠标/键盘/中文输入/断网：见 `scrcpy-manual-checklist.md`，28 条中 26 条待人工
- mDNS 跨平台互通：**已修复**（见 4.2），`npm run verify:mdns` 双向验证通过

---

## 4. 下一步该做什么

按建议顺序：

### 4.1 Android 发送端（任务 #22）

当前 Android 只能收文件，剪贴板已双向。要补：UI 选文件 → 主动连接桌面端
→ 推分块。桌面端数据面已有 GET 路由（`resolveOutgoing`），技术上可行。
工作量估计 3–5 人日，含真机验证。

**注意**：Android 侧 `TransferServer` 目前只有接收路径，
发送需要新增 `registerOutgoing` 与一个 HTTPS 客户端。
参考桌面端 `transfer/manager.ts` 的 `push()` 实现。

**mDNS 已通之后这一步比原先估计简单**：不必再手工传 IP 与端口，
直接走发现列表即可。

### 4.2 mDNS 互通 —— 已修复（2026-10-29）

曾是产品化的硬门槛，现已解决，双向发现均通过（`npm run verify:mdns`）。
问题是**三层叠加**，每层单独的表现都是「底层 mDNS 通、上层发现不了」：

1. **Android 组播锁顺序**：`advertise()` 在 `start()` 之前调用，而
   `MulticastLock` 在 `start()` 里才拿。通告同样走组播发送路径，
   锁未持有时通告静默丢失——本机日志显示注册成功，对端零收到。
2. **multicast-dns 的网卡选择**：`allInterfaces()` 不排除回环，
   `defaultInterface()` 在 Windows 上返回 `0.0.0.0` 让系统自选。
   本机因此选中 CGNAT 段（100.64/10，虚拟网卡在用），查询发不到局域网。
3. **Android 的 TXT 缺 `ver` 字段**：桌面端 `parseTxt` 用 `ver !== '1'`
   直接拒收。bonjour 底层收到了应答，但 `Discovery.handleService` 直接 return。

**残留风险**：网卡选择依赖 `192.168 > 10 > 172.16-31` 的优先级。
换网络环境（例如公司 10.x 网段 + 虚拟网卡同在）时可能需要
`LINKSPACE_BIND_IP` 手动指定。这一点没有自动化测试覆盖。

### 4.3 安装包与合规（任务 #26、#27）

electron-builder 出 NSIS 安装包；SBOM 用 `license-checker` 生成，
但 **scrcpy 等原生二进制无法被 npm 工具扫描，必须手工维护**，
这部分最容易遗漏。

### 4.4 键鼠共享（有完整设计文档）

`docs/design/input-sharing.md` 已写好，含协议草案与 10–25 人日拆分。
**约束**：必须复用已有 `ClipboardSync`，另起一套会与剪贴板同步构成回环。

### 4.5 扩展屏（IddCx，任务 #28）

本机无 VS+WDK、家庭版无 Hyper-V，**前置阻塞**。
需要先准备环境，或按 roadmap 的降级判据转为「高质量投屏式第二屏」。

---

## 5. 容易踩的坑（按发生频率排序）

1. **Android 进程已在跑时读不到端口**：`am start` 不会重新打印。
   先 `force-stop`。脚本里已处理，手工操作时注意。
2. **清理状态前确认路径**：Node 的 `/tmp` 在 Windows 上是 `D:\tmp`。
   用 `node -e "console.log(require('path').resolve('/tmp/x'))"` 确认。
3. **旧信任数据不随代码升级**：改了 scope 默认值后，
   `trust.json` 里的旧条目还是旧 scope，会表现得像「新功能没生效」。
   清掉重新配对。脚本 `.toolchain/clean-tablet-trust.sh` 可做这件事。
4. **改 `verify-e2e.ts` 的 Host 绑定地址**：它真走 mDNS，必须 `bind: '0.0.0.0'`；
   绑回环会让对端连不上。而 `verify:transfer` 走直连，绑 127.0.0.1 即可。
5. **BouncyCastle 不能显式指定 provider**：系统内置的是重打包内部类。
6. **Gradle 官方源 TLS 吊销检查失败**：用腾讯云镜像。
7. **mDNS 组播锁的获取顺序**：`advertise()` 也走组播发送路径，
   必须在拿锁**之后**调用。顺序反了通告静默丢失且不报错。
8. **`push()` 取消后仍正常 resolve**：调用方必须核对 `state !== 'completed'`
   再发 `transfer.complete`，否则半成品会被落盘。
9. **chunk 路由的键格式**：`transferId:fileName`，按第一个冒号拆分。
   Android 曾按裸 transferId 键控导致 404。

### mDNS 不通时的排查顺序

这套顺序是 2026-10-29 修三层叠加问题时总结的，按序做能少走弯路：

```
1. 组播层通不通？     node out/verify/mdns-diag.cjs
                     收不到任何包 → 网卡/组播问题，不是代码问题
2. 包里的名字对不 对？node out/verify/mdns-records.cjs
                     看 PTR 记录名是否为 _linkspace._tcp.local
3. 查询有没有应答？   node out/verify/mdns-query.cjs
                     手动发查询，有应答说明对端活着
4. 带 interface 通不通？node out/verify/mdns-iface-test.cjs 192.168.x.x
                     通 → 问题在网卡选择；不通 → 问题在 interface 本身
5. 最后才看解析层     npm run verify:mdns
                     前四步都过还发现不了 → TXT 字段缺失（ver/port）
```

---

## 6. 提交规范

当前是 Conventional Commits，中文正文，正文说明**为什么**而不是做了什么
（做什么看 diff 就知道）。例：

```
feat(android): 剪贴板同步与 offer 信任门禁修复

- 修复真实缺陷：transfer.offer 缺少信任校验，未配对设备的 offer 会走完
  「创建任务→点接收→签发 token→发 accept」才在数据面被拒，
  用户看到的是「点了接收但没有文件」。现在 offer 阶段就返回 SCOPE_DENIED
```

---

## 7. 遗留的技术债

1. **Android 的 WebSocketConnection 是手写的 RFC 6455 子集**，
   只有真机联调验证，缺单元测试。这是风险最高的一块。
2. **mDNS 网卡选择依赖优先级启发**（192.168 > 10 > 172.16-31）。
   换网络环境时可能需要 `LINKSPACE_BIND_IP` 手动指定，无自动化测试覆盖。
3. **`verify:transfer` 的 `--large` 用例**（1 GB）跑得慢，平时可不跑。
4. **Android 无前台服务**：应用退到后台可能被回收导致传输中断。
5. **scrcpy 的 GPU 规避配置**（`--in-process-gpu`）是本机特有的，
   疑与 ToDesk 虚拟显示驱动冲突，排查到根因后应移除。
6. **mDNS 诊断脚本在 `out/verify/` 下未纳入版本控制**：
   `mdns-diag.cjs` / `mdns-records.cjs` / `mdns-query.cjs` / `mdns-iface-test.cjs`
   是排查时临时写的，重建 out/ 就会丢。若还要继续排查，先把它们移到 scripts/。

---

## 8. 给接手者的第一周建议

| 天 | 做什么 |
|---|---|
| 1 | 读 `docs/architecture.md` + `docs/protocol.md`，跑通七项无头测试 |
| 2 | 读 `host.ts` 与 `LinkSpaceService.kt`，对照理解两端职责 |
| 3 | 跑 `run-xplat-verify.sh`、`run-clip-verify.sh`、`verify:mdns`，亲手看真机链路 |
| 4 | 处理 Android 发送端（#22）——mDNS 已通，它比原先估计的简单 |
| 5 | 按 `scrcpy-manual-checklist.md` 逐条人工验证，把 ⬜ 填掉 |

**原则**：任何「已验证」的结论都必须有对应证据（测试输出或日志），
没有证据的一律写成「未验证」。这是本项目文档的可信度基础。
