package cn.linkspace.client.service

import android.graphics.Bitmap
import android.util.Log
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 裸 H.264 Annex-B 字节流 → MediaCodec **ByteBuffer 模式**解码 → YUV 转
 * Bitmap → [onFrame] 回调（渲染由调用方接管，见 StreamView）。
 *
 * 为什么不用 Surface 模式：本 ROM（ZUI/联发科/高通混合栈）实测
 * surface 模式解码零输出活锁——输入缓冲有去无回、连 FORMAT_CHANGED
 * 都不出，同流同码 ByteBuffer 模式却解得干干净净（2026-10-31 绿块
 * 排障： TextureView/SurfaceView、不同预设、不同 pts 基准全部复现）。
 * 代价是每帧 YUV→RGB 的 CPU 转换（1088p 实测 ~25-40ms，约 15-25fps），
 * 先跑通，后续要更流畅再换 libyuv/RenderEffect。
 *
 * 喂数模型：视频块由调用方（WS 读循环）经 [feed] 推入内部队列，解码
 * 线程轮询取出喂给 MediaCodec。MediaCodec 输入缓冲可接受任意切块的
 * Annex-B 字节流，解码器自己找 start code。
 *
 * 队列**无界、绝不丢块**（真机教训：有界队列满时丢块 = 丢 H.264 字节流
 * 中间的一段，参考链断裂后绿块持续到下个 IDR）。反压链路：队列堆积 →
 * 解码线程 dequeueInputBuffer 阻塞 → 输入缓冲占满 → 解码停顿 → TCP
 * 接收窗口收缩 → 桌面端 B-3 码率探针降档。丢帧的正确位置是编码器
 * （跳帧），不是解码器的字节流。
 *
 * 编码端配合（screen-stream.ts）：preset=medium——ultrafast 档在 1088
 * 高度产出的流本机 C2 解码器（含软解）解出下半帧全零（ByteBuffer 模式
 * 复现），medium 同几何同参数全绿，勿改回。
 *
 * 生命周期：start 起「取块喂解码」线程；shutdown 置位 + 释放编解码器。
 * 整个对象一次性使用，重看投屏就再建一个实例。
 */
