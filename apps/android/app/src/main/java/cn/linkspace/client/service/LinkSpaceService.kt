package cn.linkspace.client.service

import android.content.Context
import android.util.Log
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

/**
 * 待发送文件的最小描述。
 *
 * SAF 只回 Uri 不回真实路径（把 Uri 转 File 是文档明确不鼓励的做法），
 * 所以发送侧只约定「名字 + 大小 + 打开输入流」，不依赖 java.io.File。
 * 流按需开关：offer、分块推送、整体摘要各开一次，
 * contentResolver 允许对同一 Uri 反复 openInputStream。
 */
class OutgoingFile(
    val name: String,
    val size: Long,
    private val open: () -> java.io.InputStream
) {
    fun inputStream(): java.io.InputStream = open()
}

/**
 * LinkSpace 主机：把身份、信任、发现、传输服务组装成一个节点。
 * 桌面端对应 `apps/desktop/src/main/host.ts`，两端职责一致。
 *
 * 当前阶段 Android 扮演**接收方**：通告自身、接受配对、接收文件。
 * 主动发起传输（连接 Windows 并推送文件）留到下一阶段。
 */
class LinkSpaceService private constructor(private val appContext: Context) {

    companion object {
        private const val TAG = "LinkSpace/Service"

        const val deviceType = "android-phone"

        private const val KEY_DISPLAY_NAME = "displayName"
        private const val KEY_CLIPBOARD_SYNC = "clipboardSyncEnabled"
        /** 同时挂起的配对请求上限，与桌面端 MAX_PENDING 一致 */
        private const val MAX_PENDING_PAIRINGS = 8
        /** 配对码最大错误次数，超过即断开对端连接（与桌面端 maxAttempts 一致） */
        private const val MAX_PAIR_ATTEMPTS = 5

        /** 配对码用 CSPRNG：Math.random 可预测，6 位码可被在线穷举（审查 P1-5） */
        private val secureRandom = java.security.SecureRandom()

        @Volatile
        var deviceIdPrefix: String = ""
            private set

        @Volatile
        var displayName: String = "Android"
            private set

        @Volatile
        private var instance: LinkSpaceService? = null

        fun get(context: Context): LinkSpaceService {
            return instance ?: synchronized(this) {
                instance ?: LinkSpaceService(context.applicationContext).also { instance = it }
            }
        }

        /** 指纹统一为 64 位小写 hex 再比较，兼容冒号分隔与纯 hex 两种写法 */
        fun normalizeFingerprint(fp: String): String = fp.replace(":", "").lowercase()
    }

    private val filesDir = File(appContext.filesDir, "linkspace")
    private val identity = Identity(filesDir)
    private val trust = TrustStore(File(filesDir, "trust.json"))
    private val discovery = Discovery(appContext)
    /** 本机显示名持久化（5.4）：改名跨重启保持，存 SharedPreferences */
    private val prefs = appContext.getSharedPreferences("linkspace", Context.MODE_PRIVATE)
    private var server: TransferServer? = null

    /** 待用户确认的配对请求 */
    data class PendingPairing(
        val id: String,
        val peerId: String,
        val displayName: String,
        val deviceType: String,
        val fingerprint: String,
        val code: String,
        val expiresAt: Long,
        /** 已错误尝试的次数，达到上限即断开该对端 */
        val attempts: Int = 0
    )

    private val _pendingPairings = MutableStateFlow<List<PendingPairing>>(emptyList())
    val pendingPairings: StateFlow<List<PendingPairing>> = _pendingPairings

    private val _discovered = MutableStateFlow<List<DiscoveredService>>(emptyList())
    val discovered: StateFlow<List<DiscoveredService>> = _discovered

    private val _transfers = MutableStateFlow<List<TransferTask>>(emptyList())
    val transfers: StateFlow<List<TransferTask>> = _transfers

    private val _trusted = MutableStateFlow<List<TrustStore.Entry>>(emptyList())
    val trusted: StateFlow<List<TrustStore.Entry>> = _trusted

    private val _port = MutableStateFlow(0)
    val port: StateFlow<Int> = _port

    /** 本机显示名（5.4），界面据此展示与编辑 */
    private val _selfName = MutableStateFlow("")
    val selfName: StateFlow<String> = _selfName

    private val pendingMap = ConcurrentHashMap<String, PendingPairing>()
    /** 已回过 announce 的对端，防止无限互弹 */
    private val announcedConnections: MutableSet<String> = java.util.Collections.synchronizedSet(mutableSetOf())
    private val taskMap = ConcurrentHashMap<String, TransferTask>()
    /** transferId → 保存目录 */
    private val saveDirs = ConcurrentHashMap<String, File>()

    val fingerprint: String get() = identity.get().fingerprint

    fun start() {
        trust.load()
        _trusted.value = trust.list()

        val cert = identity.get()
        deviceIdPrefix = cert.fingerprint.replace(":", "").take(12)
        displayName = prefs.getString(KEY_DISPLAY_NAME, null)?.takeIf { it.isNotBlank() }
            ?: (android.os.Build.MODEL ?: "Android")
        _selfName.value = displayName
        _clipboardEnabled.value = prefs.getBoolean(KEY_CLIPBOARD_SYNC, false)

        val srv = TransferServer(
            identity = identity,
            trust = trust,
            onComplete = { transferId, digests -> finalizeTask(transferId, digests) }
        )
        srv.start()
        server = srv
        _port.value = srv.port
        srv.controlHandler = { ctx, msg -> onControlMessage(ctx, msg) }
        // 对端断连时清掉它留下的待确认配对请求，避免僵尸条目；
        // 键鼠控制会话同样随断连终止
        srv.controlClosedHandler = { peerId ->
            val stale = pendingMap.values.filter { it.peerId == peerId }
            if (stale.isNotEmpty()) {
                stale.forEach { pendingMap.remove(it.id) }
                _pendingPairings.value = pendingMap.values.toList()
                Log.i(TAG, "对端 $peerId 已断连，清理 ${stale.size} 个待确认配对请求")
            }
            announcedConnections.remove(peerId)
            input.onPeerDisconnected(peerId)
        }

        discovery.onChange { list -> _discovered.value = list }
        discovery.advertise(srv.port, Protocol.DEFAULT_GRANT_SCOPE, trust.list().isNotEmpty())
        discovery.start()

        Log.i(TAG, "LinkSpace 服务已启动，id=$deviceIdPrefix，端口=${srv.port}")
    }

