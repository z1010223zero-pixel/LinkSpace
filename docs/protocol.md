# LinkSpace 通信协议 v0（草案）

> 状态：**已实现主体**（2026-10-28）。以下标注 ⚠️ 的三处是相对草案的**有意修正**，
> 实现时发现原设计存在安全问题或语义错误，已在代码中改掉并在此记录原因。
> 兼容性承诺：v1 发布前不保证兼容，v1 之后按第 8 节的版本协商规则演进。

---

## 1. 传输层

| 通道 | 协议 | 说明 |
|---|---|---|
| 发现 | mDNS / DNS-SD，服务类型 `_linkspace._tcp` | TXT 记录不含任何身份密钥 |
| 控制 | WebSocket over TLS（wss） | 长连接，心跳保活 |
| 文件 | HTTPS over TLS，分块上传/下载 | 与控制通道共用端口与证书 |
| 媒体 | 第一版由 scrcpy 自有通道承载 | 不经过本协议，见 6.5 |

**证书策略**：每台设备启动时生成自签证书（或长期身份密钥对），不依赖公共 CA。信任通过**首次配对时的指纹确认**建立（TOFU），而非证书链验证。这是局域网无云场景下的现实选择，代价是需要用户参与一次确认——这正是方案 6.4 要求的流程。

---

## 2. mDNS TXT 记录

| 键 | 值示例 | 说明 |
|---|---|---|
| `ver` | `1` | 协议版本，无法解析时忽略该设备 |
| `id` | `dev_7f3a...` | 设备 ID 前缀（不广播完整 ID 以降低追踪性） |
| `port` | `51234` | 控制/文件服务端口 |
| `type` | `win` \| `android-phone` \| `android-tablet` | 设备类型 |
| `caps` | `file,clipboard,scrcpy` | 能力位集合 |
| `paired` | `0` \| `1` | 是否已与本设备配对过（供 UI 排序，不泄露身份） |

服务名建议形如 `LinkSpace-<displayName>._linkspace._tcp.local`，显示名需做字符过滤，避免注入非法 DNS 字符。

---

## 3. 消息信封

所有控制消息统一封装：

```json
{
  "v": 1,
  "type": "pair.request",
  "id": "3f2a1c9e-...",
  "from": "dev_7f3a...",
  "to": "dev_91bc...",
  "ts": 1761667200000,
  "payload": { }
}
```

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `v` | number | 是 | 协议版本 |
| `type` | string | 是 | 消息类型，见第 4 节 |
| `id` | string(uuid) | 是 | 消息唯一 ID，用于请求-响应关联与去重 |
| `from` / `to` | string | 是 | 设备 ID |
| `ts` | number | 是 | 毫秒时间戳，用于重放窗口判断 |
| `payload` | object | 否 | 各消息自定义 |

**校验规则**：接收方必须校验 `v` 可处理、`to` 为自身、`ts` 在 ±60s 窗口内、`from` 为已知或待配对设备。任一项失败即断开连接并记录告警。

> **实现现状（2026-10-30）**：`v` / `to` / `ts` 的信封级校验两端均未实现——当前防线是连接级身份门禁（announce 指纹锚定 + TLS 证书）与各消息处理器的来源核对。信封校验列为待办，不得据此声称已实现。

---

## 4. 消息定义

