# LinkSpace 桌面端增量安全审查（基线 4083353 → HEAD f423ea4）

> 审查日期：2026-10-29。范围：`apps/desktop` 自上次审查（报告 docs/desktop-review-2026-10-29.md）
> 以来的全部增量，重点是新增功能与既有安全门禁的交互。只读审查，未运行 npm 验证套件。
> 方法：`git diff 4083353 HEAD --stat` 圈定增量，逐文件审 diff；对疑点回读当前文件确认行号与上下文。
> 注意：实际增量比任务背景列出的更多——还包含剪贴板同步（clipboard.ts，新文件）与键鼠共享
> （input/ 共 6 个新文件 + Win32 注入层），一并纳入审查。

## 结论摘要

九项既有安全门禁（token 三合一、块摘要、TLS 锚定、revoke 来源校验、配对上限、offer 门禁、
accept 身份核对、路径穿越清洗、32MiB 上限）**本体均未被回退**。但新增的「离线挂起+上线补发」
功能在**撤销信任场景下把 file 授权门禁整个绕开**（P0），构成可触达的信任边界破坏。
键鼠共享与剪贴板同步的授权设计总体扎实（会话级授权、来源三重核对、字段白名单），
另有 2 个 P2（挂起任务状态卡死、剪贴板开关不持久化且默认强制开启）。

| 级别 | 数量 |
|---|---|
| P0 | 1 |
| P1 | 0 |
| P2 | 2 |
| P3 | 6 |

---

## P0 —— 撤销信任后，挂起任务在设备重连时自动补发，file 授权门禁失效

**事实链（每一步都有代码证据）：**

1. 对端离线时创建挂起任务：`offerFiles` 只在**入队时**检查信任与授权
   （`apps/desktop/src/main/host.ts:403` `if (!this.trust.isKnown(peerId) || !this.trust.hasScope(peerId, 'file'))`），
   通过后任务以 `waiting` 状态挂起（`host.ts:405-411`）。
2. 撤销信任**不清理挂起任务**：`onRevoked` 只做 `this.peers.delete(deviceId)` 与事件广播
   （`host.ts:304-307`）。全仓 grep 确认 waiting 任务只有用户取消与对端 `transfer.cancel` 两条清理路径，
   没有 revoke 路径。`host.ts:788-792` 的 `revoked` 监听只清键鼠会话。
3. 被撤销设备重连：`PairingCoordinator.handleAnnounce` 对**不在信任清单**的设备只做
   「自报指纹 == 实际 TLS 证书指纹」自洽检查（`apps/desktop/src/main/pairing.ts:343-390`，
   `conn.peerId = peerId` 在 :390）——它出示自己的真证书即可通过（本就是它自己的身份）。
4. announce 一到就无条件补发：`host.ts:295` `this.flushWaitingOffers(conn)`。
   `flushWaitingOffers`（`host.ts:436-447`）只核对 `task.direction/.state/.peerId`，
   **不复查** `trust.isKnown(peerId)` / `hasScope(peerId,'file')`：
   ```ts
   if (task.direction !== 'send' || task.state !== 'waiting' || task.peerId !== peerId) continue
   conn.send('transfer.offer', { transferId: task.id, files: ... })
   this.transfers.markOffered(task.id)
   ```
5. 被撤销设备回 `transfer.accept`：处理器只核对「连接身份 == 任务对端」
   （`host.ts:543` `if (!task || task.direction !== 'send' || task.peerId !== conn.peerId) return`），
   随即 `attachToken` 并 `push()`（`host.ts:545-549`）——文件开始流向已撤销设备。

**影响**：用户明确撤销信任的设备（无论是本机撤销还是该设备自己发 `pair.revoke` 自撤），
重连后无需任何用户交互即可自动收到此前挂起的全部文件内容。基线确立的
「⑥ transfer.offer 必须已声明身份 + file 授权」与数据面「① 信任清单+授权+token」三闸，
在补发路径上对已撤销设备全部不生效。等待状态使暴露窗口从「传输瞬间」延长到「无限期」。

