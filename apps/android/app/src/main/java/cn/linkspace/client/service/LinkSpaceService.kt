package cn.linkspace.client.service

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.util.Log
import android.view.KeyEvent
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
        private const val KEY_STREAM_MODE = "streamMode"
        const val STREAM_MODE_AUTO = "auto"
        const val STREAM_MODE_FAST = "fast"
        const val STREAM_MODE_COMPAT = "compat"
        private const val MSG_SCREEN_STREAM_KEYFRAME = "screen.stream.keyframe"
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

    /**
     * 界面用的指纹流。start() 异步化后，首次启动时证书生成（RSA 2048 +
     * BC 签名 + 文件 IO）在后台线程进行，UI 不能再直接调 [fingerprint]——
     * 那会在主线程上阻塞在同一把 Identity 锁上，把 ANR 从启动线程挪到
     * 渲染线程。流在证书就绪前为空串，界面据此显示「初始化中」。
     */
    private val _fingerprintText = MutableStateFlow("")
    val fingerprintText: StateFlow<String> = _fingerprintText

    @Volatile
    private var started = false

    fun start() {
        // 异步化：首次启动的证书生成可能耗时数百毫秒到数秒（低端机），
        // 在 Application.onCreate 的主线程上同步做会拖慢冷启动甚至 ANR。
        // 身份就绪前 TransferServer/Discovery 都起不来，所以整个启动
        // 序列一起挪到后台线程；Identity.get() 自带锁与缓存，并发安全
        if (!started) {
            started = true
            Thread({ startBlocking() }, "linkspace-start").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun startBlocking() {
        trust.load()
        _trusted.value = trust.list()

        val cert = identity.get()
        _fingerprintText.value = cert.fingerprint
        deviceIdPrefix = cert.fingerprint.replace(":", "").take(12)
        displayName = prefs.getString(KEY_DISPLAY_NAME, null)?.takeIf { it.isNotBlank() }
            ?: (android.os.Build.MODEL ?: "Android")
        _selfName.value = displayName
        _clipboardEnabled.value = prefs.getBoolean(KEY_CLIPBOARD_SYNC, false)
        _streamMode.value = prefs.getString(KEY_STREAM_MODE, STREAM_MODE_AUTO) ?: STREAM_MODE_AUTO

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
            controlledInput.onPeerDisconnected(peerId)
            displayExtend.onPeerDisconnected(peerId)
            reverseScreen.onPeerDisconnected(peerId)
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
        // 出站控制连接随服务一起下线；先停 server 再关，input.stop 已在
        // stopAll 里把 session.stop 发出去
        closeOutbound()
        // 允许同一进程内重新 start（用户退出后再进）：start() 的
        // 幂等闸门要跟着复位
        started = false
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
        // 前置门禁（审查 P0）：未完成 device.announce（含 TLS 证书指纹核验）的连接，
        // 拒绝处理任何业务控制消息，防止攻击者跳过 announce 冒用已信任 peerId 触发免确认远控或剪贴板同步。
        if (type != Protocol.TYPE_ANNOUNCE && type != Protocol.TYPE_HEARTBEAT && !ctx.isAnnounced) {
            Log.w(TAG, "拒绝未完成 device.announce 的控制消息: type=$type from=$from，断开连接")
            ctx.close()
            return
        }
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
                        ctx.send(pairError(from, "设备指纹与已存记录不符，请撤销后重新配对"))
                        ctx.close()
                        return
                    }
                    Log.i(TAG, "对端 $from 已在信任清单中（证书指纹一致）")
                } else {
                    Log.i(TAG, "对端声明身份: $from")
                }
                ctx.markAnnounced()
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
                input.onPeerDisconnected(from)
                controlledInput.onTrustRevoked(from)
                displayExtend.onPeerDisconnected(from)
                reverseScreen.onTrustRevoked(from)
                taskMap.values
                    .filter { it.peerId == from && it.state !in listOf(TransferTask.COMPLETED, TransferTask.FAILED, TransferTask.CANCELLED) }
                    .forEach { cancelTransfer(it.id) }
                server?.closePeer(from)
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
                        name = TransferServer.sanitizeFileName(o.optString("name")),
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

            Protocol.TYPE_CLIPBOARD_SHARE -> handleClipboardShare(from, payload)

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
            // session.accept/reject/stop 按 sessionId 各自匹配：input 与
            // display-extend 控制器各认自己的挂起/活动会话，不匹配的安全忽略。
            Protocol.TYPE_SESSION_ACCEPT -> {
                input.onAccepted(from, payload)
                displayExtend.onAccepted(from, payload)
            }
            Protocol.TYPE_SESSION_REJECT -> {
                input.onRejected(from, payload)
                displayExtend.onRejected(from, payload)
            }
            Protocol.TYPE_SESSION_STOP -> {
                input.onStopped(from, payload)
                controlledInput.onStop(from, payload)
                displayExtend.onStopped(from, payload)
            }

            // ---------- 电脑→安卓远控（4.6，被控端半边，线 2 W4 骨架） ----------
            // session.start / input.event 只可能发给被控端；session.stop 双向，
            // 控制端与被控端各按 sessionId 匹配，不匹配的安全忽略。
            Protocol.TYPE_SESSION_START -> controlledInput.onStart(from, payload)
            Protocol.TYPE_INPUT_EVENT -> controlledInput.onEvent(from, payload)
            Protocol.TYPE_INPUT_TEXT -> controlledInput.onText(from, payload)
            Protocol.TYPE_SCREEN_PASTE -> controlledInput.onScreenPaste(from, payload)

            // ---------- 反向投屏（4.7，线 2 W6）：桌面看平板画面 ----------
            // 与 input 会话解耦：反向流的启停不以活动 input 会话为前提，
            // 授权门是平板端的 MediaProjection 系统录屏授权。
            Protocol.TYPE_SCREEN_STREAM_REQUEST -> CoroutineScope(Dispatchers.IO).launch {
                // 反向视频帧只能走平板主动连出的控制连接。电脑主动连入时，
                // 本端只有入站链路；这里必须先补建出站链路，否则帧全部丢弃。
                // connectControl 建链失败会抛异常（TLS/握手失败），必须兜住：
                // 否则协程静默崩溃、桌面收不到 screen.stream.error，会一直
                // 停在“暂无画面”，而平板侧 TTL 也从未启动（onRequest 没跑到）。
                val ready = runCatching { ensureOutboundForPeerId(from) }
                    .onFailure { Log.w(TAG, "反向投屏补建出站视频通道失败: $from", it) }
                    .getOrDefault(false)
                if (!ready) {
                    Log.w(TAG, "反向投屏请求无可用出站视频通道: $from")
                    sendControlMessage(from, Protocol.TYPE_SCREEN_STREAM_ERROR) {
                        put("message", "反向投屏视频通道未建立")
                    }
                    return@launch
                }
                reverseScreen.onRequest(from, payload)
            }
            Protocol.TYPE_SCREEN_STREAM_STOP -> handleScreenStreamStop(from, payload)
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
        val changed = trust.revoke(deviceId)
        _trusted.value = trust.list()
        if (!changed) return
        // 通知对端本机已撤销信任（与桌面端 pairing.ts revoke 语义对齐）
        sendControlMessage(deviceId, Protocol.TYPE_PAIR_REVOKE) {
            put("deviceId", deviceIdPrefix)
        }
        // 安全红线 §6：撤销信任必须级联断开全部活动会话、取消挂起传输并关闭连接
        input.onPeerDisconnected(deviceId)
        controlledInput.onTrustRevoked(deviceId)
        displayExtend.onPeerDisconnected(deviceId)
        reverseScreen.onTrustRevoked(deviceId)
        taskMap.values
            .filter {
                it.peerId == deviceId &&
                    it.state != TransferTask.COMPLETED &&
                    it.state != TransferTask.FAILED &&
                    it.state != TransferTask.CANCELLED
            }
            .forEach { cancelTransfer(it.id) }
        val stalePairings = pendingMap.values.filter { it.peerId == deviceId }
        if (stalePairings.isNotEmpty()) {
            stalePairings.forEach { pendingMap.remove(it.id) }
            _pendingPairings.value = pendingMap.values.toList()
        }
        announcedConnections.remove(deviceId)
        server?.closePeer(deviceId)
        if (outbound?.peerId == deviceId) {
            closeOutbound()
        }
        Log.i(TAG, "已撤销对 $deviceId 的信任并级联清理全部会话与连接")
    }

    // ---------- 信任设备清单（Bug 2：确认框“以后不再询问”） ----------

    /**
     * 该设备是否被用户标记为免确认信任设备（有效期内建会话跳过确认框）。
     */
    fun isNoConfirmTrusted(deviceId: String): Boolean =
        trust.isNoConfirmValid(deviceId)

    /**
     * 给已配对设备设置免确认有效期：
     * durationMs < 0 = 永久有效，> 0 = 有效毫秒数，0 = 每次询问
     */
    fun grantNoConfirmTrust(deviceId: String, durationMs: Long = -1L) {
        if (trust.grantNoConfirmDuration(deviceId, durationMs)) {
            _trusted.value = trust.list()
            Log.i(TAG, "已设置设备 $deviceId 免确认有效期 durationMs=$durationMs")
        }
    }

    /** 设置页撤销单个信任：只摘免确认标记，设备仍保持配对，下次再弹确认框 */
    fun revokeNoConfirmTrust(deviceId: String) {
        if (trust.revokeScope(deviceId, Protocol.SCOPE_NO_CONFIRM)) {
            _trusted.value = trust.list()
            Log.i(TAG, "已撤销设备 $deviceId 的免确认信任")
        }
    }

    /** 设置页一键清空信任清单：只摘全部设备的免确认标记，不动配对关系 */
    fun clearNoConfirmTrust() {
        if (trust.clearScope(Protocol.SCOPE_NO_CONFIRM) > 0) {
            _trusted.value = trust.list()
            Log.i(TAG, "已清空信任清单（免确认标记）")
        }
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

    /**
     * 处理收到的 clipboard.share（入站服务与出站控制连接共用）：
     * - 校验 clipboard 授权与 text 类型；
     * - 剪贴板同步开关关闭时不写入；
     * - 界面在前台（clipboard != null）时走 ClipboardSync.receive（含回环抑制）；
     * - 界面在后台（如用户在 Chrome 内接受远控，onPause 停了剪贴板读取轮询）时，
     *   写系统剪贴板不受 Android 10+ 后台读取限制，按 512 KiB 上限校验后投递主线程写入；
     *   回前台 enableClipboardSync 时 start() 会重读基线，不会触发回环。
     */
    private fun handleClipboardShare(from: String, payload: JSONObject) {
        if (!trust.hasScope(from, "clipboard")) {
            Log.w(TAG, "拒绝未授权设备的 clipboard.share: $from")
            return
        }
        val kind = payload.optString("kind", "text")
        if (kind != "text") return
        val text = payload.optString("text")
        Log.i(TAG, "收到 clipboard.share，${text.length} 字符")
        if (!_clipboardEnabled.value) return
        val sync = clipboard
        if (sync != null) {
            sync.receive(text)
            return
        }
        if (text.isEmpty()) return
        if (text.toByteArray(Charsets.UTF_8).size > 512 * 1024) {
            Log.w(TAG, "远端剪贴板内容超过上限 512 KiB，已丢弃")
            return
        }
        mainHandler.post {
            runCatching {
                val cm = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                cm?.setPrimaryClip(ClipData.newPlainText("LinkSpace", text))
            }.onFailure {
                Log.w(TAG, "后台写入剪贴板失败: ${it.message}")
            }
        }
    }

    /** 只发给持有 clipboard 授权的对端（覆盖入站与主动连出的控制连接），不做全量广播 */
    private fun broadcastClipboard(text: String) {
        val peerIds = LinkedHashSet<String>()
        server?.connectedPeerIds()?.let { peerIds.addAll(it) }
        outbound?.peerId?.let { peerIds.add(it) }
        if (peerIds.isEmpty()) return
        var sent = 0
        peerIds.forEach { peerId ->
            if (!trust.hasScope(peerId, "clipboard")) return@forEach
            sendControlMessage(peerId, Protocol.TYPE_CLIPBOARD_SHARE) {
                put("kind", "text")
                put("text", text)
            }
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
        val remoteScreen: InputController.Screen? = null,
        val ownScreen: InputController.Screen? = null // 本端申报的触控坐标空间
    )

    private val _inputState = MutableStateFlow(InputState())
    val inputState: StateFlow<InputState> = _inputState

    // ---------- 平板当扩展屏（协议 4.3，控制端半边，线 3） ----------

    /** 扩展屏会话的界面状态：idle / waiting / active */
    data class ExtendState(
        val phase: String = "idle",
        val peerId: String? = null,
        /** 虚拟显示器在虚拟屏坐标系里的矩形（触控映射与推流尺寸基准） */
        val virtualScreen: DisplayExtendController.VirtualScreen? = null
    )

    private val _extendState = MutableStateFlow(ExtendState())
    val extendState: StateFlow<ExtendState> = _extendState

    /** 会话结束原因（一次性提示，界面读后可清空） */
    private val _inputMessage = MutableStateFlow("")
    val inputMessage: StateFlow<String> = _inputMessage

    // ---------- 电脑→安卓远控（协议 4.6，被控端半边，线 2 W5） ----------

    /** 待用户确认的控制请求：非空时 MainActivity 弹确认弹窗 */
    private val _controlRequest = MutableStateFlow<ControlledInputSession.ControlRequest?>(null)
    val controlRequest: StateFlow<ControlledInputSession.ControlRequest?> = _controlRequest

    /** 正控制本机的对端 peerId，未被控制时为 null */
    private val _controlledBy = MutableStateFlow<String?>(null)
    val controlledBy: StateFlow<String?> = _controlledBy

    /** 无障碍服务是否已开启（授权状态在 App 内可见，任务 2.4-1） */
    private val _accessibilityEnabled = MutableStateFlow(false)
    val accessibilityEnabled: StateFlow<Boolean> = _accessibilityEnabled

    /**
     * 出站控制连接的串行写执行器。键鼠事件从 Compose 触摸处理器（主线程）
     * 进来，直接写 TLS socket 会 NetworkOnMainThreadException 崩掉整个
     * 应用（T7 走查实录，崩溃栈直达 ClientConnection.sendText）；单线程
     * 顺带保住 down/up 事件的提交顺序——TLS 层的 synchronized(out) 只保
     * 帧原子不保跨消息顺序。与 WebSocketConnection.send 的 submitWrite
     * 同一设计。daemon 线程常驻不随服务关闭（空转无消耗，shutdown 会让
     * 用户退出后再进时提交被拒）。
     */
    private val outboundWriter =
        java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "linkspace-outbound-write").apply { isDaemon = true }
        }

    /**
     * 控制消息出站路由（控制端 [input] 与被控端 [controlledInput] 共用）：
     * 出站连接（本端主动连出的控制通道）优先，否则走入站服务回发。
     * 提交到写线程执行，禁止在调用线程（可能是 UI 线程）直接写 socket。
     */
    private fun sendControlMessage(peerId: String, type: String, payload: JSONObject.() -> Unit) {
        // 出站连接（本端主动连出的控制通道）优先：桌面端只把消息
        // 投递给自己 accept 进来的连接，主动发起控制时只有这条
        // 出站链路能把 session.start/事件送进桌面端。
        val out = outbound
        if (out != null && out.peerId == peerId) {
            val text = envelope(type, peerId, payload).toString()
            val conn = out.conn
            Log.d(TAG, "out-> $type ${text.length}B")
            outboundWriter.execute {
                runCatching { client.sendText(conn, text) }
                    .onFailure { Log.w(TAG, "out-send 失败: ${it.javaClass.simpleName}: ${it.message}") }
            }
        } else {
            Log.w(TAG, "send 走入站路由（out=${out?.peerId}, peer=$peerId）")
            server?.sendControlTo(peerId, envelope(type, peerId, payload))
        }
    }

    val input: InputController by lazy {
        InputController(
            send = { peerId, type, payloadFn -> sendControlMessage(peerId, type, payloadFn) },
            listener = object : InputController.Listener {
                override fun onSessionActive(peerId: String, sessionId: String, remoteScreen: InputController.Screen) {
                    _inputState.value = InputState("active", peerId, remoteScreen, input.declaredScreen)
                }

                override fun onSessionEnded(reason: String) {
                    _inputMessage.value = reason
                    // 会话结束投屏随终（桌面端同步杀流，这里清 UI 状态）
                    _screenStream.value = null
                    _inputState.value = InputState()
                }

                override fun onWaiting(peerId: String) {
                    _inputState.value = InputState("waiting", peerId)
                }
            }
        )
    }

    /**
     * 扩展屏会话（线 3，控制端半边）：向桌面发起 display-extend 请求，
     * 与 input 会话解耦——各占独立槽位，互不感知。accept 里带回的
     * virtualScreen 是触控映射与推流尺寸的基准（3.2-3 / 3.2-1）。
     */
    val displayExtend: DisplayExtendController by lazy {
        DisplayExtendController(
            send = { peerId, type, payloadFn -> sendControlMessage(peerId, type, payloadFn) },
            listener = object : DisplayExtendController.Listener {
                override fun onSessionActive(peerId: String, sessionId: String, virtualScreen: DisplayExtendController.VirtualScreen) {
                    _extendState.value = ExtendState("active", peerId, virtualScreen)
                    _inputMessage.value = "扩展屏会话已建立（${virtualScreen.w}×${virtualScreen.h}），正在请求扩展屏画面…"
                    // 3.2-3：会话一建立就请求虚拟显示器画面流（source =
                    // virtual-display，前置为本扩展屏会话，不要求 input
                    // 会话）。流 start 回来后 MainActivity 按 screenStream
                    // 状态弹出与镜像流同一套观看页；触控映射走同一条链
                    // （letterbox + ownScreen → 桌面 streamRegion =
                    // virtualScreen），落点进虚拟显示器坐标空间。
                    // 注意：扩展屏画面本身不需要 input 会话，但画面上的
                    // 触控回传要经过 input 会话（InputController 无会话
                    // 时 sendEvents 是安全空操作），只看画面不点按时不
                    // 建 input 会话也行，点按需先建立键鼠控制。
                    requestScreenStream(
                        source = Protocol.STREAM_SOURCE_VIRTUAL_DISPLAY,
                        force = true
                    )
                }

                override fun onSessionEnded(reason: String) {
                    _inputMessage.value = reason
                    _extendState.value = ExtendState()
                }

                override fun onWaiting(peerId: String) {
                    _extendState.value = ExtendState("waiting", peerId)
                }
            }
        )
    }

    // ---------- 电脑→安卓远控（协议 4.6，被控端半边，线 2 W4 骨架） ----------

    /**
     * 被控端会话：桌面作控制端向本机发起 session.start 时的接待逻辑，
     * 与桌面端 InputSessionCoordinator 对称（线 2 W5 已接完）：
     * pending/active 状态、30s 请求 TTL、approve/deny、会话匹配校验先行；
     * input.event 经 ControlledInputInjector 解码映射后交
     * LinkSpaceAccessibilityService 注入；无障碍服务未开启时控制请求
     * 直接回 session.reject（reason `accessibility disabled`）并引导授权。
     *
     * 用户确认 UI 在 MainActivity：onControlRequested 到达即弹确认弹窗，
     * 确认后才放行 input.event；拒绝回 session.reject；30s 超时自动拒绝。
     * 绝不自动批准——安全红线；唯一例外是用户在确认框里亲手勾选的
     * 信任设备（Bug 2：TrustStore `control.no-confirm` scope），门禁
     * 全过后由 ControlledInputSession 直接放行，不弹确认框。
     */
    val controlledInput: ControlledInputSession by lazy {
        ControlledInputSession(
            isPeerAuthorized = { peerId -> trust.isKnown(peerId) },
            isAutoApprovePeer = { peerId -> trust.hasScope(peerId, Protocol.SCOPE_NO_CONFIRM) },
            localScreen = {
                val m = appContext.resources.displayMetrics
                InputController.Screen(m.widthPixels.coerceAtLeast(1), m.heightPixels.coerceAtLeast(1))
            },
            send = { peerId, type, payloadFn -> sendControlMessage(peerId, type, payloadFn) },
            isAccessibilityReady = { LinkSpaceAccessibilityService.isEnabled(appContext) },
            inject = { events, _ -> LinkSpaceAccessibilityService.inject(events) },
            releaseAll = { LinkSpaceAccessibilityService.releaseAll() },
            commitText = { text -> LinkSpaceAccessibilityService.commitText(text) },
            paste = { text -> handleScreenPaste(text) },
            listener = object : ControlledInputSession.Listener {
                override fun onControlRequested(request: ControlledInputSession.ControlRequest) {
                    LinkSpaceAccessibilityService.wakeAndUnlock(appContext)
                    _controlRequest.value = request
                }

                override fun onChanged() {
                    val prevControlled = _controlledBy.value
                    _controlRequest.value = controlledInput.pendingRequest
                    _controlledBy.value = controlledInput.controlledBy
                    if (prevControlled == null && _controlledBy.value != null) {
                        LinkSpaceAccessibilityService.wakeAndUnlock(appContext)
                    }
                    _accessibilityEnabled.value =
                        LinkSpaceAccessibilityService.isEnabled(appContext)
                }

                override fun onAccessibilityNotEnabled() {
                    _accessibilityEnabled.value = false
                    _inputMessage.value =
                        "电脑请求控制本机，但无障碍服务未开启，已拒绝。请在下方“被控设置”里开启。"
                }

                override fun onInjectError(sessionId: String, reason: String) {
                    _inputMessage.value = "远程输入注入失败：$reason"
                }
            }
        )
    }

    /** 本机屏幕尺寸：控制请求里声明，桌面端据此把本机事件映射过去 */
    fun localScreen(w: Int, h: Int): InputController.Screen = InputController.Screen(w, h)

    // ---------- 反向投屏（协议 4.7，线 2 W6：平板画面进电脑窗口） ----------

    /**
     * 反向投屏的待确认请求（线 2 W7）：onReverseStreamRequested 到达时
     * 写入，MainActivity 弹确认框；用户同意后走 MediaProjection 授权，
     * 拒绝/超时/取消时 ReverseScreenStreamer 经 onChanged 清掉。
     * 未确认前绝不自动开录（与 ControlledInputSession 默认拒绝同款姿势）。
     */
    private val _reverseStreamRequest = MutableStateFlow<ReverseScreenStreamer.ReverseStreamRequest?>(null)
    val reverseStreamRequest: StateFlow<ReverseScreenStreamer.ReverseStreamRequest?> = _reverseStreamRequest

    /** 反向推流状态（正在向谁推流 / 待确认 / 积压），MainActivity 展示用 */
    private val _reverseStreamStatus = MutableStateFlow<ReverseScreenStreamer.StreamStatus?>(null)
    val reverseStreamStatus: StateFlow<ReverseScreenStreamer.StreamStatus?> = _reverseStreamStatus

    /**
     * 反向推流端：桌面作观看方向本机发起 screen.stream.request 时的接待
     * 逻辑。MediaProjection 抓屏 + MediaCodec 优先（失败回落 JavaCV 软编）
     * + WS 二进制帧回推，与线 1 的桌面推流复用同一套 screen.stream.*
     * 语义、同一档位口径。
     *
     * 与 input 会话解耦：反向流的启停不以活动 input 会话为前提；授权门
     * 是平板端的 MediaProjection 系统录屏授权（线 2 W7 已接线：请求先进
     * reverseStreamRequest 流，MainActivity 弹确认框，同意后弹系统录屏
     * 授权框，拿到 MediaProjection 再调 startReverseStreamWithProjection）。
     * 未确认前绝不自动开录——与 W4 的 ControlledInputSession 默认拒绝
     * 同款安全姿势；90s 无人确认由 ReverseScreenStreamer TTL 自动拒绝。
     */
    val reverseScreen: ReverseScreenStreamer by lazy {
        ReverseScreenStreamer(
            appContext = appContext,
            isPeerAuthorized = { peerId -> trust.isKnown(peerId) },
            localScreen = {
                val m = appContext.resources.displayMetrics
                InputController.Screen(m.widthPixels.coerceAtLeast(1), m.heightPixels.coerceAtLeast(1))
            },
            send = { peerId, type, payloadFn -> sendControlMessage(peerId, type, payloadFn) },
            sendBinary = { peerId, data -> sendBinaryTo(peerId, data) },
            listener = object : ReverseScreenStreamer.Listener {
                override fun onReverseStreamRequested(request: ReverseScreenStreamer.ReverseStreamRequest) {
                    // W7：交给 MainActivity 的确认框 + 系统录屏授权框。
                    // 界面不在前台时请求只挂 90s，超时由 TTL 自动拒绝回 error，
                    // 不会静默挂住桌面窗口。
                    Log.i(TAG, "收到 ${request.peerId} 的反向投屏请求，等待本机录屏授权")
                    LinkSpaceAccessibilityService.wakeAndUnlock(appContext)
                    _reverseStreamRequest.value = request
                }

                override fun onChanged() {
                    val prevActive = _reverseStreamStatus.value?.active
                    _reverseStreamRequest.value = reverseScreen.pendingRequest
                    val nextStatus = reverseScreen.status()
                    _reverseStreamStatus.value = nextStatus
                    if (prevActive == null && nextStatus.active != null) {
                        LinkSpaceAccessibilityService.wakeAndUnlock(appContext)
                    }
                }

                override fun onError(message: String) {
                    _inputMessage.value = message
                }
            },
            isAutoApprovePeer = { peerId -> isNoConfirmTrusted(peerId) }
        )
    }

    /**
     * 反向投屏的视频块出站路由：只走平板主动连出的控制连接（二进制帧）。
     * 入站服务（WebSocketConnection）没有 sendBinary，桌面也只认这条
     * 连出的链路——无出站连接时丢弃并回填背压计数，不静默积压。
     */
    private fun sendBinaryTo(peerId: String, data: ByteArray) {
        val out = outbound
        if (out == null || out.peerId != peerId) {
            Log.w(TAG, "反向投屏视频块无出站连接可发（peer=$peerId），丢弃 ${data.size}B")
            reverseScreen.onBytesDropped(data.size)
            return
        }
        val conn = out.conn
        outboundWriter.execute {
            runCatching { client.sendBinary(conn, data) }
                .onFailure { Log.w(TAG, "反向投屏发送失败: ${it.javaClass.simpleName}: ${it.message}") }
            reverseScreen.onBytesFlushed(data.size)
        }
    }

    /**
     * UI：把系统录屏授权拿到的 MediaProjection 交给反向推流端。
     * 调用方是 MainActivity 的录屏授权结果回调。
     */
    fun startReverseStreamWithProjection(projection: android.media.projection.MediaProjection) {
        // 兜底：MainActivity 在授权结果里已调过 prepareReverseStreamCapture；
        // 以后若有别的调用方跳过那步，这里再升一次（幂等），保证退后台不断流
        prepareReverseStreamCapture()
        reverseScreen.startWithProjection(projection)
    }

    /**
     * UI：用户拒绝反向投屏请求（确认框点「拒绝」或系统录屏框取消）。
     * 回 screen.stream.error，桌面窗口显示明确原因后关闭。
     */
    fun denyReverseStream(request: ReverseScreenStreamer.ReverseStreamRequest, reason: String = "denied by user") {
        reverseScreen.deny(request, reason)
    }

    /** UI：本机主动停止反向推流（正在推流的卡片点「停止」） */
    fun stopReverseStream() {
        reverseScreen.stop()
    }

    /**
     * 录屏授权前的前台服务升级（线 2 W7，targetSdk 35）：
     * Android 14 起 MediaProjection 必须由 mediaProjection 类型的前台
     * 服务承接，否则应用退后台后录屏即停；且须先 createScreenCaptureIntent
     * （用户已在系统框里同意）再起服务、再 getMediaProjection。
     * MainActivity 在系统授权结果 RESULT_OK 后调这里，再调
     * getMediaProjection()。
     */
    fun prepareReverseStreamCapture() {
        LinkSpaceForegroundService.startMediaProjection(appContext)
    }

    /** 发送目标需要的完整设备 ID（信封 to 与桌面端按全等路由） */
    fun fullPeerIdOf(idPrefix: String): String = trust.fullDeviceIdOf(idPrefix) ?: idPrefix

    /** 界面展示完会话结束提示后清空 */
    fun clearInputMessage() {
        _inputMessage.value = ""
    }

    // ---------- 电脑→安卓远控：确认 UI 与授权状态（线 2 W5） ----------

    /**
     * 确认弹窗“允许”：只有会话层放行后才进入 active，注入随即开始。
     * [trustDevice] 为 true（确认框里勾了“信任此设备”）时，放行成功
     * 后再给该设备加上免确认标记——放行失败（过期/不存在）不授信。
     */
    fun approveControl(sessionId: String, durationMs: Long = 0L) {
        val peerId = controlledInput.pendingRequest
            ?.takeIf { it.sessionId == sessionId }?.peerId
        if (controlledInput.approve(sessionId)) {
            LinkSpaceAccessibilityService.wakeAndUnlock(appContext)
            if (durationMs != 0L && peerId != null) {
                grantNoConfirmTrust(peerId, durationMs)
            }
        }
    }

    fun approveControl(sessionId: String, trustDevice: Boolean) {
        approveControl(sessionId, if (trustDevice) -1L else 0L)
    }

    /** 确认弹窗“拒绝”/弹窗被划掉：回 session.reject */
    fun denyControl(sessionId: String) {
        controlledInput.deny(sessionId)
    }

    /** 被控端随时终止：正被控制时拔掉控制权 */
    fun terminateControl() {
        controlledInput.terminate()
    }

    /** 本端主动收起扩展屏（线 3）。幂等 */
    fun stopDisplayExtend() {
        displayExtend.stop()
    }

    /** 刷新无障碍授权状态（界面回到前台时调用；开关在系统设置里改） */
    fun refreshAccessibilityState() {
        _accessibilityEnabled.value = LinkSpaceAccessibilityService.isEnabled(appContext)
    }

    /** 跳系统无障碍设置页开服务 */
    fun accessibilitySettingsIntent(): android.content.Intent =
        android.content.Intent(android.provider.Settings.ACTION_ACCESSIBILITY_SETTINGS)

    // ---------- 平板主动连出的控制通道（T7 真机走查 Bug3） ----------

    /**
     * 出站控制连接：桌面端 ControlNode 只把控制消息投递给它自己 accept
     * 进来的连接（按「已登记连接 × peerId」匹配），平板点「控制电脑」时
     * 若没有任何连接，session.start 会被静默丢弃——桌面看不到授权提示、
     * 平板的等待框只能等 32 秒空转。修法与 sendFiles 同源：先主动
     * connectControl + announce 建链，之后的 session.* 与 input.event
     * 都改走这条连接（见 input 的 send 回调）。
     */
    private class OutboundControl(
        val peerId: String,
        val conn: LinkSpaceClient.ClientConnection,
        val jobs: kotlinx.coroutines.Job
    )

    @Volatile
    private var outbound: OutboundControl? = null

    /**
     * 确保到对端的出站控制连接已建立，然后发起键鼠控制请求。
     * 连接已存在且未断时直接复用（取消请求后重新点不需要重新握手）。
     * 结果经 Result 返回：失败时界面拿到原因即可，UI 状态统一由
     * InputController 回调维护——失败不会进入 waiting 态。
     */
    suspend fun requestInputControl(
        peer: DiscoveredService,
        screen: InputController.Screen,
        displayName: String
    ): Result<Unit> {
        // 配对预检与桌面端 session.start 的门禁（trust.isKnown，不查
        // input scope——键鼠共享随配对整体授予）对齐：解析不出完整
        // 设备 ID 就是没有配对，提前失败让界面立刻给出原因
        val fullId = trust.fullDeviceIdOf(peer.idPrefix)
            ?: return Result.failure(IllegalStateException("设备 ${peer.displayName} 未配对，请先配对"))
        val expectedFp = trust.fingerprintOf(fullId)
            ?.let { normalizeFingerprint(it) }
            ?: return Result.failure(IllegalStateException("设备 ${peer.displayName} 未配对，请先配对"))

        return withContext(Dispatchers.IO) {
            runCatching {
                ensureOutboundControl(peer, fullId, expectedFp)
                input.request(peerId = fullId, screen = screen, displayName = displayName)
            }.onFailure { err ->
                Log.w(TAG, "发起键鼠控制失败: ${err.message}")
            }
        }
    }

    /**
     * 确保到对端的出站控制连接已建立，然后发起扩展屏请求（线 3）。
     * 与 requestInputControl 同口径：配对预检、建链复用、失败时界面
     * 拿原因；UI 状态统一由 DisplayExtendController 回调维护。
     * preferred 为 null 时由桌面按 INF 预置模式选虚拟显示器尺寸。
     */
    suspend fun requestDisplayExtend(
        peer: DiscoveredService,
        preferred: DisplayExtendController.PreferredSize? = null,
        scaleWidth: Int = 1920
    ): Result<Unit> {
        val fullId = trust.fullDeviceIdOf(peer.idPrefix)
            ?: return Result.failure(IllegalStateException("设备 ${peer.displayName} 未配对，请先配对"))
        val expectedFp = trust.fingerprintOf(fullId)
            ?.let { normalizeFingerprint(it) }
            ?: return Result.failure(IllegalStateException("设备 ${peer.displayName} 未配对，请先配对"))

        return withContext(Dispatchers.IO) {
            runCatching {
                ensureOutboundControl(peer, fullId, expectedFp)
                displayExtend.request(
                    peerId = fullId,
                    preferred = preferred,
                    scaleWidth = scaleWidth,
                    displayName = displayName
                )
            }.onFailure { err ->
                Log.w(TAG, "发起扩展屏失败: ${err.message}")
            }
        }
    }

    /**
     * 确保到对端的出站控制连接存在。三段式：锁内快查 → 挂起建链（锁外，
     * Kotlin 禁止 suspend 点进 synchronized 临界区）→ 锁内提交登记。
     * 并发窗口内建成两条时提交阶段只留一条，浪费可忽略（窗口极小）。
     */
    private suspend fun ensureOutboundControl(
        peer: DiscoveredService,
        fullId: String,
        expectedFp: String
    ) {
        if (outboundReusable(fullId)) return
        val conn = client.connectControl(peer.host, peer.port, Protocol.CONTROL_PATH, expectedFp)
        // announce：桌面端靠首条消息登记连接身份，缺了它后续消息全部对不上号
        // （displayName/deviceType 用服务级属性——tablet 自报自己的身份）
        client.sendText(
            conn,
            envelope(Protocol.TYPE_ANNOUNCE, "") {
                put("displayName", displayName)
                put("deviceType", deviceType)
                put("caps", org.json.JSONArray(Protocol.DEFAULT_GRANT_SCOPE))
                put("fingerprint", fingerprint)
            }.toString()
        )
        val jobs = CoroutineScope(Dispatchers.IO).launch {
            // 心跳：桌面端 15s 收不到任何消息即断连，等待确认期间必须续住
            // （与 sendFiles 的发送期心跳同一依据）
            launch {
                while (true) {
                    delay(4_000)
                    val alive = runCatching {
                        client.sendText(conn, envelope(Protocol.TYPE_HEARTBEAT, fullId) {}.toString())
                    }.isSuccess
                    if (!alive) return@launch
                }
            }
            // 读循环：桌面端的 session.accept/reject/stop 与投屏视频块
            // 都从这条连接回来（文本帧 = JSON 控制消息，二进制帧 = 视频块）
            var recvFrames = 0
            var recvBytes = 0
            // id 去重（协议 §3）：本连接的已见 id 窗口，随读循环生死
            val seenIds = SeenMessageIds()
            val myPrefix = identity.get().fingerprint.replace(":", "").take(12)
            while (true) {
                val frame = try {
                    client.readFrame(conn)
                } catch (e: Exception) {
                    Log.w(TAG, "读循环异常退出: ${e.javaClass.simpleName}: ${e.message}")
                    break
                }
                if (frame == null) {
                    Log.i(TAG, "读循环退出：对端关闭连接")
                    break
                }
                if (frame.first == 0x2) {
                    // 视频块：解码器已挂就直接喂（持续路径）；渲染面未就绪时
                    // 缓冲（含流头 SPS/PPS，丢了就只能等下一个 IDR），等
                    // connectStreamSurface 一次性冲入。只缓冲不持续喂的话，
                    // 解码器创建后的所有帧都会滞留在这里饿死解码线程
                    // （B-1 真机验证抓过：黑屏 15s 后解码线程饿死退出）
                    recvBytes += frame.second.size
                    if (++recvFrames % 200 == 0) {
                        Log.i(TAG, "已收视频块 $recvFrames 个 / ${recvBytes / 1e6}MB")
                    }
                    val fastDec = fastStreamDecoder
                    val decoder = streamDecoder
                    if (fastDec != null) {
                        fastDec.feed(frame.second)
                    } else if (decoder != null) {
                        decoder.feed(frame.second)
                    } else {
                        synchronized(pendingVideo) { pendingVideo.add(frame.second) }
                    }
                    // announce/heartbeat 等其余类型与本连接无关，静默忽略
                }
                if (frame.first != 0x1) continue
                val msg = runCatching { JSONObject(String(frame.second, Charsets.UTF_8)) }.getOrNull() ?: continue
                // 信封按协议 §3 过滤（同 sendFiles）：v/to/ts 不合的直接跳过
                val to = msg.optString("to")
                if (msg.optInt("v", -1) != Protocol.VERSION) {
                    Log.w(TAG, "丢弃 v 不合的消息 type=${msg.optString("type")} v=${msg.optInt("v", -1)}")
                    continue
                }
                if (to.isNotEmpty() && to != myPrefix) {
                    Log.w(TAG, "丢弃 to 不合的消息 type=${msg.optString("type")} to=$to 本机=$myPrefix")
                    continue
                }
                if (kotlin.math.abs(System.currentTimeMillis() - msg.optLong("ts", 0L)) > 60_000) {
                    Log.w(TAG, "丢弃 ts 超偏的消息 type=${msg.optString("type")} 偏差=${System.currentTimeMillis() - msg.optLong("ts", 0L)}ms")
                    continue
                }
                // from 绑定（协议 §3）：这条连接建链时已知的对端就是 fullId，
                // from 为空或不符的消息丢弃并记告警，不断连（与桌面端同款分级处置）。
                // 此前 from 直接取自信封交给各 handler，冒名消息能一路走到会话层。
                val from = msg.optString("from")
                if (from.isEmpty() || from != fullId) {
                    Log.w(TAG, "丢弃 from 与连接身份不符的消息 type=${msg.optString("type")} from=$from 期望=$fullId")
                    continue
                }
                // id 去重（协议 §3）：同一连接上同一 id 只处理一次；空 id 视为畸形
                val id = msg.optString("id")
                if (id.isEmpty()) {
                    Log.w(TAG, "丢弃 id 为空的消息 type=${msg.optString("type")}")
                    continue
                }
                if (seenIds.isDuplicate(id)) {
                    if (seenIds.duplicateCount <= 3 || seenIds.duplicateCount % 100 == 0) {
                        Log.w(TAG, "丢弃重复消息 id=$id type=${msg.optString("type")}（第 ${seenIds.duplicateCount} 次）")
                    }
                    continue
                }
                val payload = msg.optJSONObject("payload") ?: JSONObject()
                when (msg.optString("type")) {
                    Protocol.TYPE_SESSION_ACCEPT -> {
                        input.onAccepted(from, payload)
                        displayExtend.onAccepted(from, payload)
                    }
                    Protocol.TYPE_SESSION_REJECT -> {
                        input.onRejected(from, payload)
                        displayExtend.onRejected(from, payload)
                    }
                    Protocol.TYPE_SESSION_STOP -> {
                        input.onStopped(from, payload)
                        controlledInput.onStop(from, payload)
                        displayExtend.onStopped(from, payload)
                    }
                    // ---------- 电脑→安卓远控（4.6，被控端半边，线 2 W4 骨架） ----------
                    Protocol.TYPE_SESSION_START -> controlledInput.onStart(from, payload)
                    Protocol.TYPE_INPUT_EVENT -> controlledInput.onEvent(from, payload)
                    Protocol.TYPE_INPUT_TEXT -> controlledInput.onText(from, payload)
                    Protocol.TYPE_SCREEN_PASTE -> controlledInput.onScreenPaste(from, payload)
                    Protocol.TYPE_CLIPBOARD_SHARE -> handleClipboardShare(from, payload)
                    // ---------- 反向投屏（4.7，线 2 W6）：桌面看平板画面 ----------
                    // 与 input 会话解耦：不查活动 input 会话，只认已配对连接
                    Protocol.TYPE_SCREEN_STREAM_REQUEST -> reverseScreen.onRequest(from, payload)
                    // ---------- 屏幕投屏 ----------
                    Protocol.TYPE_SCREEN_STREAM_START -> {
                        val mode = payload.optString("mode", "")
                        Log.i(TAG, "收到投屏启动 mode=$mode w=${payload.optInt("w")} h=${payload.optInt("h")}")
                        _streamScaleWidth.value = payload.optInt("scaleWidth", lastStreamScaleWidth)
                        streamFallbackSize = payload.optInt("w", 1920) to payload.optInt("h", 1080)
                        _screenStream.value = ScreenStreamInfo(
                            streamFallbackSize.first,
                            streamFallbackSize.second
                        )
                        // 重投屏场景：残留解码器（断流路径被 stopped 吞掉回调
                        // 的旧实例）会把新流挡死，先清再建。
                        shutdownStreamDecoders()
                        synchronized(pendingVideo) { pendingVideo.clear() }
                        if (mode == STREAM_MODE_FAST) {
                            val streamW = payload.optInt("streamW", payload.optInt("w", 1920))
                            val streamH = payload.optInt("streamH", payload.optInt("h", 1080))
                            val fps = payload.optInt("fps", 60)
                            _streamStats.value = "硬解连接中…"
                            streamRenderView?.get()?.clearBitmap()
                            startFastStreamDecoder(streamW, streamH, fps)
                        } else {
                            _streamStats.value = "兼容软解…"
                            startStreamDecoder()
                        }
                    }
                    Protocol.TYPE_SCREEN_STREAM_STOP -> handleScreenStreamStop(from, payload)
                    Protocol.TYPE_SCREEN_STREAM_ERROR -> {
                        shutdownStreamDecoders()
                        _streamStats.value = null
                        _screenStream.value = null
                        _inputMessage.value = payload.optString("message", "投屏失败")
                    }
                    Protocol.TYPE_SCREEN_CURSOR -> {
                        // 桌面 33ms 限流广播的物理光标（region-local 坐标），
                        // 换算成比例交给观看页画覆盖层
                        val w = payload.optInt("w", 0).coerceAtLeast(1)
                        val h = payload.optInt("h", 0).coerceAtLeast(1)
                        _cursorFraction.value = Pair(
                            (payload.optDouble("x", 0.0) / w).toFloat(),
                            (payload.optDouble("y", 0.0) / h).toFloat()
                        )
                    }
                    Protocol.TYPE_SCREEN_STREAM_DISPLAYS -> {
                        val arr = payload.optJSONArray("displays")
                            ?: org.json.JSONArray()
                        val list = (0 until arr.length()).map {
                            val o = arr.getJSONObject(it)
                            DisplayRect(
                                x = o.optInt("x"),
                                y = o.optInt("y"),
                                w = o.optInt("w"),
                                h = o.optInt("h")
                            )
                        }
                        Log.i(TAG, "收到显示器清单：$list")
                        _streamDisplays.value = list
                    }
                    // announce/heartbeat 等其余类型与本连接无关，静默忽略
                }
            }
            // 读循环退出 = 连接断开：清登记并让 UI 收掉等待/控制状态。
            // 主动关闭（stopAll/换目标）时 outbound 已被置空，不再误报
            if (outbound?.conn === conn) {
                outbound = null
                val wasStreaming = _screenStream.value != null || streamDecoder != null || fastStreamDecoder != null
                input.onPeerDisconnected(fullId)
                controlledInput.onPeerDisconnected(fullId)
                displayExtend.onPeerDisconnected(fullId)
                reverseScreen.onPeerDisconnected(fullId)
                // 投屏中连接断开：自动重连一次（读循环死亡 = WS 帧解析失
                // 同步等瞬态故障，重建链路常可自愈；连续失败由用户重试）
                if (wasStreaming) scheduleStreamReconnect(fullId)
            }
        }
        // 提交登记：已有同目标的活连接（并发窗口内别人建成）就丢弃本条
        synchronized(this) {
            val cur = outbound
            if (cur != null && cur.peerId == fullId && !cur.conn.socket.isClosed) {
                jobs.cancel()
                runCatching { conn.close() }
                return
            }
            if (cur != null) {
                cur.jobs.cancel()
                runCatching { cur.conn.close() }
            }
            outbound = OutboundControl(fullId, conn, jobs)
        }
    }

    /** 反向投屏请求前，确保到指定对端存在平板主动连出的控制链路 */
    private suspend fun ensureOutboundForPeerId(peerId: String): Boolean {
        if (outboundReusable(peerId)) return true
        val peer = discovered.value.firstOrNull {
            trust.fullDeviceIdOf(it.idPrefix) == peerId
        } ?: return false
        val fullId = trust.fullDeviceIdOf(peer.idPrefix) ?: peer.idPrefix
        val expectedFp = trust.fingerprintOf(fullId)
            ?.let { normalizeFingerprint(it) } ?: return false
        ensureOutboundControl(peer, fullId, expectedFp)
        return outboundReusable(fullId)
    }

    /** 已登记的出站连接是否可复用（同目标且未断） */
    private fun outboundReusable(fullId: String): Boolean = synchronized(this) {
        val cur = outbound
        cur != null && cur.peerId == fullId && !cur.conn.socket.isClosed
    }

    /** 远端光标位置（视频宽高的比例 0..1），投屏光标覆盖层用 */
    private val _cursorFraction =
        kotlinx.coroutines.flow.MutableStateFlow<Pair<Float, Float>?>(null)
    val cursorFraction: kotlinx.coroutines.flow.StateFlow<Pair<Float, Float>?> =
        _cursorFraction

    /** 上次投屏选中的显示器索引（自动重连时沿用） */
    private var lastStreamDisplayIndex = -1

    /** 上次投屏分辨率（目标宽度），自动重连和换档时沿用 */
    private var lastStreamScaleWidth = 1920

    /**
     * 上次投屏帧源（协议 4.7，线 3）：'screen'（线 1 镜像）或
     * 'virtual-display'（线 3 扩展屏）。自动重连与画质换档时沿用，
     * 换档不得把扩展屏流悄悄切回镜像流。
     */
    private var lastStreamSource: String = Protocol.STREAM_SOURCE_SCREEN

    /**
     * 观看页的渲染视图（弱引用防泄漏）。解码器每帧回调后主线程
     * submit；观看页销毁时置空，解码出的帧自然丢弃。
     */
    @Volatile
    private var streamRenderView: java.lang.ref.WeakReference<cn.linkspace.client.StreamView>? = null

    private val mainHandler = android.os.Handler(android.os.Looper.getMainLooper())

    /** 观看页挂载/更新时回调；传 null = 页面销毁 */
    fun attachStreamView(view: cn.linkspace.client.StreamView?) {
        streamRenderView = view?.let { java.lang.ref.WeakReference(it) }
        if (view != null) {
            view.onSurfaceChanged = { s -> fastStreamDecoder?.setSurface(s) }
            fastStreamDecoder?.setSurface(view.currentSurface)
            if (fastStreamDecoder != null) {
                view.clearBitmap()
            }
        } else {
            fastStreamDecoder?.setSurface(null)
        }
    }

    /**
     * 投屏中断线自动重连：重建控制链路（自动批准生效）→ 恢复会话 →
     * 按上次的显示器选择重新发起投屏。退避重试 4 次（5/10/20/30s）——
     * 单次重试撞上桌面端还在重启窗口就直接放弃了（真机踩过），连
     * 发现列表刷新这种 30s 级的延迟也兜不住；仍不无限循环，对端真
     * 下线时 65s 后停手交给用户。
     */
    private fun scheduleStreamReconnect(peerFullId: String) {
        // 扩展屏流不断线重连：断连时 display-extend 会话已结束（对端
        // onPeerDisconnected），流的前置已不在，重连只会先弹 input 确
        // 认再报“需要先建立扩展屏会话”；用户从设备详情重发扩展屏请求即可。
        if (lastStreamSource == Protocol.STREAM_SOURCE_VIRTUAL_DISPLAY) {
            Log.i(TAG, "扩展屏连接断开，不自动重连（扩展屏会话已结束，需用户重发请求）")
            return
        }
        Log.i(TAG, "投屏连接断开，5s 后开始自动重连（最多 4 次）")
        CoroutineScope(Dispatchers.IO).launch {
            val backoffs = longArrayOf(5000, 10000, 20000, 30000)
            for ((idx, backoff) in backoffs.withIndex()) {
                val round = idx + 1
                delay(backoff)
                val peer = discovered.value.firstOrNull {
                    trust.fullDeviceIdOf(it.idPrefix) == peerFullId
                }
                if (peer == null) {
                    Log.w(TAG, "自动重连第 $round 次：发现列表暂无该设备，稍后再试")
                    continue
                }
                val m = appContext.resources.displayMetrics
                val r = runCatching {
                    requestInputControl(
                        peer,
                        InputController.Screen(m.widthPixels.coerceAtLeast(1), m.heightPixels.coerceAtLeast(1)),
                        displayName
                    ).getOrThrow()
                    requestScreenStream(lastStreamDisplayIndex, lastStreamScaleWidth)
                }
                if (r.isSuccess) {
                    Log.i(TAG, "自动重连成功（第 $round 次）")
                    return@launch
                }
                Log.w(TAG, "自动重连第 $round 次失败: ${r.exceptionOrNull()?.message}")
            }
            Log.w(TAG, "自动重连放弃（4 次未成功），等待用户手动重试")
        }
    }

    /** 关闭出站控制连接（用户退出/服务停止时调用） */
    private fun closeOutbound() {
        val out = outbound
        outbound = null
        _screenStream.value = null
        _streamStats.value = null
        shutdownStreamDecoders()
        synchronized(pendingVideo) { pendingVideo.clear() }
        if (out != null) {
            out.jobs.cancel()
            runCatching { client.close(out.conn) }
        }
    }

    // ---------- 屏幕投屏（寄生在键鼠会话内，[PROTOCOL] screen.stream.*） ----------

    /**
     * 视频块走 **WebSocket 二进制帧**，复用平板主动连出的那条控制连接：
     * 桌面侧 listen 会被 Windows 防火墙静默丢入站 SYN（实测 10 秒超时）；
     * 平板侧所有 TCP 入站端口对桌面同样不通（ICMP 通、TCP 全拒）。唯有
     * 平板连出的链路可用，TCP 全双工允许桌面在该方向发数据。控制消息
     * （文本帧）与视频块（二进制帧）按 opcode 分流，互不干扰。
     */
    /** 进行中的投屏流信息。null = 无投屏。w/h 是虚拟屏尺寸（触控映射回退基准） */
    data class ScreenStreamInfo(val w: Int, val h: Int)

    /** 被控端的一块显示器（虚拟屏坐标 + 尺寸），多显示器选择用 */
    data class DisplayRect(val x: Int, val y: Int, val w: Int, val h: Int)

    private val _streamDisplays = MutableStateFlow<List<DisplayRect>>(emptyList())

    /** 被控端回报的显示器清单；非空时界面弹选择器（B-2 多显示器选择） */
    val streamDisplays: StateFlow<List<DisplayRect>> = _streamDisplays

    fun clearStreamDisplays() {
        _streamDisplays.value = emptyList()
    }

    private val _screenStream = MutableStateFlow<ScreenStreamInfo?>(null)
    val screenStream: StateFlow<ScreenStreamInfo?> = _screenStream

    private val _streamScaleWidth = MutableStateFlow(1920)
    val streamScaleWidth: StateFlow<Int> = _streamScaleWidth

    /** 串流模式偏好：auto（默认，优先高性能硬解） / fast（高性能硬解） / compat（兼容软解） */
    private val _streamMode = MutableStateFlow(STREAM_MODE_AUTO)
    val streamMode: StateFlow<String> = _streamMode

    /** 当前会话是否因硬解异常自动降级到兼容模式 */
    @Volatile
    private var fastSessionFallback = false

    /** 实时串流状态文案（供 StreamTopBar 显示帧率/码率/解码耗时） */
    private val _streamStats = MutableStateFlow<String?>(null)
    val streamStats: StateFlow<String?> = _streamStats

    fun setStreamMode(mode: String) {
        val clean = when (mode) {
            STREAM_MODE_FAST, STREAM_MODE_COMPAT, STREAM_MODE_AUTO -> mode
            else -> STREAM_MODE_AUTO
        }
        prefs.edit().putString(KEY_STREAM_MODE, clean).apply()
        val changed = _streamMode.value != clean
        _streamMode.value = clean
        fastSessionFallback = false
        if (changed && _screenStream.value != null) {
            requestScreenStream(
                displayIndex = lastStreamDisplayIndex,
                scaleWidth = lastStreamScaleWidth,
                source = lastStreamSource,
                force = true
            )
        }
    }

    /** 进行中的兼容软解解码器。null = 未走软解 */
    private var streamDecoder: StreamDecoder? = null
    /** 进行中的高性能硬解解码器。null = 未走硬解 */
    private var fastStreamDecoder: FastStreamDecoder? = null

    private fun shutdownStreamDecoders() {
        streamDecoder?.shutdown()
        streamDecoder = null
        fastStreamDecoder?.shutdown()
        fastStreamDecoder = null
    }

    /** 桌面回 start 时填的虚拟屏尺寸（触控映射的回退基准） */
    @Volatile
    var streamFallbackSize: Pair<Int, Int> = 1920 to 1080
        private set

    /** 视频块缓冲：WS 二进制帧到达早于渲染面就绪时暂存（含流头 SPS/PPS） */
    private val pendingVideo = java.util.ArrayDeque<ByteArray>()

    /**
     * 请求投屏流（线 1 镜像 + 线 3 扩展屏共用）。
     *
     * @param source 帧源（协议 4.7）：null = 沿用上次（自动重连与画质
     *   换档时传 null，不得把扩展屏流悄悄切回镜像流）；'virtual-display'
     *   时 display 参数无意义（虚拟显示器只有一块），直接按虚拟显示器
     *   尺寸开流，不弹显示器清单。
     * @param force true = 跳过“同分辨率重复请求忽略”的去重（扩展屏会
     *   话建立时自动请求用：镜像流可能正在跑同档位，去重会把扩展屏
     *   请求吞掉，桌面继续推镜像流）。
     */
    fun requestScreenStream(
        displayIndex: Int = -1,
        scaleWidth: Int = 1920,
        source: String? = null,
        force: Boolean = false
    ) {
        val out = outbound ?: run {
            _inputMessage.value = "没有到桌面的控制连接"
            return
        }
        val resolvedSource = source ?: lastStreamSource
        val anyDecoder = streamDecoder != null || fastStreamDecoder != null
        // 同一分辨率重复请求直接忽略；换分辨率则允许重建推流
        if (!force && anyDecoder && scaleWidth == lastStreamScaleWidth &&
            resolvedSource == lastStreamSource
        ) return
        // 换分辨率时如果不指定显示器，沿用当前选屏，避免再次弹显示器清单；
        // 扩展屏源不选屏（虚拟显示器只有一块）
        val resolvedDisplayIndex =
            if (resolvedSource == Protocol.STREAM_SOURCE_VIRTUAL_DISPLAY) -1
            else if (displayIndex >= 0) displayIndex else lastStreamDisplayIndex
        lastStreamDisplayIndex = resolvedDisplayIndex
        lastStreamScaleWidth = scaleWidth
        lastStreamSource = resolvedSource
        _streamScaleWidth.value = scaleWidth
        pendingVideo.clear()
        val wantFast = resolvedSource == Protocol.STREAM_SOURCE_SCREEN &&
            _streamMode.value != STREAM_MODE_COMPAT &&
            !fastSessionFallback
        val dm = appContext.resources.displayMetrics
        val dmLong = maxOf(dm.widthPixels, dm.heightPixels).coerceAtLeast(1280)
        val dmShort = minOf(dm.widthPixels, dm.heightPixels).coerceAtLeast(720)
        val boxW = scaleWidth.coerceIn(1280, 3840)
        val boxH = (boxW.toLong() * dmShort / dmLong).toInt().coerceIn(720, 2160)
        val text = envelope(Protocol.TYPE_SCREEN_STREAM_REQUEST, out.peerId) {
            // 带 display 的请求直接选屏；不带则被控端回显示器清单
            if (resolvedDisplayIndex >= 0) put("display", resolvedDisplayIndex)
            put("scaleWidth", scaleWidth)
            put("source", resolvedSource)
            if (wantFast) {
                put("mode", STREAM_MODE_FAST)
                put(
                    "fast",
                    JSONObject().apply {
                        put("w", boxW)
                        put("h", boxH)
                        put("fps", 60)
                    }
                )
            }
        }.toString()
        outboundWriter.execute { runCatching { client.sendText(out.conn, text) } }
        Log.i(
            TAG,
            "投屏请求已发（display=$resolvedDisplayIndex, scaleWidth=$scaleWidth, source=$resolvedSource, fast=$wantFast）"
        )
    }

    /**
     * screen.paste 接收侧（协议 4.8，C 回退：桌面→平板）。会话层已校验
     * 活动会话与 512 KiB 上限，这里只做三件事：
     * ① 写本机剪贴板；② 标记来源、抑制剪贴板同步回推（2.4-3 防回环）；
     * ③ 注入 Ctrl+V（走 B1 按键通道，须焦点输入框）。
     * 返回 null 表示完成，否则是失败（code + 原因），会话层回 input.error。
     */
    private fun handleScreenPaste(text: String): ControlledInputInjector.InputFailure? {
        val cm = appContext.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
            ?: return ControlledInputInjector.InputFailure(
                ControlledInputInjector.InputFailure.INJECT_FAILED,
                "本机剪贴板服务不可用，粘贴未执行"
            )
        runCatching {
            cm.setPrimaryClip(ClipData.newPlainText("LinkSpace", text))
        }.onFailure { e ->
            return ControlledInputInjector.InputFailure(
                ControlledInputInjector.InputFailure.INJECT_FAILED,
                "写平板剪贴板失败：${e.message}"
            )
        }
        // 回环抑制：刚写入的内容不触发本机剪贴板同步回推（2.4-3）。
        // 同步未开启时 clipboard 为空，无事可做；开启后基线在 start() 里
        // 重读，这里只在运行中标记。
        clipboard?.markRemoteWrite(text)
        val ctrlV = listOf(
            ControlledInputInjector.DecodedEvent.Key(KeyEvent.KEYCODE_CTRL_LEFT, true),
            ControlledInputInjector.DecodedEvent.Key(KeyEvent.KEYCODE_V, true),
            ControlledInputInjector.DecodedEvent.Key(KeyEvent.KEYCODE_V, false),
            ControlledInputInjector.DecodedEvent.Key(KeyEvent.KEYCODE_CTRL_LEFT, false)
        )
        return when (val r = LinkSpaceAccessibilityService.inject(ctrlV)) {
            is ControlledInputInjector.InjectResult.Ok -> null
            is ControlledInputInjector.InjectResult.Failed ->
                ControlledInputInjector.InputFailure(r.code, "粘贴注入 Ctrl+V 失败：${r.reason}")
        }
    }

    /**
     * 投屏粘贴（协议 4.8）：把 text 交给被控端写剪贴板并注入 Ctrl+V。
     * 键盘通道按 vk 注入，IME 组合输入（中文）无法表达——粘贴通道是
     * 中文上屏的正道。寄生 input 会话：被控端校验活动会话与来源。
     */
    fun sendScreenPaste(text: String) {
        val out = outbound ?: run {
            _inputMessage.value = "没有到桌面的控制连接"
            return
        }
        if (text.isEmpty()) return
        // 上限 512KiB（协议 4.8，与剪贴板同步一致）；超限整段拒绝，
        // 控制端可分小段重试
        if (text.toByteArray(Charsets.UTF_8).size > 512 * 1024) {
            _inputMessage.value = "粘贴内容超过 512KiB 上限"
            return
        }
        out.jobs.let {
            CoroutineScope(Dispatchers.IO).launch {
                runCatching {
                    client.sendText(
                        out.conn,
                        envelope(Protocol.TYPE_SCREEN_PASTE, out.peerId) { put("text", text) }.toString()
                    )
                }.onFailure { Log.w(TAG, "screen.paste 发送失败: ${it.message}") }
            }
        }
        Log.i(TAG, "screen.paste 已发送（${text.length} 字符）")
    }

    /**
     * 建解码器并冲入此前缓冲的视频块。ByteBuffer 模式解码 + 回调渲染，
     * 与观看页挂载状态解耦——先到帧后挂页、先挂页后到帧都成立。
     */
    /** 主线程响应看门狗：投屏期间 3s 无响应即全线程栈落日志（ANR 取证） */
    @Volatile
    private var anrWatchdog: Thread? = null
    @Volatile
    private var anrLogged = false

    private fun startAnrWatchdog() {
        if (anrWatchdog?.isAlive == true) return
        anrWatchdog = Thread({
            while (streamDecoder != null || fastStreamDecoder != null || streamRenderView?.get() != null) {
                val done = java.util.concurrent.atomic.AtomicBoolean(false)
                mainHandler.post { done.set(true) }
                Thread.sleep(3000)
                if (!done.get()) {
                    if (!anrLogged) {
                        anrLogged = true
                        val sb = StringBuilder("主线程 3s 未响应（ANR 取证）\n")
                        Thread.getAllStackTraces().forEach { (t, st) ->
                            if (t.name == "main" || st.isNotEmpty()) {
                                sb.append("【").append(t.name).append("】\n")
                                st.take(25).forEach { sb.append("  at ").append(it).append("\n") }
                            }
                        }
                        Log.e(TAG, sb.toString())
                    }
                } else {
                    anrLogged = false
                }
            }
        }, "linkspace-anr-watchdog").apply { isDaemon = true; start() }
    }

    private fun startFastStreamDecoder(streamW: Int, streamH: Int, fps: Int) {
        if (fastStreamDecoder != null) return
        startAnrWatchdog()
        var decoderRef: FastStreamDecoder? = null
        val decoder = FastStreamDecoder(
            streamWidth = streamW,
            streamHeight = streamH,
            fps = fps,
            initialSurface = streamRenderView?.get()?.currentSurface,
            onStats = { stat ->
                if (fastStreamDecoder === decoderRef) {
                    _streamStats.value = stat
                }
            },
            onRequestKeyframe = {
                val out = outbound ?: return@FastStreamDecoder
                val text = envelope(MSG_SCREEN_STREAM_KEYFRAME, out.peerId) {}.toString()
                outboundWriter.execute { runCatching { client.sendText(out.conn, text) } }
            },
            onFallback = { reason ->
                if (fastStreamDecoder !== decoderRef) return@FastStreamDecoder
                Log.w(TAG, "高性能硬解回退兼容软解: $reason")
                fastStreamDecoder?.shutdown()
                fastStreamDecoder = null
                fastSessionFallback = true
                _streamStats.value = "正在切换兼容模式…"
                requestScreenStream(
                    displayIndex = lastStreamDisplayIndex,
                    scaleWidth = lastStreamScaleWidth,
                    source = lastStreamSource,
                    force = true
                )
            },
            onEnded = { reason ->
                if (fastStreamDecoder !== decoderRef) return@FastStreamDecoder
                _inputMessage.value = reason
                _screenStream.value = null
                _streamStats.value = null
                fastStreamDecoder?.shutdown()
                fastStreamDecoder = null
            }
        )
        decoderRef = decoder
        fastStreamDecoder = decoder
        synchronized(pendingVideo) {
            while (pendingVideo.isNotEmpty()) decoder.feed(pendingVideo.poll())
        }
        decoder.start()
    }

    private fun startStreamDecoder() {
        if (streamDecoder != null) return
        startAnrWatchdog()
        var decoderRef: StreamDecoder? = null
        val decoder = StreamDecoder(
            onFrame = { bmp ->
                if (streamDecoder !== decoderRef) return@StreamDecoder
                // 直投视图（submit 内部按 vsync 合流重绘），不经主线程
                // Handler——解码快于绘制时逐帧 post 会洪泛主线程把触摸
                // 事件饿出 ANR（真机踩过）
                streamRenderView?.get()?.submit(bmp)
            },
            onEnded = { reason ->
                // 老解码器可能在换分辨率、新实例已登记后才走到 onEnded。
                // 这里必须按实例判等，否则老回调会把新解码器一起 shutdown。
                if (streamDecoder !== decoderRef) return@StreamDecoder
                _inputMessage.value = reason
                _screenStream.value = null
                _streamStats.value = null
                // 解码线程的任何死亡（断流/内部错误）都必须同时清掉引用：
                // 残留的非空 streamDecoder 会让下次投屏请求被挡死（真机踩过）
                streamDecoder?.shutdown()
                streamDecoder = null
            },
            onSize = { w, h ->
                if (streamDecoder !== decoderRef) return@StreamDecoder
                streamFallbackSize = w to h
                // 解码实际尺寸（流内 SPS）回灌 UI：letterbox 等比渲染以它为准
                // （session.start 时声明的尺寸可能与 ffmpeg 实际推流输出不同）
                _screenStream.value = ScreenStreamInfo(w, h)
            },
            onStats = { stat ->
                if (streamDecoder === decoderRef) {
                    _streamStats.value = stat
                }
            }
        )
        decoderRef = decoder
        streamDecoder = decoder
        synchronized(pendingVideo) {
            while (pendingVideo.isNotEmpty()) decoder.feed(pendingVideo.poll())
        }
        decoder.start()
    }

    /** 平板侧主动停止投屏：发 stop + 释放解码器 */
    fun stopScreenStream() {
        val out = outbound
        if (out != null) {
            val text = envelope(Protocol.TYPE_SCREEN_STREAM_STOP, out.peerId) {
                put("direction", Protocol.STREAM_DIRECTION_FORWARD)
            }.toString()
            outboundWriter.execute { runCatching { client.sendText(out.conn, text) } }
        }
        fastSessionFallback = false
        shutdownStreamDecoders()
        _streamStats.value = null
        _screenStream.value = null
    }

    /**
     * screen.stream.stop 的统一入口（出站读循环与入站服务共用）：
     * 按 direction 只停对应的一路流——forward 停本机投屏解码，
     * reverse 交反向推流端；direction 缺失的旧版本对端按
     * Protocol.resolveStreamStopDirection 的兼容规则解析（单路在跑
     * 停那一路、双向在跑只停 forward），绝不顺手停掉另一路；
     * direction 非法则忽略本消息。forwardLive / reverseLive 只认
     * 属于发消息对端的流，旁观连接的 stop 够不着别人的流。
     */
    private fun handleScreenStreamStop(from: String, payload: JSONObject) {
        val forwardLive = (streamDecoder != null || fastStreamDecoder != null || _screenStream.value != null) &&
            outbound?.peerId == from
        val reverseLive = reverseScreen.pendingRequest?.peerId == from ||
            reverseScreen.activeStream?.peerId == from
        val rawDirection: String? =
            if (payload.has("direction") && !payload.isNull("direction")) payload.optString("direction") else null
        val direction = Protocol.resolveStreamStopDirection(rawDirection, forwardLive, reverseLive)
        if (direction == null) {
            Log.w(TAG, "忽略无法解析方向的 screen.stream.stop（from=$from）")
            return
        }
        if (direction == Protocol.STREAM_DIRECTION_FORWARD) {
            shutdownStreamDecoders()
            _streamStats.value = null
            _screenStream.value = null
        } else {
            reverseScreen.onStop(from, direction)
        }
    }

    /**
     * 用户主动退出：停掉前台服务持有的全部能力——发现、传输服务、
     * 剪贴板同步与所有控制连接。对端会立即看到连接断开（键鼠会话
     * 随之终止），这是「退出 = 语义上的彻底下线」。
     */
    fun stopAll() {
        input.stop("stopped by user")
        displayExtend.stop("stopped by user")
        controlledInput.terminate()
        reverseScreen.stop()
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
                    // id 去重（协议 §3）：本次等待的已见 id 窗口
                    val seenIds = SeenMessageIds()
                    while (token == null && System.currentTimeMillis() < deadline) {
                        val text = client.readText(conn) ?: error("控制通道已关闭")
                        val msg = runCatching { JSONObject(text) }.getOrNull() ?: continue
                        val to = msg.optString("to")
                        if (msg.optInt("v", -1) != Protocol.VERSION) continue
                        if (to.isNotEmpty() && to != myPrefix) continue
                        if (kotlin.math.abs(System.currentTimeMillis() - msg.optLong("ts", 0L)) > 60_000) continue
                        // from 绑定（协议 §3）：等的是 peerFullId 的回告，
                        // from 为空或不符的直接跳过
                        val from = msg.optString("from")
                        if (from.isEmpty() || from != peerFullId) {
                            Log.w(TAG, "等待 accept 时丢弃 from 不符的消息 type=${msg.optString("type")} from=$from 期望=$peerFullId")
                            continue
                        }
                        // id 去重（协议 §3）：同一连接上同一 id 只处理一次；空 id 丢弃
                        val id = msg.optString("id")
                        if (id.isEmpty()) continue
                        if (seenIds.isDuplicate(id)) continue
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
