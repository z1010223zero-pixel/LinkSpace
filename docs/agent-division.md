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
| 2026-10-29 | B | 安卓→电脑远控的全流程真机走查需要桌面在线配合（确认弹窗 + 输入注入），B 侧已就绪（触控板 UI + InputController，真机安装启动通过） | A | **已完成（10-30）**：无头 Host（`.zwork/b/input-walkthrough.ts`，输入只记录不注入）+ 仅 debug 构建的广播驱动器（ZUI 屏蔽 adb 触摸注入，`am broadcast` 不受限）。验证结论：配对（读屏码 → 提交）→ 会话建立 → move 坐标映射（3200×2000→1920×1080 逐点核对）→ click / wheel / key → stop+releaseAll，**全链路通过**。过程中修掉 Android 服务端拒收客户端证书的握手 bug（f547ba3）与 .gitignore `Debug/` 误伤 `src/debug/` 的入库缺失。唯一未覆盖「真实手指→MotionEvent」（B 计划 T7，人工补手感核对） |
| 2026-10-29 | B | 文档一致性（审查报告 §4）：根 README 与 apps/desktop/README 的状态段过期，属 A 领地，B 不代改 | A | **已完成（10-30，c231d1e）**：§4 九项一次清完（根/desktop/android README、protocol 字段缺口、architecture koffi ADR、threat-model 缓解登记、roadmap 状态、docs/README、HANDOVER 快照标注） |
| 2026-10-29 | B | 分工文档 §2 原写「GRADLE_USER_HOME=D:\dev\gradle 没问题」与 apps/android/README 实测相反（该路径不可写，报 journal-1.lock 拒绝访问）；且 ANDROID_SDK_ROOT 与 ANDROID_HOME 不一致会让 Gradle 拒绝构建。正确姿势已补进 android README | 双方知晓 | 已更正 |
| 2026-10-30 | B | **mvp 第 6 组文件双向真机走查完成**：桌面→平板 1MB 两次推送完成、平板→桌面 512KB 两次完成、**SHA-256 双向逐字节一致**；走查基建见 `.zwork/b/input-walkthrough.ts`（无头 Host + 平板侧 DebugEntryActivity 驱动，均为仅 debug/不入库物） | 双方知晓 | 已完成 |
| 2026-10-30 | B | **mvp 第 7 组剪贴板接收向验证完成**：桌面经已配对连接推 clipboard.share，平板走 scope 门禁路径收到并写入剪贴板（logcat 证据「收到 clipboard.share，20 字符」）。发送向受 Android 10+ 前台焦点约束，走查驱动已具备能力（DEBUG_CLIPBOARD），随人工走查补 | 双方知晓 | 接收向完成 |
| 2026-10-30 | B | **桌面端 host.ts 多连接键控覆盖**（真机实测复现）：同一对端同时存在「主动连出 + 对端连入」两条连接时，`peers`/`endpoints` 按 deviceId 键控互相覆盖；平板 sendFiles 建立入站连接后，**迟到（>60s）的 transfer.accept 报「不知道对端的监听端点，无法推送」**，下行推送失败。复现：配对 → 平板发文件（建入站连接）→ 等 60s+ → 桌面推文件。建议端点跟连接绑定或按 conn 去重 | A | **已修（10-30，13bf33e）**：handleConnClosed 加幸存者检查——迟到的 close 只摘自己这条连接，同身份活连接还在时不删 peers/endpoints 并把登记移交过去；verify:e2e 8c 双连接场景回归钉死 |
| 2026-10-30 | B | `transfer.progress` 两端均未实现且无消费方（桌面进度来自数据面 committedOffset），建议 protocol.md 标注「保留未用」。协议语义冻结，不单方面改文档，请 A 会签 | A | **已会签（10-30，3b70425）**：标注「保留未用」并冻结定义，第 5 节流程步骤同步改写 |
| 2026-10-30 | B | 平板信任清单残留 5 条走查用临时身份条目（指纹密钥已随临时目录销毁，不可被利用），可在 UI 撤销或忽略 | 双方知晓 | 记录在案 |
| 2026-10-30 | A | **T7 真实手指触控走查（自动化部分）完成**：用户开启「USB 调试（安全设置）」后，A 用 `input swipe/tap` 驱动触控板——配对（读屏码）→ session 建立 → **真实 MotionEvent move 流 16 条落桌面**（触控板占比映射 3200×2000→1920×1080）→ stop+releaseAll 双端干净。剩跟手感/双指滚动为用户亲手项。**注意：ZUI 下 adb 注入的 ACTION_UP 不可靠**（Button onClick 也不触发），依赖 up 的判定必须真手验证 | 双方知晓 | 自动化部分完成 |
| 2026-10-30 | A | **Bug1：触控板轻点单击失灵（死代码）**——`MainActivity.kt` TouchpadScreen 的 pointerInput 里 `changedToUp()` 检查在 `changes.filter{it.pressed}` 之后的 `pressed.size==1` 分支内，但手指抬起后该 change pressed=false 被 filter 掉、事件落入 else 分支，**单指轻点的 click 分支永远不可达**。B 的 T1-T6 走查用 DEBUG_SEND_EVENTS 广播绕过了 UI 所以未暴露。修法：在 filter 前先取 `event.changes.firstOrNull{it.changedToUp()}` 单独判定 click | B | 待修 |
| 2026-10-30 | A | **Bug2：InputController.pending 无过期清理**——`PendingRequest.expiresAt` 从未被检查（request 入口只看 `pending != null`），UI 宣称「30 秒未确认自动失效」实际永不失效；一次未达的请求把 pending 永久占死，后续 request 全部被静默拒绝（本次走查实测复现）。修法：request 入口检查 `expiresAt`，过期先清再放行 | B | 待修 |
| 2026-10-30 | A | **Bug3：控制请求缺建连步骤（用户 T7 走查被阻塞）**——平板点「控制电脑」时若与桌面无已登记的控制连接，`sendControlTo` 按 `controlPeerIds[conn]` 匹配不到任何连接，session.start **静默丢弃**（电脑无授权提示、平板永久等待）。真机实测：netstat 零连接 + 电脑无弹窗。走查没暴露是因为无头 Host 反向连了平板（平板作为 server 有入站连接）；真实场景平板需**主动连桌面**（sendFiles 有建连逻辑但发送完即关连接，控制会话无处复用）。修法要点：request 前确保连接（复用 connectControl+announce 握手），且主动连出的 conn 必须注册进 controlConns/controlPeerIds 才能被 sendControlTo 命中 | B | **已修（A 代修，用户授权）**：`LinkSpaceService.requestInputControl` 建出站连接（connectControl+announce+心跳+读循环），input 的 send 回调优先路由出站连接，无需改 TransferServer 类型；MainActivity 改经 `scope.launch` 调用 |
| 2026-10-30 | A | **Bug4：pending 态点「取消」无反应**——等待对话框取消按钮调 `InputController.stop()`，其中 `pending = null` 后 `val a = active ?: return` 提前返回，**不触发 onSessionEnded**，`_inputState` 停在 "waiting"，对话框永远关不掉（用户实测复现）。修法：stop() 里 pending 被清且 active 为空时也要 `listener?.onSessionEnded("已取消")` | B | **已修（A 代修，用户授权）**：stop() 在 pending 态补发 `onSessionEnded("已取消请求")`，InputControllerTest 已加回归钉 |

## 7. 提交与合并流程

1. 功能分支上完成开发 → 本域验证全绿（A：typecheck + 9 项无头套件；B：APK 构建成功 + 真机走查相关项）
2. 合并：`git fetch origin` → `git rebase origin/master`（有冲突说明越界，回 §6 处理）→ merge 到 master → push → 删功能分支。**不询问用户，直接推送**（既定规则）
3. 提交信息：Conventional Commits，中文正文讲「为什么」；跨域契约改动加 `[PROTOCOL]` 前缀
4. push 前确认远端 master 没有对方的新提交；有则先 rebase。两个 agent 同时 push 的概率低（不同域），以 rebase 化解

## 8. 节奏与门限

- 每条任务线完成即合并，不在分支上积压大批量变更
- 阶段门限沿用 roadmap：A 的 IddCx 结论直接决定阶段 4 走向；B 的三条补齐完成后，mvp-acceptance 第 6、7 组重走一遍
- 本文档的移交清单与资源规则，任何一方发现规则失效时先改文档再继续开发
