package cn.linkspace.client.service

import android.content.Context
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.media.ImageReader
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.projection.MediaProjection
import android.os.Bundle
import android.os.Handler
import android.os.HandlerThread
import android.os.SystemClock
import android.util.Log
import org.bytedeco.ffmpeg.global.avcodec
import org.bytedeco.ffmpeg.global.avutil
import org.bytedeco.javacv.AndroidFrameConverter
import org.bytedeco.javacv.FFmpegFrameRecorder
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.io.OutputStream
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicLong

/**
 * 反向 screen.stream 推流端（线 2 W6，协议 4.7 反向）。
 *
 * 方向：平板屏幕 → 电脑窗口。与线 1 的桌面推流复用同一套语义，只是
 * 角色互换——同一条控制连接上的 WS 二进制帧（裸 H.264 Annex-B），
 * 分辨率档位与码率档位与线 1 同口径（720p/1080p/1440p/2160p、
 * t0 不限流/t1 6M/t2 3M/t3 1.5M，见 protocol.json
 * constraints.streamQualityPresets / streamTiers）。
 *
 * **与 input 会话解耦（本批只做到这一层）**：反向流的启停不以活动
 * input 会话为前提。它的授权门是另一道——平板端的 MediaProjection
 * 系统录屏授权（用户在系统弹框里点同意才开录），不是 input 会话的
 * approve。未配对设备、断连、撤销信任时照样拒绝/掐断。
 *
 * **MediaProjection 注入点**：本类只负责“拿到已授权的 MediaProjection
 * 之后”的抓屏 + 编码 + 推流。系统授权框必须由 Activity 发起
 * （MediaProjectionManager.createScreenCaptureIntent()），见
 * [Listener.onReverseStreamRequested] 的 TODO——MainActivity 接线是
 * 后续 UI 批次的活，本批只留干净的 [startWithProjection] 入口。
 * 确认 UI 未接之前默认拒绝（与 W4 的 ControlledInputSession 同款
 * 安全姿势：不弹系统框、不自动开录）。
 *
 * 编码：MediaCodec（COLOR_FormatSurface 直连 VirtualDisplay）优先，
 * 启动失败回落 JavaCV/libx264 软编（线 1 在该 ROM 上已验证软解可靠，
 * 编码侧同样留回落口；JavaCV 依赖已在 build.gradle.kts 里）。
 * MediaCodec 输出按 Annex-B 处理，同时兼容长度前缀（AVCC）形态——
 * 运行时检测，见 [normalizeNals]。
 *
 * 背压与重连（复用线 1 口径，不另写一套）：
 * - 发送积压：出站写队列超 3MB 即丢到最近关键帧（与 StreamDecoder 的
 *   BACKLOG_CAP 同值同语义，只不过这是在发送侧）；积压由
 *   [onBytesFlushed]/[onBytesDropped] 回填，见 LinkSpaceService 的
 *   sendBinaryTo。
 * - 码率自适应：2s 采样发送积压，>1MB 计分 +1、<100KB 计分 -1，
 *   连续 3 次拥塞降档、连续 -8（约 30s 稳定）升档——与桌面端
 *   host.ts 的 backlogProbe 同阈值；改档 MediaCodec 走 setParameters
 *  （不重启），软编走 recorder 重启。
 * - 断线重连：退避 5/10/20/30s×4 在**桌面端**（反向流的观看方重发
 *   screen.stream.request）；平板端只负责断连即停流（onPeerDisconnected）。
 * - 解码端关键帧恢复在桌面接收端（ScreenStreamReceiver 丢到最近 SPS）。
 *
 * **未验证（无真机，勿当结论）**：
 * - MediaCodec 在该 ROM 上的实际编码表现、Annex-B/AVCC 形态、SPS/PPS
 *   内联与否——normalizeNals 只能兜住两种已知形态，真机为准。
 * - 软编回落路径的帧 pacing 与 muxer 冲刷延迟（FFmpegFrameRecorder 的
 *   OutputStream 写入节奏未经真机验证）。
 * - 后台保活：targetSdk 35 下，录屏在应用退到后台后能否持续，需
 *   foregroundServiceType="mediaProjection" 的前台服务承接——
 *   本批不动 AndroidManifest、不改 LinkSpaceForegroundService，
 *   由后续批次结合真机验证后定。
 * - 画面延迟、码率自适应效果：无真机，不打勾。
 */
