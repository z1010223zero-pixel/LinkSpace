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
        val expiresAt: Long
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

        val srv = TransferServer(
            identity = identity,
            trust = trust,
            onComplete = { transferId, digests -> finalizeTask(transferId, digests) }
        )
        srv.start()
        server = srv
        _port.value = srv.port
        srv.controlHandler = { msg -> onControlMessage(msg) }
        // 对端断连时清掉它留下的待确认配对请求，避免僵尸条目
        srv.controlClosedHandler = { peerId ->
            val stale = pendingMap.values.filter { it.peerId == peerId }
            if (stale.isNotEmpty()) {
                stale.forEach { pendingMap.remove(it.id) }
                _pendingPairings.value = pendingMap.values.toList()
                Log.i(TAG, "对端 $peerId 已断连，清理 ${stale.size} 个待确认配对请求")
            }
            announcedConnections.remove(peerId)
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
     * 处理桌面端发来的控制消息。
     * 信封字段与桌面端一致，`from` 是对端设备 ID。
     */
    private fun onControlMessage(msg: JSONObject) {
        val type = msg.optString("type")
        val from = msg.optString("from")
        val payload = msg.optJSONObject("payload") ?: JSONObject()
        when (type) {
            Protocol.TYPE_ANNOUNCE -> {
                Log.i(TAG, "对端声明身份: $from")
                // 回应自己的身份，让对方知道我们是谁（每连接只回一次）
                server?.sendControl(
                    JSONObject().apply {
                        put("v", Protocol.VERSION)
                        put("type", Protocol.TYPE_ANNOUNCE)
                        put("id", java.util.UUID.randomUUID().toString())
                        put("from", deviceIdPrefix)
                        put("to", from)
                        put("ts", System.currentTimeMillis())
                        put(
                            "payload", JSONObject().apply {
                                put("displayName", displayName)
                                put("deviceType", deviceType)
                                put("caps", org.json.JSONArray(Protocol.DEFAULT_GRANT_SCOPE))
                                put("fingerprint", fingerprint)
                            }
                        )
                    }
                )
            }

            Protocol.TYPE_PAIR_REQUEST -> handlePairRequest(
                peerId = from,
                peerDisplayName = payload.optString("displayName"),
                peerDeviceType = payload.optString("deviceType"),
                peerFingerprint = payload.optString("fingerprint")
            )

            Protocol.TYPE_PAIR_SUBMIT -> {
                // 桌面端把用户输入的配对码送来，校验通过即建立信任
                val code = payload.optString("code")
                val pending = pendingMap.values.firstOrNull { it.peerId == from }
                if (pending == null) {
                    server?.sendControl(pairError(from, "没有待确认的配对请求"))
                    return
                }
                val result = submitPairingCode(pending.id, code)
                if (result.isSuccess) {
                    // 信任已建立，通告对端
                    server?.sendControl(
                        JSONObject().apply {
                            put("v", Protocol.VERSION)
                            put("type", Protocol.TYPE_PAIR_APPROVE)
                            put("id", java.util.UUID.randomUUID().toString())
                            put("from", deviceIdPrefix)
                            put("to", from)
                            put("ts", System.currentTimeMillis())
                            put(
                                "payload", JSONObject().apply {
                                    put("deviceId", deviceIdPrefix)
                                    put("displayName", displayName)
                                    put("deviceType", deviceType)
                                    put("fingerprint", fingerprint)
                                    put("scope", org.json.JSONArray(Protocol.DEFAULT_GRANT_SCOPE))
                                }
                            )
                        }
                    )
                } else {
                    server?.sendControl(
                        pairError(from, result.exceptionOrNull()?.message ?: "配对失败")
                    )
                }
            }

            Protocol.TYPE_PAIR_REJECT -> {
                pendingMap.values.filter { it.peerId == from }.forEach { pendingMap.remove(it.id) }
                _pendingPairings.value = pendingMap.values.toList()
            }

            Protocol.TYPE_PAIR_REVOKE -> {
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
                    server?.sendControl(
                        envelope(Protocol.TYPE_TRANSFER_ERROR, from) {
                            put("code", "SCOPE_DENIED")
                            put("message", "设备未授权")
                        }
                    )
                    return
                }
                val transferId = payload.optString("transferId")
                val filesArr = payload.optJSONArray("files") ?: org.json.JSONArray()
                val files = (0 until filesArr.length()).map {
                    val o = filesArr.getJSONObject(it)
                    TransferFile(name = o.optString("name"), size = o.optLong("size"))
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
                cancelTransfer(payload.optString("transferId"))
            }

            Protocol.TYPE_TRANSFER_COMPLETE -> {
                // 发送方推完了，带着每个文件的整体摘要。
                // 校验通过才落盘——这一环缺失时文件永远停在 .part。
                val transferId = payload.optString("transferId")
                val digestsObj = payload.optJSONObject("digests") ?: JSONObject()
                val digests = mutableMapOf<String, String>()
                digestsObj.keys().forEach { k -> digests[k] = digestsObj.optString(k) }
                server?.let { srv ->
                    // 走 finalizeTask 的统一入口，保证状态检查与错误处理一致
                    finalizeTask(transferId, digests)
                }
            }
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
    // 参数带 peer 前缀：pair.request 载荷里的身份是**对端（桌面）自报**的。
    // 曾用无前缀参数名与 companion 属性同名，快速通道 approve 里
    // `put("displayName", displayName)` 被遮蔽解析到参数——平板在「我是谁」
    // 的回执里发成了桌面的名字/类型/指纹，桌面入库后信任清单出现
    // 「平板证书 + 桌面名字」的缝合条目（真机踩过）。
    private fun handlePairRequest(peerId: String, peerDisplayName: String, peerDeviceType: String, peerFingerprint: String) {
        // 已信任的设备直接放行，不再要求配对码。
        // 必须回 pair.approve：桌面端对已信任对端也是直接 approve
        // （pairing.ts「若已信任，直接放行」），两端语义必须对称——
        // 曾在这里静默 return，发起方永远等不到响应，连接挂到断开，
        // UI 表现为「点了配对没反应」（真机踩过）。
        if (trust.isKnown(peerId)) {
            val known = trust.fingerprintOf(peerId)
            if (known != null && known != peerFingerprint) {
                Log.w(TAG, "对端 $peerId 指纹与信任清单不符，可能被替换")
                server?.sendControl(pairError(peerId, "设备指纹与已存记录不符，请撤销后重新配对"))
                return
            }
            Log.i(TAG, "对端 $peerId 已在信任清单中，直接确认")
            val entry = trust.list().firstOrNull { it.deviceId == peerId }
            server?.sendControl(
                JSONObject().apply {
                    put("v", Protocol.VERSION)
                    put("type", Protocol.TYPE_PAIR_APPROVE)
                    put("id", java.util.UUID.randomUUID().toString())
                    put("from", deviceIdPrefix)
                    put("to", peerId)
                    put("ts", System.currentTimeMillis())
                    put(
                        "payload", JSONObject().apply {
                            put("deviceId", deviceIdPrefix)
                            put("displayName", displayName)
                            put("deviceType", deviceType)
                            put("fingerprint", fingerprint)
                            // 沿用已存条目的授权范围，不重新扩权
                            put("scope", org.json.JSONArray(entry?.scope ?: Protocol.DEFAULT_GRANT_SCOPE))
                        }
                    )
                }
            )
            return
        }
        if (pendingMap.values.any { it.peerId == peerId }) return

        val code = String.format("%06d", (Math.random() * 1_000_000).toInt())
        val pending = PendingPairing(
            id = java.util.UUID.randomUUID().toString(),
            peerId = peerId,
            displayName = peerDisplayName,
            deviceType = peerDeviceType,
            fingerprint = peerFingerprint,
            code = code,
            expiresAt = System.currentTimeMillis() + 60_000
        )
        pendingMap[pending.id] = pending
        _pendingPairings.value = pendingMap.values.toList()
        // 必须回 challenge：发起方靠它知道「该去要配对码了」。
        // 少了这一步，发起方只会静默等待直到心跳超时。
        server?.sendControl(
            JSONObject().apply {
                put("v", Protocol.VERSION)
                put("type", Protocol.TYPE_PAIR_CHALLENGE)
                put("id", java.util.UUID.randomUUID().toString())
                put("from", deviceIdPrefix)
                put("to", peerId)
                put("ts", System.currentTimeMillis())
                put("payload", JSONObject().apply { put("expiresAt", pending.expiresAt) })
            }
        )
        // 配对码只在日志里留一次，方便联调时读取；界面上也会展示
        Log.i(TAG, "收到 $peerId 的配对请求，配对码 = ${pending.code}，等待用户确认")
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
     * 启用剪贴板同步。读写由调用方注入：
     * Android 10 起后台应用读不到剪贴板，所以注入时机由界面在前台时控制。
     */
    fun enableClipboardSync(io: ClipboardSync.ClipboardIo) {
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

        // 任务先登记再连接：界面从 offer 那一刻起就有进度可看，
        // 而不是等整条链路走完才冒出来
        val transferId = "tr-${java.util.UUID.randomUUID().toString().take(8)}"
        val totalSize = files.sumOf { it.size }
        registerOutgoing(transferId, peer.idPrefix, files)

        return withContext(Dispatchers.IO) {
            runCatching {
                val conn = client.connectControl(peer.host, peer.port, Protocol.CONTROL_PATH)
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

                    // 等 accept。拒绝/错误都带 reason，直接抛给调用方展示
                    var token: String? = null
                    val deadline = System.currentTimeMillis() + 60_000
                    while (token == null && System.currentTimeMillis() < deadline) {
                        val text = client.readText(conn) ?: error("控制通道已关闭")
                        val msg = runCatching { JSONObject(text) }.getOrNull() ?: continue
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
                    upload = client.connectUpload(peer.host, peer.port)

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
                                // 缺省会被当成 0，从第二块起必撞 409
                                val path = Protocol.chunkPath(key) + "?offset=$offset"
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
        srv.registerIncoming(transferId, task.files, saveDir)
        srv.setToken(transferId, token)
        taskMap[transferId] = task.copy(state = TransferTask.ACCEPTED)
        _transfers.value = taskMap.values.sortedBy { it.createdAt }
        // 必须把 accept 和令牌发回发送方：桌面端收到它才会开始推送分块。
        // 少了这一步，界面显示「已接收」但数据永远不来——曾踩过。
        val peer = task.peerId
        if (peer.isNotEmpty()) {
            srv.sendControl(
                JSONObject().apply {
                    put("v", Protocol.VERSION)
                    put("type", Protocol.TYPE_TRANSFER_ACCEPT)
                    put("id", java.util.UUID.randomUUID().toString())
                    put("from", deviceIdPrefix)
                    put("to", peer)
                    put("ts", System.currentTimeMillis())
                    put(
                        "payload", JSONObject().apply {
                            put("transferId", transferId)
                            put("token", token)
                        }
                    )
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
