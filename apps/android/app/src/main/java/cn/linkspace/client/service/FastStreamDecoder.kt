package cn.linkspace.client.service

import android.media.MediaCodec
import android.media.MediaFormat
import android.os.Build
import android.os.Process
import android.util.Log
import android.view.Surface
import java.nio.ByteBuffer
import java.util.ArrayDeque
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.roundToInt

/**
 * 高性能模式（"fast"）硬件解码器：
 *
 * - 接收桌面端按帧封包的 WebSocket 二进制消息：
 *   `[0] flags (bit0 = keyframe)` + `[1..8] sendTsMs (u64 LE)` + `[9..] H.264 Annex-B AU`
 * - 使用 Android 硬件 `MediaCodec` (`video/avc`) 直接解码到 [Surface]（零 CPU 像素拷贝，
 *   消除软解 `YUV420P -> ARGB Bitmap` 的 25~40ms CPU 转换开销与 GC 抖动）。
 * - 彻底修复历史 `MediaCodec` 死锁根因：
 *   1. **先取帧、后取输入缓冲**：绝不在队列为空时调用 `dequeueInputBuffer` 后丢弃索引，
 *      杜绝输入缓冲永久泄漏；
 *   2. **Surface 与首帧时序解耦**：保留最新关键帧（含 SPS/PPS/IDR），等 `Surface` 就绪后
 *      先从关键帧提取 `csd-0` (SPS) / `csd-1` (PPS) 配置解码器，再送入完整关键帧 AU；
 *   3. **2.5s 首帧看门狗**：若设备 ROM 硬解异常或超时不出帧，自动触发 [onFallback]
 *      无缝切回兼容软解模式。
 */
