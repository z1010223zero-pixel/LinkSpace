package cn.linkspace.client.service

import android.util.Log
import org.json.JSONObject
import java.io.InputStream
import java.io.OutputStream
import java.security.MessageDigest

/**
 * WebSocket 服务端（RFC 6455 的最小子集）。
 *
 * 为什么自己写：控制通道必须与文件传输共用同一个 TLS 端口（ADR-003），
 * 而我们的 HTTPS 服务是手写的，需要能识别 Upgrade 请求并原地切换协议。
 * 引入 Java-WebSocket 之类的库意味着再引入一个独立监听端，反而更复杂。
 *
 * 只实现必需部分：握手、文本帧收发、关闭帧。ping/pong 与扩展都不用。
 * 服务端发出的帧不掩码（RFC 允许），客户端来的帧必须解除掩码。
 */
class WebSocketConnection(private val socket: java.net.Socket) {

    interface Listener {
        fun onMessage(text: String)
        fun onClosed()
    }

    var listener: Listener? = null

    @Volatile
    var closed = false
        private set

    private val input: InputStream = socket.getInputStream()
    private val output: OutputStream = socket.getOutputStream()

    /**
     * 所有出站帧都走这个单线程执行器。
     *
     * 为什么：Android 禁止主线程网络 I/O（NetworkOnMainThreadException）。
     * UI 线程触发发送是常见路径——用户点「接收」按钮时 acceptTransfer
     * 要回 transfer.accept，直接写 socket 就崩。曾经只有读线程发过消息，
     * 这个坑一直没暴露，直到 UI 触发的第一条消息发出去才炸。
     */
    private val writeExecutor: java.util.concurrent.ExecutorService =
        java.util.concurrent.Executors.newSingleThreadExecutor { r ->
            Thread(r, "linkspace-ws-write").apply { isDaemon = true }
        }

    /** 阻塞读取，直到连接关闭。调用方应放在独立线程。 */
    fun run() {
        try {
            while (!closed && !socket.isClosed) {
                val frame = readFrame() ?: break
                when (frame.opcode) {
                    OP_TEXT -> listener?.onMessage(String(frame.payload, Charsets.UTF_8))
                    OP_CLOSE -> {
                        sendClose()
                        break
                    }
                    OP_PING -> writeFrame(OP_PONG, frame.payload)
                    // PONG 不需要响应
                }
            }
        } catch (e: Exception) {
            if (!closed) Log.d(TAG, "连接读取结束: ${e.message}")
        } finally {
            close()
        }
    }

    fun send(text: String) {
        if (closed) return
        submitWrite {
            writeFrame(OP_TEXT, text.toByteArray(UTF8))
        }
    }

    /** 把一次出站写提交到写线程。连接已关闭时静默丢弃。 */
    private fun submitWrite(block: () -> Unit) {
        try {
            writeExecutor.execute {
                runCatching(block).onFailure { e ->
                    Log.e(TAG, "writeFrame 失败: ${e.javaClass.name}: ${e.message}")
                    close()
                }
            }
        } catch (e: java.util.concurrent.RejectedExecutionException) {
            // 连接已关闭、执行器已停，丢弃即可
        }
    }

    fun close() {
        if (closed) return
        closed = true
        runCatching { socket.close() }
        runCatching { writeExecutor.shutdown() }
        listener?.onClosed()
    }

    private fun sendClose() {
        submitWrite {
            writeFrame(OP_CLOSE, ByteArray(0))
        }
    }

    // ---------- 帧编解码 ----------

    private class Frame(val opcode: Int, val payload: ByteArray)

    private fun readFrame(): Frame? {
        val b0 = input.read()
        if (b0 < 0) return null
        val opcode = b0 and 0x0F
        val b1 = input.read()
        if (b1 < 0) return null
        val masked = (b1 and 0x80) != 0
        var len = (b1 and 0x7F).toLong()

        if (len == 126L) {
            len = readUint16()
        } else if (len == 127L) {
            len = readUint64()
        }
        if (len > MAX_FRAME) throw Exception("帧过大: $len")

        var mask = ByteArray(0)
        if (masked) {
            mask = ByteArray(4)
            readFully(mask)
        }
        val payload = ByteArray(len.toInt())
        readFully(payload)
        if (masked) {
            for (i in payload.indices) payload[i] = (payload[i].toInt() xor mask[i % 4].toInt()).toByte()
        }
        return Frame(opcode, payload)
    }

    private fun writeFrame(opcode: Int, payload: ByteArray) {
        val out = java.io.ByteArrayOutputStream()
        out.write(0x80 or opcode)
        val len = payload.size
        when {
            len < 126 -> out.write(len)
            len <= 0xFFFF -> {
                out.write(126)
                out.write(len shr 8)
                out.write(len and 0xFF)
            }
            else -> {
                out.write(127)
                for (i in 7 downTo 0) out.write((len shr (8 * i)) and 0xFF)
            }
        }
        out.write(payload)
        output.write(out.toByteArray())
        output.flush()
    }

    private fun readUint16(): Long {
        val a = input.read()
        val b = input.read()
        if (a < 0 || b < 0) throw Exception("连接中断")
        return ((a shl 8) or b).toLong()
    }

    private fun readUint64(): Long {
        var v = 0L
        repeat(8) {
            val c = input.read()
            if (c < 0) throw Exception("连接中断")
            v = (v shl 8) or c.toLong()
        }
        return v
    }

    private fun readFully(buf: ByteArray) {
        var read = 0
        while (read < buf.size) {
            val n = input.read(buf, read, buf.size - read)
            if (n < 0) throw Exception("连接中断")
            read += n
        }
    }

    companion object {
        private const val TAG = "LinkSpace/WS"
        private const val MAX_FRAME = 16L * 1024 * 1024

        private const val OP_TEXT = 0x1
        private const val OP_CLOSE = 0x8
        private const val OP_PING = 0x9
        private const val OP_PONG = 0xA

        /** RFC 6455 规定的 GUID 魔数 */
        private const val WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

        private val UTF8 = Charsets.UTF_8

        /** 判断请求是否是 WebSocket 升级 */
        fun isUpgrade(method: String, headers: Map<String, String>): Boolean {
            return method == "GET" &&
                headers["upgrade"]?.lowercase()?.contains("websocket") == true &&
                headers["sec-websocket-key"] != null
        }

        /** 计算 Sec-WebSocket-Accept 并返回 101 响应字节 */
        fun handshakeResponse(secWebSocketKey: String): ByteArray {
            val accept = java.util.Base64.getEncoder().encodeToString(
                MessageDigest.getInstance("SHA-1")
                    .digest((secWebSocketKey + WS_GUID).toByteArray(UTF8))
            )
            return buildString {
                append("HTTP/1.1 101 Switching Protocols\r\n")
                append("Upgrade: websocket\r\n")
                append("Connection: Upgrade\r\n")
                append("Sec-WebSocket-Accept: $accept\r\n")
                append("\r\n")
            }.toByteArray(UTF8)
        }

    }
}