**修复方向**（三层任一即可闭合，建议全做）：
- `flushWaitingOffers` 补发前复查 `isKnown + hasScope('file')`，不满足则取消任务并提示；
- `onRevoked` 中取消该 peer 的所有未完成任务（至少 waiting）；
- `transfer.accept` 处理器补一道 `hasScope(conn.peerId,'file')`。

**证据等级**：一手代码，全链路逐行核对。置信：确定。
（对端重连须持有原设备证书，因此不是任意局域网攻击者可利用；但「撤销」正是针对该设备的
处置动作，门禁对其失效即机制失效。）

---

## P2

### P2-1 waiting → offered 后连接断开，任务永久卡死，自动补发承诺失效

`markOffered` 只接受 `waiting` 状态（`apps/desktop/src/main/transfer/manager.ts:183-186`
`if (!task || task.state !== 'waiting') return task`）；`flushWaitingOffers` 也只补发 `waiting`
（`host.ts:439`）。时序：挂起 → 对端上线补发（状态翻 `offered`）→ 对端在 accept 前
掉线/心跳超时 → 任务停在 `offered`，重连后**不再补发**（状态已非 waiting），
也没有任何 offered→waiting 的回退路径。验收 4.9「上线自动补发」在半路断连场景静默失效，
任务永远停在「等待对端确认」。
**修复方向**：对端离线（onClosed/心跳超时）时把「未收到 accept 的 offered 发送任务」回退为
waiting；或 flush 条件放宽为 `waiting || (offered && 未收到 accept)`。

### P2-2 剪贴板同步被启动路径强制开启，用户开关不持久化

Host 构造时 `clipboardEnabled = false`，但 `index.ts:289` 无条件调用 `startClipboardSync()`
→ `enableClipboardSync()`（`host.ts` 内）把开关置回 `true` 并 `start()`。
`setClipboardEnabled(false)` 只改内存（无落盘）。结果：用户关闭同步 → 重启应用 →
开关静默回到开，剪贴板内容再次自动广播给所有 clipboard 授权对端。与 6.6
「关闭同步 → 完全不传输」的用户预期不符（重启后语义反转）。
收发双向的授权门禁本身完好（见「验证无误」），故定 P2 而非 P1。
**修复方向**：开关持久化（profile.json 或独立设置文件），启动时按持久化值决定
是否 `enableClipboardSync`；并考虑默认值取「关」更符合剪贴板内容的敏感性。

---

## P3（加固建议）

1. **sanitizeDisplayName 不清 C1 控制符与双向文本覆盖符**
   `apps/desktop/src/main/profile.ts:64-71` 只清 `\u0000-\u001f\u007f`。U+0080–U+009F
   与 U+202E（RTL Override）等可进入对端自报名，进 UI（App.vue 插值，无 XSS 风险）与日志，
   造成显示层欺骗（如逆序显示）。建议扩充黑名单或白名单化。
2. **device.rename 无频率限制**：`host.ts:687-704` 每条 rename 触发 `trust.persist()`
   同步写盘 + UI 事件。仅已配对设备可触发，影响有限；建议按连接限频。
3. **WebSocket 未设 maxPayload**：`control/node.ts` 的 `WebSocketServer` 构造未配
   maxPayload，ws 默认单消息上限 100MiB；`clipboard.share` 要到 `receive()` 才查 512KB
   （`clipboard.ts`）。已授权对端可用大帧打内存。建议按消息类型设上限（如 1MiB，大内容走数据面）。
4. **挂起任务无上限、无超时**：waiting/offered 任务数量不受限（入站 offer 挂起任务基线即如此，
   非本次回退）。建议设每对端挂起上限与整体超时。
