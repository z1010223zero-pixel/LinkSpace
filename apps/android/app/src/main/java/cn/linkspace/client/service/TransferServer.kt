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
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLServerSocketFactory

/**
 * HTTPS 文件接收服务。
 *
 * 为什么不用 NanoHTTPD：它的 HTTPS API 要求从一个 KeyStore InputStream 构造，
 * 而我们的证书是运行时生成的，需要额外序列化一层；协议本身只有几条路由，
 * 自己实现一个最小 HTTP/1.1 处理器更可控，也更容易审查。
 *
 * 与桌面端 `transfer/server.ts` 的路由、头字段、状态码逐字对应：
 *   POST /linkspace/v1/transfer/:id/chunk?offset=N    写入分块
 *   GET  /linkspace/v1/transfer/:id/chunk?offset=N    读取分块
 *   空体 POST = 偏移探针，只回报 committedOffset
 *   偏移不衔接返回 409
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
    /** WebSocket 连接 → 对端设备 ID。收到首条消息时记录，关闭时用于清理 */
    private val controlPeerIds = java.util.Collections.synchronizedMap(mutableMapOf<WebSocketConnection, String>())

    /** 已交接给 WebSocket 的连接，finally 不得再关闭 */
    private val handedOff: MutableSet<java.net.Socket> =
        java.util.Collections.synchronizedSet(mutableSetOf())

    private var serverSocket: ServerSocket? = null
    private var thread: Thread? = null

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
        ctx.init(kmf.keyManagers, null, null)
        val factory: SSLServerSocketFactory = ctx.serverSocketFactory
        val socket = factory.createServerSocket(0, 64) as ServerSocket
        socket.reuseAddress = true
        serverSocket = socket
        port = socket.localPort

        thread = Thread({ acceptLoop(socket) }, "linkspace-transfer").apply {
            isDaemon = true
            start()
        }
        Log.i(TAG, "文件传输服务已监听 0.0.0.0:$port")
        return port
    }

    fun stop() {
        runCatching { serverSocket?.close() }
        serverSocket = null
        thread = null
    }

    /** 接收方：登记一个待接收任务（桌面端 offer 到达时调用） */
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
     * 落盘：校验大小与整体摘要，通过才把 .part 改名为正式文件。
     *
     * 摘要由发送方随 transfer.complete 经控制通道交来（与桌面端一致）。
     * 大小或摘要不符一律删除 .part 并报错——宁可丢文件也不能留个
     * 名字像模像样的损坏文件。取消/失败状态的任务直接拒绝。
     */
    fun finalizeTransfer(transferId: String, digests: Map<String, String>): Result<Int> {
        if (cancelled.contains(transferId)) {
            return Result.failure(IllegalStateException("任务已取消，不落盘"))
        }
        val inc = incoming.remove(transferId)
            ?: return Result.failure(IllegalStateException("任务不存在或已落盘"))
        tokens.remove(transferId)

        var done = 0
        for ((name, part) in inc.parts) {
            val file = File(part.partPath)
            if (!file.exists()) {
                return Result.failure(IOException("文件 $name 的 .part 不存在"))
            }
            // 1. 大小必须与 offer 声明一致
            if (file.length() != part.expectedSize) {
                runCatching { file.delete() }
                return Result.failure(
                    IOException("文件 $name 大小不符：期望 ${part.expectedSize}，实际 ${file.length()}")
                )
            }
            // 2. 整体摘要必须与发送方一致（发送方没提供则不校验，兼容旧行为）
            val expected = digests[name]
            if (expected != null) {
                val actual = sha256File(file)
                if (actual != expected) {
                    runCatching { file.delete() }
                    return Result.failure(IOException("文件 $name 摘要不符：期望 ${expected.take(12)}…，实际 ${actual.take(12)}…"))
                }
            }
            // 3. 改名。目标已存在时说明落盘目录出现了同名文件，重命名避免覆盖
            val target = File(part.finalPath)
            if (!file.renameTo(target)) {
                runCatching { file.delete() }
                return Result.failure(IOException("文件 $name 改名失败"))
            }
            done++
        }
        return Result.success(done)
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
            Thread({ handleConnection(conn) }, "linkspace-conn").apply {
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

            // 一个连接上可能有多个请求（keep-alive），循环处理
            while (!socket.isClosed) {
                val req = try {
                    HttpRequest.read(input)
                } catch (e: IOException) {
                    return
                } ?: return

                val keepAlive = handleRequest(socket, req, output)
                if (!keepAlive) return
            }
        } finally {
            // 已被 WebSocket 接管的连接不由这里关闭
            if (!handedOff.remove(socket)) {
                runCatching { socket.close() }
            }
        }
    }

    private fun handleRequest(socket: Socket, req: HttpRequest, out: OutputStream): Boolean {
        // WebSocket 升级：控制通道与文件传输共用同一端口（ADR-003）
        if (WebSocketConnection.isUpgrade(req.method, req.headers)) {
            val key = req.header("sec-websocket-key") ?: ""
            out.write(WebSocketConnection.handshakeResponse(key))
            out.flush()
            val conn = WebSocketConnection(socket)
            conn.listener = object : WebSocketConnection.Listener {
                override fun onMessage(text: String) = onControlMessage(conn, text)
                override fun onClosed() {
                    controlConns.remove(conn)
                    // 对端断连：把它留下的待确认配对请求清掉，否则会变成
                    // 永远展示在界面上、提交也不会成功的僵尸条目
                    val peer = controlPeerIds.remove(conn)
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

        val path = req.path
        val match = Regex("^/linkspace/v1/transfer/([^/]+)/chunk$").find(path)

        // 控制通道走 WebSocket，这里只处理数据面；其余一律 404
        if (match == null) {
            writeResponse(out, 404, "not found", req.keepAlive)
            return req.keepAlive
        }

        val deviceId = req.header(Protocol.HEADER_DEVICE_ID)
        val token = req.header(Protocol.HEADER_TRANSFER_TOKEN)
        if (deviceId.isNullOrEmpty() || token.isNullOrEmpty()) {
            writeResponse(out, 401, "missing credentials", req.keepAlive)
            return req.keepAlive
        }
        // 未授权设备一律拒绝——这是「未授权不能传输」的第一道闸门
        if (!trust.isKnown(deviceId) || !trust.hasScope(deviceId, "file")) {
            Log.w(TAG, "拒绝未授权设备的传输请求: ${deviceId.take(12)}")
            writeResponse(out, 403, "unknown device", req.keepAlive)
            return req.keepAlive
        }

        // 桌面端的键格式是 transferId:fileName（与 transfer/server.ts 一致），
        // 必须拆开：incoming 与 tokens 按裸 transferId 键控，part 按文件名取。
        // 不拆的话每个分块都会 404——曾踩过。
        val rawKey = decodeUriComponent(match.groupValues[1])
        val colon = rawKey.indexOf(':')
        if (colon <= 0) {
            writeResponse(out, 400, "bad key", req.keepAlive)
            return req.keepAlive
        }
        val transferId = rawKey.substring(0, colon)
        val fileName = rawKey.substring(colon + 1)
        val offset = req.query["offset"]?.toLongOrNull() ?: 0L
        val inc = incoming[transferId]
        if (inc == null) {
            writeResponse(out, 404, "unknown transfer", req.keepAlive)
            return req.keepAlive
        }
        // 令牌必须与接收方生成的匹配
        if (tokens[transferId] != token) {
            writeResponse(out, 403, "bad token", req.keepAlive)
            return req.keepAlive
        }
        // 已取消的任务不得再收分块：取消与分块几乎同时到达时，
        // 不拦的话取消后落下的字节会重新长出 .part
        if (cancelled.contains(transferId)) {
            writeResponse(out, 409, "cancelled", req.keepAlive)
            return req.keepAlive
        }
        val part = inc.parts[fileName]
        if (part == null) {
            writeResponse(out, 404, "unknown file", req.keepAlive)
            return req.keepAlive
        }

        if (req.method == "POST") {
            val written = File(part.partPath).length()

            // 空体 = 偏移探针，只回报已确认偏移
            if (req.body.isEmpty()) {
                writeJson(
                    out, 200, req.keepAlive,
                    JSONObject().apply {
                        put("ok", true)
                        put("received", 0)
                        put("committedOffset", written)
                        put("expectedSize", part.expectedSize)
                    }
                )
                return req.keepAlive
            }

            // 偏移必须衔接，否则直接追加会静默产生损坏文件
            if (offset != written) {
                writeJson(
                    out, 409, req.keepAlive,
                    JSONObject().apply {
                        put("ok", false)
                        put("committedOffset", written)
                        put("expectedSize", part.expectedSize)
                    }
                )
                return req.keepAlive
            }

            try {
                File(part.partPath).appendBytes(req.body)
            } catch (e: IOException) {
                Log.e(TAG, "写入分块失败: ${e.message}")
                writeResponse(out, 500, "io error", req.keepAlive)
                return req.keepAlive
            }

            val now = File(part.partPath).length()
            writeJson(
                out, 200, req.keepAlive,
                JSONObject().apply {
                    put("ok", true)
                    put("received", req.body.size)
                    put("committedOffset", now)
                    put("expectedSize", part.expectedSize)
                }
            )
            return req.keepAlive
        }

        if (req.method == "GET") {
            val part = inc.parts[fileName] ?: run {
                writeResponse(out, 404, "unknown file", req.keepAlive)
                return req.keepAlive
            }
            val length = req.query["length"]?.toIntOrNull() ?: Protocol.CHUNK_SIZE
            val data = readChunk(File(part.partPath), offset, length)
            out.write(
                buildHttpResponse(
                    200, req.keepAlive,
                    headers = mapOf(
                        "Content-Type" to "application/octet-stream",
                        "Content-Length" to data.size.toString(),
                        Protocol.HEADER_CHUNK_DIGEST to sha256Hex(data)
                    )
                )
            )
            out.write(data)
            out.flush()
            return req.keepAlive
        }

        writeResponse(out, 405, "method not allowed", req.keepAlive)
        return req.keepAlive
    }

    // ---------- 控制通道 ----------

    /** 上层注入的控制消息处理器 */
    var controlHandler: ((JSONObject) -> Unit)? = null

    private fun onControlMessage(conn: WebSocketConnection, text: String) {
        val obj = runCatching { JSONObject(text) }.getOrNull() ?: return
        // 记录这条连接属于哪个对端，断连清理时要用
        val from = obj.optString("from")
        if (from.isNotEmpty()) controlPeerIds[conn] = from
        controlHandler?.invoke(obj)
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
     * 广播（sendControl）不适合剪贴板：内容应当只给持有 clipboard 授权
     * 的对端，一次广播会把文本推给连上的每一台设备。
     */
    fun sendControlTo(peerId: String, obj: JSONObject) {
        val text = obj.toString()
        synchronized(controlConns) {
            controlConns.toList().forEach { conn ->
                if (controlPeerIds[conn] == peerId) conn.send(text)
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
        out.write(buildHttpResponse(code, keepAlive, mapOf("Content-Type" to "text/plain")))
        out.write(body.toByteArray())
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

        fun decodeUriComponent(s: String): String =
            java.net.URLDecoder.decode(s, "UTF-8")
    }
}

/** 单个文件的落盘信息。提成顶层类：registerIncoming 是 public，返回值不能是私有嵌套类 */
class PartInfo(val partPath: String, val finalPath: String, val expectedSize: Long)

/** 最小 HTTP/1.1 请求解析。只支持我们需要的子集：固定头 + Content-Length 体 */
private class HttpRequest(
    val method: String,
    val path: String,
    val query: Map<String, String>,
    val headers: Map<String, String>,
    val body: ByteArray,
    val keepAlive: Boolean
) {
    fun header(name: String): String? = headers[name.lowercase()]

    companion object {
        fun read(input: InputStream): HttpRequest? {
            val requestLine = readLine(input) ?: return null
            val parts = requestLine.split(" ")
            if (parts.size < 3) throw IOException("非法的请求行: $requestLine")
            val method = parts[0]
            val rawPath = parts[1]

            val headers = mutableMapOf<String, String>()
            while (true) {
                val line = readLine(input) ?: throw IOException("请求头未结束")
                if (line.isEmpty()) break
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
                    if (eq > 0) query[kv.substring(0, eq)] = kv.substring(eq + 1)
                }
            }

            val contentLength = headers["content-length"]?.toIntOrNull() ?: 0
            val body = ByteArray(contentLength)
            var read = 0
            while (read < contentLength) {
                val n = input.read(body, read, contentLength - read)
                if (n < 0) break
                read += n
            }

            val conn = headers["connection"]?.lowercase() ?: ""
            val keepAlive = conn != "close"
            return HttpRequest(method, path, query, headers, if (read == contentLength) body else body.copyOf(read), keepAlive)
        }

        private fun readLine(input: InputStream): String? {
            val sb = StringBuilder()
            while (true) {
                val c = input.read()
                if (c < 0) return if (sb.isEmpty()) null else sb.toString()
                if (c == '\n'.code) return sb.toString().removeSuffix("\r")
                if (c != '\r'.code) sb.append(c.toChar())
            }
        }
    }
}
