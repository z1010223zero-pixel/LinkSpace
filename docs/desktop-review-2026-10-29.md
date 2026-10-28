# 桌面端代码审查与修复报告（2026-10-29）

> 审查范围：`apps/desktop` 全部主进程 / preload / 渲染层代码（约 5300 行），
> 重点关注传输、配对、控制通道三个安全敏感面。
> 修复分支：`fix/desktop-review-20261029`。验证结论见文末第 4 节。

---

## 1. 结论摘要

代码整体质量高：分层清晰、注释带设计依据、信任边界意识强。但审查发现
**4 处「文档宣称的安全机制实际未生效」、1 处路径穿越、1 处主流程必坏的
UI bug**，以及若干加固项。本次全部修复并通过四组无头验证。

| 级别 | 数量 | 已修复 | 遗留 |
|---|---|---|---|
| P0（可写任意路径） | 1 | 1 | 0 |
| P1（安全机制失效 / 主流程必坏） | 4 | 4 | 0 |
| P2（功能 / 治理缺口） | 5 | 5 | 0 |
| P3（加固项） | 9 | 8 | 1（见 3.10） |

---

## 2. 问题清单与修复方式

### 2.1 P0 —— 文件名路径穿越（任意路径写入）

**问题**：`transfer.offer` 的 `files[].name` 由发送方任意提供，
`TransferManager.accept()` 直接 `join(saveDir, name)`，全程无收敛
（`basename` 仅用于日志）。已配对设备发送 `..\..\Users\x\Desktop\evil.exe`
即可把写入点挪到保存目录之外。