### 4.1 发现与配对

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `device.announce` | 双向 | `{ displayName, deviceType, caps, pubkeyFingerprint }` | 建立连接后首次发送，声明身份与能力 |
| `pair.request` | 发起方 → 接收方 | `{ displayName, deviceType, pubkeyFingerprint, pairingCode? }` | 配对码由接收方生成并展示 |
| `pair.challenge` | 接收方 → 发起方 | `{ expiresAt }` | 提示发起方「去要配对码」。⚠️ **不携带配对码本身**：配对码若经网络传输，任何能连上的人都可直接拿到，配对口令形同虚设。码只显示在接收方屏幕，由人工抄录到发起端 |
| `pair.approve` | 接收方 → 发起方 | `{ deviceId, trustScope }` | 用户确认后发送。⚠️ `deviceId` 是**发送方自己**的 id（让对端知道是谁批准的），不是被批准的设备 id |
| `pair.submit` | 发起方 → 接收方 | `{ code }` | 发起方提交人工抄录的配对码。码 60s 过期，错码累计 5 次断连（两端同款参数） |
| `pair.reject` | 接收方 → 发起方 | `{ reason }` | 用户拒绝或超时 |
| `pair.revoke` | 双向 | `{ deviceId }` | 撤销信任，立即生效。⚠️ `deviceId` 是**撤销方自己**的 id（让对端知道该删掉谁的信任条目）。⚠️ **来源校验**：接收方必须核对 `deviceId == from == conn.peerId`，且该连接的 TLS 证书指纹与信任条目一致；拿不到证书或指纹不符一律忽略。否则任何能连上控制通道的设备都能伪造撤销、定向删除第三方信任 |
| `pair.error` | 双向 | `{ code, message }` | 配对失败，code 见第 7 节 |
| `device.rename` | 双向 | `{ displayName }` | 本机改名后广播给已连接对端。⚠️ **来源校验**：仅当 `from` 在信任清单内才更新对应条目，陌生连接的改名请求一律忽略并告警——不给未认证连接改写本机状态的通道。改名方同步更新 mDNS 通告（服务名内嵌显示名，需注销重注册）并持久化，对端更新信任条目并持久化，两端重启后均保持 |

`trustScope` 显式列出本次授权的能力（如 `["file", "clipboard"]`），控制类能力默认不在其中，需二次授权。这实现了方案 2.2 的「单独管理每台设备的控制权限」。

**指纹锚定**（实现期定型）：announce / approve 载荷里的指纹是**自报**值，不能单独作为信任依据。双方在 TLS 连接建立后取对端证书的实际 SHA-256 指纹：

- 自报指纹与实际证书不符 → 立即断开（对方在声称自己不持有的身份）。
- 已信任设备重连时，实际证书指纹与信任条目不符 → 断开并告警（身份被替换或中间人），不允许该连接留在连接表里。
- 配对落库的指纹一律写**实际证书指纹**，自报值只作拿不到证书时的退路。
- 双向索证：客户端连出时出示本机证书，服务端以 requestCert 索取连入方证书，据此双向核验。对端无法出示证书的互操作场景，退化为自报指纹比对并记录告警。

### 4.2 连接维护

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `device.heartbeat` | 双向 | `{}` | 建议 5s 一次。payload 当前为空对象：`sessions` 会话摘要字段保留未实现（两端均发空对象，状态对账靠 session.* 消息本身），字段语义冻结为将来扩展预留 |
| `device.capabilities` | 双向 | `{ caps: [...] }` | 能力变更时推送（如开启无线 ADB） |
| `device.disconnect` | 双向 | `{ reason }` | 优雅断连，避免等待心跳超时 |

心跳连续 3 次（15s）无响应判定为 `offline`，触发状态机回落（见 architecture.md 5.2）。

### 4.3 会话控制

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `session.start` | 控制方 → 被控方 | `{ sessionType, params }` | `sessionType`: `scrcpy` / `input` / `display-extend` |
| `session.accept` | 被控方 → 控制方 | `{ sessionId }` | **用户确认后才发送** |
| `session.reject` | 被控方 → 控制方 | `{ reason }` | 拒绝，含未授权原因 |
| `session.stop` | 双向 | `{ sessionId, reason }` | 任一方均可终止 |
| `session.state` | 被控方 → 控制方 | `{ sessionId, state }` | 状态同步，见 architecture.md 5.3 |

### 4.4 剪贴板

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `clipboard.share` | 双向 | `{ kind, text }` | `kind` 目前只有 `text`。图片与文件走传输通道，不进剪贴板 |

