package cn.linkspace.client.service

import android.util.Log
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.net.InetSocketAddress
import java.net.Socket
import java.security.MessageDigest
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocket
import javax.net.ssl.TrustManager
import javax.net.ssl.X509TrustManager

/**
 * 主动连接对端的客户端（Android 作为发送方时使用）。
 *
 * 与 [WebSocketConnection] 的分工：那个是**服务端角色**（等别人连进来），
 * 这个是**客户端角色**（连出去）。两端都是手写的 TLS + WebSocket，
 * 没有引入 OkHttp——发送路径只需要「连上、发几帧、POST 几个分块」，
 * 引一个 HTTP 库换来的复杂度比省下的多。
 *
 * 证书链校验依然宽松（TOFU + 指纹人工核对，无 CA 可依赖），但**指纹
 * 必须钉住**：调用方传入信任清单里记录的对端指纹，握手后与对端实际
 * 证书逐一比对，不符即断开。TLS 盲信任曾被审查定性为 P0——假 mDNS
 * 或 ARP 欺骗把连接引向攻击者，就能整体接管控制通道、截获文件全文。
 */
class LinkSpaceClient(private val identity: Identity) {

    companion object {
        private const val TAG = "LinkSpace/Client"
        private const val CONNECT_TIMEOUT_MS = 8000
        /**
         * 读超时只防「对端死了读挂起」，不是活动性探测：键鼠会话的空闲期
         * （心跳只出不进，桌面端不回 heartbeat）入向可以几分钟没有字节，
         * 15s 会把还活着的读循环杀死——之后发送向仍在（TCP 未感知），
         * 表现为「请求发得出去、回告收不到」（真机踩过：投屏 start 石沉大海）。
         * 60s 足够兜住死链，又不会误伤空闲会话。
         */
        private const val READ_TIMEOUT_MS = 60000
        /** 与桌面端 CHUNK_SIZE 一致 */
        private const val CHUNK_SIZE = 4 * 1024 * 1024
    }

    private class BlindTrust : X509TrustManager {
        override fun checkClientTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun checkServerTrusted(chain: Array<out X509Certificate>?, authType: String?) {}
        override fun getAcceptedIssuers(): Array<X509Certificate> = emptyArray()
    }

    private fun tlsSocket(host: String, port: Int, expectFingerprint: String?): SSLSocket {
        val ctx = SSLContext.getInstance("TLS")
        val kmf = javax.net.ssl.KeyManagerFactory.getInstance(
            javax.net.ssl.KeyManagerFactory.getDefaultAlgorithm()
        )
        kmf.init(identity.keyStore(), CharArray(0))
        ctx.init(kmf.keyManagers, arrayOf<TrustManager>(BlindTrust()), null)
        val raw = Socket()
        raw.connect(InetSocketAddress(host, port), CONNECT_TIMEOUT_MS)
        raw.soTimeout = READ_TIMEOUT_MS
        // 键鼠事件是高频小帧：Nagle 会把小包攒到 ACK 或满段才发，
        // 视觉上就是「指针卡一下动一下」。禁用之（T7 用户实测卡顿）
        raw.tcpNoDelay = true
        val ssl = ctx.socketFactory.createSocket(raw, host, port, true) as SSLSocket
        ssl.startHandshake()

        // 指纹钉住（TOFU 的「已核对过」半边）：对端证书必须与信任清单
        // 里配对时记录的指纹一致。桌面端 fingerprintOfCert 是对 DER
        // 做 SHA-256，这里取证书编码后同样计算
        if (expectFingerprint != null) {
            val cert = ssl.session?.peerCertificates?.firstOrNull() as? X509Certificate
                ?: error("对端未出示证书")
            val actual = MessageDigest.getInstance("SHA-256").digest(cert.encoded)
                .joinToString("") { "%02x".format(it) }
            if (!actual.equals(expectFingerprint.replace(":", "").lowercase(), ignoreCase = true)) {
                ssl.close()
                error("对端证书指纹与信任清单不符，可能存在中间人，已断开")
            }
        }
        return ssl
    }

