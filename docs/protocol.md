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

---

## 4. 消息定义

### 4.1 发现与配对

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `device.announce` | 双向 | `{ displayName, deviceType, caps, pubkeyFingerprint }` | 建立连接后首次发送，声明身份与能力 |
| `pair.request` | 发起方 → 接收方 | `{ displayName, deviceType, pubkeyFingerprint, pairingCode? }` | 配对码由接收方生成并展示 |
| `pair.challenge` | 接收方 → 发起方 | `{ expiresAt }` | 提示发起方「去要配对码」。⚠️ **不携带配对码本身**：配对码若经网络传输，任何能连上的人都可直接拿到，配对口令形同虚设。码只显示在接收方屏幕，由人工抄录到发起端 |
| `pair.approve` | 接收方 → 发起方 | `{ deviceId, trustScope }` | 用户确认后发送。⚠️ `deviceId` 是**发送方自己**的 id（让对端知道是谁批准的），不是被批准的设备 id |
| `pair.reject` | 接收方 → 发起方 | `{ reason }` | 用户拒绝或超时 |
| `pair.revoke` | 双向 | `{ deviceId }` | 撤销信任，立即生效。⚠️ `deviceId` 是**撤销方自己**的 id（让对端知道该删掉谁的信任条目）。⚠️ **来源校验**：接收方必须核对 `deviceId == from == conn.peerId`，且该连接的 TLS 证书指纹与信任条目一致；拿不到证书或指纹不符一律忽略。否则任何能连上控制通道的设备都能伪造撤销、定向删除第三方信任 |
| `pair.error` | 双向 | `{ code, message }` | 配对失败，code 见第 7 节 |

`trustScope` 显式列出本次授权的能力（如 `["file", "clipboard"]`），控制类能力默认不在其中，需二次授权。这实现了方案 2.2 的「单独管理每台设备的控制权限」。

**指纹锚定**（实现期定型）：announce / approve 载荷里的指纹是**自报**值，不能单独作为信任依据。双方在 TLS 连接建立后取对端证书的实际 SHA-256 指纹：

- 自报指纹与实际证书不符 → 立即断开（对方在声称自己不持有的身份）。
- 已信任设备重连时，实际证书指纹与信任条目不符 → 断开并告警（身份被替换或中间人），不允许该连接留在连接表里。
- 配对落库的指纹一律写**实际证书指纹**，自报值只作拿不到证书时的退路。
- 双向索证：客户端连出时出示本机证书，服务端以 requestCert 索取连入方证书，据此双向核验。对端无法出示证书的互操作场景，退化为自报指纹比对并记录告警。

### 4.2 连接维护

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `device.heartbeat` | 双向 | `{ sessions: [...] }` | 建议 5s 一次，携带会话摘要用于状态对账 |
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
| `clipboard.update` | 双向 | `{ kind, digest, size, payload? }` | `kind`: `text` / `image`（图片为 P1） |

**防循环**：消息携带内容摘要 `digest`（SHA-256 前 16 字节）。接收方若发现摘要与本地最后一次**向外发送**的摘要相同，则丢弃，不回写。同时维护最近 N 条摘要的滑动窗口，避免 A→B→A 的乒乓。这是方案 10 中「文本同步不产生无限循环」验收项的直接实现。

大小限制：文本默认 1 MiB，超出不发送并提示用户，防止意外粘贴大段内容刷屏。

### 4.5 文件传输

| 类型 | 方向 | payload | 说明 |
|---|---|---|---|
| `transfer.offer` | 发送方 → 接收方 | `{ transferId, files: [{name, size, mime}], totalSize }` | 请求传输。⚠️ `transferId` 限定 `[A-Za-z0-9_-]{1,64}`（数据面 URL 与 `${id}:${name}` 组合键依赖该约束）；接收方只接受持有 file 授权设备发来的 offer |
| `transfer.accept` | 接收方 → 发送方 | `{ transferId, token }` | **用户确认保存路径后**发送。`token` 由接收方生成（randomUUID），是数据面唯一凭证；保存目录是本机路径，不出网 |
| `transfer.reject` | 接收方 → 发送方 | `{ transferId, reason }` | 拒绝或路径不可写 |
| `transfer.chunk` | 双向 | HTTP 分块体，非 WS 消息 | 见第 5 节 |
| `transfer.progress` | 接收方 → 发送方 | `{ transferId, receivedBytes }` | 节流推送（≥200ms） |
| `transfer.complete` | 接收方 → 发送方 | `{ transferId, digests }` | 校验通过后发送。`digests` 是文件名 → 整体 SHA-256 的映射（多文件任务每文件一项） |
| `transfer.cancel` | 双向 | `{ transferId, reason }` | 取消，已写入部分按策略处理 |
| `transfer.error` | 双向 | `{ transferId, code, message }` | 失败，可重试的错误在 `code` 中标识 |

**消息来源门禁**（实现期定型）：`transfer.accept / reject / cancel / complete` 都必须核对「连接身份 == 任务对端」，不匹配一律忽略。传输任务的 id 与 token 只对当事双方可见，其他连接（包括其他已配对设备）不得对别人的任务做任何操作。文件名由发送方经网络提供，接收方必须先收敛为基础名（剥掉任何路径成分）再拼接保存路径，含非法名（清洗后为空 / `.` / `..`）直接拒绝整个 offer。

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
4. 接收方校验每块摘要，落盘，节流回报 `transfer.progress`。
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