**防循环（实现期修正）**：草案原定消息携带内容摘要 `digest`，由接收方比对「最后一次向外发送的摘要」来判定回环。实现时发现摘要比对解决不了真正的回环来源——**写入剪贴板到监听读到新值之间存在窗口**，窗口内读到的仍是旧内容，摘要比对会把它判成一次新的复制并再发一轮，A→B→A 的乒乓照样成立。

实际采用的机制是**写入后抑制窗口**：收到远端文本后写入本机剪贴板，并把自身标记为「500ms 内忽略一切本地变更」，且这段时间内**不更新基线**——更新基线会把旧值记成已知状态，窗口结束后读到的真值反而变成「变更」，回环只是被延后一轮。判定逻辑集中在 `apps/desktop/src/main/clipboard.ts`，不依赖 Electron，可被无头测试完整覆盖（`npm run verify:clipboard`）。

大小限制：文本默认 512 KiB，超出不发送并在日志留痕。

**授权**：`clipboard.share` 只有持有 `clipboard` 授权的对端才能收发。配对默认授予 `file` + `clipboard`，`control` 不在其中——剪贴板会经过密码与令牌，范围门禁不能省。

### 4.5 文件传输

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `transfer.offer` | 发送方 → 接收方 | `{ transferId, files: [{name, size, mime}], totalSize }` | 请求传输。⚠️ `transferId` 限定 `[A-Za-z0-9_-]{1,64}`（数据面 URL 与 `${id}:${name}` 组合键依赖该约束）；接收方只接受持有 file 授权设备发来的 offer |
| `transfer.accept` | 接收方 → 发送方 | `{ transferId, token }` | **用户确认保存路径后**发送。`token` 由接收方生成（randomUUID），是数据面唯一凭证；保存目录是本机路径，不出网 |
| `transfer.reject` | 接收方 → 发送方 | `{ transferId, reason }` | 拒绝或路径不可写 |
| `transfer.chunk` | 双向 | HTTP 分块体，非 WS 消息 | 见第 5 节 |
| `transfer.progress` | 接收方 → 发送方 | `{ transferId, receivedBytes }` | **保留未用**（2026-10-30 双端会签）：两端均未实现发送与消费，进度实际来自数据面 `committedOffset` 与 409 偏移对账。消息定义冻结保留，将来接收方需要主动节流上报时启用 |
| `transfer.complete` | 接收方 → 发送方 | `{ transferId, digests }` | 校验通过后发送。`digests` 是文件名 → 整体 SHA-256 的映射（多文件任务每文件一项） |
| `transfer.cancel` | 双向 | `{ transferId, reason }` | 取消，已写入部分按策略处理 |
| `transfer.error` | 双向 | `{ transferId, code, message }` | 失败，可重试的错误在 `code` 中标识 |

**消息来源门禁**（实现期定型）：`transfer.accept / reject / cancel / complete` 都必须核对「连接身份 == 任务对端」，不匹配一律忽略。传输任务的 id 与 token 只对当事双方可见，其他连接（包括其他已配对设备）不得对别人的任务做任何操作。文件名由发送方经网络提供，接收方必须先收敛为基础名（剥掉任何路径成分）再拼接保存路径，含非法名（清洗后为空 / `.` / `..`）直接拒绝整个 offer。

### 4.6 键鼠共享（阶段 3，第 7 组）

复用 4.3 的会话控制消息（`sessionType: 'input'`），在其上定义输入事件流：

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `session.start` | 控制方 → 被控方 | `{ sessionType: 'input', sessionId, params: { screen, displayName } }` | `sessionId` 限定 `[A-Za-z0-9_-]{1,64}`；`screen` 是控制端主屏尺寸（自报，仅作映射基准）；`displayName` 仅用于被控端确认弹窗展示 |
| `session.accept` | 被控方 → 控制方 | `{ sessionId, screen }` | **用户确认后才发送**。`screen` 是被控端屏幕尺寸，控制端据此做坐标映射 |
| `session.reject` | 被控方 → 控制方 | `{ sessionId, reason }` | 拒绝（未授权 / 参数非法 / 过期 / 已有活动会话） |
| `session.stop` | 双向 | `{ sessionId, reason }` | 任一方均可终止；两端各按 sessionId 匹配，不匹配的静默忽略 |
| `input.event` | 控制方 → 被控方 | `{ sessionId, events: [...] }` | `sessionId` 必须匹配活动会话，不匹配整批忽略。批量事件单条消息 ≤ 64 条（`MAX_EVENTS_PER_MESSAGE`），超限整批丢弃 |

