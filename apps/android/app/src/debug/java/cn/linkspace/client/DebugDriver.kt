package cn.linkspace.client

import android.content.Context
import android.content.Intent
import cn.linkspace.client.service.ClipboardSync
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.OutgoingFile
import cn.linkspace.client.service.TransferTask
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File

/**
 * 走查驱动的共享实现：由 [DebugEntryActivity]（am start，不受广播投递
 * 管控影响）与 [DebugControlReceiver]（广播，部分 ROM 会延迟投递）共用。
 *
 * 动机：本机（ZUI）安全门屏蔽了 adb 的触摸注入（input tap/swipe 静默
 * 无效），自动走查无法用手指驱动触控板；而 shell 通道（am start /
 * am broadcast）可以直达应用。用它驱动 [LinkSpaceService]，把「会话
 * 生命周期 + 事件编解码 + 文件双向传输」在线路上端到端验证掉。
 * 唯一未覆盖的是「真实手指 → MotionEvent → pointerInput 映射」与
 * SAF 选文件的界面交互，那层是平台标准 API，留给人工走查。
 */
object DebugDriver {

    const val ACTION_REQUEST_INPUT = "cn.linkspace.client.DEBUG_REQUEST_INPUT"
    const val ACTION_SEND_EVENTS = "cn.linkspace.client.DEBUG_SEND_EVENTS"
    const val ACTION_STOP_INPUT = "cn.linkspace.client.DEBUG_STOP_INPUT"
    const val ACTION_SEND_FILE = "cn.linkspace.client.DEBUG_SEND_FILE"
    const val ACTION_AUTO_ACCEPT = "cn.linkspace.client.DEBUG_AUTO_ACCEPT"
    const val ACTION_CLIPBOARD = "cn.linkspace.client.DEBUG_CLIPBOARD"
    const val ACTION_REQUEST_CONTROL = "cn.linkspace.client.DEBUG_REQUEST_CONTROL"
    const val ACTION_SCREEN_STREAM = "cn.linkspace.client.DEBUG_SCREEN_STREAM"
    const val ACTION_SCREEN_PASTE = "cn.linkspace.client.DEBUG_SCREEN_PASTE"
    const val ACTION_DECODE_FILE = "cn.linkspace.client.DEBUG_DECODE_FILE"

    /** null = 未启动。注意 Job() 工厂创建的是「活跃」Job，不能拿它当「未启动」哨兵 */
    private var autoAcceptJob: Job? = null

    fun handle(context: Context, intent: Intent) {
        android.util.Log.i("LinkSpace/Debug", "driver: enter action=${intent.action}")
        val service = LinkSpaceService.get(context)
        android.util.Log.i("LinkSpace/Debug", "driver: service ok")
        val metrics = context.resources.displayMetrics
        val screen = InputController.Screen(
            metrics.widthPixels.coerceAtLeast(1),
            metrics.heightPixels.coerceAtLeast(1)
        )
        when (intent.action) {
            ACTION_REQUEST_INPUT -> {
                val prefix = intent.getStringExtra("prefix") ?: return
                val peerId = service.fullPeerIdOf(prefix)
                log("对 $peerId 发起控制请求（屏幕 ${screen.w}x${screen.h}）")
                service.input.request(peerId, screen, "Debug-B")
            }
            ACTION_SEND_EVENTS -> sendEvents(service, intent.getStringExtra("kind") ?: "move")
            ACTION_STOP_INPUT -> {
                service.input.stop("debug walkthrough stop")
                log("已请求结束会话")
            }
            ACTION_SEND_FILE -> sendFile(service, intent)
            ACTION_AUTO_ACCEPT -> setAutoAccept(service, intent.getBooleanExtra("on", true))
            ACTION_CLIPBOARD -> handleClipboard(context, service, intent)
            ACTION_REQUEST_CONTROL -> requestControl(context, service)
            ACTION_SCREEN_STREAM -> {
                val display = intent.getIntExtra("display", -1)
                service.requestScreenStream(display)
                log("已发起投屏请求（display=$display）")
            }
            ACTION_DECODE_FILE -> decodeFile(context, intent.getStringExtra("path") ?: "/sdcard/linkspace-test.h264")
            ACTION_SCREEN_PASTE -> {
                val text = intent.getStringExtra("text") ?: return
                service.sendScreenPaste(text)
                log("screen.paste 已提交（${'$'}{text.length} 字符）")
            }
        }
    }