    /** 连接并完成 WebSocket 客户端握手，返回可读写的连接 */
    suspend fun connectControl(
        host: String,
        port: Int,
        path: String,
        expectFingerprint: String? = null
    ): ClientConnection =
        withContext(Dispatchers.IO) {
            val ssl = tlsSocket(host, port, expectFingerprint)
            val key = java.util.Base64.getEncoder()
                .encodeToString(ByteArray(16).also { java.security.SecureRandom().nextBytes(it) })
            val req = buildString {
                append("GET $path HTTP/1.1\r\n")
                append("Host: $host:$port\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Key: $key\r\n")
                append("Sec-WebSocket-Version: 13\r\n")
                append("\r\n")
            }
            ssl.getOutputStream().also { it.write(req.toByteArray()); it.flush() }

            // 读响应头。按行读到空行为止，不假设一次性到达
            val header = StringBuilder()
            val buf = ByteArray(1)
            while (!header.endsWith("\r\n\r\n")) {
                val n = ssl.getInputStream().read(buf)
                if (n < 0) break
                header.append(String(buf, 0, n, Charsets.ISO_8859_1))
                if (header.length > 16 * 1024) error("响应头过长")
            }
            val first = header.toString().lineSequence().firstOrNull() ?: ""
            if (!first.contains("101")) {
                error("WebSocket 握手失败: $first")
            }
            Log.i(TAG, "控制通道已连接 $host:$port")
            ClientConnection(ssl)
        }

    /**
     * 分块上传专用连接：不复用控制通道的 socket。
     * 控制通道升级成 WebSocket 后，同一条连接再发 HTTP 请求会被对端的
     * ws 解析器当成畸形帧（RSV2/RSV3 报错，直接炸掉对方进程）。
     * 上传走独立 TLS 连接，对端把它当普通 HTTPS 请求处理。
     */
    suspend fun connectUpload(host: String, port: Int, expectFingerprint: String? = null): SSLSocket =
        withContext(Dispatchers.IO) {
            tlsSocket(host, port, expectFingerprint).also { Log.i(TAG, "上传通道已连接 $host:$port") }
        }

    /**
     * POST 一个分块。
     *
     * 上传连接按 keep-alive 复用：分块数量多，每块重新握手会把大部分
     * 时间花在 TLS 上。响应必须带 Content-Length（桌面端已保证），
     * 否则 chunked 残帧会让下一次解析错位。
     * 返回响应体文本，调用方据此判断是否要继续。
     */
    suspend fun postChunk(
        socket: SSLSocket,
        host: String,
        port: Int,
        url: String,
        deviceId: String,
        token: String,
        body: ByteArray,
        chunkDigest: String
    ): Pair<Int, String> = withContext(Dispatchers.IO) {
        val path = url
        val req = buildString {
            append("POST $path HTTP/1.1\r\n")
            append("Host: $host:$port\r\n")
            append("X-Device-Id: $deviceId\r\n")
            append("X-Transfer-Token: $token\r\n")
            append("X-Chunk-Digest: $chunkDigest\r\n")
            append("Content-Type: application/octet-stream\r\n")
            append("Content-Length: ${body.size}\r\n")
            append("\r\n")
        }
        val out: OutputStream = socket.getOutputStream()
        out.write(req.toByteArray())
        out.write(body)
        out.flush()

        // 读响应：状态行 + 头 + 体（Content-Length 界定）
        val input = socket.getInputStream()
        val header = StringBuilder()
        val one = ByteArray(1)
        while (!header.endsWith("\r\n\r\n")) {
            val n = input.read(one)
            if (n < 0) break
            header.append(String(one, 0, n, Charsets.ISO_8859_1))
            if (header.length > 16 * 1024) error("响应头过长")
        }
        val lines = header.toString().split("\r\n")
        val status = lines.firstOrNull()?.split(" ")?.getOrNull(1)?.toIntOrNull() ?: -1
        val headers = lines.drop(1).mapNotNull { line ->
            val i = line.indexOf(':')
            if (i <= 0) null else line.substring(0, i).lowercase() to line.substring(i + 1).trim()
        }.toMap()
        val len = headers["content-length"]?.toIntOrNull() ?: 0
        val bodyBuf = ByteArray(len)
        var read = 0
        while (read < len) {
            val n = input.read(bodyBuf, read, len - read)
            if (n < 0) break
            read += n
        }
        status to String(bodyBuf, 0, read, Charsets.UTF_8)
    }

    /** 发一帧文本（客户端→服务端必须掩码） */
    fun sendText(conn: ClientConnection, text: String) {
        conn.sendText(text)
    }

    /** 阻塞读一帧文本。返回 null 表示连接关闭 */
    fun readText(conn: ClientConnection): String? = conn.readText()

    fun readFrame(conn: ClientConnection): Pair<Int, ByteArray>? = conn.readFrame()

    fun close(conn: ClientConnection) {
        runCatching { conn.close() }
    }

    /** 已连接的控制通道。持有 TLS socket，供后续分块 POST 复用 */
    class ClientConnection(internal val socket: SSLSocket) {
        val host: String get() = socket.inetAddress?.hostAddress ?: ""
        val port: Int get() = socket.port

        private val maskKey = ByteArray(4).also { java.security.SecureRandom().nextBytes(it) }

