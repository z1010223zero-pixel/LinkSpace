package cn.linkspace.client.service

import android.util.Log
import org.json.JSONObject

/**
 * 键鼠共享的被控端状态机骨架（协议 4.6，线 2 W4）。
 *
 * 与桌面端 `input/session.ts` 的 InputSessionCoordinator 对称：别人请求
 * 来控制本机时的接待逻辑——授权门禁、30s 请求 TTL、用户确认、事件分发、
 * 随时可被掐断。桌面端是被控端实现，Android 端此前只有控制端
 * [InputController]（向桌面发起控制），没有任何被控分支。
 *
 * **骨架状态（W4 只做骨架，不做完整功能）：**
 * - pending/active 双态 + 30s 请求 TTL（与桌面端一致），过期自动拒绝；
 * - approve/deny：用户确认后才发 session.accept，拒绝发 session.reject；
 * - onEvent 会话匹配校验先行（peerId + sessionId 双核对），注入点留空桩。
 *
 * **未接线（明确 TODO，不可当作已实现）：**
 * - 未接 AccessibilityService：[onEvent] 收到合法事件后只记日志，不注入
 *   任何手势/按键（见该方法的 Log.w 与 TODO）；无障碍服务也未在
 *   AndroidManifest 里声明；
 * - 用户确认 UI 未接：[Listener.onControlRequested] 的默认实现在
 *   LinkSpaceService 里先记日志并回 session.reject（理由「确认 UI 未接」），
 *   绝不自动批准（安全红线，见协议 9.1「每次控制请求都有明确提示」）。
 *
 * control 授权语义与桌面端一致：会话级内存态，不进 TrustStore 持久化。
 */
