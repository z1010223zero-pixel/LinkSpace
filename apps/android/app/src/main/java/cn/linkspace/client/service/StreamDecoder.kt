package cn.linkspace.client.service

import android.graphics.Bitmap
import android.util.Log
import org.bytedeco.ffmpeg.avcodec.AVCodecContext
import org.bytedeco.ffmpeg.avformat.AVFormatContext
import org.bytedeco.ffmpeg.avformat.Read_packet_Pointer_BytePointer_int
import org.bytedeco.ffmpeg.avformat.Seek_Pointer_long_int
import org.bytedeco.ffmpeg.avutil.AVDictionary
import org.bytedeco.ffmpeg.avutil.AVFrame
import org.bytedeco.ffmpeg.global.avcodec
import org.bytedeco.ffmpeg.global.avformat
import org.bytedeco.ffmpeg.global.avutil
import org.bytedeco.javacpp.BytePointer
import org.bytedeco.javacpp.Pointer
import java.io.InputStream
import java.util.concurrent.atomic.AtomicBoolean

/**
 * 裸 H.264 Annex-B 字节流 → **FFmpeg 软解（libavcodec 直调）** → RGBA
 * Bitmap → [onFrame] 回调（渲染由 StreamView 接管）。
 *
 * 为什么是 FFmpeg 软解（RustDesk 同款路线，2026-11-01 定论）：本 ROM 的
 * MediaCodec——不论 c2.qti 硬解还是 c2.android 软解、Surface 还是
 * ByteBuffer 模式——对「实时涓流喂入」的活流全线不可靠（下半帧全零
 * 或零输出活锁），离线文件流同参数却全绿。libavcodec 是 RustDesk/
 * ijkplayer 验证过千机百 ROM 的兜底，JavaCV（bytedeco 预编译）免
 * NDK 构建。
 *
 * 直调而非 JavaCV 的 FrameGrabber：avformat_find_stream_info 对裸
 * h264（无时间戳）永不收敛，真机实测静默吞 10MB+ 不返回；这里跳过
 * 探测，参数由首帧 SPS 经 avcodec_parameters_to_context 自取。
 *
 * **积压治理（真机 2026-11-01 定论）**：解码（含逐像素 RGB 转换）
 * 跟不上实时时，无界管道会让延迟发散到分钟级——画面停在几十分钟前，
 * 表现为「闪烁/跳位/操作不了」。管道超 3MB 即丢到最近关键帧（SPS）
 * 重同步，延迟上界 ≈ 2-3s。丢帧的正确位置是网络缓冲（整 GOP 丢弃），
 * 不是解码器的字节流内部。
 *
 * 生命周期：start 起解码线程；shutdown 置位 + 关流打断。一次性使用，
 * 重看投屏就再建一个实例。
 */
