package cn.linkspace.client.service

import android.graphics.SurfaceTexture
import android.util.Log
import android.view.Surface
import java.io.InputStream
import java.net.Socket
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 裸 H.264 Annex-B 字节流 → MediaCodec 硬解 → Surface 渲染。
 *
 * 为什么不需要精确的 NALU 分帧：MediaCodec 的输入缓冲可以接受任意
 * 切块的 Annex-B 字节流，解码器自己找 start code；我们只按 64KB 读
 * socket 直喂，省掉解析层。SPS/PPS 在流头（桌面端 ffmpeg 在连接建立
 * 后才开始编码），首个 IDR 之前画面黑屏属正常。
 *
 * 生命周期：start 起「读流喂解码」线程；stop 置位 + 关 socket + 释放
 * 编解码器。整个对象一次性使用，重看投屏就再建一个实例。
 */
class StreamDecoder(
    private val socket: Socket,
    private val surface: Surface,
    private val onEnded: (reason: String) -> Unit,
    /** 流内 SPS 解出后的实际画面尺寸（触控映射基准），主线程外回调 */
    private val onSize: (Int, Int) -> Unit = { _, _ -> }
) : Thread("linkspace-stream-decode") {

    private val stopped = AtomicBoolean(false)

    /** 解码输出的实际分辨率（来自流内 SPS，FORMAT_CHANGED 时更新）。触控映射以此为准 */
    @Volatile
    var outWidth: Int = 0
        private set

    @Volatile
    var outHeight: Int = 0
        private set

    fun shutdown() {
        stopped.set(true)
        runCatching { socket.close() }
    }

    override fun run() {
        var codec: android.media.MediaCodec? = null
        try {
            val codecName = pickDecoder() ?: throw IllegalStateException("设备不支持 H.264 硬解")
            val format = android.media.MediaFormat.createVideoFormat(
                android.media.MediaFormat.MIMETYPE_VIDEO_AVC, 1920, 1080
            ).apply {
                // 实际分辨率以流内 SPS 为准，这里只给解码器初始分配依据；
                // MAX 尺寸放宽到 4K，避免桌面切虚拟屏后 needs-reconfigure
                setInteger(android.media.MediaFormat.KEY_MAX_WIDTH, 4096)
                setInteger(android.media.MediaFormat.KEY_MAX_HEIGHT, 4096)
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    setInteger(android.media.MediaFormat.KEY_LOW_LATENCY, 1)
                }
            }
            val decoder = android.media.MediaCodec.createByCodecName(codecName)
            codec = decoder
            decoder.configure(format, surface, null, 0)
            decoder.start()
            Log.i(TAG, "解码器就绪：$codecName")

            // 读超时必须设：下面的「15s 无数据」判定只在循环转起来时可达，
            // 若对端静默死亡，input.read() 会永久阻塞，卡顿检测成为死代码。
            // 超时让阻塞以 SocketTimeoutException 浮出来，走正常结束路径
            socket.soTimeout = 15_000
            val input = socket.getInputStream()
            val info = android.media.MediaCodec.BufferInfo()
            val tmp = ByteArray(64 * 1024)
            var eos = false
            var lastInputAt = System.currentTimeMillis()
            while (!stopped.get() && !eos && !socket.isClosed) {
                // 入：读流填缓冲。dequeueInput 带 10ms 超时轮询，给 stopped 留出口。
                // 不能用 ib.array()——MediaCodec 的输入缓冲是 direct buffer，
                // array() 直接抛 UnsupportedOperationException（消息为 null，
                // 首次联测秒退的根因）；用临时数组 + put
                var inIdx = decoder.dequeueInputBuffer(10_000)
                if (inIdx >= 0) {
                    val ib = decoder.getInputBuffer(inIdx)!!
                    ib.clear()
                    val n = input.read(tmp)
                    if (n < 0) {
                        eos = true
                        decoder.queueInputBuffer(
                            inIdx, 0, 0, 0, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM
                        )
                        break
                    }
                    ib.put(tmp, 0, n)
                    val pts = System.nanoTime() / 1000
                    decoder.queueInputBuffer(inIdx, 0, n, pts, 0)
                    lastInputAt = System.currentTimeMillis()
                }
                // 出：渲染所有就绪帧
                while (true) {
                    val outIdx = decoder.dequeueOutputBuffer(info, 0)
                    when {
                        outIdx >= 0 -> {
                            decoder.releaseOutputBuffer(outIdx, true)
                            if (info.flags and android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0) eos = true
                        }
                        outIdx == android.media.MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                            outWidth = decoder.outputFormat.getInteger(android.media.MediaFormat.KEY_WIDTH)
                            outHeight = decoder.outputFormat.getInteger(android.media.MediaFormat.KEY_HEIGHT)
                            Log.i(TAG, "解码输出格式: ${outWidth}x${outHeight}")
                            onSize(outWidth, outHeight)
                        }
                        else -> break
                    }
                }
                // 流断了 15s（与桌面 READ_TIMEOUT 语义对齐）：视为结束
                if (System.currentTimeMillis() - lastInputAt > 15_000) {
                    throw IllegalStateException("推流 15 秒无数据")
                }
            }
            onEnded("投屏结束")
        } catch (e: Exception) {
            if (!stopped.get()) {
                Log.w(TAG, "解码线程结束: ${e.message}")
                onEnded(e.message ?: "投屏已断开")
            }
        } finally {
            runCatching {
                codec?.stop()
                codec?.release()
            }
            runCatching { socket.close() }
        }
    }

    /** 选一个支持 AVC 解码到 Surface 的硬件解码器，找不到回退软解 */
    private fun pickDecoder(): String? {
        val mf = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
        for (info in mf.codecInfos) {
            if (info.isEncoder) continue
            if (!info.supportedTypes.any { it.equals(android.media.MediaFormat.MIMETYPE_VIDEO_AVC, true) }) continue
            // 别拿软解占硬件坑：c2.android.avc.decoder 是软件实现
            if (info.name.startsWith("c2.android") || info.name.startsWith("OMX.google")) continue
            Log.i(TAG, "选用解码器: ${info.name}")
            return info.name
        }
        return null
    }

    companion object {
        private const val TAG = "LinkSpace/Stream"

        /** 供 UI 建解码渲染面的 Surface（来自 TextureView 的 SurfaceTexture） */
        fun surfaceFromTexture(texture: SurfaceTexture): Surface = Surface(texture)
    }
}
