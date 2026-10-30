# 双 Agent 分工协作文档

> 目的：两个 agent 在同一仓库**同时开发、互不打扰**。按技术栈划域，按资源错峰，按契约对齐。
> 基线：master `14dfb12`（2026-10-29）。本文档本身为共享文件，改动需双方知晓。
> **2026-10-30 更新（用户指令）**：Agent A 全量离场，**所有任务移交 Agent B 独自执行**——原 A 主线并入 B-8/B-9/B-10，`apps/desktop` 领地与 §5 资源规则一并移交。下文双 Agent 隔离条款保留作为历史与再扩编模板。

---

## 1. 分工总览

| | **Agent A（桌面域，已离场）** | **Agent B（移动域 → 全域接管）** |
|---|---|---|
| 代码领地 | `apps/desktop/**`——**2026-10-30 起一并归 B** | `apps/android/**` + 接管 `apps/desktop/**` |
| 技术栈 | Electron 37 / Vue 3 / TS / Win32 | Kotlin / Jetpack Compose / NSD + 接管桌面栈（Electron 37 / Vue 3 / TS / Win32） |
| 主线任务 | （三条主线移交，见下格） | **全部**：投屏线 B-1..B-7 + 原 A 三条并入 B-8/B-9/B-10，执行顺序见 §3 头注 |
| 验收依据 | mvp-acceptance.md 第 9 组 + manual-walkthrough-stage3 桌面侧 | mvp-acceptance.md 全组 + manual-walkthrough-stage3 双端 |
| 构建产物 | NSIS 安装包、SBOM | debug APK + NSIS 安装包、SBOM（接管） |

**核心边界**：跨端功能只允许通过**协议消息**协作（见 §4），不允许直接改对方领地的文件。安卓→电脑远控是典型样例：桌面被控端 `InputSessionCoordinator` 已实现，B 只做 Android 控制端，零桌面改动。

## 2. 工作区隔离（必做，开工前先执行）

同一工作树必然冲突（git index、out/ 构建产物、node_modules 互相覆盖），各 agent 用独立 worktree：

```powershell
# Agent A（桌面域）
git worktree add ..\LinkSpace-desktop -b feat/desktop-a master
# Agent B（移动域）
git worktree add ..\LinkSpace-android -b feat/android-b master
```