class StreamDecoder(
    private val onEnded: (reason: String) -> Unit,
    /** 每个解码完成的帧（复用 Bitmap 实例，提交合流由 StreamView 负责） */
    private val onFrame: (Bitmap) -> Unit,
    /** 流内 SPS 解出后的实际画面尺寸（触控映射基准），解码线程外回调 */
    private val onSize: (Int, Int) -> Unit = { _, _ -> }
) : Thread("linkspace-stream-decode") {

    private val stopped = AtomicBoolean(false)
    private val pipe = LiveByteStream()

    /** 解码输出的实际分辨率（触控映射基准） */
    @Volatile
    var outWidth: Int = 0
        private set

    @Volatile
    var outHeight: Int = 0
        private set

    /** 推入一个视频块（WS 二进制帧负载），原始字节直通软解 */
    fun feed(data: ByteArray) {
        if (!stopped.get()) pipe.write(data)
    }

    fun shutdown() {
        stopped.set(true)
        pipe.closeWriter()
        interrupt()
    }

    override fun run() {
        var ic: AVFormatContext? = null
        var ctx: AVCodecContext? = null
        try {
            avutil.av_log_set_level(avutil.AV_LOG_ERROR)
            val fmt = avformat.av_find_input_format("h264")
            // 先真分配上下文才能在 open 前挂自定义 AVIO（AVFormatContext(null)
            // 是空指针包装，pb() 会在其上解引用空地址）
            val formatCtx = avformat.avformat_alloc_context()
            ic = formatCtx
            // 自定义 AVIO：读回调直连 [LiveByteStream]，seek 一律不支持
            //（裸活流不可回退，跳过 find_stream_info 后 ffmpeg 不会 seek）
            val ioBuffer = java.nio.ByteBuffer.allocateDirect(64 * 1024)
            val readCb = object : Read_packet_Pointer_BytePointer_int() {
                override fun call(opaque: Pointer?, buf: BytePointer, bufSize: Int): Int {
                    try {
                        if (bufSize <= 0) return 0
                        // 短读语义：等首字节最多 2s（活流静默期不能当 EOF——
                        // 否则 av_read_frame 空转几圈就把流掐了），拿到首字节
                        // 后只取当前已有量立刻返回（攒满再吐会让活流每请求
                        // 都等数秒，画面冻结）
                        val n = pipe.readAvailable(avioScratch, 0, minOf(bufSize, avioScratch.size), 2000L)
                        if (n <= 0) return avutil.AVERROR_EOF
                        buf.position(0)
                        buf.put(avioScratch, 0, n)
                        return n
                    } catch (t: Throwable) {
                        // 回调里抛 Java 异常会以 C++ 异常穿透 JNI 直接 abort
                        // 进程（真机踩过），必须在此全吞
                        Log.e(TAG, "AVIO 读回调异常", t)
                        return avutil.AVERROR_EOF
                    }
                }
            }
            val seekCb = object : Seek_Pointer_long_int() {
                override fun call(opaque: Pointer?, offset: Long, whence: Int): Long = -1
            }
            val avio = avformat.avio_alloc_context(
                BytePointer(ioBuffer), ioBuffer.capacity(), 0, null, readCb,
                null as org.bytedeco.ffmpeg.avformat.Write_packet_Pointer_BytePointer_int?, seekCb
            )
            formatCtx.pb(avio)
            val opts = AVDictionary()
            avutil.av_dict_set(opts, "fflags", "nobuffer", 0)
            avutil.av_dict_set(opts, "flags", "low_delay", 0)
            avformat.avformat_open_input(formatCtx, null as String?, fmt, opts)
            avutil.av_dict_free(opts)
            Log.i(TAG, "avformat_open_input 完成")

            // **跳过 avformat_find_stream_info**（裸流无时间戳会无限探测），
            // 直接按流 0 的 codecpar 开解码器，SPS/首帧数据补齐参数
            val codecpar = formatCtx.streams(0).codecpar()
            val codec = avcodec.avcodec_find_decoder(codecpar.codec_id())
                ?: throw IllegalStateException("无 H.264 解码器")
            val codecCtx = avcodec.avcodec_alloc_context3(codec)
            ctx = codecCtx
            avcodec.avcodec_parameters_to_context(codecCtx, codecpar)
            avcodec.avcodec_open2(codecCtx, codec, null as AVDictionary?)
            Log.i(TAG, "avcodec_open2 完成（${codecCtx.width()}x${codecCtx.height()}）")

            val pkt = avcodec.av_packet_alloc()
            val frame = avutil.av_frame_alloc()
            var bmp: Bitmap? = null
            var framePixels: IntArray? = null
            var yScratch: ByteArray? = null
            var uScratch: ByteArray? = null
            var vScratch: ByteArray? = null
            var rendered = 0L

            fun drainAndRender() {
                while (avcodec.avcodec_receive_frame(codecCtx, frame) >= 0) {
                    val w = frame.width()
                    val h = frame.height()
                    if (w <= 0 || h <= 0) {
                        avutil.av_frame_unref(frame)
                        continue
                    }
                    if (w != outWidth || h != outHeight || bmp == null) {
                        outWidth = w
                        outHeight = h
                        bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        yScratch = ByteArray(w)
                        uScratch = ByteArray(w / 2 + 8)
                        vScratch = ByteArray(w / 2 + 8)
                        onSize(w, h)
                        Log.i(TAG, "FFmpeg 软解就绪: ${w}x${h}")
                    }
                    val bitmap = bmp ?: return
                    // YUV420P → RGB：平面按行 bulk 读入 scratch（消除每像素
                    // JNI 调用，2M 次 get 是性能瓶颈），再走 Java 数组转换
                    val yB = frame.data(0)
                    val uB = frame.data(1)
                    val vB = frame.data(2)
                    val yRow = frame.linesize(0)
                    val uRow = frame.linesize(1)
                    val vRow = frame.linesize(2)
                    val yS = yScratch ?: return
                    val uS = uScratch ?: return
                    val vS = vScratch ?: return
                    var px = framePixels
                    if (px == null || px.size < w * h) {
                        px = IntArray(w * h)
                        framePixels = px
                    }
                    var idx = 0
                    for (row in 0 until h) {
                        yB.position(row.toLong() * yRow)
                        yB.get(yS, 0, w)
                        val uvRow = row shr 1
                        val uCols = w shr 1
                        uB.position(uvRow.toLong() * uRow)
                        uB.get(uS, 0, uCols)
                        vB.position(uvRow.toLong() * vRow)
                        vB.get(vS, 0, uCols)
                        val yBase = row * w
                        var col = 0
                        while (col < w) {
                            val y = ((yS[col].toInt() and 0xff) - 16) * 1192
                            val uvi = col shr 1
                            val u = (uS[uvi].toInt() and 0xff) - 128
                            val v = (vS[uvi].toInt() and 0xff) - 128
                            var r = (y + 1634 * v) shr 10
                            var g = (y - 833 * v - 400 * u) shr 10
                            var b = (y + 2066 * u) shr 10
                            if (r < 0) r = 0 else if (r > 255) r = 255
                            if (g < 0) g = 0 else if (g > 255) g = 255
                            if (b < 0) b = 0 else if (b > 255) b = 255
                            px[idx++] = -0x1000000 or (r shl 16) or (g shl 8) or b
                            col++
                        }
                    }
                    bitmap.setPixels(px, 0, w, 0, 0, w, h)
                    rendered++
                    if (rendered == 1L || rendered % 300 == 0L) {
                        Log.i(TAG, "已解码渲染 $rendered 帧")
                    }
                    onFrame(bitmap)
                    avutil.av_frame_unref(frame)
                }
            }

            var readCalls = 0L
            var lastStat = System.currentTimeMillis()
            while (!stopped.get()) {
                val ret = avformat.av_read_frame(formatCtx, pkt)
                readCalls++
                val nowMs = System.currentTimeMillis()
                if (nowMs - lastStat > 10000) {
                    Log.i(TAG, "解码循环 readCalls=$readCalls ret=$ret 管道积压=${pipe.backlog()}B")
                    lastStat = nowMs
                }
                if (ret < 0) break // EOF 或错误：推流端收尾/断流
                if (avcodec.avcodec_send_packet(codecCtx, pkt) >= 0) {
                    drainAndRender()
                }
                avcodec.av_packet_unref(pkt)
            }
            onEnded("投屏结束")
        } catch (e: InterruptedException) {
            // shutdown() 的 interrupt：正常停止路径
        } catch (e: Exception) {
            if (!stopped.get()) {
                Log.w(TAG, "解码线程结束: ${e.message}")
                onEnded(e.message ?: "投屏已断开")
            } else {
                Log.d(TAG, "解码线程退出（stopped，不回调）: ${e.message}")
            }
        } finally {
            Log.i(TAG, "解码线程退出 (stopped=${stopped.get()})")
            runCatching { ctx?.let { avcodec.avcodec_free_context(it) } }
            runCatching { ic?.let { avformat.avformat_close_input(it) } }
        }
    }

    /**
     * 极简阻塞字节流：生产端（WS 读循环）write，消费端（FFmpeg 的读
     * 回调）read。**积压治理**：超 3MB 丢到最近关键帧（SPS）重同步——
     * 解码跟不上实时时无界积压让延迟发散到分钟级（真机实测画面停在
     * 几十分钟前）；丢整 GOP 不产生绿块。
     */
    private class LiveByteStream : InputStream() {
        private val lock = Object()
        private val chunks = ArrayDeque<ByteArray>()
        private var current: ByteArray? = null
        private var pos = 0
        private var closed = false
        private var bufferedBytes = 0L

        fun write(data: ByteArray) {
            synchronized(lock) {
                if (closed) return
                chunks.addLast(data.copyOf())
                bufferedBytes += data.size
                if (bufferedBytes > BACKLOG_CAP) dropToLastKeyframe()
                lock.notifyAll()
            }
        }

        /** 丢到最近关键帧（SPS NAL）重同步；找不到 SPS 则清空（等下一个 IDR） */
        private fun dropToLastKeyframe() {
            val all = ByteArray(bufferedBytes.toInt())
            var off = 0
            current?.let {
                val n = it.size - pos
                System.arraycopy(it, pos, all, off, n)
                off += n
            }
            for (c in chunks) {
                System.arraycopy(c, 0, all, off, c.size)
                off += c.size
            }
            chunks.clear()
            current = null
            pos = 0
            var lastSps = -1
            var i = 0
            while (i + 3 < off) {
                if (all[i] == 0x00.toByte() && all[i + 1] == 0x00.toByte() && all[i + 2] == 0x01.toByte()) {
                    if ((all[i + 3].toInt() and 0x1f) == 7) lastSps = i // SPS
                    i += 4
                } else {
                    i++
                }
            }
            val keep = if (lastSps >= 0) lastSps else off // 无 SPS：全清
            bufferedBytes = (off - keep).toLong()
            var p = keep
            while (p < off) {
                val n = minOf(60 * 1024, off - p)
                chunks.addLast(all.copyOfRange(p, p + n))
                p += n
            }
            Log.w(TAG, "管道积压丢帧: 保留 ${bufferedBytes}B（自最近关键帧起）")
        }

        fun closeWriter() {
            synchronized(lock) {
                closed = true
                lock.notifyAll()
            }
        }

        fun backlog(): Long = synchronized(lock) { bufferedBytes }

        /**
         * 读取至多 len 字节：等首字节最多 timeoutMs，拿到后立刻把「现有
         * 数据」尽量拷走返回（**短读**）。绝不能攒满再返回——AVIO 读回调
         * 攒满 64KB 才吐的话，活流涓速下每个请求都要等数秒（真机实测
         * av_read_frame 3.7 秒一包，画面冻结）。
         */
        fun readAvailable(b: ByteArray, off: Int, len: Int, timeoutMs: Long): Int {
            synchronized(lock) {
                var waited = 0L
                while (!hasBuffered() && !closed && waited < timeoutMs) {
                    lock.wait(100)
                    waited += 100
                }
                if (!hasBuffered()) return if (closed) -1 else 0
                var filled = 0
                while (filled < len) {
                    val cur = current
                    if (cur != null && pos < cur.size) {
                        val n = minOf(len - filled, cur.size - pos)
                        System.arraycopy(cur, pos, b, off + filled, n)
                        pos += n
                        filled += n
                        continue
                    }
                    current = chunks.removeFirstOrNull() ?: break
                    pos = 0
                }
                bufferedBytes -= filled
                return filled
            }
        }

        private fun hasBuffered(): Boolean {
            val cur = current
            return (cur != null && pos < cur.size) || chunks.isNotEmpty()
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int = readAvailable(b, off, len, 0L)

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else (one[0].toInt() and 0xff)
        }

        override fun close() = closeWriter()
    }

    companion object {
        private const val TAG = "LinkSpace/Stream"

        /** AVIO 回调共享缓冲 */
        private val avioScratch = ByteArray(256 * 1024)

        /** 管道积压上限：超过即丢到最近关键帧（约 8-10s 的典型码率） */
        private const val BACKLOG_CAP = 3L * 1024 * 1024
    }
}
