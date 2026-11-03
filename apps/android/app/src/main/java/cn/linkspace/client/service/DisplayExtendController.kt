package cn.linkspace.client.service

import android.util.Log
import org.json.JSONObject

/**
 * 平板当扩展屏的控制端状态机（协议 4.3，sessionType: 'display-extend'）。
 *
 * 与 [InputController] 同一语义：
 *   request → 对端（桌面）用户确认（session.accept / reject）→ 扩展画面 → stop
 * 会话是点对点的：accept/reject/stop 的来源必须与请求的对端一致，
 * 旁观连接的会话消息一律忽略。
 *
 * 时序与桌面端对齐：被控端请求 TTL 30s，本端等待 32s（略长，让对方先表态）。
 *
 * 与 input 会话解耦：扩展屏会话与键鼠会话各占一个独立槽位，互不感知——
 * 无活动 input 会话也能开扩展屏；input 会话结束不终止扩展屏；扩展屏
 * 结束也不动 input 会话。accept 里带回的 virtualScreen（虚拟显示器
 * 在虚拟屏坐标系里的矩形）是触控映射与推流尺寸的基准。
 */
class DisplayExtendController(
    private val send: (peerId: String, type: String, payload: JSONObject.() -> Unit) -> Unit,
    private val listener: Listener? = null
) {

    interface Listener {
        /** 会话建立，可以请求虚拟显示器画面流 */
        fun onSessionActive(peerId: String, sessionId: String, virtualScreen: VirtualScreen)
        /** 会话结束（对端终止 / 对端拒绝 / 断连 / 本端退出） */
        fun onSessionEnded(reason: String)
        /** 请求还在等对端确认（UI 展示等待态） */
        fun onWaiting(peerId: String)
    }

    /** 虚拟显示器在虚拟屏坐标系里的矩形（x/y 可为负，w/h ≥ 1） */
    data class VirtualScreen(val x: Int, val y: Int, val w: Int, val h: Int)

    /** 平板希望的虚拟显示器尺寸；null = 由桌面按 INF 预置模式选 */
    data class PreferredSize(val width: Int, val height: Int)

    private class PendingRequest(val peerId: String, val expiresAt: Long)

    private var active: Active? = null
    private var pending: PendingRequest? = null

    private class Active(val peerId: String, val sessionId: String, val virtualScreen: VirtualScreen)

    /** 当前是否在扩展中 */
    val extending: Boolean get() = active != null

    /** 正在扩展到谁，未扩展时为 null */
    val extendingTo: String? get() = active?.peerId

    /** 活动会话的虚拟显示器矩形，未建立时为 null */
    val virtualScreen: VirtualScreen? get() = active?.virtualScreen

    /** 活动会话 id，未建立时为 null */
    val activeSessionId: String? get() = active?.sessionId

    /**
     * 请求把对端用作扩展屏。结果经 onSessionActive / onSessionEnded 回调。
     * 已有挂起或活动扩展会话时直接拒绝本次请求。
     */
    @Synchronized
    fun request(peerId: String, preferred: PreferredSize?, scaleWidth: Int, displayName: String) {
        val held = pending
        if (held != null && System.currentTimeMillis() > held.expiresAt) {
            pending = null
            Log.i(TAG, "挂起的扩展屏请求已过期，自动清理")
        }
        if (active != null || pending != null) {
            listener?.onSessionEnded("已有扩展屏会话进行中")
            return
        }
        val sessionId = java.util.UUID.randomUUID().toString()
        pending = PendingRequest(peerId, System.currentTimeMillis() + 32_000)
        listener?.onWaiting(peerId)
        send(peerId, Protocol.TYPE_SESSION_START) {
            put("sessionId", sessionId)
            put("sessionType", Protocol.SESSION_TYPE_DISPLAY_EXTEND)
            put("params", JSONObject().apply {
                if (preferred != null) {
                    put("width", preferred.width)
                    put("height", preferred.height)
                }
                put("scaleWidth", scaleWidth)
                put("displayName", displayName)
            })
        }
        Log.i(TAG, "已向 $peerId 发起扩展屏请求 $sessionId")
    }

    @Synchronized
    fun onAccepted(peerId: String, payload: JSONObject) {
        val p = pending ?: return
        if (p.peerId != peerId) return
        pending = null
        val sessionId = payload.optString("sessionId")
        if (!Regex(Protocol.SESSION_ID_RE).matches(sessionId)) {
            Log.w(TAG, "对端 accept 携带非法 sessionId，忽略")
            return
        }
        val vsObj = payload.optJSONObject("virtualScreen")
        val virtualScreen = vsObj?.let {
            val x = it.optInt("x", Int.MIN_VALUE)
            val y = it.optInt("y", Int.MIN_VALUE)
            val w = it.optInt("w", -1)
            val h = it.optInt("h", -1)
            // x/y 可为负（虚拟屏相对坐标），w/h 须 ≥ 1（与桌面端
            // decodeVirtualScreen 同口径）
            if (x == Int.MIN_VALUE || y == Int.MIN_VALUE || w < 1 || h < 1 ||
                w > Protocol.MAX_COORD || h > Protocol.MAX_COORD
            ) {
                null
            } else {
                VirtualScreen(x, y, w, h)
            }
        }
        if (virtualScreen == null) {
            Log.w(TAG, "对端 accept 缺少合法 virtualScreen，忽略")
            listener?.onSessionEnded("对端 accept 缺少虚拟显示器尺寸")
            return
        }
        active = Active(peerId, sessionId, virtualScreen)
        Log.i(TAG, "扩展屏会话已建立：$sessionId（虚拟屏 ${virtualScreen.w}x${virtualScreen.h} @ ${virtualScreen.x},${virtualScreen.y}）")
        listener?.onSessionActive(peerId, sessionId, virtualScreen)
    }

    @Synchronized
    fun onRejected(peerId: String, payload: JSONObject) {
        val p = pending ?: return
        if (p.peerId != peerId) return
        pending = null
        val reason = payload.optString("reason", "对端拒绝")
        Log.i(TAG, "扩展屏请求被拒绝: $reason")
        listener?.onSessionEnded("对端拒绝了请求（$reason）")
    }

    /** 被控端随时可以收回扩展屏 */
    @Synchronized
    fun onStopped(peerId: String, payload: JSONObject) {
        val a = active ?: return
        if (a.peerId != peerId || payload.optString("sessionId") != a.sessionId) return
        active = null
        Log.i(TAG, "被控端结束了扩展屏会话")
        listener?.onSessionEnded("被控端结束了扩展屏")
    }

    /** 对端断连：等待中的请求与活动会话都立即终止并通知界面 */
    @Synchronized
    fun onPeerDisconnected(peerId: String) {
        val p = pending
        if (p != null && p.peerId == peerId) {
            pending = null
            listener?.onSessionEnded("被控端连接已断开，请求已失效")
            return
        }
        val a = active
        if (a != null && a.peerId == peerId) {
            active = null
            listener?.onSessionEnded("被控端连接已断开")
        }
    }

    /** 本端主动退出或取消等待中的请求。幂等 */
    @Synchronized
    fun stop(reason: String = "stopped by user") {
        val hadPending = pending != null
        pending = null
        val a = active ?: run {
            if (hadPending) listener?.onSessionEnded("已取消请求")
            return
        }
        active = null
        send(a.peerId, Protocol.TYPE_SESSION_STOP) {
            put("sessionId", a.sessionId)
            put("reason", reason)
        }
        Log.i(TAG, "已结束扩展屏会话")
        listener?.onSessionEnded("已结束扩展屏")
    }

    companion object {
        private const val TAG = "LinkSpace/Extend"
    }
}