        fun sendText(text: String) {
            val payload = text.toByteArray(Charsets.UTF_8)
            val out = socket.getOutputStream()
            // 0x81 = FIN | 文本帧；129 超出 Byte 范围，必须显式 toByte()
            val header = when {
                payload.size < 126 -> byteArrayOf(0x81.toByte(), (0x80 or payload.size).toByte())
                payload.size < 65536 -> byteArrayOf(
                    0x81.toByte(), (0x80 or 126).toByte(),
                    (payload.size shr 8).toByte(), payload.size.toByte()
                )
                else -> byteArrayOf(
                    0x81.toByte(), (0x80 or 127).toByte(),
                    0, 0, 0, 0,
                    (payload.size shr 24).toByte(), (payload.size shr 16).toByte(),
                    (payload.size shr 8).toByte(), payload.size.toByte()
                )
            }
            synchronized(out) {
                out.write(header)
                out.write(maskKey)
                val masked = ByteArray(payload.size)
                for (i in payload.indices) masked[i] = (payload[i].toInt() xor maskKey[i % 4].toInt()).toByte()
                out.write(masked)
                out.flush()
            }
        }

        fun readText(): String? {
            val frame = readFrame() ?: return null
            return if (frame.first == 0x1) String(frame.second, Charsets.UTF_8) else ""
        }

        /**
         * 读一帧（阻塞）。first=opcode（0x1 文本 / 0x2 二进制 / 0x8 关闭），
         * second=负载。屏幕投屏的视频块走二进制帧，与 JSON 控制消息
         * 共用同一条连接，调用方按 opcode 分流。
         */
        fun readFrame(): Pair<Int, ByteArray>? {
            val input = socket.getInputStream()
            fun readExact(n: Int): ByteArray? {
                val b = ByteArray(n)
                var r = 0
                while (r < n) {
                    val k = input.read(b, r, n - r)
                    if (k < 0) return null
                    r += k
                }
                return b
            }
            val b0 = readExact(1) ?: return null
            val b1 = readExact(1) ?: return null
            val opcode = b0[0].toInt() and 0x0f
            // 长度编码由原始 7-bit 值决定，与解码出的长度值无关——此前用
            // 解码值判断，16-bit 扩展长度恰好为 127 的帧（node-ws 对
            // ≥126 字节一律用 16-bit 编码，127 字节的视频小帧真会出现）
            // 会被二次当成 64-bit 标记再吞 8 字节，H.264 起始码 00 00 00 01
            // 被当成长度 5.4GB → 读循环暴毙（真机 e8hex 取证实锤）
            var len = b1[0].toLong() and 0x7f
            var e8hex = ""
            when (len) {
                126L -> {
                    val e = readExact(2)!!
                    len = ((e[0].toLong() and 0xff) shl 8) or (e[1].toLong() and 0xff)
                }
                127L -> {
                    val e = readExact(8)!!
                    len = 0
                    for (i in 0..7) len = (len shl 8) or (e[i].toLong() and 0xff)
                    e8hex = e.joinToString("") { "%02x".format(it) }
                }
            }
            if (len > 32L * 1024 * 1024) {
                // 失同步诊断：正常流里不可能出现（桌面 ws 库对单 Buffer
                // 不分片、单帧 ≤64KB）。真机踩过 5.4GB 的荒谬长度——
                // 帧边界错位，把视频字节误当帧头。记下原始 8 字节定位
                throw IllegalStateException(
                    "WS 帧过大: $len (b0=0x%02x b1=0x%02x len8=%s)".format(
                        b0[0], b1[0], e8hex
                    )
                )
            }
            // 服务端发的帧不带掩码，直接读负载即可
            if (opcode == 0x8) return null
            val payload = readExact(len.toInt()) ?: return null
            return opcode to payload
        }

        fun close() {
            runCatching { socket.close() }
        }
    }

    /** 计算整体 SHA-256，随 transfer.complete 交给对端校验 */
    fun fileDigest(inp: InputStream): String {
        val md = MessageDigest.getInstance("SHA-256")
        inp.use { stream ->
            val buf = ByteArray(64 * 1024)
            while (true) {
                val n = stream.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
            }
        }
        return md.digest().joinToString("") { "%02x".format(it) }
    }

    fun chunkDigest(data: ByteArray): String =
        MessageDigest.getInstance("SHA-256").digest(data).joinToString("") { "%02x".format(it) }

    fun chunkSize(): Int = CHUNK_SIZE

    /** 构造控制消息信封 */
    fun envelope(type: String, to: String, payload: JSONObject.() -> Unit): JSONObject =
        JSONObject().apply {
            put("v", Protocol.VERSION)
            put("type", type)
            put("id", java.util.UUID.randomUUID().toString())
            put("from", identity.get().fingerprint.replace(":", "").take(12))
            put("to", to)
            put("ts", System.currentTimeMillis())
            put("payload", JSONObject().apply(payload))
        }
}
