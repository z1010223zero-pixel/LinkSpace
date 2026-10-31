# LinkSpace Android 客户端审查报告

- 日期：2026-10-29（Android 端首次审查）
- 范围：`apps/android/` 全部 Kotlin 源码（11 个文件）+ `AndroidManifest.xml` + `app/build.gradle.kts` + `gradle/libs.versions.toml`；对照 `docs/protocol.md`、`docs/threat-model.md`、`docs/desktop-review-2026-10-29.md` 与桌面端 `apps/desktop/src/main/`（用于确认「协议现状」，不评审桌面端）
- 方法：只读审查，全部结论落到 file:line；未运行构建/测试（基线由主会话负责）
- 分级：P0=可利用的安全漏洞或安全机制失效；P1=主流程必坏或信任边界绕过；P2=功能缺陷/与协议文档不符；P3=加固建议

## 结论摘要

Android 端功能链路完整（发现→配对→收发文件→剪贴板），数据面的 token/偏移/落盘策略与桌面端对齐良好，**上次审查遗留的「Android 发送方补发 digest 头」已完成**（LinkSpaceClient.kt:130）。但**上次审查确立的三大信任机制在 Android 端整体缺席**：TLS 指纹锚定（客户端方向盲信任所有证书、服务端方向不索证）、pair.revoke 来源校验、任务对端绑定，全部建立在可伪造的自报 `from` 字段上，构成可利用的 P0 链。另有未认证远程 DoS（先读体后鉴权、无长度上限）、接收文件名不收敛（路径穿越）、配对码可穷举三处 P1，以及发送方 URL 不编码导致含空格/中文名文件必发送失败的主流程缺陷。整体判断：Android 端尚未达到桌面端 2.4 修复后的安全基线，P0/P1 修复前不建议与桌面端配对投产。

---

## P0