单条事件形状（字段名取短，批量传输）：

- `{ t: 'move', x, y }` — **控制端屏幕绝对坐标**（整数 0..32768）。选绝对坐标而非相对增量：轮询采集天然只有绝对位置，且丢一帧不会造成永久偏移
- `{ t: 'down', b }` / `{ t: 'up', b }` — `b` ∈ `left / right / middle`
- `{ t: 'wheel', dx, dy }` — 滚轮刻度，钳 ±1000
- `{ t: 'key', vk, down }` — Windows 虚拟键码 0..255，布尔按下态

**收敛规则（实现期定型）**：`input.event` 的 payload 完全来自对端，而注入层直接对接 Win32 SendInput，因此编解码集中在 `apps/desktop/src/main/input/protocol.ts` 纯模块，无头测试逐字段钉死边界：

- **整批拒绝制**：一批事件中含任何非法事件（未知类型 / 非法字段 / 越界坐标 / NaN），整批丢弃而非逐条放行——「洗掉非法字段」不能变成可依赖的容错，否则攻击者可借机探测字段语义。
- **坐标映射在被控端**：`mapPoint` 按两端屏幕比例映射，round 后钳进目标屏幕边界。屏幕尺寸是自报的，不能让越界坐标进注入层。
- **三重校验**：注入前核对 `peerId == 会话对端`、`sessionId` 匹配活动会话、事件解码通过。旁观连接的事件一律忽略。

**授权语义（9.1）**：control 是**会话级内存态**——被控端 approve 后会话才算建立，结束/断连/撤销信任立即失效；TrustStore 不持久化 control（配对默认只授 `file` + `clipboard`），保证「每次控制请求都有明确提示」。所有终止路径（stop / 断连 / 撤销 / 本机终止）统一走 releaseAll 抬起全部按键，防止对端按键状态下会话被掐导致本机卡键。边缘穿越（7.1）由控制端本机光标位置驱动，触发后走的仍是同一条 `session.start` 链路，被控端照样弹确认。

### 4.7 屏幕投屏（阶段 4 前置，`screen.stream.*`）

> **[PROTOCOL] 2026-10-30 登记**（B-6）：桌面画面 → 平板的单向推流，**寄生在键鼠会话内**——没有活动 `input` 会话时一切投屏消息都被拒绝。视频数据不走本节消息，走键鼠控制连接（4.6）上的 **WS 二进制帧**（裸 H.264 Annex-B 字节流，复用平板连出的控制链路——实测平板对入站 TCP 全拒，唯有平板连出的链路可双向）。

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `screen.stream.request` | 控制端 → 被控端 | `{ display?: number, scaleWidth?: number }` | 请求开始投屏。前置：活动键鼠会话存在且 peerId 匹配、被控端 ffmpeg 可用，否则回 `error`。**`display` 省略时**：被控端单显示器直接按 0 号屏开流（免选择器）；多显示器回 `screen.stream.displays` 清单，由用户挑选后再带 `display` 重发本消息（自动重连带记住的索引时同样直连）。**`scaleWidth`**：目标视频宽度档位（1280/1920/2560/3840），省略时默认 1920；换分辨率会重启推流。**[PROTOCOL] 2026-11-01 登记**（用户要求画质/延迟可切换） |
| `screen.stream.displays` | 被控端 → 控制端 | `{ displays: [{ x, y, w, h }] }` | 多显示器清单（虚拟屏坐标），控制端弹选择器。**[PROTOCOL] 2026-10-31 登记**（ToDesk 式多屏选择，用户提出） |
| `screen.cursor` | 被控端 → 控制端 | `{ x, y, w, h }` | 物理光标坐标广播（region-local 像素 + 区域尺寸，33ms 限流），控制端本地绘制光标覆盖层（采集 draw_mouse=0 不含光标）。**[PROTOCOL] 2026-10-31 登记**（开源方案同款：光标本地画，与采集解耦） |
| `screen.stream.start` | 被控端 → 控制端 | `{ w, h, scaleWidth }` | 推流开始。`w/h` 是被控端虚拟屏全景尺寸（触控换算基准之一；实际流分辨率以流内 SPS 为准，平板按其 letterbox 等比渲染）；`scaleWidth` 是当前档位。**[PROTOCOL] 2026-11-01 登记** |
| `screen.stream.stop` | 双向 | `{}` | 停止投屏（控制端取消 / 被控端 ffmpeg 意外退出时通知对端清 UI）。会话结束（session.stop/断连）隐式终止投流，不发本消息 |
| `screen.stream.error` | 被控端 → 控制端 | `{ message }` | 投屏失败回告（无会话 / 缺 ffmpeg / 启动失败） |