    fun stop() {
        disableClipboardSync()
        discovery.stop()
        discovery.stopAdvertising()
        server?.stop()
        server = null
    }

    // ---------- 控制通道 ----------

    /**
     * 处理控制消息。
     *
     * 身份一律以 `ctx.peerId` 为准（连接在 announce 时登记、之后固定），
     * 不再信任消息信封的 `from` 字段；`ctx.tlsFingerprint` 是连入方出示的
     * 客户端证书指纹，用于把「自报身份」锚定到「真实持有的密钥」上。
     */
    private fun onControlMessage(ctx: TransferServer.ControlContext, msg: JSONObject) {
        val type = msg.optString("type")
        val from = ctx.peerId
        val payload = msg.optJSONObject("payload") ?: JSONObject()
        when (type) {
            Protocol.TYPE_ANNOUNCE -> {
                val claimedFp = normalizeFingerprint(payload.optString("fingerprint"))
                val actualFp = ctx.tlsFingerprint
                // 自报指纹与实际证书不符：对方在声称自己不持有的身份，直接断开
                if (actualFp != null && claimedFp.isNotEmpty() && actualFp != claimedFp) {
                    Log.w(TAG, "对端 $from 声称的指纹与 TLS 证书不符，断开连接")
                    ctx.close()
                    return
                }
                // 已信任设备必须有证书且与库存一致——无证书回退只允许未知设备。
                // 否则任何主机连一次采集到 deviceId+指纹，就能无证书冒充该
                // 已配对设备（全项目审查 2026-10-29 的桌面 P0 同款攻击链）
                val known = trust.fingerprintOf(from)
                if (known != null) {
                    if (actualFp == null || actualFp != normalizeFingerprint(known)) {
                        Log.w(TAG, "对端 $from 指纹与信任清单不符（或未出示证书），断开连接")
                        server?.sendControlTo(from, pairError(from, "设备指纹与已存记录不符，请撤销后重新配对"))
                        ctx.close()
                        return
                    }
                    Log.i(TAG, "对端 $from 已在信任清单中（证书指纹一致）")
                } else {
                    Log.i(TAG, "对端声明身份: $from")
                }
                // 回应自己的身份，让对方知道我们是谁（每连接只回一次）
                if (announcedConnections.add(from)) {
                    server?.sendControlTo(
                        from,
                        envelope(Protocol.TYPE_ANNOUNCE, from) {
                            put("displayName", displayName)
                            put("deviceType", deviceType)
                            put("caps", org.json.JSONArray(Protocol.DEFAULT_GRANT_SCOPE))
                            put("fingerprint", fingerprint)
                        }
                    )
                }
            }

            Protocol.TYPE_PAIR_REQUEST -> handlePairRequest(
                ctx = ctx,
                peerDisplayName = payload.optString("displayName"),
                peerDeviceType = payload.optString("deviceType"),
                peerFingerprint = payload.optString("fingerprint")
            )

            Protocol.TYPE_PAIR_SUBMIT -> {
                // 桌面端把用户输入的配对码送来，校验通过即建立信任
                val code = payload.optString("code")
                val pending = pendingMap.values.firstOrNull { it.peerId == from }
                if (pending == null) {
                    server?.sendControlTo(from, pairError(from, "没有待确认的配对请求"))
                    return
                }
                val result = submitPairingCode(pending.id, code)
                if (result.isSuccess) {
                    // 信任已建立，通告对端
                    server?.sendControlTo(
                        from,
                        envelope(Protocol.TYPE_PAIR_APPROVE, from) {
                            put("deviceId", deviceIdPrefix)
                            put("displayName", displayName)
                            put("deviceType", deviceType)
                            put("fingerprint", fingerprint)
                            put("scope", org.json.JSONArray(Protocol.DEFAULT_GRANT_SCOPE))
                        }
                    )
                } else {
                    // 错误计数：达到上限即断开，防止在线穷举 6 位配对码
                    val attempts = pending.attempts + 1
                    if (attempts >= MAX_PAIR_ATTEMPTS) {
                        pendingMap.remove(pending.id)
                        _pendingPairings.value = pendingMap.values.toList()
                        server?.sendControlTo(from, pairError(from, "配对码错误次数过多"))
                        server?.closePeer(from)
                        Log.w(TAG, "对端 $from 配对码错误 $attempts 次，已断开连接")
                    } else {
                        pendingMap[pending.id] = pending.copy(attempts = attempts)
                        _pendingPairings.value = pendingMap.values.toList()
                        server?.sendControlTo(from, pairError(from, result.exceptionOrNull()?.message ?: "配对失败"))
                    }
                }
            }

            Protocol.TYPE_PAIR_REJECT -> {
                pendingMap.values.filter { it.peerId == from }.forEach { pendingMap.remove(it.id) }
                _pendingPairings.value = pendingMap.values.toList()
            }

            Protocol.TYPE_PAIR_REVOKE -> {
                // 撤销语义是「撤销方撤销它自己」，且必须由持有对应证书的
                // 连接发出。否则任何能连上的设备都能伪造一条消息，
                // 定向删除本机对第三方的信任（全项目审查 P0-2）
                val stored = trust.fingerprintOf(from)
                if (stored != null) {
                    val fp = ctx.tlsFingerprint
                    if (fp == null || fp != normalizeFingerprint(stored)) {
                        Log.w(TAG, "撤销请求的 TLS 指纹与信任条目不符，已忽略")
                        return
                    }
                }
                trust.revoke(from)
                _trusted.value = trust.list()
                Log.i(TAG, "对端撤销了信任: $from")
            }

            Protocol.TYPE_RENAME -> {
                // 名字是对端自报的，只信信任清单内的设备（与桌面端同一门禁）
                if (!trust.isKnown(from)) {
                    Log.w(TAG, "忽略未信任设备的改名请求: $from")
                    return
                }
                val name = sanitizeDisplayName(payload.optString("displayName")) ?: return
                if (trust.rename(from, name)) {
                    _trusted.value = trust.list()
                    Log.i(TAG, "对端 $from 已改名为「$name」")
                }
            }

            Protocol.TYPE_TRANSFER_OFFER -> {
                // 门禁必须设在 offer 这一步，而不是等数据面再拒。
                // 少了这道检查，未配对设备的 offer 也会走完「创建任务 →
                // 用户点接收 → 签发 token → 发 accept」整条链，最后才在
                // 数据面被拒——用户看到的是「点了接收却没有文件」，
                // 而日志里躺着一条难以定位的 403。桌面端从一开始就拒。
                if (!trust.hasScope(from, "file")) {
                    Log.w(TAG, "拒绝未授权设备的 transfer.offer: $from")
                    server?.sendControlTo(
                        from,
                        envelope(Protocol.TYPE_TRANSFER_ERROR, from) {
                            put("code", "SCOPE_DENIED")
                            put("message", "设备未授权")
                        }
                    )
                    return
                }
                val transferId = payload.optString("transferId")
                // transferId 会进数据面 URL 与 `${id}:${name}` 组合键，
                // 必须与桌面端同一字符集约束，怪字符一律拒绝
                if (!Regex(Protocol.SESSION_ID_RE).matches(transferId)) {
                    Log.w(TAG, "拒绝非法 transferId 的 offer")
                    return
                }
                val filesArr = payload.optJSONArray("files") ?: org.json.JSONArray()
                if (filesArr.length() == 0 || filesArr.length() > 512) {
                    Log.w(TAG, "拒绝文件数异常的 offer（${filesArr.length()}）")
                    server?.sendControlTo(
                        from,
                        envelope(Protocol.TYPE_TRANSFER_ERROR, from) {
                            put("code", "BAD_REQUEST")
                            put("message", "文件清单非法")
                        }
                    )
                    return
                }
                val files = (0 until filesArr.length()).map {
                    val o = filesArr.getJSONObject(it)
                    // 名字经网络而来，先收敛为基础名再做任何路径拼接
                    TransferFile(
                        name = server?.sanitizeFileName(o.optString("name")) ?: "",
                        size = o.optLong("size", -1L)
                    )
                }
                if (files.any { it.name.isEmpty() || it.size < 0 }) {
                    Log.w(TAG, "拒绝含非法文件名的 offer")
                    server?.sendControlTo(
                        from,
                        envelope(Protocol.TYPE_TRANSFER_ERROR, from) {
                            put("code", "BAD_REQUEST")
                            put("message", "文件名非法")
                        }
                    )
                    return
                }
                handleOffer(transferId, files, from)
            }

            Protocol.TYPE_CLIPBOARD_SHARE -> {
                // 范围门禁：剪贴板会经过密码与令牌，没有 clipboard 授权
                // 的对端既不能读也不能写本机剪贴板
                if (!trust.hasScope(from, "clipboard")) {
                    Log.w(TAG, "拒绝未授权设备的 clipboard.share: $from")
                    return
                }
                val kind = payload.optString("kind", "text")
                if (kind != "text") return
                Log.i(TAG, "收到 clipboard.share，${payload.optString("text").length} 字符")
                clipboard?.receive(payload.optString("text"))
            }

            Protocol.TYPE_TRANSFER_CANCEL -> {
                // 只能取消本任务对端发来的取消：不核对来源的话，
                // 旁观连接能凭 id 弄坏别人的传输
                val transferId = payload.optString("transferId")
                val task = taskMap[transferId]
                if (task == null || task.peerId != from) return
                cancelTransfer(transferId)
            }

            Protocol.TYPE_TRANSFER_COMPLETE -> {
                // 发送方推完了，带着每个文件的整体摘要。
                // 校验通过才落盘——这一环缺失时文件永远停在 .part。
                // 来源必须与本任务对端一致：伪造 complete 会按假摘要
                // 比对失败而删掉 .part，等于让旁观连接弄坏别人的传输
                val transferId = payload.optString("transferId")
                val task = taskMap[transferId]
                if (task == null || task.direction != "receive" || task.peerId != from) return
                val digestsObj = payload.optJSONObject("digests") ?: JSONObject()
                val digests = mutableMapOf<String, String>()
                digestsObj.keys().forEach { k -> digests[k] = digestsObj.optString(k) }
                finalizeTask(transferId, digests)
            }

            // ---------- 安卓→电脑远控（4.6，控制端半边） ----------
            Protocol.TYPE_SESSION_ACCEPT -> input.onAccepted(from, payload)
            Protocol.TYPE_SESSION_REJECT -> input.onRejected(from, payload)
            Protocol.TYPE_SESSION_STOP -> input.onStopped(from, payload)
        }
    }