**修复**：
- `chunker.ts` 新增 `sanitizeFileName()`：按 `\` 与 `/` 双分隔符手工切分
  （不依赖本机 `path.basename` 的平台语义），清洗后为空 / `.` / `..` 直接
  抛错拒绝整个 offer，并截断到 255 码元。
- `manager.offer()` 入口对两个方向统一清洗（发送方向幂等）；文件数上限
  512、单个 size 必须为有限非负数。
- `host.ts` 的 offer 处理器在清洗失败时回发 `transfer.reject`，
  发送方不会干等超时。

### 2.2 P1 —— pair.revoke 无来源校验（未认证即可撤销任意信任）

**问题**：`handlePairRevoke` 直接取 `payload.deviceId ?? from` 调
`trust.revoke()`，不核对来源。控制通道 WS 升级无认证，任何局域网设备
都能定向删除本机对第三方的信任——Android 端 deviceId 就是证书指纹前
12 位，而它明文写在 mDNS TXT `id` 里，纯局外人即可精准瞄准。

**修复**（`pairing.ts`）：撤销消息必须同时满足
1. `payload.deviceId == msg.from == conn.peerId`（撤销方只能撤销自己）；
2. 若目标在信任清单中，连接的 TLS 证书指纹必须与信任条目一致，
   拿不到证书或不符一律忽略。

### 2.3 P1 —— 数据面 token 从未校验（门禁形同虚设）

**问题**：`server.ts` 只检查 `X-Transfer-Token` 头**存在**，从不比对值；
`TransferManager.verifyToken()` 是零调用死代码。任何已配对设备都能探测
（空体探针回报 committedOffset）并污染其他任务的 `.part`、按块读取发送方
源文件。

**修复**：
- `TransferRouteContext.isKnownDevice` 替换为
  `verifyTransfer(transferKey, deviceId, token)`，由 Host 接线为
  「信任清单 + file 授权 + token 匹配」三合一闸门，每请求必查。
- `manager.verifyToken()` 改为从数据面组合键 `${id}:${name}` 的首个冒号
  前缀解析任务 id（offer 的 transferId 限定 `[A-Za-z0-9_-]{1,64}`，
  保证切分无歧义）。

### 2.4 P1 —— TLS 指纹从未锚定到会话（配对码防不了中间人）

**问题**：全部客户端 `rejectUnauthorized: false`，仓库无任何
`getPeerCertificate` 调用；信任清单存的指纹来自 announce **自报字段**。
主动 MITM 可同时终止两侧 TLS、原样转发配对仪式，信任照样建立到中间人。

**修复**（`control/node.ts` + `pairing.ts`）：
- 双向索证：数据面服务端 `requestCert: true`；`ControlNode.connect`
  出示本机证书；`Connection` 新增 `tlsFingerprint`（SHA-256，去冒号小写）。
- announce 三道闸：自报指纹与实际证书不符 → 断开；已信任设备重连时
  实际证书与信任条目不符 → 断开（且不再注册进 peers 表）；
  通过后才登记身份。
- 配对落库指纹一律写**实际证书指纹**，自报值只作拿不到证书时的退路。
- `handlePairApprove` 的 scope 按白名单过滤（原先直接 `as` 断言，
  恶意 approve 可塞入未经授权的 control 能力位）。

**局限**（记录在 protocol.md）：对端无法出示证书的互操作场景退化为
自报指纹比对并记告警。

### 2.5 P1 —— connectionFor 永不匹配（UI 提交配对码必失败）

**问题**：按 `serviceName.includes(peerId.slice(0,12))` 找连接，但服务名
实际是 `LinkSpace-<型号/显示名>`，不含 deviceId 前缀。无头测试全部直连
`submitCode(conn, ...)` 绕过了该函数，故测试是绿的。真实 UI 流程中
发起方提交配对码必然得到「连接不存在」。

**修复**（`host.ts`）：新增 `serviceConns`（服务名 → 连接），
`connect()` 时登记、连接关闭时清理；`connectionFor()` 优先直查，
保留前缀匹配作直连注入场景的兜底。

### 2.6 P2 —— 块级摘要校验缺失（与协议文档不符）

**问题**：`manager.ts` 注释宣称「对端只认带正确摘要的块」，但 POST 路由
不校验任何块摘要，重试循环只重试传输错误；协议文档第 5 节早已规定
`X-Chunk-Digest` 必填。

**修复**：`sendChunk` 发送 `X-Chunk-Digest`；服务端对非空 body 强制校验，
不符返回 400（发送方现有重试循环即对其生效，坏字节不再落盘）。

### 2.7 P2 —— 多文件进度跳变

**问题**：`push()` 按当前文件进度覆盖 `task.transferred`，且完成单个文件时
按「其余文件大小求和」计算——把尚未开始的文件也计入，3 文件任务传完第 1 个
即显示 100%。

**修复**：引入 `completedBytes` 累加器；文件内进度 = 已完成字节 + 当前偏移，
文件完成后累加。单文件场景数值不变（验证脚本断言仍通过）。

### 2.8 P2 —— 接收方 UI 无法接受传输

**问题**：`transfer:acceptFor` 在 IPC 白名单里注册了 handler，但 preload 未
暴露、`App.vue` 无任何接受入口，收到的 offer 永远停在「等待确认」。

**修复**：新增 `transfer:accept` IPC（保存目录由主进程弹窗选择，
渲染层只传任务 id，遵循「文件选择放主进程」的既有约定）；
preload 与 `LinkSpaceApi` 补齐 `acceptTransfer(id)`；
`App.vue` 传输列表对 `receive + offered` 状态展示「选择位置接收」按钮；
顺带修正页脚残留的「设备发现与配对尚未实现」过期文案。

### 2.9 P2 —— 指纹不符的连接不断开 / 未认证消息可刷 UI

**问题**：announce 指纹不符仅告警，连接仍占着被冒用设备的 peers 表位；
配对请求无上限，任意连接可无限刷配对码污染接收方 UI。

**修复**：指纹不符改为断开（并入 2.4 的闸门）；`pair.request` 挂起上限
8 个，超出返回 `RESOURCE_BUSY`；`transfer.offer` 增加「必须已声明身份 +
持有 file 授权」门禁，未授权直接回 `transfer.reject`；
`transfer.accept/reject/cancel/complete` 一律核对
「连接身份 == 任务对端」——伪造 complete 删别人 `.part` 之类的旁路全部关闭。
相关规则已回写 `docs/protocol.md` 4.1 / 4.5。

### 2.10 P3 加固项

1. **POST 体积上限** 32 MiB（413）+ GET `length` 上限 32 MiB + 非法数值 400。
2. **decodeURIComponent 防御**：畸形百分号编码返回 400，不再逃逸成
   unhandledRejection。
3. **acceptTransfer 不再外发 saveDir**（`transfer.accept` 载荷改为
   `{ transferId, token }`，已同步 protocol.md；Android 端作为接收方
   只组合该消息、不解析，无兼容影响）。
4. **重复 announce handler 移除**：`startControl` 里的注册与 `startPairing`
   重复（注释自己声明「必须注册在后」），只留后者。
5. **监听地址自动收窄**：`LINKSPACE_BIND_IP` > 唯一非内部 IPv4 > 0.0.0.0
   （多网卡时保留全监听并在日志提示，安全由 TLS + 信任清单兜底）。
   README 挂账的「仅绑定局域网网卡」在此落地为可解释的折中。
6. **scrcpy 定位**：`Binaries` 新增 `scrcpyFound` 权威判定，修复
   「只找到 adb 时以 adb 路径冒充 scrcpy、existsSync 防线被击穿、
   UI 显示已就绪」的问题。
7. **scrcpy 启动参数清洗**：IPC 传入的数值/字符串字段按类型校验，
   `--max-size=NaN` 之类不再直通 scrcpy。
8. **will-navigate 守卫**：渲染层导航一律拦截，外链交系统浏览器；
   `sandbox: false` 补注原因（ESM preload 不支持沙箱）。

### 2.11 附带发现：取消与写入竞态（e2e 暴露）

修复过程中端到端测试暴露了一个此前被 4 MiB 块摘要校验放大的竞态：
取消删除 `.part` 时若有分块写入在途，Windows 上句柄未关会导致删除进入
delete-pending，出现「已取消但 .part 还在」。修复：分块写入经
`TransferManager.appendIncoming()` 串行化并在锁内重查任务存在性；
取消先摘除路由、等在途写入排空、再删文件。三次重复 e2e 均稳定通过。

---

## 3. 有意行为变更（需要知道的）

| 变更 | 影响 |
|---|---|
| 数据面强制 `X-Chunk-Digest` | 旧实现的对端发送方（若有）必须补发摘要头；Android 端目前只做接收方，不受影响 |
| `transfer.accept` 不再携带 saveDir | 协议字段变化，已回写 protocol.md；Android 端不解析该字段 |
| announce/approve 指纹与证书不符即断开 | 证书轮换后需撤销重配对（与威胁模型 T1 一致） |
| 未授权设备的 offer 直接 reject | 此前会创建任务，现在拒绝并回发消息 |
| verify-pairing 不再启动数据面服务 | 配对测试本就不用数据面，原先靠 0.0.0.0/127.0.0.1 双绑定共端口的巧合已移除 |

## 4. 验证结论

| 套件 | 覆盖 | 结果 |
|---|---|---|
| `npm run typecheck` | 全仓类型 | 通过（0 错误） |
| `npm run verify`（entry） | adb 枚举、scrcpy 会话启停/并发拒绝/清理 | 全部通过（3 台真机在线） |
| `npm run verify:transfer` | 内容一致性 / 特殊文件名 / 不覆盖 / 多块 / 断点续传 / 取消清理 / 鉴权拒绝 / 并发 | 全部通过（含重复运行） |
| verify-pairing | 连接身份 / 配对码正误 / 撤销传播 | 全部通过 |
| verify-e2e | 发现 → 配对 → 传输 → 取消 → 撤销，全真实路径 | 全部通过（含重复运行） |

## 5. 遗留与后续建议

1. **`0.0.0.0` 多网卡回落**：本机检测到 4 个非内部 IPv4（含 Tailscale /
   链路本地地址），保持全监听；正式分发前应考虑让用户在 UI 里选择网卡。
2. **Android 端未纳入本次审查**（未提交的在途工作）。Android 成为发送方时
   需补 `X-Chunk-Digest` 头与 `transferId` 字符集约束。
3. 在线配对码爆破（每连接 5 次 × 无限连接）仍属可接受风险；若要收紧，
   可按远端地址做指数退避。
4. `GET` 下载方向（resolveOutgoing）目前无调用方，token 门禁已就位，
   后续启用无需再改。
