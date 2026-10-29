# 双 Agent 分工协作文档

> 目的：两个 agent 在同一仓库**同时开发、互不打扰**。按技术栈划域，按资源错峰，按契约对齐。
> 基线：master `14dfb12`（2026-10-29）。本文档本身为共享文件，改动需双方知晓。

---

## 1. 分工总览

| | **Agent A（桌面域）** | **Agent B（移动域）** |
|---|---|---|
| 代码领地 | `apps/desktop/**`（含 scripts/、docs 中桌面实现文档） | `apps/android/**` |
| 技术栈 | Electron 37 / Vue 3 / TS / Win32 | Kotlin / Jetpack Compose / NSD |
| 主线任务 | ① 阶段 4 前置：IddCx 虚拟显示器技术验证（独立实验项目，见 §3）② mvp-acceptance 第 9 组安全与隐私（桌面侧）③ NSIS 打包 / SBOM / 发布链路 | ① 真机反馈补齐：文件共享 UI 入口（发送/接收）、剪贴板开关界面 ② 安卓→电脑远控（Android 作控制端，桌面被控端协议已就绪，**无需改桌面代码**）③ 杀后台仍可控的合理化（前台服务通知 / 退出策略） |
| 验收依据 | mvp-acceptance.md 第 9 组 + manual-walkthrough-stage3 桌面侧 | mvp-acceptance.md 安卓侧项 + manual-walkthrough-stage3 移动侧 |
| 构建产物 | NSIS 安装包、SBOM | debug APK |

**核心边界**：跨端功能只允许通过**协议消息**协作（见 §4），不允许直接改对方领地的文件。安卓→电脑远控是典型样例：桌面被控端 `InputSessionCoordinator` 已实现，B 只做 Android 控制端，零桌面改动。

## 2. 工作区隔离（必做，开工前先执行）

同一工作树必然冲突（git index、out/ 构建产物、node_modules 互相覆盖），各 agent 用独立 worktree：

```powershell
# Agent A（桌面域）
git worktree add ..\LinkSpace-desktop -b feat/desktop-a master
# Agent B（移动域）
git worktree add ..\LinkSpace-android -b feat/android-b master
```

- 各 worktree 首次需 `npm install`（apps/desktop）；Android 构建共享 `GRADLE_USER_HOME=D:\dev\gradle` 没问题（gradle 自带并发锁）
- 分支命名：`feat/desktop-*` / `feat/android-*`，只允许提交本域文件
- 本仓库根目录（`d:\test\testforai\LinkSpace`）保留为**合并与发版工作区**，由 A 负责 merge 与 push

## 3. 任务线详情

### Agent A
1. **IddCx 技术验证**（对应 roadmap 阶段 4 停止判据）：独立实验工程（不进主仓，或放 `experiments/iddcx-poc/` 且不引入主构建），产出结论回写 `docs/technical-validation.md`。**未通过则阶段 4 降级为投屏式第二屏**——这是先决判定，优先做。
2. **第 9 组安全与隐私**（桌面侧）：按 mvp-acceptance 第 9 组逐项实现/走查（剪贴板开关默认值、信任清单一目了然、撤销即断连等）。
3. **打包链路**：NSIS、SBOM、许可证清单随版本更新（镜像变量见 project_memory）。

### Agent B
1. **文件共享 UI**：平板端发送/接收入口（发送链路 `LinkSpaceClient.sendFiles` 已通，缺 UI）。
2. **安卓→电脑远控**：Android 端 InputController + 会话 UI；桌面被控端已有 `session.start/accept/reject/stop` 协议与确认弹窗，B 直接对接。
3. **杀后台行为**：`am force-stop` 后连接残留问题——明确前台服务通知与「用户主动退出 = 断开所有控制会话」语义。

### 禁区
- A 不得改 `apps/android/**`；B 不得改 `apps/desktop/**`。发现对方域的 bug → 在 `docs/agent-division.md` §6 挂「待办移交清单」，或口头移交，不直接动手。
- 双方都不得单方面修改协议语义（见 §4）。

## 4. 协议契约（唯一共享接口）

共享契约物：`docs/protocol.md`、`Protocol.kt` ↔ `apps/desktop/src/main/control/node.ts` 的消息类型、mDNS TXT 键、`/linkspace/v1/transfer/*` 路由。