    /** 统一的信封构造，避免每处手写一遍字段导致对不齐 */
    private fun envelope(type: String, to: String, payload: JSONObject.() -> Unit): JSONObject =
        JSONObject().apply {
            put("v", Protocol.VERSION)
            put("type", type)
            put("id", java.util.UUID.randomUUID().toString())
            put("from", deviceIdPrefix)
            put("to", to)
            put("ts", System.currentTimeMillis())
            put("payload", JSONObject().apply(payload))
        }

    private fun pairError(to: String, message: String): JSONObject = JSONObject().apply {
        put("v", Protocol.VERSION)
        put("type", Protocol.TYPE_PAIR_ERROR)
        put("id", java.util.UUID.randomUUID().toString())
        put("from", deviceIdPrefix)
        put("to", to)
        put("ts", System.currentTimeMillis())
        put("payload", JSONObject().apply { put("code", "AUTH_REQUIRED"); put("message", message) })
    }

    // ---------- 配对 ----------

    /**
     * 收到 pair.request：生成配对码并等待用户确认。
     * 配对码只显示在本机屏幕上，由对方用户人工抄录后经 pair.submit 送回。
     */
    private fun handlePairRequest(
        ctx: TransferServer.ControlContext,
        peerDisplayName: String,
        peerDeviceType: String,
        peerFingerprint: String
    ) {
        val peerId = ctx.peerId
        // 参数带 peer 前缀：pair.request 载荷里的身份是**对端自报**的。
        // 曾用无前缀参数名与 companion 属性同名，快速通道 approve 里
        // `put("displayName", displayName)` 被遮蔽解析到参数——平板在
        // 「我是谁」的回执里发成了桌面的名字/类型/指纹（真机踩过，master
        // 15dff8a 修复；本重构按同一规则命名，遮蔽在编译期不可能再发生）。
        // 已信任的设备直接放行，不再要求配对码。
        // 必须回 pair.approve：桌面端对已信任对端也是直接 approve
        // （pairing.ts「若已信任，直接放行」），两端语义必须对称——
        // 曾在这里静默 return，发起方永远等不到响应，连接挂到断开，
        // UI 表现为「点了配对没反应」（真机踩过）。
        if (trust.isKnown(peerId)) {
            val known = trust.fingerprintOf(peerId)
            // 指纹以 TLS 证书为准；连入方未出示证书的已信任设备
            // 在 announce 闸门处就已被断开，这里只做双保险
            if (known != null && (ctx.tlsFingerprint == null || ctx.tlsFingerprint != normalizeFingerprint(known))) {
                Log.w(TAG, "对端 $peerId 指纹与信任清单不符，可能被替换")
                server?.sendControlTo(peerId, pairError(peerId, "设备指纹与已存记录不符，请撤销后重新配对"))
                ctx.close()
                return
            }
            Log.i(TAG, "对端 $peerId 已在信任清单中，直接确认")
            val entry = trust.list().firstOrNull { it.deviceId == peerId }
            server?.sendControlTo(
                peerId,
                envelope(Protocol.TYPE_PAIR_APPROVE, peerId) {
                    // 回执是「我是谁」：全部用本机身份，不是载荷里的自报值
                    put("deviceId", deviceIdPrefix)
                    put("displayName", displayName)
                    put("deviceType", deviceType)
                    put("fingerprint", fingerprint)
                    // 沿用已存条目的授权范围，不重新扩权
                    put("scope", org.json.JSONArray(entry?.scope ?: Protocol.DEFAULT_GRANT_SCOPE))
                }
            )
            return
        }
        if (pendingMap.values.any { it.peerId == peerId }) return
        // 配对请求不需要任何前置授权就能发起，必须设总量上限，
        // 否则任意连接都能刷出配对码污染本机界面
        if (pendingMap.size >= MAX_PENDING_PAIRINGS) {
            Log.w(TAG, "挂起配对请求已达上限 $MAX_PENDING_PAIRINGS，拒绝新请求")
            server?.sendControlTo(peerId, pairError(peerId, "配对请求过多，请稍后再试"))
            return
        }

        val code = String.format("%06d", secureRandom.nextInt(1_000_000))
        val pending = PendingPairing(
            id = java.util.UUID.randomUUID().toString(),
            peerId = peerId,
            displayName = peerDisplayName,
            deviceType = peerDeviceType,
            // 落库指纹以 TLS 证书为准，自报值只作拿不到证书时的退路
            fingerprint = ctx.tlsFingerprint ?: normalizeFingerprint(peerFingerprint),
            code = code,
            expiresAt = System.currentTimeMillis() + 60_000
        )
        pendingMap[pending.id] = pending
        _pendingPairings.value = pendingMap.values.toList()
        // 必须回 challenge：发起方靠它知道「该去要配对码了」。
        // 少了这一步，发起方只会静默等待直到心跳超时。
        server?.sendControlTo(
            peerId,
            envelope(Protocol.TYPE_PAIR_CHALLENGE, peerId) {
                put("expiresAt", pending.expiresAt)
            }
        )
        // 配对码只进界面不进日志：logcat 任何应用可读，T5 明确禁止（审查 P2）
        Log.i(TAG, "收到 $peerId 的配对请求，等待用户确认")
    }