    /**
     * 发起键鼠控制（与 MainActivity 的 debug 接收器同一逻辑，走 am start
     * 确定性通道）。依赖发现列表里有 paired 条目——桌面端必须在线通告。
     */
    private fun requestControl(context: Context, service: LinkSpaceService) {
        // 发现列表受 NSD 再上报节奏影响会闪空（见 Discovery.STALE_MS 注释），
        // 轮询等它出现而不是一枪毙命
        var peer: DiscoveredService? = null
        for (i in 0 until 25) {
            peer = service.discovered.value.firstOrNull { it.paired }
            if (peer != null) break
            Thread.sleep(3000)
        }
        peer ?: run {
            log("75s 内未发现已配对条目")
            return
        }
        val metrics = context.resources.displayMetrics
        CoroutineScope(Dispatchers.IO).launch {
            service.requestInputControl(
                peer = peer,
                screen = InputController.Screen(
                    metrics.widthPixels.coerceAtLeast(1),
                    metrics.heightPixels.coerceAtLeast(1)
                ),
                displayName = service.selfName.value
            ).onSuccess { log("控制会话已建立") }
                .onFailure { log("发起控制失败: ${it.message}") }
        }
    }

    /**
     * 剪贴板走查驱动。语义按 extras 组合：
     *   --ez on true/false   开关同步（开关持久化）
     *   --es text "..."      把该文本写入系统剪贴板并立刻 poll——
     *                        poll 读到与基线不同的新内容就会经同步通道
     *                        发给持有 clipboard 授权的对端（发送向验证）。
     *                        直接写系统剪贴板而不走 ClipboardSync.receive，
     *                        避免更新基线把发送抑制掉。
     */
    private fun handleClipboard(context: Context, service: LinkSpaceService, intent: Intent) {
        val text = intent.getStringExtra("text")
        if (text != null) {
            // 只写不读：Android 10+ 只有获焦窗口能读剪贴板，NoDisplay 的
            // 本 Activity 读不到（实测读到空）。写完后由 MainActivity 的
            // OnPrimaryClipChangedListener 自然触发 poll——它在焦点上，
            // 且其同步实例的基线还是旧内容，新内容会被当成变更正常发送
            runCatching {
                val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
                    as? android.content.ClipboardManager
                cm?.setPrimaryClip(android.content.ClipData.newPlainText("LinkSpace", text))
                log("已写入系统剪贴板（${text.length} 字符），等待界面监听器触发发送")
            }
            return
        }
        setClipboard(context, service, intent.getBooleanExtra("on", true))
    }

    /**
     * 开/关剪贴板同步（走查第 7 组用）。驱动器自带 io：Android 10 起
     * 后台读不到剪贴板，但走查时 MainActivity 就在前台，读得到。
     */
    private fun setClipboard(context: Context, service: LinkSpaceService, on: Boolean) {
        service.setClipboardSyncEnabled(on)
        if (on) {
            val handler = android.os.Handler(android.os.Looper.getMainLooper())
            service.enableClipboardSync(object : ClipboardSync.ClipboardIo {
                override fun readText(): String =
                    // 基线读取发生在 start() 的调用线程（驱动器在主线程调用），
                    // 前台下直接读是允许的
                    runCatching {
                        val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
                            as? android.content.ClipboardManager
                        cm?.primaryClip?.getItemAt(0)?.coerceToText(context)?.toString() ?: ""
                    }.getOrDefault("")

                override fun writeText(text: String) {
                    handler.post {
                        runCatching {
                            val cm = context.getSystemService(Context.CLIPBOARD_SERVICE)
                                as? android.content.ClipboardManager
                            cm?.setPrimaryClip(android.content.ClipData.newPlainText("LinkSpace", text))
                        }
                    }
                }
            })
            log("剪贴板同步已开启（调试 io）")
        } else {
            log("剪贴板同步已关闭")
        }
    }

    private fun setAutoAccept(service: LinkSpaceService, on: Boolean) {
        android.util.Log.i("LinkSpace/Debug", "driver: setAutoAccept on=$on active=${autoAcceptJob?.isActive}")
        if (on && autoAcceptJob?.isActive != true) {
            // 观察传输任务流，出现待确认的接收任务就代用户点「接收」。
            // 编排完全在 debug 代码侧，生产代码不背任何调试开关
            autoAcceptJob = CoroutineScope(Dispatchers.IO).launch {
                service.transfers.collect { list ->
                    list.filter { it.direction == "receive" && it.state == TransferTask.OFFERED }
                        .forEach { t ->
                            val r = service.acceptTransfer(t.id)
                            log("自动接受 ${t.id}: ${r.isSuccess} ${r.exceptionOrNull()?.message ?: ""}")
                        }
                }
            }
            log("自动接受已开启")
        } else if (!on) {
            autoAcceptJob?.cancel()
            autoAcceptJob = null
            log("自动接受已关闭")
        }
    }

    private fun sendFile(service: LinkSpaceService, intent: Intent) {
        val prefix = intent.getStringExtra("prefix") ?: return
        val host = intent.getStringExtra("host") ?: return
        val port = intent.getIntExtra("port", 0)
        val path = intent.getStringExtra("path") ?: return
        val file = File(path)
        log("SEND_FILE $path exists=${file.exists()} length=${file.length()}")
        if (!file.exists()) return
        val peer = DiscoveredService(
            serviceName = "debug-send",
            displayName = "B-Walkthrough",
            idPrefix = prefix,
            deviceType = "win",
            caps = listOf("file"),
            host = host,
            port = port,
            paired = true
        )
        CoroutineScope(Dispatchers.IO).launch {
            val result = service.sendFiles(
                peer,
                listOf(OutgoingFile(file.name, file.length()) { file.inputStream() })
            )
            result.onSuccess { log("发送完成 $it 个文件") }
                .onFailure { log("发送失败: ${it.message}") }
        }
    }

