package cn.linkspace.client.service

import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.io.OutputStream
import java.net.ServerSocket
import java.net.Socket
import java.security.MessageDigest
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Semaphore
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocket
import javax.net.ssl.SSLSocket

/**
 * HTTPS 文件接收服务 + 控制通道服务端。
 *
 * 为什么不用 NanoHTTPD：它的 HTTPS API 要求从一个 KeyStore InputStream 构造，
 * 而我们的证书是运行时生成的，需要额外序列化一层；协议本身只有几条路由，
 * 自己实现一个最小 HTTP/1.1 处理器更可控，也更容易审查。
 *
 * 与桌面端 `transfer/server.ts` 的路由、头字段、状态码逐字对应：
 *   POST /linkspace/v1/transfer/:id/chunk?offset=N    写入分块
 *   GET  /linkspace/v1/transfer/:id/chunk?offset=N    读取分块
 *   空体 POST = 偏移探针，只回报 committedOffset
 *   偏移不衔接返回 409；块摘要不符返回 400；体超限返回 413
 *
 * 请求体的读取发生在**鉴权之后**：body 缓冲按 Content-Length 分配，
 * 若在读头阶段就分配，任何同网段设备都能用一个 Content-Length 头
 * 触发最高 2GB 的内存分配把进程杀死（全项目审查 2026-10-29 P0-3）。
 */