    /** 用户输入了对方抄来的配对码，校验通过即建立信任 */
    fun submitPairingCode(pairingId: String, code: String): Result<Unit> {
        val pending = pendingMap[pairingId] ?: return Result.failure(IllegalStateException("配对请求已失效"))
        if (System.currentTimeMillis() > pending.expiresAt) {
            pendingMap.remove(pairingId)
            _pendingPairings.value = pendingMap.values.toList()
            return Result.failure(IllegalStateException("配对码已过期，请重新发起"))
        }
        if (code != pending.code) {
            return Result.failure(IllegalArgumentException("配对码不正确"))
        }
        trust.grant(
            TrustStore.Entry(
                deviceId = pending.peerId,
                displayName = pending.displayName,
                deviceType = pending.deviceType,
                fingerprint = pending.fingerprint,
                scope = Protocol.DEFAULT_GRANT_SCOPE,
                trustedAt = System.currentTimeMillis()
            )
        )
        pendingMap.remove(pairingId)
        _pendingPairings.value = pendingMap.values.toList()
        _trusted.value = trust.list()
        Log.i(TAG, "已与 ${pending.peerId} 建立信任")
        return Result.success(Unit)
    }

    fun rejectPairing(pairingId: String) {
        pendingMap.remove(pairingId)
        _pendingPairings.value = pendingMap.values.toList()
    }

