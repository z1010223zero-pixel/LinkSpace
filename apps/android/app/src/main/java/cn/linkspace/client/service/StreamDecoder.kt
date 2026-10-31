package cn.linkspace.client.service

import android.graphics.Bitmap
import android.util.Log
import org.bytedeco.ffmpeg.avcodec.AVCodecContext
import org.bytedeco.ffmpeg.avformat.AVFormatContext
import org.bytedeco.ffmpeg.avformat.Read_packet_Pointer_BytePointer_int
import org.bytedeco.ffmpeg.avformat.Write_packet_Pointer_BytePointer_int
import org.bytedeco.ffmpeg.avformat.Seek_Pointer_long_int
import org.bytedeco.ffmpeg.avutil.AVDictionary
import org.bytedeco.ffmpeg.avutil.AVFrame
import org.bytedeco.ffmpeg.global.avcodec
import org.bytedeco.ffmpeg.global.avformat
import org.bytedeco.ffmpeg.global.avutil
import org.bytedeco.ffmpeg.global.swscale
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
 * 为什么是 FFmpeg 软解 + 直调 API（RustDesk 同款路线，2026-11-01 定论）：
 * ①本 ROM 的 MediaCodec——c2.qti/c2.android、Surface/ByteBuffer——对
 * 「实时涓流喂入」的活流全线不可靠（下半帧全零或零输出活锁），离线
 * 文件流同参数却全绿；②JavaCV 的 FFmpegFrameGrabber.start() 内部走
 * avformat_find_stream_info，裸 h264 无时间戳时探测永不收敛（真机
 * 实测静默吞 10MB+ 不返回），probesize/analyzeduration 压不死。
 * 因此直调 libavformat/libavcodec：**跳过 find_stream_info**，参数由
 * 首帧 SPS 经 avcodec_parameters_to_context 自取，行为完全受控。
 *
 * 喂数模型：WS 读循环经 [feed] 把原始字节写入 [LiveByteStream]，解码
 * 线程 av_read_frame 阻塞拉取，FFmpeg 自行找 start code/分帧。
 *
 * 生命周期：start 起解码线程；shutdown 置位 + 关流打断。一次性使用，
 * 重看投屏就再建一个实例。
 */