### P0-1 Android 作为发送方：TLS 盲信任所有证书，无任何指纹锚定

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceClient.kt:41-46,53,58`
- 证据：
  ```kotlin
  private class BlindTrust : X509TrustManager {
      override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
      override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
  ```
  `:53` `ctx.init(kmf.keyManagers, arrayOf<TrustManager>(BlindTrust()), null)`；全文件无一处读取 `ssl.session().peerCertificates`。注释自称「证书校验刻意宽松……这不是疏忽」（:35-38），但 TOFU 的「核对指纹」环节在客户端方向完全缺失——既不取证书、也不与 TrustStore 条目比对。
- 影响控制通道 `connectControl`（:63-99）承载 announce/offer/**accept+token**/complete：ARP 欺骗或假 mDNS 把 `peer.host` 指向攻击者后，攻击者以任意自签证书终结 TLS，即可伪装桌面端回 `transfer.accept`，截获文件全文、手机身份指纹与数据面 token。威胁模型 T3 要求「自签证书 + 指纹绑定，连接时校验指纹与持久化值一致，不一致即断开」；桌面端 2.4 修复后已在 `control/node.ts` 出示证书并在 `pairing.ts:347-369` 做自报/实际指纹三道闸（不符 `conn.close(4006)`）。Android 单方面放弃这道闸，双向通道中最薄弱的一环。上传连接 `connectUpload`（:102-110）同样盲信任（桌面端数据面客户端 `rejectUnauthorized: false` 也被桌面审查 2.4 列为问题，不应复制）。
- 修复方向：握手后取 `session.peerCertificates[0]` 计算 SHA-256（Identity.fingerprintOf 同算法），与 TrustStore 中目标设备条目比对，不符即断开并告警；上传连接同样锚定；首次连接（未配对）场景由 UI 呈现对端指纹供人工核对。

### P0-2 服务端不索证、身份=自报 `from`，且 accept/token 全连接广播 → 未认证攻击者可冒充已配对设备

- 位置：
  - `apps/android/app/src/main/java/cn/linkspace/client/service/TransferServer.kt:66` —— `ctx.init(kmf.keyManagers, null, null)`，无 `setWantClientAuth/setNeedClientAuth` 调用：从不向连入方索要证书，TLS 层没有对端身份；
  - `TransferServer.kt:399` —— `if (from.isNotEmpty()) controlPeerIds[conn] = from`：连接身份 = 消息里自报的 `from`，无任何校验；
  - `TransferServer.kt:406-412` —— `sendControl` 把消息发给**所有** `controlConns`（任何完成 WS 升级的连接都在内，无认证状态之分）；
  - `LinkSpaceService.kt:752-770` —— `acceptTransfer` 经 `sendControl` 广播 `transfer.accept`，payload 含 **token**（:770），信封 `to` 字段暴露任务对端**完整 deviceId**（:766 `put("to", peer)`）；
  - `LinkSpaceService.kt:242-244` —— `Protocol.TYPE_PAIR_REVOKE -> { trust.revoke(from)`：无来源校验。协议 §4.1 ⚠️ 明确要求「接收方必须核对 `deviceId == from == conn.peerId`，且该连接的 TLS 证书指纹与信任条目一致」；桌面端 `pairing.ts:532-556` 已逐条实现（`deviceId !== msg.from || deviceId !== conn.peerId` 拒绝 + `conn.tlsFingerprint` 与信任条目比对），Android 缺失。
- 攻击链（同网段未认证设备，全部步骤只用公开行为）：
  1. 向手机端口发起 WS 升级（`TransferServer.kt:236-256` 对任意 Upgrade 直接 101，无前置鉴权），保持连接；
  2. 手机用户在桌面端发起的传输上点「接收」→ `transfer.accept`（含 token、`to`=桌面完整 deviceId）**广播**到攻击者连接；
  3. 攻击者此后以该 deviceId 作 `from`/`X-Device-Id`：数据面闸门 `trust.isKnown(deviceId) && hasScope(deviceId,"file")`（`TransferServer.kt:273`）与 token 比对（:297）全部通过 → 可 **GET 读取他人在收文件的分块内容**、POST 污染；
  4. 发 `pair.revoke`（from=该 deviceId）→ 本机对该桌面端的信任被无条件删除 → 触发重配对，为假 mDNS 诱导配对铺路（配合 T1）；
  5. 剪贴板：以冒充的 deviceId 自报 `from` 后，`broadcastClipboard`（`LinkSpaceService.kt:494-505`）按 `hasScope(peerId,"clipboard")` 命中冒充身份 → 手机侧外发的剪贴板文本（常含密码/令牌，威胁模型 A3）定向送达攻击者。
- 修复方向：服务端 `SSLServerSocket` 开启 wantClientAuth/needClientAuth；announce 三道闸（自报指纹≠实际证书断开、已信任设备重连证书不符断开、通过才登记）；`accept` 改为定向发送（桌面端 `host.ts:458` 用 `conn?.send(...)` 只发任务对端连接）；`pair.revoke` 移植桌面端 `pairing.ts:532-556` 的双校验；`onControlMessage` 把 `conn` 传入 handler（现签名 `TransferServer.kt:395-402` 只有 msg），任务类消息绑定 `conn.peerId`。

### P0-3 未认证远程 DoS：请求体按 Content-Length 预分配、头行无界，均在鉴权之前

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/TransferServer.kt:560` —— `val body = ByteArray(contentLength)`（`HttpRequest.read` 在 `handleRequest` 做任何鉴权**之前**完整读体）；`:533-545` `readLine` 逐字节拼 `StringBuilder`，长度无界；`handleConnection`（:226-247）只有 try/finally 无 catch，`OutOfMemoryError` 沿线程抛出即触发 Android 默认 uncaught handler **杀死整个进程**。
- 证据：`contentLength` 取自请求头 `toIntOrNull()`，最大 2^31-1（约 2GB）——单个 `POST /whatever` 请求即可触发 OOM；一条 100MB 的头行同理。协议 §5 要求「单块 POST 体上限 32 MiB，超出返回 413」，Android 数据面完全未实现。
- 影响：同网段任何设备、无需配对、单个报文即可令应用崩溃（发现/配对/传输/剪贴板全部不可用，且可反复触发）。`:249-253` 每连接一线程也无上限，可叠加线程耗尽。
- 修复方向：解析头后先鉴权、再按上限读体；头行限长（如 32KB）；体上限 32MiB 超出 413；并发连接数与每连接请求速率设上限。

---

## P1

### P1-4 接收文件名不收敛基础名 → 路径穿越写 / 接收必崩

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/TransferServer.kt:97` `val finalPath = uniqueFile(saveDir, f.name)`；`:437` `val direct = File(dir, name)` —— `name` 直接来自 offer 网络数据，无任何清洗；`LinkSpaceService.kt:719-735`（handleOffer）与 `:744`（registerIncoming）也不校验。`.part` 路径 `File(finalPath.parentFile, ".${finalPath.name}.linkspace.part")`（:98）与 `appendBytes`（:344）、`renameTo`（:186）全部沿用越界路径。
- 影响：
  - `name = "../../x"` 时 `.part` 创建/追加/改名都落在保存目录之外。minSdk 26（build.gradle.kts:16），API 26–28 设备 + 已授权 `WRITE_EXTERNAL_STORAGE`（manifest:11-13 为旧设备保留）下可写 `/storage/emulated/0` 任意位置（覆盖其他应用文件）；API 10+ 仍可在 app 专属外部目录树内任意位置创建/覆盖。
  - `name` 含 `/`、`.`、空名等非法值时 `createNewFile()`（:99）抛 IOException，`acceptTransfer`（`LinkSpaceService.kt:738-748`）无捕获 → 用户点「接收」即崩溃。
- 对照：协议 §4.5「接收方必须先收敛为基础名（剥掉任何路径成分）再拼接保存路径，含非法名（清洗后为空 / `.` / `..`）直接拒绝整个 offer」；桌面端已实现（desktop-review 确立机制之一）。
- 修复方向：registerIncoming 入口对 name 取最后一段路径成分、拒绝空/`.`/`..`/控制字符，清洗失败拒绝整个 offer 并回 `transfer.error`；acceptTransfer 包裹异常。

### P1-5 配对码可在线穷举：非密码学随机 + 无尝试上限 + 挂起请求无上限

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceService.kt:358` `val code = String.format("%06d", (Math.random() * 1_000_000).toInt())` —— `Math.random()` 基于 java.util.Random（48 位 LCG），非 CSPRNG；桌面端对照 `control/node.ts:363-370` 用 `randomFillSync`。
- `:388-401` `submitPairingCode`：错码只返回 failure，**不计数、不销毁 pending** —— 同一 pending 的 60s 窗口内可无限次猜（桌面端 `pairing.ts:89` `MAX_ATTEMPTS = 5`、:206-209 超限 `conn.close(4003)`）。
- `:346-370` `handlePairRequest`：pendingMap 无数量上限（协议 §5/桌面端 `pairing.ts:417-420` 超过 8 个回 `RESOURCE_BUSY`），攻击者可用 N 个伪造 `from` 开 N 个 pending 并行摊薄猜测。
- 影响：10^6 空间、60s 窗口、局域网 RTT + 无需读响应即可流水线提交 → 多连接并行下分钟级命中；命中即获 `file+clipboard` 授权，与 P0-2 叠加后完全接管数据面与剪贴板。副作用：受害者 UI 会刷出垃圾配对卡片（可感知症状）。T4「配对请求限流」未实现。
- 修复方向：`SecureRandom` 生成码；每 pending 错 5 次作废并断开连接；pending 总量 8 + `RESOURCE_BUSY`；按 `from` 限流。

### P1-6 数据面不校验块级摘要，整体摘要可缺省放行

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/TransferServer.kt:311-345`（POST 分支）—— 通篇无 `X-Chunk-Digest` 读取与比对（GET 响应倒是回写该头 :372-380）；`:156-163` `finalizeTransfer` 中 `if (expected != null)` —— `transfer.complete` 不带 digests 时直接跳过整体摘要校验（注释自认「兼容旧行为」）。
- 对照：协议 §5「非空 POST 必须携带与 body 一致的 X-Chunk-Digest……缺头视为非法请求」；桌面端接收侧 `transfer/server.ts:290-292` 必校验（不符 400）。协议 §4.5 中 complete 的 `digests` 是校验依据，非可选项。
- 影响：传输中位翻转/被篡改的分块静默落盘；最终防线（整体摘要）也可被发送方省略。与 P0-1/P0-2 叠加时，攻击者可在 token 校验通过的情况下注入任意内容。
- 修复方向：非空 POST 缺头或不符 → 400；finalize 缺 digests → 拒绝落盘。

### P1-7 `transfer.cancel` / `transfer.complete` 不核对任务对端

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceService.kt:299-301`
  ```kotlin
  Protocol.TYPE_TRANSFER_CANCEL -> {
      cancelTransfer(payload.optString("transferId"))
  ```
  `:303-315` complete 同样只取 `transferId` 直接 `finalizeTask`，均不看 `from`。协议 §4.5：「`transfer.accept / reject / cancel / complete` 都必须核对『连接身份 == 任务对端』，不匹配一律忽略」；桌面端 `host.ts:536-542` 注释即「只有本任务的对端才能交还 token，其他连接的 accept 一律无视」。
- 影响：任何控制连接（未认证亦可）可枚举/猜测 transferId 取消他人任务；更糟的是可对**未完成**的任务发伪造 `complete`+digests → `finalizeTransfer` 大小/摘要不符时**删除他人 `.part`**（`TransferServer.kt:158-166`），摘要碰巧一致（如空文件）则提前把半成品改名落盘。
- 修复方向：随 P0-2 的 conn 透传一并修：cancel/complete 核对 `conn.peerId == task.peerId`。

### P1-8 发送方分块 URL 不编码组合键：含空格/中文/特殊字符的文件名发送必失败

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceService.kt:622` `val key = "$transferId:${f.name}"` → `:633` `val path = Protocol.chunkPath(key) + "?offset=$offset"`（`Protocol.kt:16` chunkPath 纯字符串插值）→ `LinkSpaceClient.kt:124,120-131` 原样写入请求行。
- 影响：文件名含空格（`a b.txt`）、中文、`?`/`#` 等 → 请求行非法，桌面端（Node llhttp）直接 400/断连，发送必然失败。SAF `DISPLAY_NAME` 极常见空格与中文 → 发送主流程对一大类文件必坏（「主流程必坏」定 P1）。桌面端发送方对照 `transfer/server.ts:404` `encodeURIComponent(transferId)` 对组合键整体编码。
- 修复方向：发送前对 key 做 percent-encoding（`URLEncoder` 后把 `+` 换 `%20`，或手写 encodeURIComponent 等价实现）；接收方已有 `decodeUriComponent`（`TransferServer.kt:282,512-513`）可正确解码 `%3A/%20/%2B`。

---

## P2

### P2-9 监听 0.0.0.0 且无来源地址门禁（T0）

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/TransferServer.kt:68` `factory.createServerSocket(0, 64)`、`:75` 日志「已监听 0.0.0.0:$port」；accept 后（:226-247）无 remote address 归属检查。威胁模型 T0 要求入站过「RFC1918/链路本地/ULA」门禁并挂数据面与 upgrade 两处；桌面端有 `net-scope.ts` 专模块，Android 无对应物。
- 影响：手机是典型的跨网络设备（访客 WiFi、公共热点、VPN/虚拟网卡），暴露面按威胁模型属「扩大到可路由网络」。
- 修复方向：accept 后校验 `socket.inetAddress` 归属，不符即在 TLS 握手前断开；绑定前优先选局域网 IPv4。

### P2-10 配对码明文写入 logcat（T5）

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceService.kt:384` `Log.i(TAG, "收到 $peerId 的配对请求，配对码 = ${pending.code}，等待用户确认")`。
- 威胁模型 T5 明确「日志与崩溃转储里出现……配对码」为威胁、缓解为「不记录内容」；与 P1-5 叠加（USB 调试开启/日志被采集场景）。
- 修复方向：移除该日志。

### P2-11 offer 无文件数/大小上限

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/LinkSpaceService.kt:261-284` —— 仅 `hasScope(from,"file")` 门禁；`files` 数组长度、单个 `size`（`optLong` 可为负/超大）、`totalSize` 全不校验。桌面端对照 `transfer/manager.ts:136` `if (files.length > 512) throw`。
- 影响：已配对（或经 P0-2 冒充）设备可创建任意大任务：TransferTask 全量驻内存、用户接受后写满磁盘（T4「单文件与总大小上限可配置」未落实）。
- 修复方向：文件数 ≤512、单文件/总量上限、`size < 0` 拒绝，超限回 `transfer.error`。

### P2-12 GET `length` 无 32MiB 上限（已认证 OOM）

- 位置：`apps/android/app/src/main/java/cn/linkspace/client/service/TransferServer.kt:369` `val length = req.query["length"]?.toIntOrNull() ?: Protocol.CHUNK_SIZE` → `readChunk` 分配 `ByteArray(length)`（:428-436 区段）。
- 协议 §5「GET 的 `length` 上限同为 32 MiB」。持有 token 的设备或 P0-2 攻击者请求 `length≈2^31-1` → OOM 杀进程。
- 修复方向：超限 413。

### P2-13 无前台服务：常驻可用性不成立

- 位置：`apps/android/app/src/main/AndroidManifest.xml:3-34` —— 无 `<service>` 声明、无 FOREGROUND_SERVICE/POST_NOTIFICATIONS/RECEIVE_BOOT_COMPLETED；`LinkSpaceService` 是普通单例（LinkSpaceService.kt:64-86），生命周期=进程生命周期；`LinkSpaceApp.kt:8-9` 注释宣称「设备需要能被桌面端随时发现」，但进程未启动/被缓存回收后 mDNS 通告与数据面全部下线。
- 影响：发现、配对、接收、剪贴板全部依赖进程存活；threat-model「待补充」清单里「Android 端前台服务与通知的隐私影响评估」印证该决策未做。
- 修复方向：引入前台服务 + 常驻通知（注意通知内容脱敏，T5），或产品层面明确「仅前台可用」并同步文档与 UI 预期。

### P2-14 信封 §3 语义校验两端均缺（文档-实现冲突，记录）

- 位置：Android `LinkSpaceService.kt:165-168`（仅 `optString`/`optJSONObject`，不校验 `v`/`to`/`ts`/`id` 去重）、`TransferServer.kt:395-402`；桌面端 `control/node.ts:347-360` `isEnvelope` 也只查字段类型，`dispatch`（:275-286）不查 `ts` 窗口与 `to==self`。
- 协议 §3：「接收方必须校验 v 可处理、to 为自身、ts 在 ±60s 窗口内……任一项失败即断开」——两端都未落实，属文档与实现的整体偏差（按任务背景，这属于协议意图与两套实现的冲突，单列供主会话裁决，Android 侧修复时应与桌面端同步实现）。

---

## P3（加固建议）

1. **剪贴板无用户开关 + 轻度数据竞争**：前台即无条件启用（`MainActivity.kt:74-91`），无本地退出开关（授权门禁有，本地开关无）；`ClipboardSync.kt:52-64` poll（主线程）与 `:68-84` receive（WS 读线程）无同步地共享 `lastSeen/suppressUntil`，可见性竞态可能让抑制窗口失效一轮。建议加开关并收敛到单线程或加锁。
2. **Discovery 软过期未实现**：`Discovery.kt:19-20` 注释宣称「保留软过期」，代码只有 `onServiceLost`（:89-92），无定时清理 → 异常下线设备在列表残留。补实现或改注释。
3. **错误响应无 Content-Length**：`TransferServer.kt:462-466` `writeResponse` 只写 Content-Type（`writeJson` :472-479 有），keep-alive 下严格客户端无法分帧。补 CL。
4. **finalize 部分成功不回滚**：`TransferServer.kt:167-186` 循环中前几个文件已 `renameTo`，后续失败任务置 failed 但部分文件已落盘。先全量校验再统一改名。
5. **cancel 与 append 竞态**：`TransferServer.kt:303` cancelled 检查与 `:344` appendBytes 之间无锁，`cancel()`（:112-119）删 `.part` 后在途 append 会以追加模式重建孤儿 `.part`。协议 §5 要求「同一任务的分块写入串行化，取消时先摘路由等排空再删」。按任务加锁即可。
6. **Identity 健壮性与密钥存储**：`Identity.kt:57-58` 密钥/证书两步 `writeText` 非原子，cert 写一半损坏后 `get()`（:38-56）无 runCatching，`fingerprintOf` 抛异常 → `Application.onCreate` 崩溃循环，只能清数据；私钥明文 PEM 存内部存储（:57），建议 AndroidKeyStore（对照桌面 safeStorage/DPAPI，T6）。
7. **主线程 IO/密钥生成**：`LinkSpaceApp.kt:11` → `LinkSpaceService.start()`（:117-137，含 trust.load 读盘）→ `TransferServer.start()`（TransferServer.kt:58-66）→ `identity.keyStore()`，首次运行触发 RSA-2048 生成（Identity.kt:79-101）全在主线程 → 首启 ANR/StrictMode 风险。移到后台线程。
8. **杂项**：`announcedConnections` 死字段（LinkSpaceService.kt:107,141，声明与清理都在、防回环逻辑从未使用）；`WRITE_EXTERNAL_STORAGE` 死声明（manifest:11-13，运行时从未请求）；`transfer.progress` 从不发送（Protocol.kt 无 TYPE_TRANSFER_PROGRESS，协议 §4.5 有节流推送要求，桌面发送方无进度反馈）；`URLDecoder.decode` 把 `+` 解成空格（TransferServer.kt:512-513）——桌面发送方经 encodeURIComponent 不受影响，Android↔Android 场景含 `+` 文件名会 404；`TrustStore.persist` 的 `renameTo` 返回值未检查（TrustStore.kt:130-131）。

---

## 验证无误的方面

1. **明文面干净**：manifest 未开 `usesCleartextTraffic`（AndroidManifest.xml:15-23 无该属性，targetSdk 35 默认 false），也无 networkSecurityConfig 例外；控制与数据面都架在 `SSLServerSocket`/`SSLSocket` 上，无明文通道。
2. **数据面门禁的两道闸在位**：每请求 `X-Device-Id` + `X-Transfer-Token`（TransferServer.kt:266-267），信任清单 + file 授权（:273）、token 与任务匹配（:297）、任务存在性（:291）、已取消拒收分块（:303-305）、偏移不衔接 409（:331-340）、空体偏移探针（:317-328）——与协议 §5 补充规则逐条对应（缺的是「身份到连接的绑定」，见 P0-2）。
3. **落盘策略安全**：`uniqueFile` 重命名防静默覆盖（:436-448）；finalize 大小+摘要双校验通过才 rename（:148-186）；取消/失败任务拒绝落盘（:133-140）；`LinkSpaceService.finalizeTask` 对 CANCELLED/FAILED 状态拒绝（:655-662）；保存目录为 app 专属外部存储（LinkSpaceService.kt:720 `getExternalFilesDir(null)/LinkSpace`），不写公共存储。
4. **剪贴板门禁与防循环**：收/发两侧均有 clipboard scope 检查（LinkSpaceService.kt:289-297、:498）；512KiB 上限（ClipboardSync.kt:19）与协议一致；500ms 抑制窗口且窗口内不更新基线（ClipboardSync.kt:52-84）与桌面 `clipboard.ts` 同款判定。
5. **配对码不出网**：challenge 只带 `expiresAt`（LinkSpaceService.kt:372-382），码只显示在本机屏幕（MainActivity.kt:123-140），配对协议 §4.1 ⚠️ 修正得到遵守；已知设备重发 pair.request 时校验自报指纹与信任条目一致（:349-353）。
6. **rename 门禁存在**：仅信任清单内条目更新（:248-258）——但依赖自报身份，根治归 P0-2。
7. **上次审查遗留项已完成（发送方向）**：Android 作为发送方按块携带 `X-Chunk-Digest`（LinkSpaceClient.kt:130）与 `offset`（LinkSpaceService.kt:633），组合键 `${transferId}:${name}`（:622）与桌面数据面路由一致（manager.ts:170/275/362）；发送期间心跳保活防桌面端 15s 判离线（:550-556）；分块上传走独立 TLS 连接避免炸对端 WS 解析器（:614、LinkSpaceClient.kt:102-110）。
8. **WS 实现边界合理**：帧长上限 16MB（WebSocketConnection.kt:123,187）、客户端帧解掩码（:134-137）、出站单线程执行器防帧交错与 NetworkOnMainThreadException（:35-47）。
9. **信任存储**：`trust.json` tmp+rename 原子写（TrustStore.kt:129-131）、存内部私有目录；`allowBackup="false"`（manifest:17）；scope 显式存储、默认只授 `file+clipboard`（Protocol.kt:56-58，control 不默认授予，符合 §4.1）。
10. **mDNS 符合 §2**：TXT 只含 ver/id(12位前缀)/port/type/caps/paired（Discovery.kt:139-151），无密钥材料；MulticastLock 正确持有/释放（:113-123,159-168）；自通告过滤（:46-47）；每次 resolve 新建 listener 规避 NsdManager 限制（:29-36）。
11. **设备身份**：RSA-2048 + SHA256withRSA 自签（Identity.kt:79-101），指纹算法与 openssl/桌面一致（:111-121），身份跨重启持久化（:38-56），deviceIdPrefix 取指纹前 12 位与桌面 TXT 约定一致。

## 待证项

1. **桌面端数据面 requestCert 后的互操作**：桌面 2.4 修复要求「数据面服务端 requestCert: true」。Android 的 `tlsSocket` 配置了 KeyManager（LinkSpaceClient.kt:48-58），握手时应 CertificateRequest 会出示证书，理论上可通过；但桌面端把**证书指纹 ↔ X-Device-Id** 绑定的具体逻辑本次未逐行核对。建议读 `manager.ts` 的 verifyTransfer 接线或跑一次 Android→桌面实机发送确认。
2. **Android↔Android 互传是否为支持场景**：两台 Android 均通告 `caps=file,clipboard` 且可互相发现。若支持，P3-8 的 `+` 解码问题升 P2，且发送方 URL 不编码（P1-8）同样影响该路径。
3. **pair.submit 是否还有每设备级频率限制（T4）**：本次只确认桌面端 per-pending 5 次上限（pairing.ts:89,206-209），未确认是否有跨 pending 的每设备限流；影响 P1-5 修复方案的对齐粒度。

## 建议的下一步（按性价比排序）

1. P0-2 最小闭环：`setWantClientAuth(true)` + announce 指纹三道闸 + `accept` 定向发送 + revoke/cancel/complete 绑定 `conn.peerId`——桌面端 `pairing.ts:347-369,532-556`、`host.ts:458,536-542` 有现成实现可对照移植。
2. P0-1：`LinkSpaceClient` 握手后取 `peerCertificates` 与 TrustStore 比对，不符断开。
3. P0-3/P1-4/P1-6 三件套都在 `handleRequest`/`registerIncoming` 两个函数内：先鉴权后限长读体、文件名收敛、块摘要必校验 + 32MiB 上限。
4. P1-5：SecureRandom + attempts=5 + pending≤8 + RESOURCE_BUSY（对齐桌面端）。
5. P1-8：发送方对组合键 percent-encode。