class ReverseScreenStreamer(
    private val appContext: Context,
    private val isPeerAuthorized: (String) -> Boolean,
    private val localScreen: () -> InputController.Screen,
    private val send: (peerId: String, type: String, payload: JSONObject.() -> Unit) -> Unit,
    private val sendBinary: (peerId: String, data: ByteArray) -> Unit,
    private val listener: Listener? = null
) {

    interface Listener {
        /** 新反向投屏请求到达且已过门禁，UI 应立即发起录屏授权流程 */
        fun onReverseStreamRequested(request: ReverseStreamRequest)

        /** 推流状态变化（进入/离开 pending、active），UI 刷新用 */
        fun onChanged()

        /** 推流失败（编码器起不来等），UI 提示用 */
        fun onError(message: String)
    }

    /** 需要用户授权的反向投屏请求（被控端 UI 展示用） */
    data class ReverseStreamRequest(
        val peerId: String,
        val scaleWidth: Int,
        val requestedAt: Long
    )

    /** 进行中的反向推流（源端视角） */
    data class ActiveStream(
        val peerId: String,
        val scaleWidth: Int,
        val width: Int,
        val height: Int,
        val encoder: String,
        val startedAt: Long
    )

    /** 分辨率档位（协议 4.7，与 protocol.json streamQualityPresets 同值） */
    data class StreamPreset(val label: String, val width: Int, val fps: Int, val bps: Int)

    /** 码率档位（协议 4.7，与 protocol.json streamTiers 同值） */
    data class StreamTier(val label: String, val bps: Int?)

    /** 编码器句柄：MediaCodec 与软编的公共面 */
    private interface EncoderHandle {
        val name: String
        fun setBitrate(bps: Int)
        fun stop()
    }

    @Volatile
    private var pending: ReverseStreamRequest? = null

    @Volatile
    private var active: ActiveStream? = null

    private var ttlTimer: java.util.Timer? = null
    private var probeTimer: java.util.Timer? = null
    private var projection: MediaProjection? = null
    private var projectionCallback: MediaProjection.Callback? = null
    private var encoderHandle: EncoderHandle? = null

    @Volatile
    private var tier = 0

    @Volatile
    private var congestionScore = 0

    /** 已交出站写线程、尚未确认写出的字节数（背压信号源） */
    private val queuedBytes = AtomicLong(0)

    private var droppedBytes = 0L
    private var keyframeResyncs = 0L

    @Volatile
    private var dropping = false

    val pendingRequest: ReverseStreamRequest? get() = pending

    val activeStream: ActiveStream? get() = active

    val isStreaming: Boolean get() = active != null

    data class StreamStatus(
        val pendingPeerId: String?,
        val active: ActiveStream?,
        val tier: Int,
        val queuedBytes: Long,
        val droppedBytes: Long,
        val keyframeResyncs: Long
    )

    fun status(): StreamStatus =
        StreamStatus(pending?.peerId, active, tier, queuedBytes.get(), droppedBytes, keyframeResyncs)

    /**
     * 处理对端发来的 screen.stream.request（反向：桌面看平板）。
     * 与 input 会话解耦——不查活动 input 会话。门禁只有已配对。
     */
    @Synchronized
    fun onRequest(peerId: String, payload: JSONObject) {
        val requested = payload.optInt("scaleWidth", DEFAULT_SCALE_WIDTH)
        val scaleWidth =
            if (STREAM_PRESETS.any { it.width == requested }) requested else DEFAULT_SCALE_WIDTH
        if (!isPeerAuthorized(peerId)) {
            Log.i(TAG, "拒绝未信任设备 $peerId 的反向投屏请求")
            sendError(peerId, "not trusted")
            return
        }
        val a = active
        if (a != null) {
            if (a.peerId == peerId && a.scaleWidth == scaleWidth) {
                // 幂等：对端重发请求，重新回 start（与 ControlledInputSession
                // 的重发 accept 对称）
                sendStart(a)
                return
            }
            if (a.peerId == peerId) {
                // 同对端换分辨率：MediaProjection 已持有，无需重新授权，
                // 直接重启编码器（线 1 同款语义：换分辨率重启推流）
                Log.i(TAG, "反向投屏换分辨率 ${a.scaleWidth} → $scaleWidth，重启编码器")
                restartEncoder(scaleWidth)
                return
            }
            sendError(peerId, "resource busy")
            return
        }
        val p = pending
        if (p != null) {
            if (p.peerId == peerId && p.scaleWidth == scaleWidth) return
            sendError(peerId, "resource busy")
            return
        }
        queueRequest(peerId, scaleWidth)
    }

    /** UI：用户拒绝反向投屏请求（或默认拒绝桩调用） */
    @Synchronized
    fun deny(request: ReverseStreamRequest, reason: String = "denied by user") {
        val req = pending ?: return
        if (req != request) return
        clearTimer()
        pending = null
        sendError(req.peerId, reason)
        Log.i(TAG, "反向投屏请求被拒绝：$reason")
        listener?.onChanged()
    }

    /**
     * UI（后续批次）：把系统录屏授权拿到的 MediaProjection 交进来，开始推流。
     * 无挂起请求时直接释放该 projection，不开录。
     */
    @Synchronized
    fun startWithProjection(projection: MediaProjection) {
        val req = pending
        if (req == null) {
            Log.w(TAG, "收到 MediaProjection 但无挂起的反向投屏请求，忽略并释放")
            runCatching { projection.stop() }
            return
        }
        clearTimer()
        pending = null
        startEncoderFor(req, projection)
    }

    /**
     * 处理对端发来的 screen.stream.stop（反向）。direction 由调用方
     * （LinkSpaceService）按协议 4.7 解析后传入——本类只负责反向流，
     * forward 的 stop 与本类无关，直接忽略。
     */
    @Synchronized
    fun onStop(peerId: String, direction: String) {
        if (direction == Protocol.STREAM_DIRECTION_FORWARD) {
            Log.i(TAG, "screen.stream.stop 是 forward 流，与反向推流无关，忽略")
            return
        }
        val a = active
        if (a != null && a.peerId == peerId) {
            // 对端主动停：停推流并回 stop 确认（与桌面端 screen.stream.stop
            // 回声对称）
            stopInternal("对端停止反向投屏", notifyPeer = true)
            return
        }
        val p = pending
        if (p != null && p.peerId == peerId) {
            clearTimer()
            pending = null
            Log.i(TAG, "对端取消了反向投屏请求")
            listener?.onChanged()
        }
    }

    /** 本机主动停止反向投屏（UI 关闭 / 服务退出） */
    @Synchronized
    fun stop() {
        stopInternal("本机停止反向投屏", notifyPeer = true)
    }

    /** 连接断开：推流立即失效（断线恢复的源端半边） */
    @Synchronized
    fun onPeerDisconnected(peerId: String) {
        if (active?.peerId == peerId || pending?.peerId == peerId) {
            stopInternal("对端连接断开", notifyPeer = false)
        }
    }

    /** 信任撤销：比断连更优先的终止理由，立即掐断 */
    @Synchronized
    fun onTrustRevoked(peerId: String) {
        if (active?.peerId == peerId || pending?.peerId == peerId) {
            stopInternal("信任已被撤销", notifyPeer = false)
        }
    }

    /** 系统停掉了录屏（用户从通知栏停止或授权被收回） */
    @Synchronized
    fun onProjectionStopped() {
        if (active == null) return
        stopInternal("系统停掉了录屏", notifyPeer = true)
    }

    /** 出站写线程确认一批字节已写出（背压回填） */
    fun onBytesFlushed(n: Int) {
        queuedBytes.addAndGet(-n.toLong())
    }

    /** 出站写线程确认一批字节因无连接被丢弃（背压回填） */
    fun onBytesDropped(n: Int) {
        queuedBytes.addAndGet(-n.toLong())
    }

    // ---------- 内部 ----------

    private fun queueRequest(peerId: String, scaleWidth: Int) {
        val req = ReverseStreamRequest(peerId, scaleWidth, System.currentTimeMillis())
        pending = req
        // TTL 计时先于确认回调起表：确认 UI 的默认实现是同步拒绝，
        // 若先调回调再起表，拒绝里清掉的计时器会留下一个无人认领的空转任务
        //（与 ControlledInputSession 同款写法）。
        ttlTimer?.cancel()
        ttlTimer = java.util.Timer(true).apply {
            schedule(object : java.util.TimerTask() {
                override fun run() = onRequestExpired(req)
            }, REQUEST_TTL_MS)
        }
        Log.i(TAG, "收到 $peerId 的反向投屏请求（${scaleWidth}p），等待本机录屏授权")
        listener?.onReverseStreamRequested(req)
        listener?.onChanged()
    }

    @Synchronized
    fun onRequestExpired(req: ReverseStreamRequest) {
        if (pending != req) return
        Log.i(TAG, "反向投屏请求超时未确认，已自动拒绝")
        pending = null
        clearTimer()
        sendError(req.peerId, "expired")
        listener?.onChanged()
    }

    private fun clearTimer() {
        ttlTimer?.cancel()
        ttlTimer = null
    }

    private fun startProbe() {
        stopProbe()
        probeTimer = java.util.Timer(true).apply {
            scheduleAtFixedRate(object : java.util.TimerTask() {
                override fun run() = probeTick()
            }, PROBE_INTERVAL_MS, PROBE_INTERVAL_MS)
        }
    }

    private fun stopProbe() {
        probeTimer?.cancel()
        probeTimer = null
    }

    /**
     * 码率自适应采样（桌面端 host.ts backlogProbe 的同阈值移植）：
     * 积压 >1MB 计分 +1、<100KB 计分 -1；连续 3 次拥塞降档、
     * 连续 -8（约 30s 稳定）升档。信号源是本机出站写队列深度
     * （平板端没有 ws.bufferedAmount 可采样）。
     */
    private fun probeTick() {
        if (active == null) return
        val q = queuedBytes.get()
        congestionScore = when {
            q > CONGESTION_BYTES -> minOf(3, congestionScore + 1)
            q < IDLE_BYTES -> maxOf(-8, congestionScore - 1)
            else -> 0
        }
        if (congestionScore >= 3) {
            congestionScore = 0
            applyTier(minOf(tier + 1, STREAM_TIERS.size - 1))
        } else if (congestionScore <= -8 && tier > 0) {
            congestionScore = 0
            applyTier(tier - 1)
        }
    }

    @Synchronized
    private fun applyTier(newTier: Int) {
        if (newTier == tier) return
        val a = active ?: return
        tier = newTier
        val preset = STREAM_PRESETS.firstOrNull { it.width == a.scaleWidth } ?: STREAM_PRESETS[1]
        val bps = currentBitrateBps(preset)
        Log.i(TAG, "反向投屏码率档位 → ${STREAM_TIERS[tier].label}（${bps / 1_000_000.0}Mbps）")
        encoderHandle?.setBitrate(bps)
    }

    private fun currentBitrateBps(preset: StreamPreset): Int {
        val tierBps = STREAM_TIERS[tier].bps
        // 自适应码率与用户画质档位取交集：拥塞时仍能下降；用户选低清晰度
        // 时也不会因为 t0 无上限而把 Wi-Fi 打爆（桌面端 screen-stream.ts 同款公式）。
        return minOf(tierBps ?: preset.bps, preset.bps)
    }

    private fun computeDims(scaleWidth: Int, screen: InputController.Screen): Pair<Int, Int> {
        val w = scaleWidth
        // 高度按宽高比等比缩放，向下对齐到 16（MediaCodec 表面输入的安全
        // 对齐；桌面 ffmpeg 解码任意偶数尺寸均可，见 screen-stream.ts 的
        // 32 对齐注记——那是该 ROM 解码器的 quirks，编码侧不对齐到 32）。
        val h = ((scaleWidth.toLong() * screen.h / screen.w).toInt() / 16 * 16).coerceAtLeast(16)
        return w to h
    }

    private fun startEncoderFor(req: ReverseStreamRequest, projection: MediaProjection) {
        val screen = localScreen()
        val (w, h) = computeDims(req.scaleWidth, screen)
        val preset = STREAM_PRESETS.firstOrNull { it.width == req.scaleWidth } ?: STREAM_PRESETS[1]
        val bitrateBps = currentBitrateBps(preset)
        val cb = object : MediaProjection.Callback() {
            override fun onStop() {
                Log.w(TAG, "系统停掉了录屏（用户从通知栏停止或授权被收回）")
                onProjectionStopped()
            }
        }
        projection.registerCallback(cb, null)
        projectionCallback = cb
        this.projection = projection
        val handle = createEncoder(projection, w, h, bitrateBps)
        if (handle == null) {
            runCatching { projection.unregisterCallback(cb) }
            projectionCallback = null
            this.projection = null
            sendError(req.peerId, "投屏启动失败：编码器不可用")
            listener?.onError("投屏启动失败：编码器不可用")
            listener?.onChanged()
            return
        }
        encoderHandle = handle
        tier = 0
        congestionScore = 0
        queuedBytes.set(0)
        dropping = false
        active = ActiveStream(req.peerId, req.scaleWidth, w, h, handle.name, System.currentTimeMillis())
        startProbe()
        sendStart(active!!)
        Log.i(TAG, "反向投屏已启动 → ${req.peerId}（${w}x$h，编码器=${handle.name}）")
        listener?.onChanged()
    }

    /** 同对端换分辨率：复用已持有的 MediaProjection，直接重启编码器 */
    private fun restartEncoder(newScaleWidth: Int) {
        val a = active ?: return
        val proj = projection ?: return
        val screen = localScreen()
        val (w, h) = computeDims(newScaleWidth, screen)
        val preset = STREAM_PRESETS.firstOrNull { it.width == newScaleWidth } ?: STREAM_PRESETS[1]
        val bitrateBps = currentBitrateBps(preset)
        stopEncoderOnly()
        val handle = createEncoder(proj, w, h, bitrateBps)
        if (handle == null) {
            stopInternal("编码器重启失败", notifyPeer = true)
            return
        }
        encoderHandle = handle
        tier = 0
        congestionScore = 0
        queuedBytes.set(0)
        dropping = false
        active = a.copy(scaleWidth = newScaleWidth, width = w, height = h, encoder = handle.name)
        sendStart(active!!)
        Log.i(TAG, "反向投屏已换分辨率 → ${w}x$h（编码器=${handle.name}）")
        listener?.onChanged()
    }

    /** MediaCodec 优先，失败回落软编；两者都起不来返回 null */
    private fun createEncoder(
        projection: MediaProjection,
        width: Int,
        height: Int,
        bitrateBps: Int
    ): EncoderHandle? {
        val sink: (ByteArray, Boolean) -> Unit = { bytes, isKey -> emitEncoded(bytes, isKey) }
        try {
            Log.i(TAG, "反向投屏优先用 MediaCodec 硬编（${width}x$height @ ${bitrateBps / 1_000_000.0}Mbps）")
            return MediaCodecEncoder(projection, width, height, bitrateBps, sink)
        } catch (e: Exception) {
            Log.w(TAG, "MediaCodec 编码器启动失败，回落软编（JavaCV/libx264）: ${e.javaClass.simpleName}: ${e.message}")
        }
        try {
            return SoftwareEncoder(projection, width, height, bitrateBps, sink)
        } catch (e: Exception) {
            Log.e(TAG, "软编启动也失败: ${e.javaClass.simpleName}: ${e.message}")
            return null
        }
    }

    private fun stopEncoderOnly() {
        val h = encoderHandle
        encoderHandle = null
        h?.let { runCatching { it.stop() } }
    }

    private fun stopInternal(reason: String, notifyPeer: Boolean) {
        val a = active
        clearTimer()
        stopProbe()
        pending = null
        active = null
        stopEncoderOnly()
        val proj = projection
        val cb = projectionCallback
        projection = null
        projectionCallback = null
        if (cb != null && proj != null) runCatching { proj.unregisterCallback(cb) }
        if (proj != null) runCatching { proj.stop() }
        queuedBytes.set(0)
        dropping = false
        if (a != null && notifyPeer) {
            send(a.peerId, Protocol.TYPE_SCREEN_STREAM_STOP) {
                put("direction", Protocol.STREAM_DIRECTION_REVERSE)
            }
        }
        Log.i(TAG, "反向投屏停止：$reason")
        listener?.onChanged()
    }

    private fun sendStart(a: ActiveStream) {
        send(a.peerId, Protocol.TYPE_SCREEN_STREAM_START) {
            put("w", a.width)
            put("h", a.height)
            put("scaleWidth", a.scaleWidth)
        }
    }

    private fun sendError(peerId: String, message: String) {
        send(peerId, Protocol.TYPE_SCREEN_STREAM_ERROR) { put("message", message) }
    }

    /**
     * 编码输出 → WS 二进制帧（≤64KB 一块）。
     * 背压：发送积压超 3MB 即丢到最近关键帧（与 StreamDecoder 的
     * BACKLOG_CAP 同值同语义，发送侧版本）。
     */
    private fun emitEncoded(data: ByteArray, isKeyFrame: Boolean) {
        val a = active ?: return
        if (dropping) {
            if (!isKeyFrame) {
                droppedBytes += data.size
                return
            }
            dropping = false
            keyframeResyncs++
            Log.w(TAG, "背压丢帧恢复：等到关键帧，恢复推流")
        }
        if (queuedBytes.get() > BACKLOG_CAP_BYTES) {
            dropping = true
            droppedBytes += data.size
            Log.w(TAG, "发送积压超 3MB，丢到最近关键帧（线 1 解码端同口径）")
            return
        }
        var off = 0
        while (off < data.size) {
            val n = minOf(MAX_WS_CHUNK_BYTES, data.size - off)
            val chunk = data.copyOfRange(off, off + n)
            queuedBytes.addAndGet(n.toLong())
            sendBinary(a.peerId, chunk)
            off += n
        }
    }

    /** 编码器线程异常（中途死亡）：停流并回 error，对端清 UI */
    private fun onEncoderFailed(e: Exception) {
        Log.w(TAG, "编码器异常，停止反向投屏: ${e.javaClass.simpleName}: ${e.message}")
        val a = active
        stopInternal("编码器异常", notifyPeer = false)
        if (a != null) sendError(a.peerId, "编码器异常：${e.message}")
        listener?.onError("编码器异常：${e.message}")
    }

    // ---------- MediaCodec 编码器（优先） ----------

    private inner class MediaCodecEncoder(
        private val projection: MediaProjection,
        private val width: Int,
        private val height: Int,
        private var bitrateBps: Int,
        private val sink: (ByteArray, Boolean) -> Unit
    ) : EncoderHandle {
        override val name: String = "mediacodec"

        private val codec: MediaCodec
        private val inputSurface: android.view.Surface
        private val virtualDisplay: android.hardware.display.VirtualDisplay
        private val stopped = AtomicBoolean(false)
        private val drainThread: Thread

        /** SPS/PPS（csd-0/csd-1，裸 NAL），关键帧前补发 */
        @Volatile
        private var csd: ByteArray? = null

        init {
            val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
                setInteger(
                    MediaFormat.KEY_COLOR_FORMAT,
                    MediaCodecInfo.CodecCapabilities.COLOR_FormatSurface
                )
                setInteger(MediaFormat.KEY_BIT_RATE, bitrateBps)
                setInteger(MediaFormat.KEY_FRAME_RATE, STREAM_FPS)
                setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, KEYFRAME_INTERVAL_S)
                setInteger(
                    MediaFormat.KEY_BITRATE_MODE,
                    MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_CBR
                )
            }
            codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            inputSurface = codec.createInputSurface()
            codec.start()
            val dpi = appContext.resources.displayMetrics.densityDpi
            virtualDisplay = projection.createVirtualDisplay(
                "LinkSpaceReverse",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                inputSurface,
                null,
                null
            )
            drainThread = Thread({ drainLoop() }, "linkspace-reverse-encode").apply {
                isDaemon = true
                start()
            }
        }

        override fun setBitrate(bps: Int) {
            bitrateBps = bps
            try {
                codec.setParameters(Bundle().apply {
                    putInt(MediaCodec.PARAMETER_KEY_VIDEO_BITRATE, bps)
                })
            } catch (e: Exception) {
                Log.w(TAG, "MediaCodec 改码率失败: ${e.message}")
            }
        }

        override fun stop() {
            if (!stopped.compareAndSet(false, true)) return
            runCatching { virtualDisplay.release() }
            runCatching { codec.stop() }
            runCatching { codec.release() }
            runCatching { inputSurface.release() }
            // stop() 可能从 drain 线程自己的异常路径调入，join 自己会死锁
            if (Thread.currentThread() !== drainThread) {
                runCatching { drainThread.join(1000) }
            }
        }

        private fun drainLoop() {
            val info = MediaCodec.BufferInfo()
            try {
                while (!stopped.get()) {
                    val idx = codec.dequeueOutputBuffer(info, 10_000)
                    if (idx == MediaCodec.INFO_TRY_AGAIN_LATER) continue
                    if (idx == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                        captureCsd()
                        continue
                    }
                    if (idx < 0) continue
                    val buf = codec.getOutputBuffer(idx)
                    if (buf == null) {
                        codec.releaseOutputBuffer(idx, false)
                        continue
                    }
                    val isConfig = (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG) != 0
                    val isKey = (info.flags and MediaCodec.BUFFER_FLAG_KEY_FRAME) != 0
                    val bytes = ByteArray(info.size)
                    val dup = buf.duplicate()
                    dup.position(info.offset)
                    dup.limit(info.offset + info.size)
                    dup.get(bytes)
                    codec.releaseOutputBuffer(idx, false)
                    if (isConfig) {
                        // 编码器配置数据（SPS/PPS）不直接发，存下来补在关键帧前
                        //（与 csd-0/csd-1 同源，见 captureCsd）
                        csd = normalizeNals(bytes)
                        continue
                    }
                    if (bytes.isEmpty()) continue
                    val annexB = normalizeNals(bytes)
                    if (isKey && csd != null) {
                        val withCsd = ByteArray(csd!!.size + annexB.size)
                        System.arraycopy(csd!!, 0, withCsd, 0, csd!!.size)
                        System.arraycopy(annexB, 0, withCsd, csd!!.size, annexB.size)
                        sink(withCsd, true)
                    } else {
                        sink(annexB, isKey)
                    }
                }
            } catch (e: Exception) {
                if (!stopped.get()) onEncoderFailed(e)
            }
        }

        private fun captureCsd() {
            try {
                val fmt = codec.outputFormat
                val sps = fmt.getByteBuffer("csd-0")?.duplicate()?.toByteArray()
                val pps = fmt.getByteBuffer("csd-1")?.duplicate()?.toByteArray()
                if (sps != null && pps != null) {
                    val out = ByteArrayOutputStream()
                    out.write(START_CODE)
                    out.write(sps)
                    out.write(START_CODE)
                    out.write(pps)
                    csd = out.toByteArray()
                }
            } catch (e: Exception) {
                Log.w(TAG, "读取编码器 csd 失败: ${e.message}")
            }
        }
    }

    // ---------- JavaCV/libx264 软编（回落） ----------

    private inner class SoftwareEncoder(
        private val projection: MediaProjection,
        private val width: Int,
        private val height: Int,
        private var bitrateBps: Int,
        private val sink: (ByteArray, Boolean) -> Unit
    ) : EncoderHandle {
        override val name: String = "ffmpeg-soft"

        private val stopped = AtomicBoolean(false)
        private val recorderLock = Any()
        private val imgThread = HandlerThread("linkspace-reverse-img").apply { start() }
        private val imageReader: ImageReader
        private val virtualDisplay: android.hardware.display.VirtualDisplay
        private val converter = AndroidFrameConverter()
        private var recorder: FFmpegFrameRecorder
        private var lastRecordMs = 0L

        init {
            imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
            val dpi = appContext.resources.displayMetrics.densityDpi
            virtualDisplay = projection.createVirtualDisplay(
                "LinkSpaceReverse",
                width,
                height,
                dpi,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
                imageReader.surface,
                null,
                null
            )
            imageReader.setOnImageAvailableListener({ reader ->
                if (stopped.get()) return@setOnImageAvailableListener
                val img = runCatching { reader.acquireLatestImage() }.getOrNull()
                    ?: return@setOnImageAvailableListener
                try {
                    // 30fps 节流：VirtualDisplay 按屏幕刷新率出图，
                    // 高于编码帧率只会白耗 CPU
                    val now = SystemClock.uptimeMillis()
                    if (now - lastRecordMs < 33) return@setOnImageAvailableListener
                    lastRecordMs = now
                    val bmp = imageToBitmap(img)
                    val frame = converter.convert(bmp) ?: return@setOnImageAvailableListener
                    // JavaCV Frame 时间戳是微秒；Image 时间戳是纳秒单调时钟
                    frame.timestamp = img.timestamp / 1000
                    synchronized(recorderLock) {
                        if (!stopped.get()) recorder.record(frame)
                    }
                } catch (e: Exception) {
                    Log.w(TAG, "软编帧处理失败: ${e.message}")
                } finally {
                    runCatching { img.close() }
                }
            }, Handler(imgThread.looper))
            recorder = newRecorder(bitrateBps)
        }

        override fun setBitrate(bps: Int) {
            bitrateBps = bps
            // FFmpegFrameRecorder 的码率只在 start() 时读入，改档需重启
            // recorder（新 SPS/PPS/IDR，解码器带内消化，与线 1 换档重启同款）。
            synchronized(recorderLock) {
                if (stopped.get()) return
                try {
                    runCatching { recorder.stop(); recorder.release() }
                    recorder = newRecorder(bps)
                } catch (e: Exception) {
                    onEncoderFailed(e)
                }
            }
        }

        override fun stop() {
            if (!stopped.compareAndSet(false, true)) return
            runCatching { imageReader.setOnImageAvailableListener(null, null) }
            runCatching { virtualDisplay.release() }
            runCatching { imageReader.close() }
            synchronized(recorderLock) {
                runCatching { recorder.stop(); recorder.release() }
            }
            runCatching { imgThread.quitSafely() }
        }

        private fun newRecorder(bps: Int): FFmpegFrameRecorder {
            val out = object : OutputStream() {
                private val buf = ByteArrayOutputStream()
                override fun write(b: Int) {
                    buf.write(b)
                }

                override fun write(b: ByteArray, off: Int, len: Int) {
                    buf.write(b, off, len)
                    if (buf.size() >= MAX_WS_CHUNK_BYTES) flushBuffer()
                }

                override fun flush() = flushBuffer()

                private fun flushBuffer() {
                    if (buf.size() == 0) return
                    val bytes = buf.toByteArray()
                    buf.reset()
                    // 关键帧判定：本单元含 SPS 即视为关键帧边界（SPS 总在
                    // IDR 之前，见 StreamDecoder 的 dropToLastKeyframe 同款扫描）
                    sink(bytes, containsSps(bytes))
                }
            }
            return FFmpegFrameRecorder(out, width, height).apply {
                videoCodec = avcodec.AV_CODEC_ID_H264
                format = "h264"
                frameRate = STREAM_FPS.toDouble()
                videoBitrate = bps
                setVideoOption("preset", "ultrafast")
                setVideoOption("tune", "zerolatency")
                pixelFormat = avutil.AV_PIX_FMT_YUV420P
                gopSize = KEYFRAME_INTERVAL_S * STREAM_FPS
                start()
            }
        }

        private fun imageToBitmap(img: android.media.Image): Bitmap {
            val plane = img.planes[0]
            val w = img.width
            val h = img.height
            val bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888)
            val rowStride = plane.rowStride
            if (rowStride == w * 4) {
                bmp.copyPixelsFromBuffer(plane.buffer)
            } else {
                // 行距不等于宽×4 时逐行搬（bulk 拷贝，不逐像素 JNI）
                val tmp = ByteBuffer.allocateDirect(w * h * 4)
                val dup = plane.buffer.duplicate()
                val row = ByteArray(w * 4)
                for (y in 0 until h) {
                    dup.position(y * rowStride)
                    dup.get(row, 0, w * 4)
                    tmp.put(row, 0, w * 4)
                }
                tmp.flip()
                bmp.copyPixelsFromBuffer(tmp)
            }
            return bmp
        }
    }

    companion object {
        private const val TAG = "LinkSpace/ReverseStream"

        /**
         * 挂起的反向投屏请求多久无人处理即自动拒绝。这里必须覆盖两次
         * 用户确认：LinkSpace 同意框 + 系统 MediaProjection 授权框。真机
         * 实测 30s 会把“用户正在点系统框”的合法请求提前判为 expired。
         */
        const val REQUEST_TTL_MS = 90_000L

        const val DEFAULT_SCALE_WIDTH = 1920
        const val STREAM_FPS = 30

        /** GOP 30（1s 一个 IDR，丢帧后 1s 内自愈，与线 1 的 -g 30 一致） */
        const val KEYFRAME_INTERVAL_S = 1

        /** 单个 WS 二进制帧上限（桌面 ws 库单 Buffer 不分片、单帧 ≤64KB，见 LinkSpaceClient 注释） */
        const val MAX_WS_CHUNK_BYTES = 64 * 1024

        /** 发送积压上限：超过即丢到最近关键帧（与 StreamDecoder BACKLOG_CAP 同值） */
        const val BACKLOG_CAP_BYTES = 3L * 1024 * 1024

        /** 码率自适应采样阈值（桌面端 host.ts backlogProbe 同值） */
        const val CONGESTION_BYTES = 1_000_000L
        const val IDLE_BYTES = 100_000L
        const val PROBE_INTERVAL_MS = 2000L

        private val START_CODE = byteArrayOf(0, 0, 0, 1)

        /** 分辨率档位（协议 4.7，与 protocol.json streamQualityPresets 同值） */
        val STREAM_PRESETS = listOf(
            StreamPreset("720p", 1280, 30, 4_000_000),
            StreamPreset("1080p", 1920, 30, 8_000_000),
            StreamPreset("1440p", 2560, 30, 14_000_000),
            StreamPreset("2160p", 3840, 30, 24_000_000)
        )

        /** 码率档位（协议 4.7，与 protocol.json streamTiers 同值） */
        val STREAM_TIERS = listOf(
            StreamTier("t0-uncapped", null),
            StreamTier("t1-6M", 6_000_000),
            StreamTier("t2-3M", 3_000_000),
            StreamTier("t3-1.5M", 1_500_000)
        )

        /**
         * 把编码器输出归一化成 Annex-B：
         * 已带起始码（00 00 00 01 或 00 00 01）原样返回；否则按 4 字节
         * 大端长度前缀（AVCC）逐个 NAL 重写起始码。MediaCodec 在不同
         * ROM 上的形态未经本机验证，两种都兜住。
         */
        fun normalizeNals(bytes: ByteArray): ByteArray {
            if (bytes.size >= 4 &&
                bytes[0] == 0.toByte() && bytes[1] == 0.toByte() &&
                bytes[2] == 0.toByte() && bytes[3] == 1.toByte()
            ) return bytes
            if (bytes.size >= 3 &&
                bytes[0] == 0.toByte() && bytes[1] == 0.toByte() && bytes[2] == 1.toByte()
            ) return bytes
            val out = ByteArrayOutputStream(bytes.size + 16)
            var off = 0
            while (off + 4 <= bytes.size) {
                val len = ((bytes[off].toInt() and 0xff) shl 24) or
                    ((bytes[off + 1].toInt() and 0xff) shl 16) or
                    ((bytes[off + 2].toInt() and 0xff) shl 8) or
                    (bytes[off + 3].toInt() and 0xff)
                if (len <= 0 || off + 4 + len > bytes.size) break
                out.write(START_CODE)
                out.write(bytes, off + 4, len)
                off += 4 + len
            }
            return if (out.size() > 0) out.toByteArray() else bytes
        }

        /** 字节流里是否含 SPS NAL（关键帧边界判定） */
        fun containsSps(bytes: ByteArray): Boolean {
            var i = 0
            while (i + 4 < bytes.size) {
                if (bytes[i] == 0.toByte() && bytes[i + 1] == 0.toByte() &&
                    bytes[i + 2] == 0.toByte() && bytes[i + 3] == 1.toByte()
                ) {
                    if ((bytes[i + 4].toInt() and 0x1f) == 7) return true
                    i += 5
                } else {
                    i++
                }
            }
            return false
        }
    }
}

/** ByteBuffer 内容拷成 ByteArray（不改动原 buffer 的 position） */
private fun ByteBuffer.toByteArray(): ByteArray {
    val dup = duplicate()
    val bytes = ByteArray(dup.remaining())
    dup.get(bytes)
    return bytes
}