class StreamDecoder(
    private val onEnded: (reason: String) -> Unit,
    /** 每个解码完成的帧（复用 Bitmap 实例，调用方须同步消费/绘制） */
    private val onFrame: (Bitmap) -> Unit,
    /** 流内 SPS 解出后的实际画面尺寸（触控映射基准），解码线程外回调 */
    private val onSize: (Int, Int) -> Unit = { _, _ -> }
) : Thread("linkspace-stream-decode") {

    private val stopped = AtomicBoolean(false)
    private val pipe = LiveByteStream()

    // FunctionPointer 必须持强引用：native 侧只存函数地址，Java 侧引用
    // 被 GC 回收后回调即悬空（真机踩过：open_input 中段段错误）
    private val readCb = object : Read_packet_Pointer_BytePointer_int() {
        override fun call(opaque: Pointer?, buf: BytePointer, bufSize: Int): Int {
            try {
                if (bufSize <= 0) return 0
                // 短读语义：等首个字节最多 2s（活流静默期不能当 EOF——
                // 否则 av_read_frame 空转几圈就把流掐了），拿到首字节后
                // 只取当前已有量立刻返回（攒满 64KB 再吐会让活流每请求
                // 都等数秒，画面冻结）
                val n = pipe.readAvailable(tmpShare, 0, minOf(bufSize, tmpShare.size), 2000L)
                if (n <= 0) return avutil.AVERROR_EOF
                buf.position(0)
                buf.put(tmpShare, 0, n)
                return n
            } catch (t: Throwable) {
                // 回调里抛 Java 异常会以 C++ 异常穿透 JNI 直接 abort 进程
                //（真机踩过），必须在此全吞
                Log.e(TAG, "AVIO 读回调异常", t)
                return avutil.AVERROR_EOF
            }
        }
    }
    /** 回调共享缓冲（解码线程独占，免每次分配 64KB） */
    private val tmpShare = ByteArray(64 * 1024)
    private val seekCb = object : Seek_Pointer_long_int() {
        override fun call(opaque: Pointer?, offset: Long, whence: Int): Long = -1
    }

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
            val avio = avformat.avio_alloc_context(BytePointer(ioBuffer), 64 * 1024, 0, null, readCb, null as Write_packet_Pointer_BytePointer_int?, seekCb)
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
            var framePixels: IntArray? = null
            var bmp: Bitmap? = null
            var rendered = 0L

            fun drainAndRender() {
                while (avcodec.avcodec_receive_frame(codecCtx, frame) >= 0) {
                    val w = frame.width()
                    val h = frame.height()
                    if (w <= 0 || h <= 0) {
                        avutil.av_frame_unref(frame)
                        continue
                    }
                    if (w != outWidth || h != outHeight) {
                        outWidth = w
                        outHeight = h
                        bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
                        onSize(w, h)
                        Log.i(TAG, "FFmpeg 软解就绪: ${w}x${h}")
                    }
                    // YUV420P → RGB 直读平面（sws_scale 在本机返回 -22 的原因
                    // 未查明，先用逐像素转换，1088p 约 25-40ms/帧，后续换 libyuv）
                    val yB = frame.data(0)
                    val uB = frame.data(1)
                    val vB = frame.data(2)
                    val yRow = frame.linesize(0)
                    val uRow = frame.linesize(1)
                    val vRow = frame.linesize(2)
                    var px = framePixels
                    if (px == null || px.size < w * h) {
                        px = IntArray(w * h)
                        framePixels = px
                    }
                    var idx = 0
                    for (row in 0 until h) {
                        val yBase = row * yRow
                        val uvRow = row shr 1
                        val uBase = uvRow * uRow
                        val vBase = uvRow * vRow
                        var col = 0
                        while (col < w) {
                            val y = (yB.get((yBase + col).toLong()).toInt() and 0xff) - 16
                            val uvi = col shr 1
                            val u = (uB.get((uBase + uvi).toLong()).toInt() and 0xff) - 128
                            val v = (vB.get((vBase + uvi).toLong()).toInt() and 0xff) - 128
                            var r = (1192 * y + 1634 * v) shr 10
                            var g = (1192 * y - 833 * v - 400 * u) shr 10
                            var b = (1192 * y + 2066 * u) shr 10
                            if (r < 0) r = 0 else if (r > 255) r = 255
                            if (g < 0) g = 0 else if (g > 255) g = 255
                            if (b < 0) b = 0 else if (b > 255) b = 255
                            px[idx++] = -0x1000000 or (r shl 16) or (g shl 8) or b
                            col++
                        }
                    }
                    (bmp ?: return).setPixels(px, 0, w, 0, 0, w, h)
                    rendered++
                    if (rendered == 1L || rendered % 120 == 0L) {
                        Log.i(TAG, "已解码渲染 $rendered 帧")
                    }
                    if (rendered == 30L) {
                        val b = bmp!!
                        Log.i(
                            TAG,
                            "像素采样 (200,200)=#${Integer.toHexString(b.getPixel(200, 200))} " +
                                "(960,540)=#${Integer.toHexString(b.getPixel(960, 540))} " +
                                "(1700,900)=#${Integer.toHexString(b.getPixel(1700, 900))}"
                        )
                    }
                    onFrame(bmp!!)
                    avutil.av_frame_unref(frame)
                }
            }

            var readCalls = 0L
            var lastReadLog = System.currentTimeMillis()
            while (!stopped.get()) {
                val ret = avformat.av_read_frame(formatCtx, pkt)
                readCalls++
                val nowMs = System.currentTimeMillis()
                if (nowMs - lastReadLog > 5000) {
                    Log.i(TAG, "av_read_frame 循环 readCalls=$readCalls ret=$ret stopped=${stopped.get()}")
                    lastReadLog = nowMs
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
     * 回调）read。无界队列防丢块（教训同旧实现）；关写端后读端返回
     * AVERROR_EOF 让 ffmpeg 走收尾。
     */
    private class LiveByteStream : InputStream() {
        private val lock = Object()
        private val chunks = ArrayDeque<ByteArray>()
        private var current: ByteArray? = null
        private var pos = 0
        private var closed = false

        fun write(data: ByteArray) {
            synchronized(lock) {
                if (closed) return
                chunks.addLast(data.copyOf())
                lock.notifyAll()
            }
        }

        fun closeWriter() {
            synchronized(lock) {
                closed = true
                lock.notifyAll()
            }
        }

        override fun read(b: ByteArray, off: Int, len: Int): Int = readAvailable(b, off, len, 0L)

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
                return filled
            }
        }

        private fun hasBuffered(): Boolean {
            val cur = current
            return (cur != null && pos < cur.size) || chunks.isNotEmpty()
        }

        override fun read(): Int {
            val one = ByteArray(1)
            return if (read(one, 0, 1) < 0) -1 else (one[0].toInt() and 0xff)
        }

        override fun close() = closeWriter()
    }

    companion object {
        private const val TAG = "LinkSpace/Stream"
    }
}