    fun revokeTrust(deviceId: String) {
        trust.revoke(deviceId)
        _trusted.value = trust.list()
    }

    // ---------- 本机改名（5.4） ----------

    /**
     * 显示名清洗：与桌面端 `profile.ts` 的 sanitizeDisplayName 同一规则，
     * 去控制字符、去首尾空白、限长 60。返回 null 表示无效名。
     */
    private fun sanitizeDisplayName(raw: String): String? {
        val clean = raw.replace(Regex("[\\u0000-\\u001f\\u007f]"), "").trim()
        if (clean.isEmpty()) return null
        return clean.take(60)
    }

    /**
     * 本机改名：持久化 → 更新 mDNS 通告（服务名内嵌显示名，NSD 不支持
     * 原地改名，先注销再注册）→ 广播 device.rename 给已连接对端。
     * 对端仅更新信任清单内的条目并落盘，两端重启后都保持。
     * 成功时返回清洗后的名字，供 UI 展示「对端将看到的名字」。
     */
    fun setDisplayName(name: String): Result<String> {
        val clean = sanitizeDisplayName(name)
            ?: return Result.failure(IllegalArgumentException("名字不能为空"))
        if (clean == displayName) return Result.success(clean)
        displayName = clean
        prefs.edit().putString(KEY_DISPLAY_NAME, clean).apply()
        _selfName.value = clean
        server?.let { srv ->
            runCatching { discovery.stopAdvertising() }
            discovery.advertise(srv.port, Protocol.DEFAULT_GRANT_SCOPE, trust.list().isNotEmpty())
            var sent = 0
            srv.connectedPeerIds().forEach { peerId ->
                srv.sendControlTo(
                    peerId,
                    envelope(Protocol.TYPE_RENAME, peerId) { put("displayName", clean) }
                )
                sent++
            }
            if (sent > 0) Log.i(TAG, "本机已改名为「$clean」，通知 $sent 台在线设备")
        }
        return Result.success(clean)
    }

    // ---------- 剪贴板同步 ----------

    private var clipboard: ClipboardSync? = null

    /**
     * 剪贴板同步开关，持久化、默认**关**。
     * 剪贴板会经过密码与令牌，默认静默双向同步等于把敏感内容常年在网上
     * 推给所有已配对设备；用户显式开启才参与（与桌面端 P2-1 的修复方向
     * 一致）。关闭时既不发送也不接收。
     */
    private val _clipboardEnabled = MutableStateFlow(false)
    val clipboardEnabled: StateFlow<Boolean> = _clipboardEnabled

    fun setClipboardSyncEnabled(enabled: Boolean) {
        prefs.edit().putBoolean(KEY_CLIPBOARD_SYNC, enabled).apply()
        _clipboardEnabled.value = enabled
        // 关闭立即生效；开启方向由界面在前台时注入 io 后生效
        if (!enabled) disableClipboardSync()
    }

    /**
     * 启用剪贴板同步。读写由调用方注入：
     * Android 10 起后台应用读不到剪贴板，所以注入时机由界面在前台时控制。
     * 开关未开启时调用是空操作——界面的 onResume 不再是无条件开启。
     */
    fun enableClipboardSync(io: ClipboardSync.ClipboardIo) {
        if (!clipboardEnabled.value) return
        clipboard?.stop()
        clipboard = ClipboardSync(
            io = io,
            send = { text -> broadcastClipboard(text) },
            onSkip = { reason -> Log.w(TAG, reason) }
        ).also { it.start() }
    }

    fun disableClipboardSync() {
        clipboard?.stop()
        clipboard = null
    }

    /** 本机剪贴板可能变了，由界面在前台时驱动 */
    fun pollClipboard() {
        clipboard?.poll()
    }

    /** 只发给持有 clipboard 授权的对端，不做全量广播 */
    private fun broadcastClipboard(text: String) {
        val srv = server ?: return
        var sent = 0
        srv.connectedPeerIds().forEach { peerId ->
            if (!trust.hasScope(peerId, "clipboard")) return@forEach
            srv.sendControlTo(
                peerId,
                envelope(Protocol.TYPE_CLIPBOARD_SHARE, peerId) {
                    put("kind", "text")
                    put("text", text)
                }
            )
            sent++
        }
        if (sent > 0) Log.i(TAG, "剪贴板已同步到 $sent 台设备")
    }

    // ---------- 发送 ----------

    private val client = LinkSpaceClient(identity)

    // ---------- 安卓→电脑远控（协议 4.6，控制端半边） ----------

    /** 键鼠控制会话的界面状态：idle / waiting / active */
    data class InputState(
        val phase: String = "idle",
        val peerId: String? = null,
        val remoteScreen: InputController.Screen? = null
    )