**视频帧通道**：被控端 ffmpeg（gdigrab 抓屏 → libx264 baseline → Annex-B stdout）的字节块以 WS 二进制帧（opcode 0x2）经控制连接发出；控制端逐块喂硬件解码器。帧无序号、无确认——丢帧表现为画面短暂停滞，等下一个 IDR 恢复（`-g 30` 即 1s 一个 IDR）。

**授权语义**：投屏是键鼠会话的衍生能力——`session.start` 被批准即含画面查看；`session.stop`/断连/撤销信任终止投流。不新增独立授权位。

### 4.8 投屏粘贴（`screen.paste`）

> **[PROTOCOL] 2026-10-30 登记**（B-7）：投屏场景下平板向被控端粘贴文本。背景：键盘通道按 Windows 虚拟键码注入，IME 组合输入（中文等）无法经 vk 通道表达（vk=0 的事件被丢弃）。

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `screen.paste` | 控制端 → 被控端 | `{ text }` | 将文本写入被控端剪贴板并向前台注入 Ctrl+V。**前置：活动键鼠会话存在且 peerId 匹配**（寄生 input 会话授权，不新增授权位） |

**被控端语义**：收到后 `clipboard.writeText(text)`（Electron 剪贴板，会话内存态，不落盘）→ 注入 Ctrl+V（走 4.6 的注入层）。文本上限 512 KiB（与 4.4 剪贴板一致），超限丢弃并留痕（粘贴失败由控制端分小段重试）。

---

## 5. 文件传输子协议

控制消息走 WebSocket，文件数据走同一 TLS 端口上的 HTTPS 路由，避免大块数据阻塞控制消息。

```
POST   /linkspace/v1/transfer/:transferId/chunk?offset=N
       Body: 原始字节流
       Header: X-Chunk-Size, X-Chunk-Digest
GET    /linkspace/v1/transfer/:transferId/chunk?offset=N&length=M
       （用于从对方拉取文件）
```

流程（对应方案 6.3）：

1. 发送方 `transfer.offer`，携带文件清单与总大小。
2. 接收方展示确认 UI（保存路径 + 覆盖提醒），用户确认后 `transfer.accept`。
3. 发送方按固定块大小（默认 4 MiB）顺序推送，块级校验。
4. 接收方校验每块摘要，落盘。进度不走控制消息回报（`transfer.progress` 保留未用，见 4.5），发送方以数据面写入确认与偏移探针对账推进。
5. 全部完成且整体摘要匹配 → `transfer.complete`。
6. 任一方 `transfer.cancel` 或连接中断 → 进入恢复流程。

**恢复**：接收方记录已确认的连续偏移 `committedOffset`。重连后从该偏移继续，无需重传整个文件。断点信息仅存于内存 + 传输临时目录，不写敏感历史。

**已实现的补充规则**（实现中定型）：