class ControlledInputSession(
    private val isPeerAuthorized: (String) -> Boolean,
    private val localScreen: () -> InputController.Screen,
    private val send: (peerId: String, type: String, payload: JSONObject.() -> Unit) -> Unit,
    private val listener: Listener? = null
) {

    interface Listener {
        /** 新控制请求到达且已过门禁，UI 应立即展示确认弹窗（协议 9.1） */
        fun onControlRequested(request: ControlRequest)

        /** 会话状态变化（进入/离开 pending、active），UI 刷新用 */
        fun onChanged()
    }

    /** 需要用户确认的控制请求（被控端 UI 展示用） */
    data class ControlRequest(
        val sessionId: String,
        val peerId: String,
        /** 对端自报的显示名，仅用于提示文案，不作信任依据 */
        val displayName: String,
        /** 控制端屏幕尺寸，accept 时对端据此把本机事件映射过去 */
        val screen: InputController.Screen,
        val expiresAt: Long
    )

    /** 进行中的控制会话（被控端视角） */
    data class ActiveSession(
        val sessionId: String,
        val peerId: String,
        val screen: InputController.Screen,
        val startedAt: Long
    )

    @Volatile
    private var pending: ControlRequest? = null

    @Volatile
    private var active: ActiveSession? = null

    private var ttlTimer: java.util.Timer? = null

    val pendingRequest: ControlRequest? get() = pending

    val activeSession: ActiveSession? get() = active

    /** UI 提示用：本机正被谁控制 */
    val controlledBy: String? get() = active?.peerId

    /**
     * 处理对端发来的 session.start（sessionType: 'input'）。
     * 门禁与状态迁移全在这里，分发层只做透传。
     */
    @Synchronized
    fun onStart(peerId: String, payload: JSONObject) {
        val sessionType = payload.optString("sessionType")
        val sessionId = payload.optString("sessionId")
        if (sessionType != "input" || !Regex(Protocol.SESSION_ID_RE).matches(sessionId)) {
            send(peerId, Protocol.TYPE_SESSION_REJECT) {
                put("sessionId", sessionId)
                put("reason", "bad request")
            }
            return
        }
        val params = payload.optJSONObject("params") ?: JSONObject()
        val screenObj = params.optJSONObject("screen")
        // 与桌面端 decodeScreenSize 一致：w/h 须为 1..MAX_COORD 的整数，
        // 否则拒绝（0 会让比例映射除零，超限坐标不许进注入层）。
        val w = screenObj?.optInt("w", -1) ?: -1
        val h = screenObj?.optInt("h", -1) ?: -1
        if (w < 1 || w > Protocol.MAX_COORD || h < 1 || h > Protocol.MAX_COORD) {
            send(peerId, Protocol.TYPE_SESSION_REJECT) {
                put("sessionId", sessionId)
                put("reason", "bad screen params")
            }
            return
        }
        val screen = InputController.Screen(w, h)

        // 门禁一：未配对设备的控制请求直接拒绝，**不进 pending、不弹 UI**。
        // 9.1 的授权提示是给用户的，而任意局域网连接都能刷出的提示框
        // 本身就是骚扰面（与桌面端一致）。
        if (!isPeerAuthorized(peerId)) {
            Log.i(TAG, "拒绝未信任设备 $peerId 的键鼠控制请求")
            send(peerId, Protocol.TYPE_SESSION_REJECT) {
                put("sessionId", sessionId)
                put("reason", "not trusted")
            }
            return
        }

        // 门禁二：同一时刻至多一个挂起/活动会话。键鼠只有一套，多个
        // 控制端同时注入没有意义；重复请求回 RESOURCE_BUSY 语义。
        val p = pending
        if (p != null && p.peerId == peerId && p.sessionId == sessionId) {
            return // 同一请求的重入：保持等待，不能回 busy 把对端挂起的请求打掉
        }
        val a = active
        if (a != null || p != null) {
            // 幂等：同一会话的 start 重发（对端消息重传）直接重新 accept
            if (a != null && a.peerId == peerId && a.sessionId == sessionId) {
                sendAccept(peerId, sessionId)
                return
            }
            send(peerId, Protocol.TYPE_SESSION_REJECT) {
                put("sessionId", sessionId)
                put("reason", "resource busy")
            }
            return
        }

        val req = ControlRequest(
            sessionId = sessionId,
            peerId = peerId,
            displayName = params.optString("displayName", ""),
            screen = screen,
            expiresAt = System.currentTimeMillis() + REQUEST_TTL_MS
        )
        pending = req
        // TTL 计时先于确认回调起表：确认 UI 的默认实现是同步拒绝，
        // 若先调回调再起表，拒绝里清掉的计时器会留下一个无人认领的空转任务。
        ttlTimer?.cancel()
        ttlTimer = java.util.Timer(true).apply {
            schedule(object : java.util.TimerTask() {
                override fun run() = onTtlExpired(sessionId)
            }, REQUEST_TTL_MS)
        }
        Log.i(TAG, "收到 $peerId 的键鼠控制请求，等待本机确认")
        listener?.onControlRequested(req)
        listener?.onChanged()
    }

    /** UI：用户同意。过期或不存在返回 false */
    @Synchronized
    fun approve(sessionId: String): Boolean {
        val req = pending ?: return false
        if (req.sessionId != sessionId) return false
        if (System.currentTimeMillis() > req.expiresAt) {
            expirePending()
            return false
        }
        clearTimer()
        pending = null
        active = ActiveSession(req.sessionId, req.peerId, req.screen, System.currentTimeMillis())
        sendAccept(req.peerId, req.sessionId)
        Log.i(TAG, "已授权 ${req.peerId} 控制本机键鼠（会话级，结束后失效）")
        listener?.onChanged()
        return true
    }

    /** UI：用户拒绝 */
    @Synchronized
    fun deny(sessionId: String, reason: String = "denied by user") {
        val req = pending ?: return
        if (req.sessionId != sessionId) return
        clearTimer()
        pending = null
        send(req.peerId, Protocol.TYPE_SESSION_REJECT) {
            put("sessionId", req.sessionId)
            put("reason", reason)
        }
        Log.i(TAG, "用户拒绝了键鼠控制请求")
        listener?.onChanged()
    }

    /**
     * 处理 input.event。会话匹配校验先行；注入点留空桩。
     *
     * TODO(线2实现)：接 AccessibilityService 做手势/按键注入。当前骨架
     * 只做校验与日志，**不注入任何事件**——无障碍服务未接（见类注释）。
     */
    @Synchronized
    fun onEvent(peerId: String, payload: JSONObject) {
        val a = active
        // 旁观连接（含其他已配对设备）不得注入：会话是点对点的
        if (a == null || peerId != a.peerId) {
            Log.i(TAG, "忽略 $peerId 的 input.event（无活动会话或来源不符）")
            return
        }
        if (payload.optString("sessionId") != a.sessionId) return
        // TODO(线2实现)：事件解码 + AccessibilityService 注入。
        Log.w(TAG, "收到 ${a.peerId} 的 input.event（会话 ${a.sessionId}），未接无障碍服务，事件已丢弃")
    }

    /** 处理 session.stop（对端主动结束） */
    @Synchronized
    fun onStop(peerId: String, payload: JSONObject) {
        val a = active ?: return
        if (a.peerId == peerId && payload.optString("sessionId") == a.sessionId) {
            endSession("对端结束了控制")
        }
    }

    /** 连接断开：活动会话立即失效（断线恢复的被控端半边） */
    @Synchronized
    fun onPeerDisconnected(peerId: String) {
        val a = active
        if (a != null && a.peerId == peerId) {
            endSession("对端连接断开")
        } else {
            val p = pending
            if (p != null && p.peerId == peerId) {
                clearTimer()
                pending = null
                listener?.onChanged()
            }
        }
    }

    /** 信任撤销：比断连更优先的终止理由，立即掐断 */
    @Synchronized
    fun onTrustRevoked(peerId: String) {
        val a = active
        val p = pending
        if ((a != null && a.peerId == peerId) || (p != null && p.peerId == peerId)) {
            clearTimer()
            pending = null
            if (a != null) endSession("信任已被撤销")
        }
    }

    /** 本机用户主动终止（被控端随时可以拔掉控制权） */
    @Synchronized
    fun terminate() {
        if (active == null) return
        // endSession 内已向对端发 session.stop，不再重复发（桌面端
        // terminate 在 endSession 外又补发一次 stop，属重复，骨架不跟）。
        endSession("本机终止了控制")
    }

    private fun sendAccept(peerId: String, sessionId: String) {
        val screen = localScreen()
        send(peerId, Protocol.TYPE_SESSION_ACCEPT) {
            put("sessionId", sessionId)
            put("screen", JSONObject().apply {
                put("w", screen.w)
                put("h", screen.h)
            })
        }
    }

    private fun endSession(reason: String) {
        val ended = active ?: return
        active = null
        // TODO(线2实现)：接无障碍服务后，此处抬起全部按住的键与鼠标键
        // （防卡键，与桌面端 releaseAll 对应）。当前无注入层，无需释放。
        Log.i(TAG, "键鼠控制会话结束：$reason")
        send(ended.peerId, Protocol.TYPE_SESSION_STOP) {
            put("sessionId", ended.sessionId)
            put("reason", reason)
        }
        listener?.onChanged()
    }

    @Synchronized
    fun onTtlExpired(sessionId: String) {
        val cur = pending
        if (cur != null && cur.sessionId == sessionId) {
            Log.i(TAG, "键鼠控制请求超时未确认，已自动拒绝")
            expirePending()
        }
    }

    private fun expirePending() {
        val req = pending
        clearTimer()
        pending = null
        if (req != null) {
            send(req.peerId, Protocol.TYPE_SESSION_REJECT) {
                put("sessionId", req.sessionId)
                put("reason", "expired")
            }
        }
        listener?.onChanged()
    }

    private fun clearTimer() {
        ttlTimer?.cancel()
        ttlTimer = null
    }

    companion object {
        private const val TAG = "LinkSpace/ControlledInput"

        /** 挂起的控制请求多久无人处理即自动拒绝，与桌面端一致。产品值 30s */
        const val REQUEST_TTL_MS = 30_000L
    }
}