5. **来源门禁对 CGNAT/VPN overlay（Tailscale 100.64/10）不设防，且与发现层判定相互矛盾**
   `net-scope.ts:64` 把 100.64/10 计入「局域网」（`inboundAllowed` 放行），
   `server.ts` 的 `isRoutableLanAddress` 也不排除它（可作为绑定地址）；
   而 `discovery.ts` 的 `pickLanInterface` 明确排除 CGNAT（注释：不能跑 mDNS）。
   即：Tailscale/ZeroTier 对端顺利通过来源门禁，只剩 TLS 身份门禁兜底。
   代码注释声明这是「避免误伤」的刻意取舍——按「门禁语义与注释一致、身份层不受影响」
   定为加固项：建议至少在日志/文档写明「来源门禁对 VPN overlay 无效」，或提供开关。
6. **杂项**：`resolveBindAddress` 只看 IPv4（`server.ts`），纯 IPv6 局域网环境退回回环绑定
   （设备不可见，注释已声明，属功能限制）；`transfer.accept` 处理器在校验前执行
   `this.peers.set(conn.peerId, conn)`（`host.ts:540`，基线已有），
   未声明身份的连接会以空串键入表，建议移到校验后。

---

## 验证无误的方面（逐项对照基线 9 门禁 + 新增面）

**基线门禁本体（一手代码核对，均未回退）：**
1. 数据面三合一校验仍是唯一闸门：`transfer/server.ts:224-228`（verifyTransfer 在 method 分叉前）；
   接线 `host.ts:242-246` `isKnown(deviceId) && hasScope(deviceId,'file') && verifyToken(...)`。
2. `X-Chunk-Digest` 强制校验保留（`server.ts:287-293`，不符 400）；`sendChunk` 新增的
   `opts.declaredDigest` 注入点仅测试路径使用（`server.ts:450-459` 注释明示「产品路径不传」）。
3. TLS 指纹锚定未动：自报≠实际断开、已信任设备重连证书不符断开（`pairing.ts:343-391`）。
4. `pair.revoke` 来源校验未改（pairing.ts 撤销处理逻辑本次 diff 零改动）。
5. `pair.request` 挂起上限 8 保留（`pairing.ts:93` `MAX_PENDING_PAIRINGS = 8` 及 busy 拒绝）。
6. `transfer.offer` 门禁保留且更严：身份声明 + `TRANSFER_ID_RE` + `hasScope('file')`
   （`host.ts:502-519`）。
7. `transfer.accept/reject/cancel/complete` 核对「连接身份==任务对端」全保留
   （`host.ts:543/566/585/595`）。
8. `sanitizeFileName` 路径穿越清洗未动（manager.offer 入口清洗逻辑本次仅增加 waiting 分支）。
9. POST 32MiB 上限与 GET length 上限、413/400 分支全保留（`server.ts:129-131` 及处理分支）。

**新增面（按重点逐项）：**
- **rename**：只允许对端改**它自己**的条目——`host.ts:687-704` 处理器以 `conn.peerId`
  调 `trust.rename(peerId, clean)`，且要求 `trust.isKnown`；`trust.ts:127-136` rename 按
  deviceId 精确匹配。无法改「别人」的名字，无法伪造身份字段。名字清洗限 60 字符去控制符
  （缺口见 P3-1）。
- **离线挂起队列**：入队时校验信任+授权（`host.ts:403`）；补发幂等（`markOffered` 只吃 waiting）；
  token 生命周期正常（waiting 发送任务无 token，accept 时才由接收方生成并 attach；
  文件句柄按块 open/close 无长期句柄）。缺陷见 P0 与 P2-1。
- **heartbeat**：超时真正关闭连接（`control/node.ts` `conn.close(4000, 'heartbeat timeout')`），
  onClosed 链清理 peers/endpoints/键鼠会话；间隔/超时可注入供测试；
  verify-heartbeat 无头覆盖「TCP 断连立即感知」与「静默超时踢出」两条路径。
- **GET 下载方向**：`verifyTransfer` 三闸在 method 分叉**之前**执行，GET 同样受限；
  waiting 任务在 accept 前无 token，GET 返回 403；产品路径仍无 GET 调用方（发送走 POST sendChunk）。
