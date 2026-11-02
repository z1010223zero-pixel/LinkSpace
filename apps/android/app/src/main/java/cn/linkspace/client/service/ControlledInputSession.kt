package cn.linkspace.client.service

import android.util.Log
import cn.linkspace.client.service.ControlledInputInjector.InputFailure
import org.json.JSONObject

/**
 * 键鼠共享的被控端状态机（协议 4.6，线 2 W4 骨架、W5 接完注入与确认 UI）。
 *
 * 与桌面端 `input/session.ts` 的 InputSessionCoordinator 对称：别人请求
 * 来控制本机时的接待逻辑——授权门禁、30s 请求 TTL、用户确认、事件分发、
 * 随时可被掐断。桌面端是被控端实现，Android 端此前只有控制端
 * [InputController]（向桌面发起控制），没有任何被控分支。
 *
 * **状态（W5 已接完注入与确认 UI）：**
 * - pending/active 双态 + 30s 请求 TTL（与桌面端一致），过期自动拒绝；
 * - approve/deny：用户确认后才发 session.accept，拒绝发 session.reject；
 * - onEvent 会话匹配校验先行（peerId + sessionId 双核对），再经
 *   [ControlledInputInjector] 解码 + 坐标映射，交 AccessibilityService
 *   注入手势/按键；注入失败带明确原因上报，不静默丢掉。
 * - onText / onScreenPaste（协议 4.9 / 4.8，中文输入 B2/C）：同一套会话
 *   校验；文本超 8 KiB / 粘贴超 512 KiB 整条丢弃；提交失败回
 *   `input.error`（code + 原因，同一 code 5 秒内只回一次）并报 UI。
 * - 门禁三：无障碍服务未开启时控制请求直接回 session.reject
 *   （reason `accessibility disabled`），不进 pending、不弹 UI，
 *   并由 [Listener.onAccessibilityNotEnabled] 通知界面引导用户去开。
 *
 * 用户确认 UI 在 MainActivity：[Listener.onControlRequested] 到达即弹
 * 确认弹窗，确认后才放行 input.event；拒绝回 session.reject；
 * 30s 超时自动回落拒绝；确认 UI 未弹出或服务未启用时不放行任何输入
 * （安全红线，见协议 9.1「每次控制请求都有明确提示」）。
 *
 * control 授权语义与桌面端一致：会话级内存态，不进 TrustStore 持久化。
 */