    /** 按 kind 构造一组固定事件，覆盖 move/click/wheel/key 四类形状 */
    private fun sendEvents(service: LinkSpaceService, kind: String) {
        val events: List<JSONObject> = when (kind) {
            "move" -> listOf(
                InputController.move(100, 100),
                InputController.move(400, 300),
                InputController.move(800, 600)
            )
            "click" -> listOf(
                InputController.down("left"),
                InputController.up("left")
            )
            "wheel" -> listOf(
                InputController.wheel(0, 1),
                InputController.wheel(0, 1),
                InputController.wheel(0, -1)
            )
            "key" -> InputController.tap(0x48) + InputController.tap(0x49) // h, i
            else -> return
        }
        // sendEvents 单条消息上限 64，这里每批远小于上限
        service.input.sendEvents(events)
        log("已发送 ${events.size} 条 $kind 事件")
    }

    private fun log(msg: String) {
        android.util.Log.i("LinkSpace/Debug", msg)
    }

    /**
     * 绿块定性实验（2026-10-31）：无 Surface（ByteBuffer 输出）解码指定
     * h264 文件，把第 N 帧落成 PNG。若字节流模式解码出干净帧 → 损坏在
     * 渲染/合成路径；若同样花 → 输入组装问题。与在线链路完全无关。
     */
    private fun decodeFile(context: Context, path: String) {
        CoroutineScope(Dispatchers.IO).launch {
            try {
                val file = File(path)
                if (!file.exists()) {
                    log("decodeFile: 文件不存在 $path")
                    return@launch
                }
                val bytes = file.readBytes()
                log("decodeFile: ${bytes.size} 字节")
                val format = android.media.MediaFormat.createVideoFormat(
                    android.media.MediaFormat.MIMETYPE_VIDEO_AVC, 1920, 1080
                )
                val codec = android.media.MediaCodec.createByCodecName("c2.android.avc.decoder")
                codec.configure(format, null, null, 0)
                codec.start()
                var queued = 0
                var decoded = 0
                val info = android.media.MediaCodec.BufferInfo()
                var off = 0
                var eos = false
                while (!eos && decoded < 30) {
                    val inIdx = codec.dequeueInputBuffer(10_000)
                    if (inIdx >= 0 && off < bytes.size) {
                        val ib = codec.getInputBuffer(inIdx)!!
                        ib.clear()
                        val n = minOf(64 * 1024, bytes.size - off)
                        ib.put(bytes, off, n)
                        codec.queueInputBuffer(inIdx, 0, n, off.toLong(), 0)
                        off += n
                        queued++
                    } else if (inIdx >= 0 && off >= bytes.size && !eos) {
                        codec.queueInputBuffer(inIdx, 0, 0, 0L, android.media.MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        eos = true
                    }
                    var outIdx = codec.dequeueOutputBuffer(info, 10_000)
                    while (outIdx >= 0) {
                        decoded++
                        val img = codec.getOutputImage(outIdx)!!
                        if (decoded == 5) {
                            saveYuvAsPng(context, img, info)
                        }
                        codec.releaseOutputBuffer(outIdx, false)
                        img.close()
                        outIdx = codec.dequeueOutputBuffer(info, 0)
                    }
                }
                log("decodeFile 完成: 入队 $queued 块, 解出 $decoded 帧")
                codec.stop()
                codec.release()
            } catch (t: Throwable) {
                log("decodeFile 失败: ${t.javaClass.simpleName}: ${t.message}")
            }
        }
    }

    /** YUV_420_888 → PNG（仅取 Y 平面当灰度，够定性花屏位置） */
    private fun saveYuvAsPng(context: Context, img: android.media.Image, info: android.media.MediaCodec.BufferInfo) {
        val w = img.width
        val h = img.height
        val yPlane = img.planes[0]
        val buf = yPlane.buffer
        val rowStride = yPlane.rowStride
        val pixels = IntArray(w * h)
        for (y in 0 until h) {
            for (x in 0 until w) {
                val v = buf.get(y * rowStride + x).toInt() and 0xff
                pixels[y * w + x] = 0xff000000.toInt() or (v shl 16) or (v shl 8) or v
            }
        }
        val bmp = android.graphics.Bitmap.createBitmap(pixels, w, h, android.graphics.Bitmap.Config.ARGB_8888)
        val out = File(context.getExternalFilesDir(null), "decode-frame.png")
        out.outputStream().use { bmp.compress(android.graphics.Bitmap.CompressFormat.PNG, 100, it) }
        bmp.recycle()
        log("decodeFile: 帧${info.offset} 已存 ${out.absolutePath} (${w}x${h} stride=$rowStride)")
    }
}
