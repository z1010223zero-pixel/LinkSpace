package cn.linkspace.client.service

import android.util.Log
import org.json.JSONArray
import org.json.JSONObject

/**
 * 键鼠共享的控制端状态机（协议 4.6）。Android 作控制端，桌面作被控端。
 *
 * 与桌面端 `input/session.ts` 的 InputController 同一语义：
 *   request → 对端用户确认（session.accept / reject）→ 事件流 → stop
 * 会话是点对点的：accept/reject/stop 的来源必须与请求的对端一致，
 * 旁观连接的会话消息一律忽略。
 *
 * 时序与桌面端对齐：被控端请求 TTL 30s，本端等待 32s（略长，让对方先表态）。
 */
class InputController(
    private val send: (peerId: String, type: String, payload: JSONObject.() -> Unit) -> Unit,
    private val listener: Listener? = null
) {

    interface Listener {
        /** 会话建立，可以开始注入事件 */
        fun onSessionActive(peerId: String, sessionId: String, remoteScreen: Screen)
        /** 会话结束（对端终止 / 对端拒绝 / 断连 / 本端退出） */
        fun onSessionEnded(reason: String)
        /** 请求还在等对端确认（UI 展示等待态） */
        fun onWaiting(peerId: String)
    }

    /** 屏幕尺寸。w/h 为像素，事件坐标即按此空间上报 */
    data class Screen(val w: Int, val h: Int)

    private class PendingRequest(val peerId: String, val expiresAt: Long)

    private var active: Active? = null
    private var pending: PendingRequest? = null

    private class Active(val peerId: String, val sessionId: String, val remoteScreen: Screen)

    /** 本端在 session.start 里申报的屏幕（触控坐标空间基准），请求时记录 */
    @Volatile
    var declaredScreen: Screen? = null
        private set

    /** 当前是否在控制中 */
    val controlling: Boolean get() = active != null

    /** 正在控制的对端，未控制时为 null */
    val controllingPeer: String? get() = active?.peerId

    /**
     * 请求控制对端。结果经 onSessionActive / onSessionEnded 回调。
     * 已有挂起或活动会话时直接拒绝本次请求。
     */
    @Synchronized
    fun request(peerId: String, screen: Screen, displayName: String) {
        // 过期挂起先清再放行（T7 走查 Bug2）：expiresAt 从未被检查的话，
        // 一次未达的请求把 pending 永久占死，后续 request 全被静默拒绝，
        // 桌面端 TTL 超时回的 reject 是唯一出口——错过它就只能杀进程
        val held = pending
        if (held != null && System.currentTimeMillis() > held.expiresAt) {
            pending = null
            Log.i(TAG, "挂起的控制请求已过期，自动清理")
        }
        if (active != null || pending != null) {
            listener?.onSessionEnded("已有键鼠共享会话进行中")
            return
        }
        val sessionId = java.util.UUID.randomUUID().toString()
        declaredScreen = screen // 触控映射基准：本端申报的空间（桌面 mapPoint 的 from）
        pending = PendingRequest(peerId, System.currentTimeMillis() + 32_000)
        listener?.onWaiting(peerId)
        send(peerId, Protocol.TYPE_SESSION_START) {
            put("sessionId", sessionId)
            put("sessionType", "input")
            put("params", JSONObject().apply {
                put("screen", JSONObject().apply {
                    put("w", screen.w)
                    put("h", screen.h)
                })
                put("displayName", displayName)
            })
        }
        Log.i(TAG, "已向 $peerId 发起键鼠控制请求 $sessionId")
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
        val screenObj = payload.optJSONObject("screen")
        val screen = Screen(
            w = screenObj?.optInt("w", 1920)?.coerceIn(1, 32768) ?: 1920,
            h = screenObj?.optInt("h", 1080)?.coerceIn(1, 32768) ?: 1080
        )
        active = Active(peerId, sessionId, screen)
        Log.i(TAG, "键鼠控制会话已建立：$sessionId（对端屏幕 ${screen.w}x${screen.h}）")
        listener?.onSessionActive(peerId, sessionId, screen)
    }

    @Synchronized
    fun onRejected(peerId: String, payload: JSONObject) {
        val p = pending ?: return
        if (p.peerId != peerId) return
        pending = null
        val reason = payload.optString("reason", "对端拒绝")
        Log.i(TAG, "键鼠控制请求被拒绝: $reason")
        listener?.onSessionEnded("对端拒绝了请求（$reason）")
    }

    /** 被控端随时可以拔掉控制权 */
    @Synchronized
    fun onStopped(peerId: String, payload: JSONObject) {
        val a = active ?: return
        if (a.peerId != peerId || payload.optString("sessionId") != a.sessionId) return
        active = null
        Log.i(TAG, "被控端结束了控制会话")
        listener?.onSessionEnded("被控端结束了控制")
    }

    /** 对端断连：等待中的请求与活动会话都立即终止并通知界面 */
    @Synchronized
    fun onPeerDisconnected(peerId: String) {
        val p = pending
        if (p != null && p.peerId == peerId) {
            // 等待中的请求没有对端超时兜底（拒绝来自被控端），连接一断
            // 就永远不会有人回复——必须通知 UI 收掉等待态，否则对话框
            // 会一直挂着
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

    /**
     * 批量外发事件。会话未激活时安全空操作。
     * 单条消息最多 [Protocol.MAX_EVENTS_PER_MESSAGE] 条，超出部分丢弃——
     * 被控端对超限批次整批拒绝，多切几段没有意义。
     */
    @Synchronized
    fun sendEvents(events: List<JSONObject>) {
        val a = active ?: return
        if (events.isEmpty()) return
        send(a.peerId, Protocol.TYPE_INPUT_EVENT) {
            put("sessionId", a.sessionId)
            put("events", JSONArray(events.take(Protocol.MAX_EVENTS_PER_MESSAGE)))
        }
    }

    /** 本端主动退出或取消等待中的请求。幂等 */
    @Synchronized
    fun stop(reason: String = "stopped by user") {
        val hadPending = pending != null
        pending = null
        val a = active ?: run {
            // 取消等待中的请求也必须把 UI 拉回 idle（T7 真机走查发现）：
            // onSessionEnded 是界面收起「正在请求控制」对话框的唯一信号，
            // 这里静默 return 会让对话框永远关不掉，只能杀进程
            if (hadPending) listener?.onSessionEnded("已取消请求")
            return
        }
        active = null
        send(a.peerId, Protocol.TYPE_SESSION_STOP) {
            put("sessionId", a.sessionId)
            put("reason", reason)
        }
        Log.i(TAG, "已结束键鼠控制会话")
        listener?.onSessionEnded("已结束控制")
    }

    companion object {
        private const val TAG = "LinkSpace/Input"

        // ---------- 事件构造（形状与桌面端 input/protocol.ts 逐字段一致） ----------

        /** 控制端屏幕绝对坐标 move。坐标按本端在 session.start 里声明的屏幕空间 */
        fun move(x: Int, y: Int): JSONObject = JSONObject().apply {
            put("t", "move")
            put("x", x.coerceIn(0, Protocol.MAX_COORD))
            put("y", y.coerceIn(0, Protocol.MAX_COORD))
        }

        fun down(button: String): JSONObject = JSONObject().apply {
            put("t", "down")
            put("b", button)
        }

        fun up(button: String): JSONObject = JSONObject().apply {
            put("t", "up")
            put("b", button)
        }

        /** 滚轮刻度，与桌面端一样钳 ±1000 */
        fun wheel(dx: Int, dy: Int): JSONObject = JSONObject().apply {
            put("t", "wheel")
            put("dx", dx.coerceIn(-1000, 1000))
            put("dy", dy.coerceIn(-1000, 1000))
        }

        /** Windows 虚拟键码 0..255 + 按下态 */
        fun key(vk: Int, down: Boolean): JSONObject = JSONObject().apply {
            put("t", "key")
            put("vk", vk.coerceIn(0, 255))
            put("down", down)
        }

        /**
         * 一组「按键输入」事件：down + up 连发。修饰键由调用方先行处理。
         */
        fun tap(vk: Int): List<JSONObject> = listOf(key(vk, true), key(vk, false))
    }
}