- 各 worktree 首次需 `npm install`（apps/desktop）；Android 构建用仓库内置工具链（`GRADLE_USER_HOME`/`ANDROID_HOME` 指向 `.toolchain\`，完整命令见 §3.1——`D:\dev\gradle` 旧说法已实测不可写）
- 分支命名（双 Agent 时代约定，现为历史模板）：`feat/desktop-*` / `feat/android-*`，只允许提交本域文件
- 本仓库根目录（`d:\test\testforai\LinkSpace`）保留为**合并与发版工作区**，原由 A 负责 merge 与 push，**2026-10-30 起由 B 负责**；单 Agent 时代 B 可直接在根工作区开发，无需 worktree

## 3. 任务线详情

### Agent A（2026-10-30 全量离场，三条任务移交 B 为 B-8/B-9/B-10，详情保留供 B 执行）

1. **→ B-8｜IddCx 技术验证**（对应 roadmap 阶段 4 停止判据）：独立实验工程（不进主仓，或放 `experiments/iddcx-poc/` 且不引入主构建），产出结论回写 `docs/technical-validation.md`。**未通过则阶段 4 降级为投屏式第二屏**——这是先决判定。
2. **→ B-9｜第 9 组安全与隐私**（桌面侧）：按 mvp-acceptance 第 9 组逐项实现/走查（剪贴板开关默认值、信任清单一目了然、撤销即断连等）。
3. **→ B-10｜打包链路**：NSIS、SBOM、许可证清单随版本更新（镜像变量见 project_memory）。

### Agent B（2026-10-30 起全域唯一执行者）

> **执行顺序建议**（编号≠顺序）：B-1（验证基线，通过前其余不开工）→ B-2 → B-6 → B-8（IddCx 是阶段 4 先决判定，尽早穿插）→ B-3 → B-9 → B-5 → B-4 → B-10 → B-7。协议新增项（B-3/B-4/B-7，及 B-6 的登记）动手前先按 §4 规则改 protocol.md。单 Agent 时代领地禁令解除、两域代码均可直改，协议语义仍需登记冻结。

1. **B-1（首要）投屏绿屏修复真机验证闭环**：master 最新（9108929，WS 二进制流改造）装机 → `DEBUG_REQUEST_CONTROL` → 桌面 CDP approve → `DEBUG_SCREEN_STREAM` → screencap 确认画面正常非绿屏 → 触控滑动映射回归 → §6 销账。不通过按 §3.1 备忘定位。
2. **B-2 投屏 letterbox 等比渲染**：流为 1920×1080、屏 3200×2000，当前直接铺满拉伸变形。SurfaceView 按流宽高比居中留黑边；触控坐标按实际显示区域映射（黑边 clamp），注意与 `streamFallbackSize`/解码回读尺寸的基准关系。
3. **B-6 screen.stream.* 协议登记与会签**：四消息两端已实现并联测通过，但 protocol.md 未正式登记（A 打了 [PROTOCOL] 待会签）。补登四消息 + **WS 二进制帧分流约定**（0x1 文本 JSON / 0x2 二进制视频块 / 帧上限 32MB）。
4. **B-3 码率/分辨率自适应**：StreamDecoder 队列满丢块的计数上报告桌面，桌面动态调 scale 档位与 x264 crf/maxrate（必要时下调 preset）。新消息类型走 [PROTOCOL]。
5. **B-5 硬编探索**：libx264 软编桌面 CPU 占用可观，试 h264_nvenc（低延迟 tune）与 h264_mf，探测失败自动回退软编；结论回写 screen-stream.ts 头注（含为何弃用）。
6. **B-4 音频流**：系统声音采集 → AAC → WS 二进制帧（需与视频块区分的帧子约定，随 B-6 一并登记）→ 平板 AudioTrack 播放。
7. **B-7 投屏粘贴中文**：投屏场景平板剪贴板中文无法经键盘通道上屏（vk=0 跳过），设计剪贴板/粘贴消息通道（可与第 7 组 clipboard.share 复用思路）。
8. **B-8（原 A ①）IddCx 技术验证**：详见 §3 Agent A 条目——独立实验工程 `experiments/iddcx-poc/`（不引入主构建），结论回写 `docs/technical-validation.md`；未通过则阶段 4 降级投屏式第二屏。**阶段 4 的先决判定，建议在 B-6 完成后尽早穿插**。
9. **B-9（原 A ②）mvp-acceptance 第 9 组安全与隐私（桌面侧）**：详见 §3 Agent A 条目；B 跨两域后可直接实现与走查。
10. **B-10（原 A ③）NSIS 打包 / SBOM / 许可证清单**：详见 §3 Agent A 条目；electron-builder 权限已随移交放开（§5），打包只在本仓库根工作区跑。

#### §3.1 B-1 环境备忘（A 会话实测，拿去即用）

- **Android 构建**（仓库无 wrapper，用 .toolchain 内置发行版；两个 SDK 变量必须指向同处，否则 Gradle 拒绝构建——实测踩坑）：
  ```powershell
  $env:GRADLE_USER_HOME='D:\test\testforai\LinkSpace\.toolchain\gradle-home'
  $env:ANDROID_HOME='D:\test\testforai\LinkSpace\.toolchain\android-sdk'
  $env:ANDROID_SDK_ROOT=$env:ANDROID_HOME
  & 'D:\test\testforai\LinkSpace\.toolchain\gradle-8.10.2\bin\gradle.bat' -p d:\test\testforai\LinkSpace\apps\android :app:testDebugUnitTest :app:assembleDebug
  ```
- **桌面 dev 实例必须重启**：9108929 之前的实例跑的是旧推流逻辑（TCP 监听），WS 二进制改造在桌面侧三个文件（screen-stream.ts / host.ts / node.ts）。B 本轮验证允许起 CDP 9222 实例（A 会话已结束让出）；approve 弹窗可用 `.zwork/a/cdp-eval.ps1` 驱动。
- **平板无线调试端口随重连变化**：`adb connect <ip>:<当前端口>`（上轮为 192.168.101.111:42369，端口会变）。
- **debug 广播链**：`am broadcast -a cn.linkspace.DEBUG_REQUEST_CONTROL`（发起控制）→ CDP approve → `am broadcast -a cn.linkspace.DEBUG_SCREEN_STREAM`（发起投屏）→ `adb exec-out screencap -p > cap.png` 验画面。
- **logcat**：`adb logcat -s LinkSpace/Stream LinkSpace/Service LinkSpace/Client`（解码器选型/输出尺寸/喂入队列、帧分流、连接层）。
- **排查要点**：若仍绿屏，先看「选用解码器」日志确认落在 c2.qti 且输出尺寸=1920×1080（FORMAT_CHANGED）；再核对桌面 ffmpeg 命令含 `scale=1920:-2 -profile:v baseline`；若黑屏不出首帧，查 pendingVideo 缓冲是否在 connectStreamSurface 前已到（SPS/PPS 在流头，WS 帧先于 UI 切换到达是常态）。

### 禁区（2026-10-30 单 Agent 时代更新）
- 领地禁令随 A 离场解除：B 可直改两域。若将来再扩编双 Agent，恢复按域隔离（本节与 §2、§5 的历史规则即模板）。
- 协议语义仍**不得单方面修改**（见 §4）——这条与人数无关，是两端兼容性约束。
- 桌面域关键决策（ffmpeg 编码参数、注入坐标基准等）的「为什么」写进对应文件头注或 §6，替代原 A↔B 移交通道；历史记录显示这类「为什么」是排查时的第一线索。

## 4. 协议契约（唯一共享接口）

共享契约物：`docs/protocol.md`、`Protocol.kt` ↔ `apps/desktop/src/main/control/node.ts` 的消息类型、mDNS TXT 键、`/linkspace/v1/transfer/*` 路由。

规则：
1. **现有消息类型与字段语义冻结**。改语义必须双方同意并在 `docs/protocol.md` 同步登记后才能动手。
2. **新增消息类型**：提议方先改 `docs/protocol.md`（提交信息打 `[PROTOCOL]` 标签），对端下一个迭代跟进实现；未跟进期间提议方代码必须兼容对端「不认识该消息」的现状（发送可带、接收忽略未知 type——两端 dispatch 均已是此语义）。
3. 协议文档冲突时以 master 上 `docs/protocol.md` 为准，本地重放 rebase。

## 5. 共享资源调度（冲突高发区）

| 资源 | 归属规则（2026-10-30 单 Agent 时代） |
|---|---|
| 真机平板 TB710FU（唯一） | B（唯一执行者）。多任务并行时注意 logcat/走查会话别互相踩 |
| 桌面 GUI 实例 | B 可随意起（CDP 9222）。⚠️ 同 userData 起双实例仍会产生同 deviceId 的双实例、mDNS 通告互踢——**任何时候只跑一个 GUI 实例**，确需第二个用途时用 9223 + 独立 `--user-data-dir` |
| CDP 端口 | 9222 主用；第二实例例外用 9223 + 独立目录 |
| electron-builder 打包 | B（权限随全量移交放开），在本仓库根工作区跑 `npm run dist` |
| 5353 组播网络 | 无头 verify 用回环/独立端口不冲突；涉及真实 mDNS 的验证别与在跑的 GUI 实例重叠 |
| `.zwork/` 工具目录 | 共享只读工具（walkthrough.mjs、fastpath.mjs、check-disc.mjs）不动；B 新增脚本放 `.zwork/b/`；A 的 `.zwork/a/`（cdp-eval.ps1、mdns-probe4.mjs 等）仍可直接复用；此目录不入库 |

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
| 2026-10-30 | A | **投屏真机联测通过（三坑连修）**：①桌面 listen 被防火墙拦（ffmpeg 无放行规则，SYN 静默丢弃 10 秒超时）→ **连接方向反转**：平板起 ServerSocket 随机端口随 request 上行，桌面 ffmpeg 连出（conn.remoteAddress 此前从未赋值，补自 ws._socket）；②mDNS 解析地址错乱：先后拿到 169.254 链路本地与 **VMware VMnet8 的 192.168.101.1（与家里路由器撞号）**→ Discovery 解析加可路由性过滤（链路本地/CGNAT/.1 结尾排除）；③解码秒退：MediaCodec 输入缓冲是 direct buffer，ib.array() 抛无消息异常 → 临时数组+put；触控坐标空间修正为 session.start 声明屏（桌面 mapPoint 的 from）。**端到端验证**：投屏界面出现（6720×2160 硬解）、画面滑动驱动桌面光标精确移动。debug 广播新增 DEBUG_SCREEN_STREAM（ZUI 注入点不了按钮）。B 的读超时修复（621e9b5）已 rebase 合入回归 | B 会签（协议新增四消息） | 双端联测通过（后被绿屏问题推翻重改，见下条） |
| 2026-10-30 | A | **投屏绿屏（用户截图满屏绿）三根因修复（9108929）**：①网络方向推翻上条方案——实测平板侧**所有 TCP 入站端口对桌面不通**（ICMP 通、TCP 全拒），ServerSocket 方案根本不成立；视频块改走 **WS 二进制帧复用平板主动连出的控制连接**（TCP 全双工，读循环按 opcode 分流），ffmpeg 改 pipe:1；②骁龙 6 系 AVC 硬解上限 1080p 级（6720 宽流仅顶部条带正常）→ 桌面 `scale=1920:-2`，解码 MAX 尺寸 8192 防 stride 错位；③x264 多 slice 流在 c2.qti 块级损坏 → `baseline + sliced-threads=0`。StreamDecoder 改 feed 模式（16 深队列满丢旧），渲染面前块缓冲在服务层。typecheck/单测/装配全绿，**真机画面验证未做**（A 会话转交接） | B | **待 B-1 验证闭环（首要）** |
| 2026-10-30 | 用户 | **Agent A 全量离场，所有任务移交 Agent B 独自执行**：原 A 主线三条并入 B-8（IddCx）/ B-9（第 9 组安全隐私）/ B-10（NSIS 打包），`apps/desktop` 领地、merge/push 职责与 §5 资源规则一并移交；B-1..B-7 维持原编号，执行顺序见 §3 头注 | 双方知晓 | 已生效（本文档 §1/§2/§3/§5/禁区 同步改写） |

| 2026-10-31 | B | **B-1 投屏真机验证完成（绿屏修复确认）**：全链路控制会话 → WS 二进制流 → c2.qti 硬解 → FORMAT_CHANGED 1920x1200（桌面 2880x1800 等比）→ 渲染内容干净无绿色伪影。过程中抓到并修掉 **9108929 喂入模型重构的缺口**（视频块只进缓冲、无持续 feed 路径，解码线程饿死——a5bf900/c30ed96）、推流 socket 无读超时（621e9b5）、桌面 mDNS 无周期重通告（e64362e）、平板 STALE_MS 与 NSD 再上报节奏错配（300s）。剩余：真实桌面内容的目视确认与触控手感（user-ops §7，PC 前台解锁时人工过） | 双方知晓 | B-1 完成 |
| 2026-10-31 | B | 桌面新增 `LINKSPACE_AUTO_APPROVE=1` 走查自动批准 + Discovery 45s 周期重通告（e64362e）：均为真机走查驱动设施，正常用户流程不变 | 双方知晓 | 记录在案 |

| 2026-10-31 | B | **B-2 letterbox 等比渲染完成**：解码实际尺寸经 onSize 回灌 UI（响应式）、SurfaceView 按流宽高比居中黑边、触控按显示矩形映射（黑边 clamp）；letterboxRect 抽纯函数 + 6 例 JVM 单测（含浮点 round 修正）。真机验证：解码 1920x1200 回灌 ✓、PC 锁屏内容干净渲染 ✓；真实桌面内容的目视确认随 user-ops §7 | 双方知晓 | B-2 完成 |

## 7. 提交与合并流程

1. 功能分支上完成开发 → 本域验证全绿（A：typecheck + 9 项无头套件；B：APK 构建成功 + 真机走查相关项）
2. 合并：`git fetch origin` → `git rebase origin/master`（有冲突说明越界，回 §6 处理）→ merge 到 master → push → 删功能分支。**不询问用户，直接推送**（既定规则）
3. 提交信息：Conventional Commits，中文正文讲「为什么」；跨域契约改动加 `[PROTOCOL]` 前缀
4. push 前确认远端 master 没有对方的新提交；有则先 rebase。两个 agent 同时 push 的概率低（不同域），以 rebase 化解

## 8. 节奏与门限

- 每条任务线完成即合并，不在分支上积压大批量变更
- 阶段门限沿用 roadmap：A 的 IddCx 结论直接决定阶段 4 走向；B 的三条补齐完成后，mvp-acceptance 第 6、7 组重走一遍
- 本文档的移交清单与资源规则，任何一方发现规则失效时先改文档再继续开发