规则：
1. **现有消息类型与字段语义冻结**。改语义必须双方同意并在 `docs/protocol.md` 同步登记后才能动手。
2. **新增消息类型**：提议方先改 `docs/protocol.md`（提交信息打 `[PROTOCOL]` 标签），对端下一个迭代跟进实现；未跟进期间提议方代码必须兼容对端「不认识该消息」的现状（发送可带、接收忽略未知 type——两端 dispatch 均已是此语义）。
3. 协议文档冲突时以 master 上 `docs/protocol.md` 为准，本地重放 rebase。

## 5. 共享资源调度（冲突高发区）

| 资源 | 归属规则 |
|---|---|
| 真机平板 TB710FU（唯一） | **B 优先**（Android UI 走查必须真机）。A 需要真机时先错峰：确认 B 无进行中的 walkthrough/logcat 会话；A 的发现/传输验证尽量用无头套件（`npm run verify:mdns` 等）替代 |
| 桌面 GUI 实例 | A 可随意起（CDP 9222）。**B 不起桌面 GUI**——需要桌面对端时用无头 Host 套件，或请 A 代跑。原因：同 userData 会产生同 deviceId 的双实例，mDNS 通告互踢 |
| CDP 端口 | A=9222；若 B 确需起桌面实例（例外情况），用 9223 并加 `--user-data-dir` 独立目录 |
| electron-builder 打包 | 仅 A。B 只产出 APK，不跑 `npm run dist` |
| 5353 组播网络 | 无头 verify 用回环/独立端口的不冲突；涉及真实 mDNS 的验证按「真机」条错峰 |
| `.zwork/` 工具目录 | 共享只读工具（walkthrough.mjs、fastpath.mjs、check-disc.mjs）；各自新增脚本放 `.zwork/a/`、`.zwork/b/`，不覆盖共享脚本；此目录不入库 |

## 6. 移交清单（跨域 bug 记录处）

| 日期 | 发现方 | 问题 | 移交给 | 状态 |
|---|---|---|---|---|
| （示例）2026-10-29 | B | 桌面心跳 15s 超时偏短 | A | 已修（14dfb12） |
| 2026-10-29 | B | 安卓→电脑远控的全流程真机走查需要桌面在线配合（确认弹窗 + 输入注入），B 侧已就绪（触控板 UI + InputController，真机安装启动通过） | A | 进展（10-30）：B 已用无头 Host（`.zwork/b/input-walkthrough.ts`，输入只记录不注入）验证到「TLS 握手 → announce 指纹闸门 → pair.request 送达」全绿，顺带修掉 Android 服务端拒收客户端证书的握手 bug（f547ba3）。剩余步骤（读屏配对码 → 点「控制电脑」→ 手势事件核对）被**平板安全锁屏**挡住（secure=true，ADB 无法代解锁），模拟器 shell 亦卡死。续作：解锁平板 → `cd .zwork/b && rm -f pair-code.txt && NODE_PATH=…\apps\desktop\node_modules TABLET_HOST=<平板IP> TABLET_PORT=<端口> node walkthrough.cjs`（后台）→ 截屏读码写入 pair-code.txt → 按 UI 点「控制电脑」→ 手势后查 events.log |
| 2026-10-29 | B | 文档一致性（审查报告 §4）：根 README 与 apps/desktop/README 的状态段过期，属 A 领地，B 不代改 | A | 待办 |
| 2026-10-29 | B | 分工文档 §2 原写「GRADLE_USER_HOME=D:\dev\gradle 没问题」与 apps/android/README 实测相反（该路径不可写，报 journal-1.lock 拒绝访问）；且 ANDROID_SDK_ROOT 与 ANDROID_HOME 不一致会让 Gradle 拒绝构建。正确姿势已补进 android README | 双方知晓 | 已更正 |

## 7. 提交与合并流程

1. 功能分支上完成开发 → 本域验证全绿（A：typecheck + 9 项无头套件；B：APK 构建成功 + 真机走查相关项）
2. 合并：`git fetch origin` → `git rebase origin/master`（有冲突说明越界，回 §6 处理）→ merge 到 master → push → 删功能分支。**不询问用户，直接推送**（既定规则）
3. 提交信息：Conventional Commits，中文正文讲「为什么」；跨域契约改动加 `[PROTOCOL]` 前缀
4. push 前确认远端 master 没有对方的新提交；有则先 rebase。两个 agent 同时 push 的概率低（不同域），以 rebase 化解

## 8. 节奏与门限

- 每条任务线完成即合并，不在分支上积压大批量变更
- 阶段门限沿用 roadmap：A 的 IddCx 结论直接决定阶段 4 走向；B 的三条补齐完成后，mvp-acceptance 第 6、7 组重走一遍
- 本文档的移交清单与资源规则，任何一方发现规则失效时先改文档再继续开发