    private val _inputState = MutableStateFlow(InputState())
    val inputState: StateFlow<InputState> = _inputState

    /** 会话结束原因（一次性提示，界面读后可清空） */
    private val _inputMessage = MutableStateFlow("")
    val inputMessage: StateFlow<String> = _inputMessage

    val input: InputController by lazy {
        InputController(
            send = { peerId, type, payloadFn ->
                server?.sendControlTo(peerId, envelope(type, peerId, payloadFn))
            },
            listener = object : InputController.Listener {
                override fun onSessionActive(peerId: String, sessionId: String, remoteScreen: InputController.Screen) {
                    _inputState.value = InputState("active", peerId, remoteScreen)
                }

                override fun onSessionEnded(reason: String) {
                    _inputMessage.value = reason
                    _inputState.value = InputState()
                }

                override fun onWaiting(peerId: String) {
                    _inputState.value = InputState("waiting", peerId)
                }
            }
        )
    }

    /** 本机屏幕尺寸：控制请求里声明，桌面端据此把本机事件映射过去 */
    fun localScreen(w: Int, h: Int): InputController.Screen = InputController.Screen(w, h)

    /** 发送目标需要的完整设备 ID（信封 to 与桌面端按全等路由） */
    fun fullPeerIdOf(idPrefix: String): String = trust.fullDeviceIdOf(idPrefix) ?: idPrefix

    /** 界面展示完会话结束提示后清空 */
    fun clearInputMessage() {
        _inputMessage.value = ""
    }

    /**
     * 用户主动退出：停掉前台服务持有的全部能力——发现、传输服务、
     * 剪贴板同步与所有控制连接。对端会立即看到连接断开（键鼠会话
     * 随之终止），这是「退出 = 语义上的彻底下线」。
     */
    fun stopAll() {
        input.stop("stopped by user")
        stop()
        taskMap.clear()
        _transfers.value = emptyList()
        pendingMap.clear()
        _pendingPairings.value = emptyList()
        Log.i(TAG, "用户主动退出，已断开全部连接")
    }

