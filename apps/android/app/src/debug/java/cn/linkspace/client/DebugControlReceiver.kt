package cn.linkspace.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService
import org.json.JSONObject

/**
 * 仅 debug 构建的走查驱动入口（src/debug 源集，不进 release）。
 *
 * 动机：本机（ZUI）安全门屏蔽了 adb 的触摸注入（input tap/swipe 静默
 * 无效），自动走查无法用手指驱动触控板。shell 命令通道（am broadcast）
 * 不受影响，于是用它直接驱动 [LinkSpaceService.input]，把「会话生命周期
 * + 事件编解码 + 线路互通」端到端验证掉。唯一未覆盖的是「真实手指 →
 * MotionEvent → pointerInput 映射」，那层是 Compose 标准输入 API，
 * 风险最低，留给人工走查。
 *
 * 用法（adb）：
 *   am broadcast -n cn.linkspace.client/.DebugControlReceiver \
 *     -a cn.linkspace.client.DEBUG_REQUEST_INPUT --es prefix dev_xxxxxxxxxxxx
 *   am broadcast ... -a cn.linkspace.client.DEBUG_SEND_EVENTS --es kind move|click|wheel|key
 *   am broadcast ... -a cn.linkspace.client.DEBUG_STOP_INPUT
 */
class DebugControlReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val service = LinkSpaceService.get(context)
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

    companion object {
        const val ACTION_REQUEST_INPUT = "cn.linkspace.client.DEBUG_REQUEST_INPUT"
        const val ACTION_SEND_EVENTS = "cn.linkspace.client.DEBUG_SEND_EVENTS"
        const val ACTION_STOP_INPUT = "cn.linkspace.client.DEBUG_STOP_INPUT"
    }
}