- 空体 POST 到 chunk 路由视为**偏移探针**，只回报 `committedOffset`，不写盘。
  发送方据此从断点继续，而不是从 0 重传。
- 接收方校验 `offset === 已写入字节`，不符返回 **409** 并带上当前偏移。
  直接追加会静默产生损坏文件，必须让发送方重新对齐。
- **数据面鉴权**：每个请求必须带 `X-Device-Id` 与 `X-Transfer-Token`，
  接收方核对「设备在信任清单且持有 file 授权」+「token 与该任务匹配」
  两道闸。token 在 `transfer.accept` 时由接收方生成，把每台已配对设备
  限制在它自己的任务里——没有 token 门禁，任何已配对设备都能探测并
  污染其他任务的 `.part`。
- **块级摘要必须校验**：非空 POST 必须携带与 body 一致的
  `X-Chunk-Digest`（SHA-256 hex），不符返回 **400** 由发送方重传该块；
  缺头视为非法请求。
- **请求体上限**：单块 POST 体上限 32 MiB，超出返回 **413**；
  GET 的 `length` 上限同为 32 MiB。
- **取消与写入不竞态**：同一任务的分块写入串行化，取消时先摘除任务
  路由、等在途写入排空，再删 `.part`（Windows 上打开中的句柄会让
  删除进入 delete-pending，留下「已取消但 .part 还在」的残局）。
- `transfer.complete` 携带每个文件的整体 SHA-256（文件名 → 摘要），
  接收方 `finalize` 前比对；大小或摘要不符一律删除 `.part` 并报错。
- `finalize` 拒绝 `cancelled` / `failed` 状态的任务：取消与完成几乎同时
  发生时 complete 可能乱序到达，此时不能把半成品变成正式文件。
- **配对请求挂起上限**：同时挂起的 `pair.request` 超过 8 个即返回
  `RESOURCE_BUSY`——配对请求不需要任何前置授权就能发起，没有上限
  的话任意连接都能刷出配对码污染接收方 UI。

**覆盖策略**：同名文件默认重命名（`name (1).ext`），显式询问后才覆盖。不允许静默覆盖。

---

## 6. 与 scrcpy 的关系

本协议**不承载** scrcpy 的视频与输入流。scrcpy 经 adb 隧道自行通信，LinkSpace 只负责：

- 决定是否启动、以何参数启动；
- 监听进程生命周期；
- 把启动/停止/异常映射为本协议的 `session.*` 消息，供跨设备状态同步。

理由：过早把媒体流并入自研协议会同时引入编解码、延迟优化和输入注入三项风险，与方案 7.1「先验证功能闭环」相悖。

媒体通道是否统一（含 WebRTC），留待扩展屏幕验证阶段决策（architecture.md 第 9 节问题 3）。

---

## 7. 错误码

| code | 含义 | 可重试 |
|---|---|---|
| `AUTH_REQUIRED` | 未配对或授权不足 | 否，需用户操作 |
| `NOT_TRUSTED` | 信任已撤销 | 否 |
| `SCOPE_DENIED` | 能力不在授权范围内 | 否，需重新授权 |
| `VERSION_MISMATCH` | 协议版本不兼容 | 否 |
| `RESOURCE_BUSY` | 已有同名会话在跑 | 是 |
| `TRANSFER_IO` | 读写失败 | 是 |
| `TRANSFER_DIGEST` | 校验失败 | 是（重传该块） |
| `DEVICE_OFFLINE` | 目标不可达 | 是 |
| `INTERNAL` | 未分类 | 否 |

错误码稳定不变，文案可随语言变化。UI 只依赖 code。

---

## 8. 版本兼容

- `v` 为主版本号。主版本不同 → 拒绝连接并提示升级，不做降级协商（第一版无存量用户，复杂度不划算）。
- 同一主版本内：新增消息类型 → 接收方忽略未知 `type`；`payload` 新增字段 → 可选，缺失时用默认值。
- 移除字段或变更语义必须提升主版本。
- 每条消息都要能被安全忽略：不得设计「必须响应否则状态错乱」的消息。