    /**
     * 向桌面端推送文件（Android 作为发送方）。
     *
     * 流程与桌面端 `transfer/manager.ts` 的 push() 对称：
     *   连接 → announce → offer → 等 accept → 逐块 POST → complete
     * 桌面端作为接收方的 offer/accept/complete 链路本就完整
     * （Windows↔Windows 双向对称），所以这里只补「连接 + 推块」。
     *
     * @param peer mDNS 发现的桌面端（必须已配对，否则 offer 会被拒）
     * @param files 待发送文件，内容由调用方通过 SAF 以流的形式提供
     */
    suspend fun sendFiles(peer: DiscoveredService, files: List<OutgoingFile>): Result<Int> {
        if (files.isEmpty()) return Result.failure(IllegalArgumentException("没有待发送的文件"))
        // 信任判定放在这里而不是等对端拒：提前失败能让界面立刻给出原因，
        // 而不是等一个 403 回来再猜。
        // 用前缀匹配：发现的 idPrefix 是 12 位，桌面端信任条目存的是完整 ID
        if (!trust.hasScopeFor(peer.idPrefix, "file")) {
            return Result.failure(IllegalStateException("设备 ${peer.displayName} 未授权，请先配对"))
        }
        // 信封 to 必须是完整设备 ID：桌面端按全等路由，填 12 位前缀的
        // offer 会被静默丢弃——连接看着活着，对面却当没收到
        val peerFullId = trust.fullDeviceIdOf(peer.idPrefix) ?: peer.idPrefix
        // 对端证书指纹：TLS 握手后必须核对。Android 作为 TLS 客户端时
        // 若盲信任证书，假 mDNS / ARP 把连接引向攻击者即可整体接管
        // 控制通道、截获文件全文与数据面 token（全项目审查 P0-1）
        val expectedFp = trust.fingerprintOf(peerFullId)
            ?.let { LinkSpaceService.normalizeFingerprint(it) }
            ?: return Result.failure(IllegalStateException("设备 ${peer.displayName} 未授权，请先配对"))

        // 任务先登记再连接：界面从 offer 那一刻起就有进度可看，
        // 而不是等整条链路走完才冒出来
        val transferId = "tr-${java.util.UUID.randomUUID().toString().take(8)}"
        val totalSize = files.sumOf { it.size }
        registerOutgoing(transferId, peer.idPrefix, files)

        return withContext(Dispatchers.IO) {
            runCatching {
                val conn = client.connectControl(peer.host, peer.port, Protocol.CONTROL_PATH, expectedFp)
                // 发送期间没有控制消息来回（分块 POST 不走控制通道），
                // 桌面端 15s 收不到任何消息就判定离线并断连——大文件传输
                // 会被中途掐断。发送期间周期性发心跳把会话续住。
                val heartbeat = CoroutineScope(Dispatchers.IO).launch {
                    while (true) {
                        delay(4_000)
                        val alive = runCatching {
                            client.sendText(
                                conn,
                                envelope(Protocol.TYPE_HEARTBEAT, peerFullId) {}.toString()
                            )
                        }.isSuccess
                        if (!alive) return@launch
                    }
                }
                // 上传连接在 accept 之后才建立；提前声明让 finally 能关到它
                var upload: javax.net.ssl.SSLSocket? = null
                try {
                    // announce：对端靠它知道我们是谁，并据此查信任清单。
                    // 少了这一步，对端会因 peerId 为空而丢弃后续所有消息。
                    client.sendText(
                        conn,
                        envelope(Protocol.TYPE_ANNOUNCE, "") {
                            put("displayName", displayName)
                            put("deviceType", deviceType)
                            put("caps", org.json.JSONArray(Protocol.DEFAULT_GRANT_SCOPE))
                            put("fingerprint", fingerprint)
                        }.toString()
                    )

                    val metas = files.map { f ->
                        JSONObject().apply {
                            put("name", f.name)
                            put("size", f.size)
                        }
                    }
                    client.sendText(
                        conn,
                        envelope(Protocol.TYPE_TRANSFER_OFFER, peerFullId) {
                            put("transferId", transferId)
                            put("files", org.json.JSONArray(metas))
                            put("totalSize", totalSize)
                        }.toString()
                    )
                    Log.i(TAG, "已发起传输任务 $transferId，${files.size} 个文件")

                    // 等 accept。拒绝/错误都带 reason，直接抛给调用方展示。
                    // 信封按协议 §3 过滤：v/to/ts 不合的消息直接跳过
                    var token: String? = null
                    val deadline = System.currentTimeMillis() + 60_000
                    val myPrefix = identity.get().fingerprint.replace(":", "").take(12)
                    while (token == null && System.currentTimeMillis() < deadline) {
                        val text = client.readText(conn) ?: error("控制通道已关闭")
                        val msg = runCatching { JSONObject(text) }.getOrNull() ?: continue
                        val to = msg.optString("to")
                        if (msg.optInt("v", -1) != Protocol.VERSION) continue
                        if (to.isNotEmpty() && to != myPrefix) continue
                        if (kotlin.math.abs(System.currentTimeMillis() - msg.optLong("ts", 0L)) > 60_000) continue
                        when (msg.optString("type")) {
                            Protocol.TYPE_TRANSFER_ACCEPT ->
                                token = msg.optJSONObject("payload")?.optString("token")
                            Protocol.TYPE_TRANSFER_REJECT ->
                                error("对方拒绝接收：${msg.optJSONObject("payload")?.optString("reason") ?: "未知原因"}")
                            Protocol.TYPE_TRANSFER_ERROR ->
                                error("传输失败：${msg.optJSONObject("payload")?.optString("message") ?: "未知原因"}")
                        }
                    }
                    val tok = token ?: error("等待对方确认超时")
                    Log.i(TAG, "任务 $transferId 已被接受，开始推送")
                    setOutgoingState(transferId, TransferTask.ACCEPTED)

                    // 分块上传走独立连接：控制通道已是 WebSocket，
                    // 在它上面再发 HTTP 请求会把对端解析器炸掉
                    upload = client.connectUpload(peer.host, peer.port, expectedFp)

                    val myId = identity.get().fingerprint.replace(":", "").take(12)
                    val chunk = client.chunkSize()
                    var sent = 0L
                    for (f in files) {
                        // key 必须是 transferId:fileName：桌面端数据面按该组合键路由，
                        // 用裸 transferId 会 404（Android 接收侧曾踩过这个坑）
                        val key = "$transferId:${f.name}"
                        var offset = 0L
                        f.inputStream().use { inp ->
                            val buf = ByteArray(chunk)
                            while (true) {
                                val n = inp.read(buf)
                                if (n <= 0) break
                                val data = if (n == buf.size) buf else buf.copyOf(n)
                                val digest = client.chunkDigest(data)
                                // offset 必须随块上报：桌面端强制偏移衔接（409 对齐冲突），
                                // 缺省会被当成 0，从第二块起必撞 409。
                                // 组合键必须百分号编码：文件名含空格/中文/+ 时裸拼
                                // 会发出畸形 URL（审查 P1-8，SAF 文件名极常见）
                                val path = Protocol.chunkPath(Protocol.encodeTransferKey(key)) + "?offset=$offset"
                                // 失败重试一次：单块 4MB，重传成本低于整体重来
                                var attempt = 0
                                while (true) {
                                    val (status, body) = client.postChunk(
                                        upload, peer.host, peer.port, path, myId, tok, data, digest
                                    )
                                    if (status == 200) break
                                    attempt++
                                    if (attempt >= 2) error("分块上传失败 $status: $body")
                                    Log.w(TAG, "分块 ${key}@$offset 返回 $status，重试")
                                }
                                offset += n
                                sent += n
                                updateOutgoingProgress(transferId, sent)
                            }
                        }
                    }

                    // complete 带整体摘要：桌面端据此校验，不符则删 .part 不落盘
                    val digests = JSONObject()
                    files.forEach { f -> digests.put(f.name, client.fileDigest(f.inputStream())) }
                    client.sendText(
                        conn,
                        envelope(Protocol.TYPE_TRANSFER_COMPLETE, peerFullId) {
                            put("transferId", transferId)
                            put("digests", digests)
                        }.toString()
                    )
                    Log.i(TAG, "任务 $transferId 已推送完成，共 $sent 字节")
                    setOutgoingState(transferId, TransferTask.COMPLETED)
                    files.size
                } finally {
                    // WIP 版本只在成功路径关连接，中途 error() 会把 TLS socket 泄漏掉
                    heartbeat.cancel()
                    upload?.let { u -> runCatching { u.close() } }
                    client.close(conn)
                }
            }.onFailure { err ->
                // 发送中途的任何失败都要在任务列表留下痕迹
                failOutgoing(transferId, err.message ?: "发送失败")
            }
        }
    }

    // ---------- 发送任务的界面状态推进（接收路径对应 handleOffer / finalizeTask） ----------

    private fun registerOutgoing(transferId: String, peerId: String, files: List<OutgoingFile>) {
        taskMap[transferId] = TransferTask(
            id = transferId,
            direction = "send",
            peerId = peerId,
            state = TransferTask.OFFERED,
            files = files.map { TransferFile(name = it.name, size = it.size) },
            totalSize = files.sumOf { it.size },
            transferred = 0,
            createdAt = System.currentTimeMillis()
        )
        _transfers.value = taskMap.values.sortedBy { it.createdAt }
    }