class TransferServer(
    private val identity: Identity,
    private val trust: TrustStore,
    private val onComplete: (transferId: String, digests: Map<String, String>) -> Unit
) {

    /** 接收中的任务：transferId → 落盘信息 */
    private class Incoming {
        val parts = ConcurrentHashMap<String, PartInfo>()
        val files = ConcurrentHashMap<String, TransferFile>()
    }

    private val incoming = ConcurrentHashMap<String, Incoming>()
    private val tokens = ConcurrentHashMap<String, String>()
    private val cancelled = ConcurrentHashMap.newKeySet<String>()
    private val controlConns = java.util.Collections.synchronizedSet(mutableSetOf<WebSocketConnection>())
    /**
     * WebSocket 连接 → 对端设备 ID。**首条消息（announce）时固定**，
     * 之后该连接上任何 `from` 与之不符的消息一律丢弃——否则一条连接
     * 可以先冒用 A 建立身份、再换 B 的 id 操作 A 的任务。
     */
    private val controlPeerIds = java.util.Collections.synchronizedMap(mutableMapOf<WebSocketConnection, String>())
    /** 连接 → 连入方 TLS 客户端证书指纹（未出示证书为 null），指纹锚定用 */
    private val controlFingerprints = java.util.Collections.synchronizedMap(mutableMapOf<WebSocketConnection, String?>())

    /** 已交接给 WebSocket 的连接，finally 不得再关闭 */
    private val handedOff: MutableSet<Socket> =
        java.util.Collections.synchronizedSet(mutableSetOf())

    /** 并发连接上限：accept 后拿不到槽位直接断开，防止线程与内存被灌满 */
    private val connSlots = Semaphore(64)

    private var serverSocket: ServerSocket? = null
    private var thread: Thread? = null

    /**
     * 控制连接保活心跳。桌面端 15s 收不到对端任何消息就判离线并断连
     * （control/node.ts startHeartbeat），桌面之间靠双方互发心跳维持。
     * 本端作为服务端若一声不吭，桌面发起的连接会在配对等待 ~15s 后被
     * 掐断——用户还没来得及点「接受」，connectAndPair 就报「连接已断开」
     * （真机踩过）。安卓自己发起的连接此前靠发送方的临时心跳续命，
     * 服务端方向一直没有，这里补齐两端对称。
     */
    @Volatile
    private var heartbeat: Thread? = null

    @Volatile
    var port: Int = 0
        private set

    fun start(): Int {
        val ctx = SSLContext.getInstance("TLS")
        // init 要 KeyManager 数组而不是 KeyStore，需经 KeyManagerFactory 转换
        val kmf = javax.net.ssl.KeyManagerFactory.getInstance(
            javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm()
        )
        kmf.init(identity.keyStore(), CharArray(0))
        // TLS 层只索取、不验证连入方证书（与桌面端 requestCert +
        // rejectUnauthorized:false 同语义）：对端全是自签证书，没有 CA
        // 可依赖。真机走查踩过：默认 TrustManager 会拿系统 CA 验客户端
        // 证书并回 certificate_unknown 告警，握手直接失败。
        // 信任判定在控制消息层的指纹闸门（LinkSpaceService.onControlMessage）
        ctx.init(kmf.keyManagers, arrayOf<javax.net.ssl.TrustManager>(PermissiveTrustManager), null)
        val factory: SSLContext = ctx
        val socket = factory.serverSocketFactory.createServerSocket(0, 64) as ServerSocket
        socket.reuseAddress = true
        // 索取连入方证书用于指纹锚定（对端桌面已实现客户端出示证书）。
        // 用 want 而不是 need：旧版对端不出示证书时仍可完成配对，
        // 已信任设备的证书校验在控制消息层强制执行
        (socket as SSLServerSocket).wantClientAuth = true
        serverSocket = socket
        port = socket.localPort

        thread = Thread({ acceptLoop(socket) }, "linkspace-transfer").apply {
            isDaemon = true
            start()
        }
        heartbeat = Thread({ heartbeatLoop() }, "linkspace-heartbeat").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "文件传输服务已监听 0.0.0.0:$port")
        return port
    }

    fun stop() {
        heartbeat?.interrupt()
        heartbeat = null
        runCatching { serverSocket?.close() }
        serverSocket = null
        thread = null
        synchronized(controlConns) {
            controlConns.toList().forEach { runCatching { it.close() } }
            controlConns.clear()
        }
        controlPeerIds.clear()
        controlFingerprints.clear()
    }

    /** 周期向所有控制连接发心跳。to 留空：保活包是广播性质，桌面端允许空 to */
    private fun heartbeatLoop() {
        val selfPrefix = identity.get().fingerprint.replace(":", "").take(12)
        while (true) {
            runCatching { Thread.sleep(4_000) }.getOrNull() ?: return
            val text = JSONObject().apply {
                put("v", Protocol.VERSION)
                put("type", Protocol.TYPE_HEARTBEAT)
                put("id", java.util.UUID.randomUUID().toString())
                put("from", selfPrefix)
                put("to", "")
                put("ts", System.currentTimeMillis())
                put("payload", JSONObject())
            }.toString()
            synchronized(controlConns) {
                controlConns.toList().forEach { runCatching { it.send(text) } }
            }
        }
    }

    /** 接收方：登记一个待接收任务（文件名已在 handleOffer 清洗过） */
    fun registerIncoming(
        transferId: String,
        files: List<TransferFile>,
        saveDir: File
    ): Map<String, PartInfo> {
        val inc = Incoming()
        saveDir.mkdirs()
        files.forEach { f ->
            // 同名默认重命名，绝不静默覆盖
            val finalPath = uniqueFile(saveDir, f.name)
            val partPath = File(finalPath.parentFile, ".${finalPath.name}.linkspace.part")
            // 空文件没有任何分块，.part 必须在此建好，否则 rename 会 ENOENT
            partPath.createNewFile()
            inc.parts[f.name] = PartInfo(partPath.absolutePath, finalPath.absolutePath, f.size)
            inc.files[f.name] = f
        }
        incoming[transferId] = inc
        return inc.parts
    }

    fun setToken(transferId: String, token: String) {
        tokens[transferId] = token
    }

    fun cancel(transferId: String) {
        cancelled.add(transferId)
        incoming.remove(transferId)?.let { inc ->
            inc.parts.values.forEach { runCatching { File(it.partPath).delete() } }
        }
        tokens.remove(transferId)
    }

    fun forget(transferId: String) {
        incoming.remove(transferId)
        tokens.remove(transferId)
        cancelled.remove(transferId)
    }

    /**
     * 落盘：两阶段——先对全部文件校验（大小 + 整体摘要），全部通过后
     * 再统一改名。逐文件「校验即改名」的话，多文件任务第 N 个失败时
     * 前 N-1 个已经成了正式文件，任务整体却是失败状态，落盘结果与
     * 任务状态互相矛盾（审查 P3「部分成功不回滚」）。
     *
     * 摘要由发送方随 transfer.complete 经控制通道交来（与桌面端一致）。
     * 大小或摘要不符一律删除 .part 并报错——宁可丢文件也不能留个
     * 名字像模像样的损坏文件。取消/失败状态的任务直接拒绝。
     * 缺摘要不再兼容放行：协议规定 complete 必带 digests，缺省跳过
     * 等于给「静默篡改落盘内容」留门（全项目审查 P1-6）。
     */
    fun finalizeTransfer(transferId: String, digests: Map<String, String>): Result<Int> {
        if (cancelled.contains(transferId)) {
            return Result.failure(IllegalStateException("任务已取消，不落盘"))
        }
        val inc = incoming.remove(transferId)
            ?: return Result.failure(IllegalStateException("任务不存在或已落盘"))
        tokens.remove(transferId)

        // 第一阶段：全部校验，任何一项不过就整体失败（.part 统一清理）
        for ((name, part) in inc.parts) {
            val file = File(part.partPath)
            val fail = { reason: String -> Result.failure<Int>(IOException(reason)) }
            if (!file.exists()) {
                inc.cleanupParts()
                return fail("文件 $name 的 .part 不存在")
            }
            if (file.length() != part.expectedSize) {
                inc.cleanupParts()
                return fail("文件 $name 大小不符：期望 ${part.expectedSize}，实际 ${file.length()}")
            }
            val expected = digests[name] ?: run {
                inc.cleanupParts()
                return fail("缺少文件 $name 的整体摘要，拒绝落盘")
            }
            val actual = sha256File(file)
            if (actual != expected) {
                inc.cleanupParts()
                return fail("文件 $name 摘要不符：期望 ${expected.take(12)}…，实际 ${actual.take(12)}…")
            }
        }

        // 第二阶段：全部校验已通过，逐个改名。此刻唯一可能的失败是
        // 改名本身的 IO 异常（目标被占用等），概率极低且不会产生
        // 「坏内容当正式文件」的后果
        var done = 0
        for ((name, part) in inc.parts) {
            val target = File(part.finalPath)
            if (!File(part.partPath).renameTo(target)) {
                inc.cleanupParts()
                return Result.failure(IOException("文件 $name 改名失败"))
            }
            done++
        }
        return Result.success(done)
    }

    private fun Incoming.cleanupParts() {
        parts.values.forEach { runCatching { File(it.partPath).delete() } }
    }

    private fun sha256File(file: File): String {
        val md = MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    // ---------- 服务循环 ----------

    private fun acceptLoop(socket: ServerSocket) {
        while (!socket.isClosed) {
            val conn = try {
                socket.accept()
            } catch (e: IOException) {
                if (socket.isClosed) return else continue
            }
            if (!connSlots.tryAcquire()) {
                Log.w(TAG, "连接数已达上限，拒绝新连接")
                runCatching { conn.close() }
                continue
            }
            Thread({
                try {
                    handleConnection(conn)
                } catch (t: Throwable) {
                    // 处理器内的任何异常（包括 OOM 级别的分配失败）都不允许
                    // 带走 accept 线程，否则服务整体下线
                    Log.w(TAG, "连接处理异常: ${t.javaClass.simpleName}: ${t.message}")
                } finally {
                    connSlots.release()
                }
            }, "linkspace-conn").apply {
                isDaemon = true
                start()
            }
        }
    }

    private fun handleConnection(raw: Socket) {
        // 不能用 use {}：WebSocket 升级成功后连接被 WebSocketConnection 接管，
        // 而 use 退出时会关闭 socket，升级就等于白做。
        val socket = raw
        try {
            socket.tcpNoDelay = true
            val input = socket.getInputStream()
            val output = socket.getOutputStream()
            // 连入方 TLS 证书指纹：升级前连接已完成 TLS 握手（请求已读过），
            // 此时取证书既准确又省事。null = 对端未出示证书
            val tlsFp = tlsFingerprintOf(socket)

            // 一个连接上可能有多个请求（keep-alive），循环处理
            while (!socket.isClosed) {
                val head = try {
                    HttpHead.read(input)
                } catch (e: IOException) {
                    return
                } ?: return
                val keepAlive = handleRequest(socket, head, input, output, tlsFp)
                if (!keepAlive) return
            }
        } finally {
            // 已被 WebSocket 接管的连接不由这里关闭
            if (!handedOff.remove(socket)) {
                runCatching { socket.close() }
            }
        }
    }

    private fun handleRequest(
        socket: Socket,
        head: HttpHead,
        input: InputStream,
        out: OutputStream,
        tlsFp: String?
    ): Boolean {
        // WebSocket 升级：控制通道与文件传输共用同一端口（ADR-003）
        if (WebSocketConnection.isUpgrade(head.method, head.headers)) {
            val key = head.header("sec-websocket-key") ?: ""
            out.write(WebSocketConnection.handshakeResponse(key))
            out.flush()
            val conn = WebSocketConnection(socket)
            conn.listener = object : WebSocketConnection.Listener {
                override fun onMessage(text: String) = onControlMessage(conn, text, tlsFp)
                override fun onClosed() {
                    controlConns.remove(conn)
                    // 对端断连：把它留下的待确认配对请求清掉，否则会变成
                    // 永远展示在界面上、提交也不会成功的僵尸条目
                    val peer = controlPeerIds.remove(conn)
                    controlFingerprints.remove(conn)
                    if (peer != null) controlClosedHandler?.invoke(peer)
                }
            }
            controlConns.add(conn)
            Thread({ conn.run() }, "linkspace-ws").apply { isDaemon = true; start() }
            // 标记已交接，handleConnection 的 finally 不能再关这个 socket
            handedOff.add(socket)
            // WebSocket 接管了这个连接，HTTP 循环必须退出
            return false
        }

        val match = Regex("^/linkspace/v1/transfer/([^/]+)/chunk$").find(head.path)

        // 控制通道走 WebSocket，这里只处理数据面；其余一律 404 并断开
        // （body 未读，保持 keep-alive 会让后续解析错位）
        if (match == null) {
            writeResponse(out, 404, "not found", false)
            return false
        }

        // ---------- 鉴权（全部通过之前不读 body、不分配缓冲） ----------
        val deviceId = head.header(Protocol.HEADER_DEVICE_ID)
        val token = head.header(Protocol.HEADER_TRANSFER_TOKEN)
        if (deviceId.isNullOrEmpty() || token.isNullOrEmpty()) {
            writeResponse(out, 401, "missing credentials", head.keepAlive)
            return head.keepAlive
        }
        // 未授权设备一律拒绝——这是「未授权不能传输」的第一道闸门
        if (!trust.isKnown(deviceId) || !trust.hasScope(deviceId, "file")) {
            Log.w(TAG, "拒绝未授权设备的传输请求: ${deviceId.take(12)}")
            writeResponse(out, 403, "unknown device", head.keepAlive)
            return head.keepAlive
        }

        // 桌面端的键格式是 transferId:fileName（与 transfer/server.ts 一致），
        // 必须拆开：incoming 与 tokens 按裸 transferId 键控，part 按文件名取。
        // 不拆的话每个分块都会 404——曾踩过。
        val rawKey = decodeUriComponent(match.groupValues[1])
        val colon = rawKey.indexOf(':')
        if (colon <= 0) {
            writeResponse(out, 400, "bad key", head.keepAlive)
            return head.keepAlive
        }
        val transferId = rawKey.substring(0, colon)
        val fileName = rawKey.substring(colon + 1)
        val offset = head.query["offset"]?.toLongOrNull() ?: 0L
        if (offset < 0) {
            writeResponse(out, 400, "bad offset", head.keepAlive)
            return head.keepAlive
        }
        val inc = incoming[transferId]
        if (inc == null) {
            writeResponse(out, 404, "unknown transfer", head.keepAlive)
            return head.keepAlive
        }
        // 令牌必须与接收方生成的匹配
        if (tokens[transferId] != token) {
            writeResponse(out, 403, "bad token", head.keepAlive)
            return head.keepAlive
        }
        // 已取消的任务不得再收分块：取消与分块几乎同时到达时，
        // 不拦的话取消后落下的字节会重新长出 .part
        if (cancelled.contains(transferId)) {
            writeResponse(out, 409, "cancelled", head.keepAlive)
            return head.keepAlive
        }
        val part = inc.parts[fileName]
        if (part == null) {
            writeResponse(out, 404, "unknown file", head.keepAlive)
            return head.keepAlive
        }

        if (head.method == "POST") {
            // 请求体超限直接 413 断开，绝不分配缓冲
            if (head.contentLength > Protocol.MAX_CHUNK_BODY) {
                Log.w(TAG, "分块体超限 ${head.contentLength}，断开连接")
                writeResponse(out, 413, "chunk too large", false)
                return false
            }
            val body = readBody(input, head.contentLength)
            if (body == null) {
                return false
            }
            val written = File(part.partPath).length()

            // 空体 = 偏移探针，只回报已确认偏移
            if (body.isEmpty()) {
                writeJson(
                    out, 200, head.keepAlive,
                    JSONObject().apply {
                        put("ok", true)
                        put("received", 0)
                        put("committedOffset", written)
                        put("expectedSize", part.expectedSize)
                    }
                )
                return head.keepAlive
            }

            // 偏移必须衔接，否则直接追加会静默产生损坏文件
            if (offset != written) {
                writeJson(
                    out, 409, head.keepAlive,
                    JSONObject().apply {
                        put("ok", false)
                        put("committedOffset", written)
                        put("expectedSize", part.expectedSize)
                    }
                )
                return head.keepAlive
            }

            // 块级摘要校验（协议第 5 节）：不符的块不落盘，由发送方重传，
            // 而不是把坏字节写进 .part。缺摘要头视为非法请求
            val declared = head.header(Protocol.HEADER_CHUNK_DIGEST)
            if (declared.isNullOrEmpty() || !declared.equals(sha256Hex(body), ignoreCase = true)) {
                Log.w(TAG, "分块摘要校验失败: $transferId@$offset")
                writeJson(
                    out, 400, false,
                    JSONObject().apply {
                        put("ok", false)
                        put("error", "digest mismatch")
                        put("committedOffset", written)
                    }
                )
                return false
            }

            try {
                File(part.partPath).appendBytes(body)
            } catch (e: IOException) {
                Log.e(TAG, "写入分块失败: ${e.message}")
                writeResponse(out, 500, "io error", head.keepAlive)
                return head.keepAlive
            }

            val now = File(part.partPath).length()
            writeJson(
                out, 200, head.keepAlive,
                JSONObject().apply {
                    put("ok", true)
                    put("received", body.size)
                    put("committedOffset", now)
                    put("expectedSize", part.expectedSize)
                }
            )
            return head.keepAlive
        }

        if (head.method == "GET") {
            // length 上限与桌面端一致（32MiB）：不设上限时已认证对端
            // 一个请求就能申请 2GB 缓冲
            val length = (head.query["length"]?.toIntOrNull() ?: Protocol.CHUNK_SIZE)
                .coerceIn(1, Protocol.MAX_CHUNK_BODY)
            val data = readChunk(File(part.partPath), offset, length)
            out.write(
                buildHttpResponse(
                    200, head.keepAlive,
                    headers = mapOf(
                        "Content-Type" to "application/octet-stream",
                        "Content-Length" to data.size.toString(),
                        Protocol.HEADER_CHUNK_DIGEST to sha256Hex(data)
                    )
                )
            )
            out.write(data)
            out.flush()
            return head.keepAlive
        }

        writeResponse(out, 405, "method not allowed", head.keepAlive)
        return head.keepAlive
    }

    private fun readBody(input: InputStream, length: Long): ByteArray? {
        if (length <= 0) return ByteArray(0)
        val buf = ByteArray(length.toInt())
        var read = 0
        while (read < length) {
            val n = input.read(buf, read, length.toInt() - read)
            if (n < 0) return null
            read += n
        }
        return buf
    }

    private fun tlsFingerprintOf(socket: Socket): String? = runCatching {
        val ssl = socket as? SSLSocket ?: return null
        val cert = ssl.session?.peerCertificates?.firstOrNull()
            as? java.security.cert.X509Certificate ?: return null
        sha256Hex(cert.encoded).replace(":", "").lowercase()
    }.getOrNull()

    // ---------- 控制通道 ----------

    /**
     * 控制消息的处理上下文。peerId 是该连接在 announce 时登记的身份，
     * tlsFingerprint 是连入方出示的客户端证书指纹（可能为 null）。
     * 服务层据此做指纹锚定：自报身份只有挂到真实证书上才可信。
     */
    class ControlContext(
        val peerId: String,
        val tlsFingerprint: String?,
        internal val conn: WebSocketConnection
    ) {
        /** 主动掐断这条连接（指纹不符、配对码穷举等场景） */
        fun close() {
            runCatching { conn.close() }
        }
    }

    /** 上层注入的控制消息处理器 */
    var controlHandler: ((ControlContext, JSONObject) -> Unit)? = null

    private fun onControlMessage(conn: WebSocketConnection, text: String, tlsFp: String?) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        val from = obj.optString("from")
        if (from.isEmpty()) return
        // 协议 §3 语义校验：v 可处理、to 为本机或空（心跳广播）、
        // ts 在 ±60s 窗口。任一项失败即断开——这是对畸形/重放消息的
        // 统一防线，桌面端 control/node.ts 同规则
        val selfPrefix = identity.get().fingerprint.replace(":", "").take(12)
        if (obj.optInt("v", -1) != Protocol.VERSION) {
            Log.w(TAG, "协议版本不符（v=${obj.optInt("v", -1)}），断开连接")
            runCatching { conn.close() }
            return
        }
        val to = obj.optString("to")
        if (to.isNotEmpty() && to != selfPrefix) {
            Log.w(TAG, "信封 to 非本机（$to），断开连接")
            runCatching { conn.close() }
            return
        }
        val ts = obj.optLong("ts", 0L)
        if (ts <= 0 || kotlin.math.abs(System.currentTimeMillis() - ts) > 60_000) {
            Log.w(TAG, "信封 ts 超出时钟窗口，断开连接")
            runCatching { conn.close() }
            return
        }
        val registered = controlPeerIds[conn]
        if (registered == null) {
            controlPeerIds[conn] = from
            controlFingerprints[conn] = tlsFp
            controlHandler?.invoke(ControlContext(from, tlsFp, conn), obj)
        } else if (registered != from) {
            Log.w(TAG, "连接身份漂移（$registered → $from），丢弃消息")
        } else {
            controlHandler?.invoke(ControlContext(registered, controlFingerprints[conn], conn), obj)
        }
    }

    /** 控制连接断开回调，参数为对端设备 ID */
    var controlClosedHandler: ((String) -> Unit)? = null

    fun sendControl(obj: JSONObject) {
        val text = obj.toString()
        synchronized(controlConns) {
            controlConns.toList().forEach { it.send(text) }
        }
    }

    /**
     * 只发给指定对端。
     * 广播（sendControl）不适合 accept 与剪贴板：token 和内容应当只给
     * 任务的当事对端，一次广播等于把它们交给连上的每一台设备——
     * 包括未认证的连接（全项目审查 P0-2）。
     */
    fun sendControlTo(peerId: String, obj: JSONObject) {
        val text = obj.toString()
        synchronized(controlConns) {
            controlConns.toList().forEach { conn ->
                if (controlPeerIds[conn] == peerId) conn.send(text)
            }
        }
    }

    /** 主动掐断某对端的全部控制连接（指纹不符 / 配对码穷举时调用） */
    fun closePeer(peerId: String) {
        synchronized(controlConns) {
            controlConns.toList().forEach { conn ->
                if (controlPeerIds[conn] == peerId) runCatching { conn.close() }
            }
        }
    }

    /** 当前已建立控制连接且已声明身份的对端 ID */
    fun connectedPeerIds(): Set<String> {
        synchronized(controlConns) {
            return controlConns.mapNotNull { controlPeerIds[it] }.toSet()
        }
    }

    // ---------- 工具 ----------

    /**
     * 清洗来自对端的文件名：剥掉全部路径成分，只留基础名。
     * 名字不清洗的话 `join(saveDir, name)` 会被 `../` 序列拼出保存目录
     * 之外的写入路径；清洗后为空 / `.` / `..` 的名字直接拒绝。
     * 手工按两种分隔符切分，不依赖本机 File 的平台语义。
     */
    fun sanitizeFileName(name: String): String {
        val base = name.replace('\\', '/').substringAfterLast('/')
        val cleaned = base.trim()
        if (cleaned.isEmpty() || cleaned == "." || cleaned == "..") {
            throw IOException("非法文件名: ${name.take(80)}")
        }
        return cleaned.take(255)
    }

    private fun uniqueFile(dir: File, name: String): File {
        val direct = File(dir, name)
        if (!direct.exists()) return direct
        val ext = name.substringAfterLast('.', "")
        val stem = if (ext.isEmpty()) name else name.removeSuffix(".$ext")
        for (i in 1..9999) {
            val candidate = File(dir, if (ext.isEmpty()) "$stem ($i)" else "$stem ($i).$ext")
            if (!candidate.exists()) return candidate
        }
        throw IOException("无法为 $name 生成不重复的文件名")
    }

    private fun readChunk(file: File, offset: Long, length: Int): ByteArray {
        val raf = java.io.RandomAccessFile(file, "r")
        raf.use {
            it.seek(offset)
            val buf = ByteArray(length)
            var read = 0
            while (read < length) {
                val n = it.read(buf, read, length - read)
                if (n < 0) break
                read += n
            }
            return if (read == length) buf else buf.copyOf(read)
        }
    }

    private fun writeResponse(out: OutputStream, code: Int, body: String, keepAlive: Boolean) {
        val bytes = body.toByteArray()
        out.write(
            buildHttpResponse(
                code, keepAlive,
                mapOf("Content-Type" to "text/plain", "Content-Length" to bytes.size.toString())
            )
        )
        out.write(bytes)
        out.flush()
    }

    private fun writeJson(out: OutputStream, code: Int, keepAlive: Boolean, obj: JSONObject) {
        val body = obj.toString().toByteArray()
        out.write(
            buildHttpResponse(
                code, keepAlive,
                mapOf("Content-Type" to "application/json", "Content-Length" to body.size.toString())
            )
        )
        out.write(body)
        out.flush()
    }

    private fun buildHttpResponse(
        code: Int,
        keepAlive: Boolean,
        headers: Map<String, String>
    ): ByteArray {
        val reason = when (code) {
            200 -> "OK"
            400 -> "Bad Request"
            401 -> "Unauthorized"
            403 -> "Forbidden"
            404 -> "Not Found"
            405 -> "Method Not Allowed"
            409 -> "Conflict"
            413 -> "Payload Too Large"
            500 -> "Internal Server Error"
            else -> "Unknown"
        }
        return buildString {
            append("HTTP/1.1 $code $reason\r\n")
            headers.forEach { (k, v) -> append("$k: $v\r\n") }
            append("Connection: ${if (keepAlive) "keep-alive" else "close"}\r\n")
            append("\r\n")
        }.toByteArray()
    }

    companion object {
        private const val TAG = "LinkSpace/Transfer"

        fun sha256Hex(data: ByteArray): String =
            MessageDigest.getInstance("SHA-256").digest(data)
                .joinToString("") { "%02x".format(it) }

        /**
         * 百分号解码。URLDecoder 是表单编码语义，会把 `+` 还原成空格——
         * 文件名里字面的 `+` 会被解码错，先把它转义成 %2B 再解码
         * （发送方编码时 + 从不表示空格，桌面端 decodeURIComponent 同语义）。
         */
        fun decodeUriComponent(s: String): String =
            java.net.URLDecoder.decode(s.replace("+", "%2B"), "UTF-8")
    }
}