class StreamDecoder(
    private val onEnded: (reason: String) -> Unit,
    /** 每个解码完成的帧（复用同一 Bitmap 实例，调用方须在回调内同步消费） */
    private val onFrame: (Bitmap) -> Unit,
    /** 流内 SPS 解出后的实际画面尺寸（触控映射基准），解码线程外回调 */
    private val onSize: (Int, Int) -> Unit = { _, _ -> }
) : Thread("linkspace-stream-decode") {

    private val stopped = AtomicBoolean(false)
    private val queue = LinkedBlockingQueue<ByteArray>()
    private var lastFeedAt = System.currentTimeMillis()

    /** 解码输出的实际分辨率（来自流内 SPS，FORMAT_CHANGED 时更新）。触控映射以此为准 */
    @Volatile
    var outWidth: Int = 0
        private set

    @Volatile
    var outHeight: Int = 0
        private set

    /** 复用的输出位图与像素缓冲（解码线程独占，免每帧分配 8MB） */
    private var frameBitmap: Bitmap? = null
    private var framePixels: IntArray? = null

    // ---- AU 对齐喂帧（Moonlight/VLC 模式，2026-10-31）----
    // 本机各解码器「离线整块喂能解、活流任意切块喂就坏/花」，唯余的
    // 差异就是喂入边界。这里把 WS 来的字节流重切成「一个队列项 = 一个
    // 完整访问单元」（slice 的 first_mb_in_slice==0 / AUD 判界），与
    // Moonlight 的帧对齐喂入同款。注意 NAL 会跨 WS 块边界，必须用
    // 持久累积缓冲扫描，不能按块就地解析。
    private val acc = java.io.ByteArrayOutputStream()
    private val auBuf = java.io.ByteArrayOutputStream()
    private var auHasData = false
    private val pendingAus = ArrayDeque<ByteArray>()

    /** 推入一个视频块（WS 二进制帧负载）。追加进累积缓冲并扫描 NAL 边界 */
    fun feed(data: ByteArray) {
        lastFeedAt = System.currentTimeMillis()
        acc.write(data)
        val buf = acc.toByteArray()
        var i = 0
        var nalStart = -1
        while (i + 2 < buf.size) {
            if (buf[i] == 0x00.toByte() && buf[i + 1] == 0x00.toByte()) {
                val scLen: Int
                if (buf[i + 2] == 0x01.toByte()) {
                    scLen = 3
                } else if (i + 3 < buf.size && buf[i + 2] == 0x00.toByte() && buf[i + 3] == 0x01.toByte()) {
                    scLen = 4
                } else {
                    i++
                    continue
                }
                if (nalStart >= 0 && i > nalStart) settleNal(buf, nalStart, i)
                if (nalStart < 0 && i > 0) {
                    Log.d(TAG, "丢弃流头 ${i} 字节（首个 start code 前）")
                }
                nalStart = i
                i += scLen
            } else {
                i++
            }
        }
        // 保留最后未结算的 NAL（可能被下一块续上）
        acc.reset()
        if (nalStart >= 0 && nalStart < buf.size) {
            acc.write(buf, nalStart, buf.size - nalStart)
        } else if (nalStart < 0) {
            acc.write(buf)
        }
    }

    /** 结算一个完整 NAL（含 start code，区间 [start, end)），组装进当前 AU */
    private fun settleNal(buf: ByteArray, start: Int, end: Int) {
        val nal = buf.copyOfRange(start, end)
        val type = (nal[0].toInt() and 0x1f)
        val startsNewPicture = when (type) {
            1, 5 -> isFirstMbZero(nal)
            9 -> true // AUD：每帧一个，天然分界
            else -> false // SPS/PPS/SEI 归属当前 AU 头部
        }
        if (startsNewPicture && auHasData) flushAu()
        auBuf.write(nal, 0, nal.size)
        auHasData = true
        // 单 AU 超过 4MB 视为异常（防解析失误内存堆积），强制结算
        if (auBuf.size() > 4 * 1024 * 1024) flushAu()
    }

    private fun flushAu() {
        val au = auBuf.toByteArray()
        auBuf.reset()
        auHasData = false
        if (au.isEmpty()) return
        // 批量结算：攒 ~6 个 AU（约 200ms）一口气入队。本机实测「活流涓流
        // 喂 = 各解码器零输出」，「离线大块喂 = 全绿」——c2 系解码器要快
        // 速灌满才肯开工，涓流单喂疑似撞上其内部批处理的水线
        pendingAus.addLast(au)
        if (pendingAus.size >= 6) flushPendingAus()
    }

    private fun flushPendingAus() {
        while (pendingAus.isNotEmpty()) queue.put(pendingAus.removeFirst())
    }

    /**
     * 读 slice 头第一个 ue(v)（first_mb_in_slice）。需要去 00 00 03 防止
     * 仿真前缀后按位读；值很大时（分片罕见）返回 -1 当作「非新帧」保守处理。
     */
    private fun isFirstMbZero(nal: ByteArray): Boolean {
        // 去 00 00 03
        val rbsp = java.io.ByteArrayOutputStream()
        var i = 1 // 跳过 NAL 头
        while (i < nal.size) {
            if (i + 2 < nal.size && nal[i] == 0x00.toByte() && nal[i + 1] == 0x00.toByte() && nal[i + 2] == 0x03.toByte()) {
                rbsp.write(0x00)
                rbsp.write(0x00)
                i += 3
            } else {
                rbsp.write(nal[i].toInt())
                i++
            }
        }
        val b = rbsp.toByteArray()
        // 按 MSB 位序找第一个 1（前导零数 = lzb），值 = (1<<lzb)-1 + 后 lzb 位
        var bitPos = 0
        var lzb = 0
        val totalBits = b.size * 8
        fun bit(pos: Int): Int = (b[pos / 8].toInt() shr (7 - pos % 8)) and 1
        while (bitPos < totalBits && bit(bitPos) == 0) {
            lzb++
            bitPos++
            if (lzb > 16) return false // 超大值，保守当非 0
        }
        if (bitPos >= totalBits) return false
        var value = (1 shl lzb) - 1
        for (k in 0 until lzb) {
            bitPos++
            value = (value shl 1) or bit(bitPos)
        }
        return value == 0
    }

    fun shutdown() {
        stopped.set(true)
        interrupt()
    }

    override fun run() {
        var codec: android.media.MediaCodec? = null
        try {
            val codecName = pickDecoder() ?: throw IllegalStateException("设备不支持 H.264 解码")
            val format = android.media.MediaFormat.createVideoFormat(
                android.media.MediaFormat.MIMETYPE_VIDEO_AVC, 1920, 1080
            )
            val decoder = android.media.MediaCodec.createByCodecName(codecName)
            codec = decoder
            // ByteBuffer 模式：不配 surface。输出经 getOutputImage 取
            // YUV_420_888，软/硬解在本机都稳定（surface 模式活锁见类注释）
            decoder.configure(format, null, null, 0)
            decoder.start()
            Log.i(TAG, "解码器就绪：$codecName（ByteBuffer 模式）")

            val info = android.media.MediaCodec.BufferInfo()
            var eos = false
            var noInputBufStreak = 0
            var lastStatAt = System.currentTimeMillis()
            var loopRounds = 0L
            var ptsUs = 0L
            var decodedFrames = 0L
            while (!stopped.get() && !eos) {
                loopRounds++
                var inIdx = decoder.dequeueInputBuffer(10_000)
                if (inIdx >= 0) {
                    noInputBufStreak = 0
                    val block = queue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS)
                    if (block != null) {
                        val ib = decoder.getInputBuffer(inIdx)!!
                        ib.clear()
                        ib.put(block)
                        // pts 用 0 起步的 30fps 步进（baseline 无 B 帧，展示序
                        // = 解码序，pts 只需单调）
                        decoder.queueInputBuffer(inIdx, 0, block.size, ptsUs, 0)
                        ptsUs += block.size
                    }
                } else {
                    // 输入缓冲耗尽：正常是输出消费在追赶，持续 -1 记一条
                    if (++noInputBufStreak == 10 || noInputBufStreak % 50 == 0) {
                        Log.w(TAG, "输入缓冲紧张 streak=$noInputBufStreak queue=${queue.size} rounds=$loopRounds")
                    }
                }
                var outIdx = decoder.dequeueOutputBuffer(info, 0)
                while (outIdx >= 0) {
                    val img = decoder.getOutputImage(outIdx)
                    if (img != null) {
                        if (outWidth != img.width || outHeight != img.height) {
                            outWidth = img.width
                            outHeight = img.height
                            Log.i(TAG, "解码输出格式: $outWidth x $outHeight")
                            onSize(outWidth, outHeight)
                        }
                        renderFrame(img)
                        img.close()
                        decodedFrames++
                        if (decodedFrames == 1L || decodedFrames % 120 == 0L) {
                            Log.i(TAG, "已解码渲染 $decodedFrames 帧")
                        }
                    }
                    decoder.releaseOutputBuffer(outIdx, false)
                    outIdx = decoder.dequeueOutputBuffer(info, 0)
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
            } else {
                Log.d(TAG, "解码线程退出（stopped，不回调）: ${e.message}")
            }
        } finally {
            Log.i(TAG, "解码线程退出 (stopped=${stopped.get()})")
            runCatching {
                codec?.stop()
                codec?.release()
            }
        }
    }

    /**
     * YUV_420_888 → RGB → 复用 Bitmap。同时兼容半平面（NV12，pixelStride=2）
     * 与全平面布局；rowStride ≥ width 时按 stride 逐行取。
     */
    private fun renderFrame(img: android.media.Image) {
        val w = img.width
        val h = img.height
        val bmp = frameBitmap ?: Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888).also {
            frameBitmap = it
        }
        var px = framePixels
        if (px == null || px.size < w * h) {
            px = IntArray(w * h)
            framePixels = px
        }
        val planes = img.planes
        val yB = planes[0].buffer
        val uB = planes[1].buffer
        val vB = planes[2].buffer
        val yRow = planes[0].rowStride
        val uRow = planes[1].rowStride
        val vRow = planes[2].rowStride
        val uPix = planes[1].pixelStride
        val vPix = planes[2].pixelStride
        var yi = 0
        for (row in 0 until h) {
            val yBase = row * yRow
            val uvRowBase = (row shr 1)
            val uBase = uvRowBase * uRow
            val vBase = uvRowBase * vRow
            var col = 0
            while (col < w) {
                val y = (yB.get(yBase + col).toInt() and 0xff) - 16
                val uvi = col shr 1
                val u = (uB.get(uBase + uvi * uPix).toInt() and 0xff) - 128
                val v = (vB.get(vBase + uvi * vPix).toInt() and 0xff) - 128
                var r = (1192 * y + 1634 * v) shr 10
                var g = (1192 * y - 833 * v - 400 * u) shr 10
                var b = (1192 * y + 2066 * u) shr 10
                if (r < 0) r = 0 else if (r > 255) r = 255
                if (g < 0) g = 0 else if (g > 255) g = 255
                if (b < 0) b = 0 else if (b > 255) b = 255
                px[yi++] = -0x1000000 or (r shl 16) or (g shl 8) or b
                col++
            }
        }
        bmp.setPixels(px, 0, w, 0, 0, w, h)
        onFrame(bmp)
    }

    /**
     * 选 AVC 解码器。**软解优先（c2.android.avc.decoder）**：本 ROM 的
     * c2.qti 硬解在活流喂入下极不稳定——libx264 流解出下半帧全零、
     * MF 流直接零输出活锁（2026-10-31 真机矩阵：软解+ByteBuffer 是
     * 唯一全绿组合，离线文件流与活流都干净）。代价是 1088p 每帧
     * ~30ms CPU（实测总帧率 ~15-20fps，可接受），别改回硬解优先。
     */
    private fun pickDecoder(): String? {
        val mf = android.media.MediaCodecList(android.media.MediaCodecList.REGULAR_CODECS)
        var fallback: String? = null
        for (info in mf.codecInfos) {
            if (info.isEncoder) continue
            if (!info.supportedTypes.any { it.equals(android.media.MediaFormat.MIMETYPE_VIDEO_AVC, true) }) continue
            // 软解优先：本 ROM 硬解（c2.qti）对活流不可靠（见方法注释）
            if (info.name.startsWith("c2.android") || info.name.startsWith("OMX.google")) {
                Log.i(TAG, "选用解码器: ${info.name}（软解优先策略）")
                return info.name
            }
            if (fallback == null) fallback = info.name
        }
        fallback?.let { Log.i(TAG, "选用解码器(回退硬解): $it") }
        return fallback
    }

    companion object {
        private const val TAG = "LinkSpace/Stream"

        /**
         * feed 拆分的子块大小。**必须远大于典型帧**：MediaCodec 的输入
         * 缓冲数量有限（c2 系 4 个上下），每缓冲只装一个子块——60KB 子块
         * 让解码器的「总在途输入」只有 ~240KB，首帧 IDR（高码率启动突发
         * 下 300KB+）永远凑不齐：解码器等数据、我等缓冲，双向死锁
         * （真机踩过）。512KB 单块仍在输入缓冲容量（MB 级）之内。
         */
        private const val FEED_PIECE = 64 * 1024
    }
}