class ControlledInputSession(
    private val isPeerAuthorized: (String) -> Boolean,
    private val localScreen: () -> InputController.Screen,
    private val send: (peerId: String, type: String, payload: JSONObject.() -> Unit) -> Unit,
    /**
     * 无障碍服务是否已开启（系统设置级开关）。门禁三与 approve 复核
     * 都以它为准；默认 false——注入层没接线时控制请求一律拒绝，
     * 绝不放行（安全默认值）。
     */
    private val isAccessibilityReady: () -> Boolean = { false },
    /**
     * 事件注入出口。到达时已完成解码与坐标映射；返回失败时会话层
     * 记日志并报给 UI。默认拒绝注入（未接线时不注入任何事件）。
     */
    private val inject: (List<ControlledInputInjector.DecodedEvent>, ActiveSession) -> ControlledInputInjector.InjectResult =
        { _, _ -> ControlledInputInjector.InjectResult.Failed("accessibility service not wired") },
    /** 会话结束时抬起全部按住的键与鼠标键（防卡键）。 */
    private val releaseAll: () -> Unit = {},
    private val listener: Listener? = null,
    /**
     * 文本直通出口（协议 4.9，B2）。到达时已完成会话校验与长度校验；
     * 返回 null 表示已提交，否则是失败（code + 原因），会话层回
     * `input.error` 并报给 UI。默认拒绝提交（未接线时不提交任何文本）。
     */
    private val commitText: (String) -> InputFailure? =
        { InputFailure(InputFailure.ACCESSIBILITY_DISABLED, "文本直通未接线") },
    /**
     * 粘贴出口（协议 4.8，C 回退：桌面→平板）。到达时已完成会话校验
     * 与长度校验；实现侧写剪贴板 + 注入 Ctrl+V + 回环抑制。
     * 返回 null 表示完成，否则是失败，会话层回 `input.error`。
     */
    private val paste: (String) -> InputFailure? =
        { InputFailure(InputFailure.ACCESSIBILITY_DISABLED, "粘贴通道未接线") },
    /** 时间源（input.error 节流用，测试可注入确定性时钟）。 */
    private val now: () -> Long = { System.currentTimeMillis() }
) {

    interface Listener {
        /** 新控制请求到达且已过门禁，UI 应立即展示确认弹窗（协议 9.1） */
        fun onControlRequested(request: ControlRequest)

        /** 会话状态变化（进入/离开 pending、active），UI 刷新用 */
        fun onChanged()

        /** 控制请求因无障碍服务未开启被拒绝：UI 应展示授权引导 */
        fun onAccessibilityNotEnabled()

        /** 某批 input.event 注入失败：UI 应展示明确原因，不静默 */
        fun onInjectError(sessionId: String, reason: String)
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

    /** input.error 节流：同一 code 上次回告的 code 与时间（见 reportInputError） */
    private var lastInputErrorCode: String? = null
    private var lastInputErrorAt: Long = 0L

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

        // 门禁三：无障碍服务未开启时直接拒绝，**不进 pending、不弹 UI**。
        // 未授权的控制请求必须有明确回执与引导，不静默落掉（任务 2.4-1）。
        if (!isAccessibilityReady()) {
            Log.i(TAG, "拒绝 $peerId 的键鼠控制请求：无障碍服务未开启")
            send(peerId, Protocol.TYPE_SESSION_REJECT) {
                put("sessionId", sessionId)
                put("reason", "accessibility disabled")
            }
            listener?.onAccessibilityNotEnabled()
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
        // 用户点“允许”前服务被关掉：不放行，改回拒绝（堵门禁三的竞态）。
        if (!isAccessibilityReady()) {
            deny(sessionId, "accessibility disabled")
            listener?.onAccessibilityNotEnabled()
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
     * 处理 input.event。会话匹配校验先行；解码与坐标映射按桌面端
     * 同口径（[ControlledInputInjector]）；注入失败带明确原因上报。
     *
     * 注入只在活动会话里发生：确认 UI 未弹出（pending）或服务未启用
     * 时到不了这里；非法批次整批丢弃，不逐条放行。
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
        val decoded = ControlledInputInjector.decodeInputEvents(payload)
        if (decoded == null) {
            Log.w(TAG, "丢弃非法的 input.event 批次（会话 ${a.sessionId}）")
            return
        }
        val local = localScreen()
        val mapped = decoded.map { ev ->
            if (ev is ControlledInputInjector.DecodedEvent.Move) {
                val (x, y) = ControlledInputInjector.mapPoint(ev.x, ev.y, a.screen, local)
                ControlledInputInjector.DecodedEvent.Move(x, y)
            } else ev
        }
        when (val result = inject(mapped, a)) {
            is ControlledInputInjector.InjectResult.Ok -> Unit
            is ControlledInputInjector.InjectResult.Failed -> {
                Log.e(TAG, "input.event 注入失败（会话 ${a.sessionId}）：${result.reason}")
                reportInputError(a, InputFailure(result.code, result.reason))
            }
        }
    }

    /**
     * 处理 input.text（协议 4.9，B2 文本直通）。会话匹配校验与
     * input.event 同口径；单条超 8 KiB 整条丢弃并回 input.error
     * （code too-large），不截断；提交失败回 input.error 并报 UI。
     * 与 B1 按键同一把锁串行处理，不并发（协议 §4.9 模式互斥）。
     */
    @Synchronized
    fun onText(peerId: String, payload: JSONObject) {
        val a = active
        if (a == null || peerId != a.peerId) {
            Log.i(TAG, "忽略 $peerId 的 input.text（无活动会话或来源不符）")
            return
        }
        if (payload.optString("sessionId") != a.sessionId) return
        val text = payload.optString("text", "")
        if (text.isEmpty()) return
        val size = text.toByteArray(Charsets.UTF_8).size
        if (size > Protocol.MAX_INPUT_TEXT_BYTES) {
            reportInputError(
                a,
                InputFailure(
                    InputFailure.TOO_LARGE,
                    "文本超过单条 8 KiB 上限（$size 字节），整条已丢弃，请分段发送"
                )
            )
            return
        }
        val failure = commitText(text)
        if (failure != null) reportInputError(a, failure)
    }

    /**
     * 处理 screen.paste（协议 4.8，C 回退：桌面→平板）。会话匹配校验
     * 与 input.event 同口径；超 512 KiB 整段丢弃并回 input.error；
     * 写剪贴板 + Ctrl+V + 回环抑制由 paste 出口实现。
     */
    @Synchronized
    fun onScreenPaste(peerId: String, payload: JSONObject) {
        val a = active
        if (a == null || peerId != a.peerId) {
            Log.i(TAG, "忽略 $peerId 的 screen.paste（无活动会话或来源不符）")
            return
        }
        val text = payload.optString("text", "")
        if (text.isEmpty()) return
        val size = text.toByteArray(Charsets.UTF_8).size
        if (size > Protocol.MAX_PASTE_BYTES) {
            reportInputError(
                a,
                InputFailure(
                    InputFailure.TOO_LARGE,
                    "粘贴内容超过 512 KiB 上限（$size 字节），整段已丢弃"
                )
            )
            return
        }
        val failure = paste(text)
        if (failure != null) reportInputError(a, failure)
    }

    /**
     * 输入失败回告（协议 4.9 `input.error`）：会话匹配通过后注入失败时
     * 发给控制端，桌面 UI 原样展示原因。同一 code 5 秒内只回告一次——
     * B1 按键是高频流，无焦点时每键都回告会刷屏；节流后桌面仍能看到
     * 原因，5 秒后复发一次提醒。另经 listener 报给本机 UI（双通道）。
     */
    @Synchronized
    private fun reportInputError(session: ActiveSession, failure: InputFailure) {
        val nowMs = now()
        if (failure.code == lastInputErrorCode && nowMs - lastInputErrorAt < INPUT_ERROR_MIN_INTERVAL_MS) return
        lastInputErrorCode = failure.code
        lastInputErrorAt = nowMs
        send(session.peerId, Protocol.TYPE_INPUT_ERROR) {
            put("sessionId", session.sessionId)
            put("code", failure.code)
            put("reason", failure.reason)
        }
        listener?.onInjectError(session.sessionId, failure.reason)
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
        // 会话结束即抬起全部按住的键与鼠标键（防卡键，与桌面端
        // releaseAll 对应）；断连/撤销/本机终止都走这里。
        releaseAll()
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

        /** 同一 code 的 input.error 最小回告间隔（协议 4.9，防高频按键刷屏） */
        const val INPUT_ERROR_MIN_INTERVAL_MS = 5_000L
    }
}