/** 单个文件的落盘信息。提成顶层类：registerIncoming 是 public，返回值不能是私有嵌套类 */
class PartInfo(val partPath: String, val finalPath: String, val expectedSize: Long)

/**
 * 服务端对连入方证书的 TLS 层放行器：只索取不出示就拒真的证书校验。
 * 空实现与 [cn.linkspace.client.service.LinkSpaceClient] 的 BlindTrust
 * 同款——身份锚定靠应用层指纹闸门，不靠证书链。
 */
private object PermissiveTrustManager : javax.net.ssl.X509TrustManager {
    override fun checkClientTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
    override fun checkServerTrusted(chain: Array<out java.security.cert.X509Certificate>?, authType: String?) {}
    override fun getAcceptedIssuers(): Array<java.security.cert.X509Certificate> = emptyArray()
}

/** 单个请求头区块的上限，防止无界逐字节拼接吃光内存 */
private const val MAX_HEADER_BYTES = 32 * 1024
private const val MAX_HEADER_LINES = 100

/**
 * HTTP 请求头（不含 body）。body 由 handleRequest 在鉴权通过后
 * 经 [TransferServer.readBody] 读取——先鉴权后读体是内存安全的根基。
 */
private class HttpHead(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val contentLength: Long,
    val keepAlive: Boolean
) {
    fun header(name: String): String? = headers[name.lowercase()]

    companion object {
        fun read(input: InputStream): HttpHead? {
            val requestLine = readLine(input) ?: return null
            val parts = requestLine.split(" ")
            if (parts.size < 3) throw IOException("非法的请求行: ${requestLine.take(80)}")
            val method = parts[0]
            val rawPath = parts[1]

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readLine(input) ?: throw IOException("请求头未结束")
                if (line.isEmpty()) break
                if (headers.size >= MAX_HEADER_LINES) throw IOException("请求头过多")
                val idx = line.indexOf(':')
                if (idx > 0) {
                    headers[line.substring(0, idx).trim().lowercase()] = line.substring(idx + 1).trim()
                }
            }

            val qIdx = rawPath.indexOf('?')
            val path = if (qIdx >= 0) rawPath.substring(0, qIdx) else rawPath
            val query = mutableMapOf<String, String>()
            if (qIdx >= 0) {
                rawPath.substring(qIdx + 1).split('&').forEach { kv ->
                    val eq = kv.indexOf('=')
                    if (eq > 0) query[kv.substring(0, eq)] = TransferServer.decodeUriComponent(kv.substring(eq + 1))
                }
            }

            val contentLength = headers["content-length"]?.toLongOrNull() ?: 0L
            val conn = headers["connection"]?.lowercase() ?: ""
            val keepAlive = conn != "close"
            return HttpHead(method, path, query, headers, contentLength, keepAlive)
        }

        /** 逐字节读一行，行长超限即抛——头行无界拼接是内存耗尽的另一条路 */
        private fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val c = input.read()
                if (c < 0) return if (sb.isEmpty()) null else sb.toString()
                if (c == '\n'.code) return sb.toString().removeSuffix("\r")
                if (c != '\r'.code) sb.append(c.toChar())
                if (sb.length > MAX_HEADER_BYTES) throw IOException("请求行/头过长")
            }
        }
    }
}