class FastStreamDecoder(
    private val streamWidth: Int,
    private val streamHeight: Int,
    private val fps: Int,
    initialSurface: Surface?,
    private val onStats: (String) -> Unit,
    private val onRequestKeyframe: () -> Unit,
    private val onFallback: (reason: String) -> Unit,
    private val onEnded: (reason: String) -> Unit
) {
    private data class FramePacket(
        val au: ByteArray,
        val key: Boolean,
        val sendTsMs: Long,
        val recvNs: Long
    )

    private val stopped = AtomicBoolean(false)
    private val fallbackTriggered = AtomicBoolean(false)
    private val surfaceChanged = AtomicBoolean(false)
    private val lock = Object()

    @Volatile
    private var surface: Surface? = initialSurface

    private val queue = ArrayDeque<FramePacket>()
    private var lastKeyframe: FramePacket? = null
    private var waitingForKeyframe = false
    private var lastKeyframeReqAt = 0L

    private val bytesInWindow = AtomicLong(0L)
    private val framesOut = AtomicLong(0L)
    private val submitTimeNs = ConcurrentHashMap<Long, Long>()

    private var inputThread: Thread? = null

    /** 更新渲染 Surface（TextureView 就绪/尺寸变化/销毁时由主线程调用） */
    fun setSurface(newSurface: Surface?) {
        synchronized(lock) {
            if (surface === newSurface) return
            surface = newSurface
            surfaceChanged.set(true)
            lock.notifyAll()
        }
    }

    /** 喂入一个完整的 fast 二进制帧（9 字节头 + Annex-B AU） */
    fun feed(raw: ByteArray) {
        if (stopped.get() || raw.size <= FAST_HEADER_BYTES) return
        val flags = raw[0].toInt() and 0xff
        val key = (flags and FAST_FLAG_KEY) != 0
        val sendTsMs = readUint64Le(raw, 1)
        val au = raw.copyOfRange(FAST_HEADER_BYTES, raw.size)
        bytesInWindow.addAndGet(au.size.toLong())
        val pkt = FramePacket(au = au, key = key, sendTsMs = sendTsMs, recvNs = System.nanoTime())

        synchronized(lock) {
            if (key) {
                lastKeyframe = pkt
                waitingForKeyframe = false
                // 队列若有陈旧积压，直接跳到最新关键帧，把排队延迟归零
                if (queue.size >= 2) {
                    queue.clear()
                }
                queue.addLast(pkt)
            } else {
                if (waitingForKeyframe) {
                    requestKeyframeThrottled()
                    return
                }
                if (queue.size >= MAX_QUEUE_FRAMES) {
                    // 队列积压超阈值：丢弃非关键帧并请求桌面立即发 IDR
                    queue.clear()
                    waitingForKeyframe = true
                    requestKeyframeThrottled()
                    return
                }
                queue.addLast(pkt)
            }
            lock.notifyAll()
        }
    }

    private fun requestKeyframeThrottled() {
        val now = System.currentTimeMillis()
        if (now - lastKeyframeReqAt >= 600L) {
            lastKeyframeReqAt = now
            runCatching { onRequestKeyframe() }
        }
    }

    fun start() {
        if (inputThread != null) return
        val t = Thread({ runDecoderLoop() }, "linkspace-fast-in")
        t.isDaemon = true
        inputThread = t
        t.start()
    }

    fun shutdown() {
        if (!stopped.compareAndSet(false, true)) return
        synchronized(lock) {
            queue.clear()
            lock.notifyAll()
        }
        inputThread?.interrupt()
    }

    private fun triggerFallback(reason: String) {
        if (stopped.get()) return
        if (fallbackTriggered.compareAndSet(false, true)) {
            Log.w(TAG, "触发硬解回退兼容模式: $reason")
            stopped.set(true)
            onFallback(reason)
        }
    }

    private fun runDecoderLoop() {
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY) }
        val waitStart = System.currentTimeMillis()
        var initKeyPkt: FramePacket? = null
        var initSurface: Surface? = null

        synchronized(lock) {
            while (!stopped.get()) {
                val s = surface
                if (queue.isEmpty() && lastKeyframe != null) {
                    queue.addLast(lastKeyframe!!)
                }
                val firstKey = queue.firstOrNull { it.key } ?: lastKeyframe
                if (s != null && s.isValid && firstKey != null) {
                    initSurface = s
                    initKeyPkt = firstKey
                    surfaceChanged.set(false)
                    break
                }
                if (System.currentTimeMillis() - waitStart > 5000L && firstKey == null) {
                    triggerFallback("5s 未收到关键帧")
                    return
                }
                lock.wait(50L)
            }
        }
        if (stopped.get()) return
        val targetSurface = initSurface ?: return
        val firstKey = initKeyPkt ?: return

        var codec: MediaCodec? = null
        val outputStop = AtomicBoolean(false)
        var outputThread: Thread? = null

        try {
            val csd = extractSpsPps(firstKey.au)
            val format = MediaFormat.createVideoFormat(
                MediaFormat.MIMETYPE_VIDEO_AVC,
                streamWidth.coerceAtLeast(32),
                streamHeight.coerceAtLeast(32)
            )
            if (csd != null) {
                format.setByteBuffer("csd-0", ByteBuffer.wrap(csd.first))
                format.setByteBuffer("csd-1", ByteBuffer.wrap(csd.second))
            }
            // 开启 Android 11+ 标准低延迟硬解与高通/联发科扩展低延迟标志
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                runCatching { format.setInteger(MediaFormat.KEY_LOW_LATENCY, 1) }
            }
            runCatching { format.setInteger(MediaFormat.KEY_PRIORITY, 0) }
            runCatching { format.setInteger(MediaFormat.KEY_OPERATING_RATE, Short.MAX_VALUE.toInt()) }
            runCatching { format.setInteger("vendor.qti-ext-dec-low-latency.enable", 1) }
            runCatching { format.setInteger("vendor.rtc-ext-dec-low-latency.enable", 1) }
            runCatching { format.setInteger("vendor.hisi-ext-low-latency-video-dec.video-scene-for-low-latency-req", 1) }

            val decoder = MediaCodec.createDecoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            codec = decoder
            decoder.configure(format, targetSurface, null, 0)
            decoder.start()
            Log.i(
                TAG,
                "硬件解码器已启动: ${decoder.name} (${streamWidth}x${streamHeight}@${fps}fps, csd=${csd != null})"
            )

            val outThread = Thread(
                { drainOutputLoop(decoder, outputStop) },
                "linkspace-fast-out"
            ).apply {
                isDaemon = true
                start()
            }
            outputThread = outThread

            val configuredAt = System.currentTimeMillis()
            val frameStepUs = (1_000_000L / fps.coerceAtLeast(1))
            var ptsUs = 0L
            var framesIn = 0L
            var lastFeedMs = System.currentTimeMillis()

            while (!stopped.get()) {
                val curSurface = synchronized(lock) { surface }
                if (curSurface == null || !curSurface.isValid) {
                    // Surface 临时销毁（如屏幕旋转/视图重挂载）：暂停送帧等待新 Surface，避免向已释放 Surface 解码抛异常断流
                    synchronized(lock) {
                        if (!stopped.get() && (surface == null || surface?.isValid != true)) {
                            lock.wait(50L)
                        }
                    }
                    continue
                }
                if (surfaceChanged.compareAndSet(true, false)) {
                    runCatching {
                        decoder.setOutputSurface(curSurface)
                        requestKeyframeThrottled()
                    }.onFailure { e ->
                        Log.w(TAG, "切换 Surface 失败: ${e.message}")
                    }
                }

                val pkt: FramePacket? = synchronized(lock) {
                    if (queue.isEmpty()) {
                        lock.wait(40L)
                    }
                    queue.pollFirst()
                }

                if (pkt == null) {
                    val now = System.currentTimeMillis()
                    if (framesIn >= 20 && framesOut.get() == 0L && now - configuredAt > 2500L) {
                        triggerFallback("硬解 2.5s 未出帧")
                        return
                    }
                    if (now - lastFeedMs > 15_000L) {
                        onEnded("推流 15 秒无数据")
                        return
                    }
                    continue
                }

                lastFeedMs = System.currentTimeMillis()

                // 先拿到 pkt，再去取 MediaCodec 输入缓冲，绝不泄漏 inIdx
                var queued = false
                while (!stopped.get() && !queued) {
                    val inIdx = decoder.dequeueInputBuffer(10_000L)
                    if (inIdx >= 0) {
                        val ib = decoder.getInputBuffer(inIdx)
                        if (ib != null) {
                            ib.clear()
                            if (pkt.au.size <= ib.remaining()) {
                                ib.put(pkt.au)
                                submitTimeNs[ptsUs] = System.nanoTime()
                                val flags = if (pkt.key) MediaCodec.BUFFER_FLAG_KEY_FRAME else 0
                                decoder.queueInputBuffer(inIdx, 0, pkt.au.size, ptsUs, flags)
                                ptsUs += frameStepUs
                                framesIn++
                            } else {
                                decoder.queueInputBuffer(inIdx, 0, 0, 0L, 0)
                            }
                        } else {
                            decoder.queueInputBuffer(inIdx, 0, 0, 0L, 0)
                        }
                        queued = true
                    } else if (framesIn >= 20 && framesOut.get() == 0L &&
                        System.currentTimeMillis() - configuredAt > 2500L
                    ) {
                        triggerFallback("硬解输入缓冲阻塞")
                        return
                    }
                }
            }
        } catch (
            @Suppress("SwallowedException")
            e: InterruptedException
        ) {
            // 正常停止
        } catch (t: Throwable) {
            if (!stopped.get()) {
                Log.w(TAG, "硬件解码异常: ${t.javaClass.simpleName}: ${t.message}")
                if (framesOut.get() == 0L) {
                    triggerFallback("硬解初始化失败：${t.message}")
                } else {
                    onEnded("投屏连接已断开")
                }
            }
        } finally {
            outputStop.set(true)
            runCatching { outputThread?.join(300L) }
            runCatching { codec?.stop() }
            runCatching { codec?.release() }
            Log.i(TAG, "硬件解码线程已退出 (framesOut=${framesOut.get()})")
        }
    }

    private fun drainOutputLoop(decoder: MediaCodec, outputStop: AtomicBoolean) {
        runCatching { Process.setThreadPriority(Process.THREAD_PRIORITY_DISPLAY) }
        val info = MediaCodec.BufferInfo()
        var windowFrames = 0
        var windowDecodeNs = 0L
        var windowStartMs = System.currentTimeMillis()

        while (!stopped.get() && !outputStop.get()) {
            val outIdx = try {
                decoder.dequeueOutputBuffer(info, 10_000L)
            } catch (t: Throwable) {
                if (!stopped.get() && !outputStop.get()) {
                    Log.w(TAG, "dequeueOutputBuffer 退出: ${t.message}")
                }
                break
            }
            when {
                outIdx >= 0 -> {
                    val subNs = submitTimeNs.remove(info.presentationTimeUs)
                    if (subNs != null) {
                        windowDecodeNs += (System.nanoTime() - subNs).coerceAtLeast(0L)
                    }
                    // 清理可能因跳帧遗留的旧时间戳记录，防止 Map 增长
                    if (submitTimeNs.size > 64) {
                        submitTimeNs.clear()
                    }
                    runCatching { decoder.releaseOutputBuffer(outIdx, true) }
                    val total = framesOut.incrementAndGet()
                    windowFrames++
                    if (total == 1L) {
                        Log.i(TAG, "硬件解码首帧已上屏！")
                    }
                    val now = System.currentTimeMillis()
                    val elapsedMs = now - windowStartMs
                    if (elapsedMs >= 1000L) {
                        val realFps = (windowFrames * 1000f / elapsedMs).roundToInt()
                        val bytes = bytesInWindow.getAndSet(0L)
                        val mbps = (bytes * 8.0 / (elapsedMs / 1000.0)) / 1_000_000.0
                        val avgDecMs = if (windowFrames > 0) {
                            (windowDecodeNs / windowFrames) / 1_000_000.0
                        } else {
                            0.0
                        }
                        val statText = String.format(
                            java.util.Locale.US,
                            "硬解 %dfps · %.1fMbps · %.1fms",
                            realFps,
                            mbps,
                            avgDecMs
                        )
                        onStats(statText)
                        if (total % 120L < windowFrames) {
                            Log.i(TAG, "$statText (累计 $total 帧)")
                        }
                        windowFrames = 0
                        windowDecodeNs = 0L
                        windowStartMs = now
                    }
                }
                outIdx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED -> {
                    val fmt = runCatching { decoder.outputFormat }.getOrNull()
                    Log.i(TAG, "硬件解码输出格式就绪: $fmt")
                }
            }
        }
    }

    companion object {
        private const val TAG = "LinkSpace/FastDec"
        const val FAST_HEADER_BYTES = 9
        const val FAST_FLAG_KEY = 0x01
        private const val MAX_QUEUE_FRAMES = 6

        internal fun readUint64Le(b: ByteArray, offset: Int): Long {
            var v = 0L
            for (i in 0 until 8) {
                v = v or ((b[offset + i].toLong() and 0xffL) shl (i * 8))
            }
            return v
        }

        /**
         * 从 Annex-B 关键帧 AU 中提取 SPS（NAL 7）与 PPS（NAL 8），带 4 字节起始码。
         */
        internal fun extractSpsPps(au: ByteArray): Pair<ByteArray, ByteArray>? {
            var sps: ByteArray? = null
            var pps: ByteArray? = null
            var i = 0
            var nalPayloadStart = -1
            var nalType = -1

            fun finishNal(end: Int) {
                if (nalPayloadStart < 0 || end <= nalPayloadStart) return
                val len = end - nalPayloadStart
                val out = ByteArray(4 + len)
                out[3] = 1
                System.arraycopy(au, nalPayloadStart, out, 4, len)
                if (nalType == 7 && sps == null) sps = out
                if (nalType == 8 && pps == null) pps = out
            }

            while (i + 2 < au.size) {
                if (au[i] == 0.toByte() && au[i + 1] == 0.toByte()) {
                    val scLen = when {
                        au[i + 2] == 1.toByte() -> 3
                        i + 3 < au.size && au[i + 2] == 0.toByte() && au[i + 3] == 1.toByte() -> 4
                        else -> 0
                    }
                    if (scLen > 0) {
                        val nalStart = i
                        finishNal(nalStart)
                        val hdrIdx = i + scLen
                        if (hdrIdx < au.size) {
                            nalPayloadStart = hdrIdx
                            nalType = au[hdrIdx].toInt() and 0x1f
                        } else {
                            nalPayloadStart = -1
                            nalType = -1
                        }
                        i += scLen
                        continue
                    }
                }
                i++
            }
            finishNal(au.size)
            val s = sps
            val p = pps
            return if (s != null && p != null) s to p else null
        }
    }
}
