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
            ACTION_CLIPBOARD -> setClipboard(context, service, intent.getBooleanExtra("on", true))
        }
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
}
