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
| 2026-10-30 | A | **Bug1：触控板轻点单击失灵（死代码）**——`MainActivity.kt` TouchpadScreen 的 pointerInput 里 `changedToUp()` 检查在 `changes.filter{it.pressed}` 之后的 `pressed.size==1` 分支内，但手指抬起后该 change pressed=false 被 filter 掉、事件落入 else 分支，**单指轻点的 click 分支永远不可达**。B 的 T1-T6 走查用 DEBUG_SEND_EVENTS 广播绕过了 UI 所以未暴露。修法：在 filter 前先取 `event.changes.firstOrNull{it.changedToUp()}` 单独判定 click | B | **已修（A 代修，用户授权修基础使用问题）**：抬起帧（pressed=0 的 else 分支）先判轻点再复位滚动状态；adb 自测确认注入 [down left, up left] |
| 2026-10-30 | A | **Bug2：InputController.pending 无过期清理**——`PendingRequest.expiresAt` 从未被检查（request 入口只看 `pending != null`），UI 宣称「30 秒未确认自动失效」实际永不失效；一次未达的请求把 pending 永久占死，后续 request 全部被静默拒绝（本次走查实测复现）。修法：request 入口检查 `expiresAt`，过期先清再放行 | B | **已修（A 代修，用户授权）**：request 入口清理过期 pending；回归钉 `过期挂起不阻塞新请求`。此 bug 曾让自动化走查误判「连接老化丢帧」——实际是第二次 request 被本地静默拒绝根本没发 |
| 2026-10-30 | A | **Bug3：控制请求缺建连步骤（用户 T7 走查被阻塞）**——平板点「控制电脑」时若与桌面无已登记的控制连接，`sendControlTo` 按 `controlPeerIds[conn]` 匹配不到任何连接，session.start **静默丢弃**（电脑无授权提示、平板永久等待）。真机实测：netstat 零连接 + 电脑无弹窗。走查没暴露是因为无头 Host 反向连了平板（平板作为 server 有入站连接）；真实场景平板需**主动连桌面**（sendFiles 有建连逻辑但发送完即关连接，控制会话无处复用）。修法要点：request 前确保连接（复用 connectControl+announce 握手），且主动连出的 conn 必须注册进 controlConns/controlPeerIds 才能被 sendControlTo 命中 | B | **已修（A 代修，用户授权）**：`LinkSpaceService.requestInputControl` 建出站连接（connectControl+announce+心跳+读循环），input 的 send 回调优先路由出站连接，无需改 TransferServer 类型；MainActivity 改经 `scope.launch` 调用 |
| 2026-10-30 | A | **Bug4：pending 态点「取消」无反应**——等待对话框取消按钮调 `InputController.stop()`，其中 `pending = null` 后 `val a = active ?: return` 提前返回，**不触发 onSessionEnded**，`_inputState` 停在 "waiting"，对话框永远关不掉（用户实测复现）。修法：stop() 里 pending 被清且 active 为空时也要 `listener?.onSessionEnded("已取消")` | B | **已修（A 代修，用户授权）**：stop() 在 pending 态补发 `onSessionEnded("已取消请求")`，InputControllerTest 已加回归钉 |
| 2026-10-30 | A | **触控板体验整改（用户实测反馈）**：①绝对映射改**相对移动**——本地虚拟光标按灵敏度累积、跨手势保持（修「移动慢」+「抬起再按跳点」），协议仍发绝对坐标桌面零改动；②灵敏度滑杆 0.5x-5x 持久化；③文本框 hint 标注需英文输入法（Vk 只映射 ASCII，中文 IME 上屏内容 vk=0 跳过）；④debug 构建新增 `am broadcast -a cn.linkspace.DEBUG_REQUEST_CONTROL` 走查驱动（ZUI 注入 ACTION_UP 不可靠点不了按钮）。**adb 全链路自测通过**：光标 700→1076→1424（相对连续）、轻点注入 left click、键盘 xyz 实际写进记事本 | 双方知晓 | 已完成 |
| 2026-10-30 | A | **双屏映射 + 流畅度（用户实测反馈第二批）**：①指针只在一屏一半——根因是 mapPoint 目标用 Electron `getPrimaryDisplay().size`（DIP 逻辑分辨率）而 SendInput 归一化基准是虚拟屏**物理**像素（GetSystemMetrics 系），DPI 缩放 + 只映射主屏双重错位；修法：`inputLocalScreen` 改用 `win32.virtualScreen()` 物理 bounds，注入前补回负 origin 偏移，指针覆盖全部显示器（自测：光标到达虚拟屏左右边界 -4389/2878）；②指针卡顿——出站 socket 未禁 Nagle（高频小帧被攒包）+ 每帧一条消息开销；修法：`tcpNoDelay=true` + 触控板 move 攒批（16 条或 30ms 合并，一条消息一次 SendInput），up/轻点前 flush 保序。**投屏到平板（电脑画面流到平板触控）为全新大特性，需单独立项（桌面 DXGI 采集→编码→流传输→平板 MediaCodec 渲染→触控回传），不在 bugfix 轮实现** | B 会签（涉及被控端映射语义变化：session.accept 的 screen 现在是虚拟屏物理尺寸） | 已完成/待会签 |
| 2026-10-30 | A | **屏幕投屏 MVP 实现（上条立项的落地）**：①桌面 `screen-stream.ts`——ffmpeg gdigrab 抓桌面（不传 offset/size：gdigrab 不支持负 offset，desktop 模式默认抓多显示器并集）+ libx264 ultrafast/zerolatency → 裸 H.264 Annex-B over TCP；②协议新增 `screen.stream.request/start/stop/error` 四消息（**[PROTOCOL]** 待 B 会签），投屏寄生在键鼠会话内（同 peer active 会话才受理，会话结束/断连/撤销自动杀流）；③平板 `StreamDecoder`——MediaCodec 硬解（跳过软解实现）直喂 64KB 块，输出实际分辨率回读供触控映射；④平板 UI：触控板加「投屏」按钮，流就绪整屏切投屏画面，手势 VNC 惯例（滑动=移动/轻点=单击/静置长按拖=左键拖拽/双指=滚轮） | B 会签（协议新增） | 桌面完成 |
| 2026-10-30 | A | **投屏真机联测通过（三坑连修）**：①桌面 listen 被防火墙拦（ffmpeg 无放行规则，SYN 静默丢弃 10 秒超时）→ **连接方向反转**：平板起 ServerSocket 随机端口随 request 上行，桌面 ffmpeg 连出（conn.remoteAddress 此前从未赋值，补自 ws._socket）；②mDNS 解析地址错乱：先后拿到 169.254 链路本地与 **VMware VMnet8 的 192.168.101.1（与家里路由器撞号）**→ Discovery 解析加可路由性过滤（链路本地/CGNAT/.1 结尾排除）；③解码秒退：MediaCodec 输入缓冲是 direct buffer，ib.array() 抛无消息异常 → 临时数组+put；触控坐标空间修正为 session.start 声明屏（桌面 mapPoint 的 from）。**端到端验证**：投屏界面出现（6720×2160 硬解）、画面滑动驱动桌面光标精确移动。debug 广播新增 DEBUG_SCREEN_STREAM（ZUI 注入点不了按钮）。B 的读超时修复（621e9b5）已 rebase 合入回归 | B 会签（协议新增四消息） | 双端联测通过 |

## 7. 提交与合并流程

1. 功能分支上完成开发 → 本域验证全绿（A：typecheck + 9 项无头套件；B：APK 构建成功 + 真机走查相关项）
2. 合并：`git fetch origin` → `git rebase origin/master`（有冲突说明越界，回 §6 处理）→ merge 到 master → push → 删功能分支。**不询问用户，直接推送**（既定规则）
3. 提交信息：Conventional Commits，中文正文讲「为什么」；跨域契约改动加 `[PROTOCOL]` 前缀
4. push 前确认远端 master 没有对方的新提交；有则先 rebase。两个 agent 同时 push 的概率低（不同域），以 rebase 化解

## 8. 节奏与门限

- 每条任务线完成即合并，不在分支上积压大批量变更
- 阶段门限沿用 roadmap：A 的 IddCx 结论直接决定阶段 4 走向；B 的三条补齐完成后，mvp-acceptance 第 6、7 组重走一遍
- 本文档的移交清单与资源规则，任何一方发现规则失效时先改文档再继续开发
