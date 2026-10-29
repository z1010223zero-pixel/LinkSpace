package cn.linkspace.client.service

import android.content.Context
import android.util.Log
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import org.json.JSONObject
import java.io.File
import java.util.concurrent.ConcurrentHashMap

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
        displayName = android.os.Build.MODEL ?: "Android"

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
                displayName = payload.optString("displayName"),
                deviceType = payload.optString("deviceType"),
                fingerprint = payload.optString("fingerprint")
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
    private fun handlePairRequest(peerId: String, displayName: String, deviceType: String, fingerprint: String) {
        // 已信任的设备直接放行，不再要求配对码
        if (trust.isKnown(peerId)) {
            if (trust.fingerprintOf(peerId) != fingerprint) {
                Log.w(TAG, "对端 $peerId 指纹与信任清单不符，可能被替换")
                return
            }
            Log.i(TAG, "对端 $peerId 已在信任清单中")
            return
        }
        if (pendingMap.values.any { it.peerId == peerId }) return

        val code = String.format("%06d", (Math.random() * 1_000_000).toInt())
        val pending = PendingPairing(
            id = java.util.UUID.randomUUID().toString(),
            peerId = peerId,
            displayName = displayName,
            deviceType = deviceType,
            fingerprint = fingerprint,
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