    private fun setOutgoingState(transferId: String, state: String) {
        taskMap[transferId]?.let {
            taskMap[transferId] = it.copy(state = state)
            _transfers.value = taskMap.values.sortedBy { it.createdAt }
        }
    }

    private fun updateOutgoingProgress(transferId: String, transferred: Long) {
        taskMap[transferId]?.let {
            taskMap[transferId] = it.copy(transferred = transferred)
            _transfers.value = taskMap.values.sortedBy { it.createdAt }
        }
    }

    private fun failOutgoing(transferId: String, message: String) {
        taskMap[transferId]?.let {
            if (it.direction == "send" && it.state != TransferTask.COMPLETED) {
                taskMap[transferId] = it.copy(state = TransferTask.FAILED, error = message)
                _transfers.value = taskMap.values.sortedBy { it.createdAt }
            }
        }
    }

    // ---------- 传输 ----------

    private fun handleOffer(transferId: String, files: List<TransferFile>, peerId: String) {
        val saveDir = File(appContext.getExternalFilesDir(null), "LinkSpace")
        saveDirs[transferId] = saveDir
        val task = TransferTask(
            id = transferId,
            direction = "receive",
            peerId = peerId,
            state = TransferTask.OFFERED,
            files = files,
            totalSize = files.sumOf { it.size },
            transferred = 0,
            createdAt = System.currentTimeMillis()
        )
        taskMap[transferId] = task
        _transfers.value = taskMap.values.sortedBy { it.createdAt }
        Log.i(TAG, "收到传输任务 $transferId，${files.size} 个文件")
    }

    /** 用户确认接收：登记落盘路径并生成数据面令牌 */
    fun acceptTransfer(transferId: String): Result<String> {
        val task = taskMap[transferId] ?: return Result.failure(IllegalStateException("任务不存在"))
        val srv = server ?: return Result.failure(IllegalStateException("服务未启动"))
        val saveDir = saveDirs[transferId] ?: return Result.failure(IllegalStateException("保存目录丢失"))

        val token = java.util.UUID.randomUUID().toString()
        // 落盘登记可能因文件名/磁盘问题抛 IOException——必须变成 Result
        // 让界面提示，而不是把进程带走（审查 P1-4：点「接收」即崩）
        try {
            srv.registerIncoming(transferId, task.files, saveDir)
        } catch (e: Exception) {
            taskMap[transferId] = task.copy(state = TransferTask.FAILED, error = e.message ?: "登记落盘失败")
            _transfers.value = taskMap.values.sortedBy { it.createdAt }
            return Result.failure(IllegalStateException(e.message ?: "登记落盘失败"))
        }
        srv.setToken(transferId, token)
        taskMap[transferId] = task.copy(state = TransferTask.ACCEPTED)
        _transfers.value = taskMap.values.sortedBy { it.createdAt }
        // 必须把 accept 和令牌发回发送方：桌面端收到它才会开始推送分块。
        // 少了这一步，界面显示「已接收」但数据永远不来——曾踩过。
        // 定向发送：token 是数据面唯一凭证，广播等于交给连着的每一台
        // 设备（包括未认证连接）——全项目审查 P0-2
        val peer = task.peerId
        if (peer.isNotEmpty()) {
            srv.sendControlTo(
                peer,
                envelope(Protocol.TYPE_TRANSFER_ACCEPT, peer) {
                    put("transferId", transferId)
                    put("token", token)
                }
            )
        } else {
            Log.w(TAG, "任务 $transferId 没有对端 ID，无法回 accept")
        }
        Log.i(TAG, "已接受传输任务 $transferId")
        return Result.success(token)
    }

    fun cancelTransfer(transferId: String) {
        server?.cancel(transferId)
        taskMap[transferId]?.let {
            taskMap[transferId] = it.copy(state = TransferTask.CANCELLED)
        }
        _transfers.value = taskMap.values.sortedBy { it.createdAt }
    }

    /**
     * 发送方推完了：校验大小与整体摘要，通过才落盘。
     * 失败则任务置 failed 并删掉 .part，绝不把半成品变成正式文件。
     */
    private fun finalizeTask(transferId: String, digests: Map<String, String>) {
        val task = taskMap[transferId] ?: return
        if (task.state == TransferTask.CANCELLED || task.state == TransferTask.FAILED) {
            // complete 可能乱序到达，半成品不得变成正式文件
            Log.w(TAG, "任务 $transferId 状态为 ${task.state}，放弃落盘")
            return
        }
        val srv = server
        if (srv == null) {
            taskMap[transferId] = task.copy(state = TransferTask.FAILED, error = "服务未启动")
            _transfers.value = taskMap.values.sortedBy { it.createdAt }
            return
        }
        srv.finalizeTransfer(transferId, digests)
            .onSuccess { count ->
                taskMap[transferId] = task.copy(
                    state = TransferTask.COMPLETED,
                    transferred = task.totalSize
                )
                _transfers.value = taskMap.values.sortedBy { it.createdAt }
                Log.i(TAG, "传输任务 $transferId 已完成，落盘 $count 个文件")
            }
            .onFailure { err ->
                taskMap[transferId] = task.copy(
                    state = TransferTask.FAILED,
                    error = err.message ?: "落盘失败"
                )
                _transfers.value = taskMap.values.sortedBy { it.createdAt }
                Log.e(TAG, "传输任务 $transferId 落盘失败: ${err.message}")
            }
    }

    /** 供界面显示：任务的落盘目录 */
    fun saveDirFor(transferId: String): File? = saveDirs[transferId]
}