- **来源地址门禁（fdc1774）**：数据面 `secureConnection`（`server.ts:157-160`）与 WS upgrade
  （`node.ts:139/159` guardInbound）双层拦截，缺地址按不信任处理；`LINKSPACE_ALLOW_WAN`
  逃生口需显式设置。多网卡时绑定收窄到唯一可路由局域网地址，挑不出则 0.0.0.0+门禁兜底。
  IPv6 段判定（fe80::/10、fc00::/7）与 CGNAT 位计算核对无误（C2/12/10 掩码均正确）。
  Tailscale 场景见 P3-5。
- **mDNS 修复（f11a88f）**：改动仅「显式选择组播网卡」（`discovery.ts` pickLanInterface），
  未引入 TXT 字段进信任决策的新路径——TXT 只提供 id 前缀/port/type/displayName，
  指纹比对仍只认 TLS 实际证书；服务名经 `sanitizeServiceName` 清洗（限 60、去特殊字符）。
- **剪贴板**：收与发双向都过 `hasScope(peerId,'clipboard')`（`host.ts:625/676`）；
  512KB 上限 + 回环抑制窗口（`clipboard.ts`）；配对默认授权范围扩为 `['file','clipboard']`
  且强制剔除 control（`pairing.ts:86/118-122`）；信任列表 UI 明示授权范围（App.vue:704）。
  开关持久化问题见 P2-2。
- **键鼠共享（input/，最大新增面）**：未信任设备的控制请求**直接拒绝、不弹窗**
  （`session.ts` 门禁一，注释明确「任意连接刷提示框本身是骚扰面」）；单会话槽 + 30s TTL
  （门禁二）；`input.event` 三重核对：活动会话存在 + peerId==会话对端 + sessionId 匹配
  （`onEvent`），事件解码字段白名单 + 数值钳制 + 非法整批拒绝（`protocol.ts`，含
  MAX_EVENTS_PER_MESSAGE=64、VK 0..255、坐标 ≤32768）；坐标双重收敛（mapPoint 钳进
  目标屏 + normalizeAbsolute 钳进 0..65535）；control 授权是会话级内存态，不落 TrustStore，
  撤销/断连/用户拔掉立即 endSession 并 releaseAll 防卡键（`session.ts:218-243`、
  `host.ts:788-792`）；被控端确认弹窗文案明示「授权仅本次会话有效」（App.vue:549）。
  控制端 accept/reject 均核对请求对端（`InputController.onAccepted/onRejected`）。
- **IPC/preload/渲染层**：新增 13 个 invoke 通道与 3 个事件全部在白名单内
  （`ipc.ts CHANNELS/EVENTS`），参数逐一类型校验（layout:save 校验字符串数组、
  input:setEdge 校验枚举、profile:rename 校验字符串）；文件路径仍不出主进程
  （transfer.accept 自上次审查起不外发 saveDir）；渲染层无 v-html/innerHTML，
  对端自报名均走插值。
- **生命周期（553b65d）**：菜单退出与标题栏 X 汇合到 `before-quit`：
  停剪贴板轮询/键鼠采集循环 → `globalShortcut.unregisterAll()`（防全局钩子残留劫持系统键）
  → `adapter.stopAll()`（scrcpy 进程清理）→ `host.stop()`（discovery/control/server 依次停、
  端口释放）→ `app.exit(0)`；`quitting` 标志防重入。
- **布局持久化（e6cfa48）**：layout.json 只存 serial 有序数组，无路径语义；写入经
  tmp+rename 原子替换；`layout:save` 校验后入 Store，无注入面。
- **NSIS/SBOM（a2b35f2）**：打包脚本与许可证清单，无运行时安全面（未逐行审）。

## 待证项 / 建议下一步

1. P0 的 Android 端行为：Android 作为发送方是否有等价「挂起补发」逻辑（本次只审了桌面端），
   若有需同步复查撤销交互。查法：`apps/android` 内 grep transfer.offer/等待补发相关实现。
2. 剪贴板 6.6 验收文档是否要求开关持久化（决定 P2-2 是「与文档不符」还是「产品决策」）：
   查 docs/ 验收清单第 6 组条目原文。
3. `INPUT_TICK_MS=12ms` 常驻采集循环的功耗/CPU 影响未在本次范围内（非安全项）。
