package cn.linkspace.client.service

import android.util.Log
import android.view.Surface
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 裸 H.264 Annex-B 字节流 → MediaCodec 硬解 → Surface 渲染。
 *
 * 喂数模型：视频块由调用方（WS 读循环）经 [feed] 推入内部队列，解码
 * 线程轮询取出喂给 MediaCodec。为什么不需要精确的 NALU 分帧：MediaCodec
 * 的输入缓冲可以接受任意切块的 Annex-B 字节流，解码器自己找 start code。
 * 队列满（解码慢于产出）时丢最旧的块——视频流丢帧好过堆积延迟。
 * SPS/PPS 在流头（桌面端 ffmpeg 在连接建立后才开始编码），首个 IDR
 * 之前画面黑屏属正常。
 *
 * 生命周期：start 起「取块喂解码」线程；shutdown 置位 + 释放编解码器。
 * 整个对象一次性使用，重看投屏就再建一个实例。
 */
class StreamDecoder(
    private val surface: Surface,
    private val onEnded: (reason: String) -> Unit,
    /** 流内 SPS 解出后的实际画面尺寸（触控映射基准），解码线程外回调 */
    private val onSize: (Int, Int) -> Unit = { _, _ -> }
) : Thread("linkspace-stream-decode") {

    private val stopped = AtomicBoolean(false)
    private val queue = ArrayBlockingQueue<ByteArray>(QUEUE_CAPACITY)
    private var lastFeedAt = System.currentTimeMillis()

    /** 解码输出的实际分辨率（来自流内 SPS，FORMAT_CHANGED 时更新）。触控映射以此为准 */
    @Volatile
    var outWidth: Int = 0
        private set

    @Volatile
    var outHeight: Int = 0
        private set

    /** 推入一个视频块（WS 二进制帧负载）。拆成 60KB 子块入队；队列满时丢最旧的子块 */
    fun feed(data: ByteArray) {
        lastFeedAt = System.currentTimeMillis()
        var off = 0
        while (off < data.size) {
            val n = minOf(FEED_PIECE, data.size - off)
            val piece = data.copyOfRange(off, off + n)
            if (!queue.offer(piece)) {
                queue.poll()
                queue.offer(piece)
            }
            off += n
        }
    }

    fun shutdown() {
        stopped.set(true)
        interrupt()
    }

    override fun run() {
        var codec: android.media.MediaCodec? = null
        try {
            val codecName = pickDecoder() ?: throw IllegalStateException("设备不支持 H.264 硬解")
            val format = android.media.MediaFormat.createVideoFormat(
                android.media.MediaFormat.MIMETYPE_VIDEO_AVC, 1920, 1080
            ).apply {
                // 实际分辨率以流内 SPS 为准，这里只给解码器初始分配依据。
                // MAX 必须 ≥ 流的真实尺寸：虚拟屏全景流实测 6720 宽，MAX
                // 只给 4096 时输出缓冲按 4096 分配，每行 stride 错位——
                // 画面呈绿底花屏碎块（用户截图）
                setInteger(android.media.MediaFormat.KEY_MAX_WIDTH, 8192)
                setInteger(android.media.MediaFormat.KEY_MAX_HEIGHT, 8192)
                if (android.os.Build.VERSION.SDK_INT >= 30) {
                    setInteger(android.media.MediaFormat.KEY_LOW_LATENCY, 1)
                }
            }
            val decoder = android.media.MediaCodec.createByCodecName(codecName)
            codec = decoder
            decoder.configure(format, surface, null, 0)
            decoder.start()
            Log.i(TAG, "解码器就绪：$codecName")

            val info = android.media.MediaCodec.BufferInfo()
            var eos = false
            while (!stopped.get() && !eos) {
                // 入：从队列取子块（feed 时已拆 ≤60KB）直装缓冲。
                // 不能用 ib.array()——MediaCodec 的输入缓冲是 direct buffer，
                // array() 直接抛 UnsupportedOperationException（消息为 null，
                // 首次联测秒退的根因）；用临时数组 + put
                var inIdx = decoder.dequeueInputBuffer(200_000)
                if (inIdx >= 0) {
                    val block = queue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS)
                    if (block != null) {
                        val ib = decoder.getInputBuffer(inIdx)!!
                        ib.clear()
                        ib.put(block)
                        decoder.queueInputBuffer(inIdx, 0, block.size, System.nanoTime() / 1000, 0)
                    }
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
                // 喂数断流 15s（桌面心跳与视频同连接，心跳停=连接死）：
                // 视为结束
                if (System.currentTimeMillis() - lastFeedAt > 15_000 && queue.isEmpty()) {
                    throw IllegalStateException("推流 15 秒无数据")
                }
            }
            onEnded("投屏结束")
        } catch (e: InterruptedException) {
            // shutdown() 的 interrupt：正常停止路径，不当作错误
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
        /** 喂入队列容量（子块数）。满则丢最旧——视频丢帧好过堆积延迟 */
        private const val QUEUE_CAPACITY = 16
        /** feed 拆分的子块大小 */
        private const val FEED_PIECE = 60 * 1024
    }
}
