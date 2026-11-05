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
import org.bytedeco.ffmpeg.global.swscale
import org.bytedeco.ffmpeg.swscale.SwsContext
import org.bytedeco.javacpp.BytePointer
import org.bytedeco.javacpp.IntPointer
import org.bytedeco.javacpp.Pointer
import org.bytedeco.javacpp.PointerPointer
import java.io.InputStream
import java.nio.ByteBuffer
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
        var swsCtx: SwsContext? = null
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
            avutil.av_dict_set(opts, "probesize", "32", 0)
            avutil.av_dict_set(opts, "analyzeduration", "0", 0)
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
            // 开启 LOW_DELAY + FAST + SLICE 多核并行（与桌面端 sliced-threads=1 匹配，零帧级缓冲延迟）
            codecCtx.flags(codecCtx.flags() or avcodec.AV_CODEC_FLAG_LOW_DELAY)
            codecCtx.flags2(codecCtx.flags2() or avcodec.AV_CODEC_FLAG2_FAST)
            codecCtx.thread_count(4)
            codecCtx.thread_type(AVCodecContext.FF_THREAD_SLICE)
            avcodec.avcodec_open2(codecCtx, codec, null as AVDictionary?)
            Log.i(TAG, "avcodec_open2 完成（${codecCtx.width()}x${codecCtx.height()}）")

            val pkt = avcodec.av_packet_alloc()
            val frame = avutil.av_frame_alloc()
            val bmpRing = arrayOfNulls<Bitmap>(2)
            var ringIdx = 0
            var rgbaBuf: ByteBuffer? = null
            var dstPtr: BytePointer? = null
            val dstData = PointerPointer<BytePointer>(4L)
            val dstLinesize = IntPointer(4L)
            var rendered = 0L

            fun drainAndRender() {
                while (avcodec.avcodec_receive_frame(codecCtx, frame) >= 0) {
                    val w = frame.width()
                    val h = frame.height()
                    val pixFmt = frame.format()
                    if (w <= 0 || h <= 0) {
                        avutil.av_frame_unref(frame)
                        continue
                    }
                    if (w != outWidth || h != outHeight || bmpRing[0] == null) {
                        outWidth = w
                        outHeight = h
                        bmpRing[0] = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        bmpRing[1] = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        val direct = ByteBuffer.allocateDirect(w * h * 4)
                        rgbaBuf = direct
                        val bp = BytePointer(direct)
                        dstPtr = bp
                        dstData.put(0L, bp)
                        dstLinesize.put(0L, w * 4)
                        onSize(w, h)
                        Log.i(TAG, "FFmpeg 软解就绪: ${w}x${h}")
                    }
                    // 仅当管道内真的堆积超过 64KB（多帧未读）时才跳过渲染追赶最新包
                    if (rendered > 0L && pipe.backlog() > 64 * 1024L) {
                        avutil.av_frame_unref(frame)
                        continue
                    }
                    val buf = rgbaBuf ?: return
                    val bitmap = bmpRing[ringIdx] ?: return
                    ringIdx = (ringIdx + 1) and 1
                    // 原生 libswscale NEON 加速 YUV420P → RGBA + 直接内存拷贝（~1.5ms/帧，消除逐行 JNI 循环）
                    swsCtx = swscale.sws_getCachedContext(
                        swsCtx,
                        w, h, if (pixFmt >= 0) pixFmt else avutil.AV_PIX_FMT_YUV420P,
                        w, h, avutil.AV_PIX_FMT_RGBA,
                        swscale.SWS_FAST_BILINEAR,
                        null, null, null as DoubleArray?
                    )
                    val sCtx = swsCtx
                    if (sCtx != null && dstPtr != null) {
                        swscale.sws_scale(
                            sCtx,
                            frame.data(),
                            frame.linesize(),
                            0,
                            h,
                            dstData,
                            dstLinesize
                        )
                        buf.rewind()
                        bitmap.copyPixelsFromBuffer(buf)
                    }
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
            runCatching { swsCtx?.let { swscale.sws_freeContext(it) } }
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

        /** 管道积压上限：超过即丢到最近关键帧（约 0.5s 码率，避免积压出秒级画面延迟） */
        private const val BACKLOG_CAP = 512L * 1024
    }
}
