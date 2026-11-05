package cn.linkspace.client.service

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.AccessibilityServiceInfo
import android.accessibilityservice.GestureDescription
import android.content.ComponentName
import android.content.Context
import android.graphics.Path
import android.graphics.PointF
import android.media.AudioManager
import android.os.Build
import android.os.SystemClock
import android.util.Log
import android.view.KeyEvent
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityManager
import cn.linkspace.client.service.ControlledInputInjector.DecodedEvent
import cn.linkspace.client.service.ControlledInputInjector.InjectResult
import cn.linkspace.client.service.ControlledInputInjector.InputFailure
import cn.linkspace.client.service.ControlledInputInjector.InputInjector
import cn.linkspace.client.service.ControlledInputInjector.MouseButtonTracker
import cn.linkspace.client.service.ControlledInputInjector.PressAction

/**
 * 线 2 被控端注入服务（线 2 W5，选型 A：AccessibilityService 为主）。
 *
 * 职责只有一件：把 [ControlledInputSession] 解码映射后的输入事件落到
 * 本机——手势走 [dispatchGesture]，按键走系统全局动作与 API 33+
 * 输入连接（见下文“按键”一节）。
 * 不读窗口内容（`canRetrieveWindowContent=false`），不监听无障碍事件
 * （`onAccessibilityEvent` 空实现）。中文输入（任务 2.3-3，三通道
 * B1+B2+C）：B1 按键直通复用下面的按键通道（平板自带输入法组字）；
 * B2 文本直通走 [commitText]（`InputConnection.commitText` 直接上屏）；
 * C 粘贴回退由会话层写剪贴板 + 本服务的按键通道注 Ctrl+V。
 *
 * **安全门禁不在这里**：服务本身只认「已连接 + 会话层放行」。
 * 会话层（[ControlledInputSession]）在 `session.start` 时先查系统
 * 设置确认本服务已开启，未开启直接回 `session.reject`
 * （reason `accessibility disabled`），并由 UI 引导用户去开；
 * 每次控制都要平板端点「允许」，确认 UI 未弹出时不放行任何输入。
 * 因此即使本服务常驻开启，没有一次用户确认过的活动会话，
 * [inject] 也永远不会被调用。
 *
 * **手势模型**（无障碍服务没有“移动光标”API，只能发手势）：
 * - `move`（未按下）：只更新落点记录，不发手势；
 * - `down`（左键）：记下锚点（取最近一次 `move` 的落点），开始攒路径；
 *   右/中键的 down 只记按住态，不攒路径（见左右键映射）；
 * - `move`（左键已按下）：往路径里追加点（拖拽轨迹）；
 * - `up`（左键）：把整条路径一次发成一个手势（点按 = 1px 短划，拖拽 =
 *   整条轨迹）。代价是拖拽过程对方要到松手才看到完整轨迹——
 *   换来的是不中途取消手势、不出现“手指半路抬起”的断裂，
 *   首版先求稳，真机联调时再评估是否改分段发。
 * - `up`（右/中键）：不发手势，改发系统动作——右键返回
 *   （`GLOBAL_ACTION_BACK`）、中键主页（`GLOBAL_ACTION_HOME`），
 *   与键盘系统键在 ACTION_UP 时触发同口径。配对逻辑在
 *   [ControlledInputInjector.MouseButtonTracker]（纯逻辑，可单测）。
 * - `wheel`：按滚动方向在落点处发一段短滑动（dy>0 向下滚 = 手指
 *   向上滑），是近似实现，不是系统级滚轮。
 * - `key`：无障碍服务没有“向任意前台应用发按键”的公开 API——
 *   `AccessibilityService` 根本没有 dispatchKeyEvent（查过
 *   android-35 android.jar；RustDesk InputService 源码同款结论）。
 *   分三档，都是公开 API：
 *   ① 系统键（返回/主页/最近任务/电源/音量）走 [performGlobalAction] /
 *   AudioManager，与输入焦点无关；
 *   ② 其余按键走 API 33+ 输入连接
 *   `getInputMethod()?.currentInputConnection?.sendKeyEvent()`——
 *   须配 `FLAG_INPUT_METHOD_EDITOR`（见配置文件），且只在当前有
 *   获得焦点的输入框时才有连接；
 *   ③ 无连接或 Android < 13 时回明确失败，不静默丢掉。
 *   修饰键状态（Shift/Ctrl/Alt）由本类跟踪并随每次按键带上 metaState。
 *   结论：A 路线下通用按键只能落在文本输入处；非文本场景的按键
 *   （如桌面快捷键、游戏按键）不在公开 API 能力内，属选型 A 的
 *   已知短板，真机联调时以实测为准（全量按键须走 scrcpy/adb 即
 *   B 路线，不在本批）。
 *
 * **失败不静默**：手势分发被拒、或按键无路可走（无焦点输入框、
 * Android < 13）时，[inject] 即回 [InjectResult.Failed] 带明确原因；
 * 会话层记日志并报给 UI。单批里首个失败即停，不继续注剩余事件。
 *
 * **左右键映射（线 2，2026-11-03，已实现，未验证）**：左键点按/拖拽
 * 不变；右键一次按下+抬起 = 系统返回，中键 = 系统主页（抬起时触发）。
 * 右键不产生点按、不弹上下文菜单——无障碍手势本就没有左右键之分，
 * 这是按走查清单 2.6 定死的语义映射，不是真右键。失败（全局动作被
 * 系统拒绝）时回明确原因，不静默丢掉。
 *
 * **已知未做（真机联调时定）**：拖拽轨迹在松手时才一次发出，拖拽过程
 * 对方看不到实时轨迹；右键/中键的实际表现（返回/主页是否生效、与前台
 * 应用的冲突）待用户在小新平板 Pro GT 上走查（清单 2.6 右键/中键项）。
 *
 * **线程**：[dispatchGesture] 与输入连接调用是 Binder 调用，
 * 会话层的 WS 读线程直接调即可；内部状态用一把锁保护。
 *
 * 未验证：真机联调不在本批，没有平板在手，以上落点语义
 * （点按/拖拽/滚轮方向、按键 metaState）一律标注未验证。
 */
class LinkSpaceAccessibilityService : AccessibilityService(), InputInjector {

    companion object {
        private const val TAG = "LinkSpace/A11y"

        /** 点按手势时长 */
        private const val TAP_MS = 60L

        /** 滚轮折算的一段滑动时长 */
        private const val WHEEL_SWIPE_MS = 120L

        /** 单条拖拽轨迹最多攒的点数，超了只保留轨迹首尾走向 */
        private const val MAX_DRAG_POINTS = 256

        @Volatile
        private var instance: LinkSpaceAccessibilityService? = null

        /**
         * 系统无障碍设置里本服务是否已开启。授权状态的唯一依据，
         * 会话层与 UI 都以它为准；重启 App 后仍有效（系统级开关）。
         */
        fun isEnabled(context: Context): Boolean {
            // 主判据：AccessibilityService 只有系统开启并绑定后才会有实例；
            // 注入也必须依赖这个实例。实例存在时直接认为服务可用。
            if (instance != null) return true
            // 第二判据：AccessibilityManager 的已绑定列表（只含当前已
            // 绑定、活着的服务）。Settings.Secure 的 ENABLED_ACCESSIBILITY_
            // SERVICES 只是“用户曾经开启”的持久记录，不能再当充分条件：
            // 2026-11-03 真机踩到的假阳性——进程被前台服务停止超时杀掉
            // 后，服务仍在该列表里、横条随之消失，但 dumpsys 显示服务
            // 在 Crashed 列表、Bound services 为空、accessibility_enabled
            // 为 0；会话按“已开启”放行后注入全失败，看着像功能坏了。
            // 本 ROM 曾出现“已绑定但该列表不含本服务”的假阴性，但那种
            // 情况下 instance 非空，已被第一条覆盖，不会误判。
            val am = context.getSystemService(Context.ACCESSIBILITY_SERVICE)
                as? AccessibilityManager ?: return false
            val id = ComponentName(context, LinkSpaceAccessibilityService::class.java)
            // 不同 ROM / Android 版本里 AccessibilityServiceInfo.id 可能是
            // flattenToString 或 flattenToShortString 形态。按组件名归一后
            // 比较，避免“服务已绑定但 App 状态仍为关闭”的假阴性。
            val bound = runCatching {
                am.getEnabledAccessibilityServiceList(AccessibilityServiceInfo.FEEDBACK_ALL_MASK)
                    .any {
                        ComponentName.unflattenFromString(it.id) == id ||
                            it.resolveInfo?.serviceInfo?.let { si ->
                                ComponentName(si.packageName, si.name)
                            } == id
                    }
            }.getOrDefault(false)
            if (!bound) {
                // 诊断用：只记日志，不再把“在已启用列表里”当成可用。
                // 出现这行 = 服务已开启但未绑定（进程被杀/崩溃后常见），
                // 界面应显示未开启并引导用户重开，而不是报“已开启”。
                val inSetting = runCatching {
                    android.provider.Settings.Secure.getString(
                        context.contentResolver,
                        android.provider.Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES
                    )?.split(':')?.any { raw ->
                        ComponentName.unflattenFromString(raw) == id
                    } == true
                }.getOrDefault(false)
                if (inSetting) {
                    Log.w(
                        "LinkSpace/A11y",
                        "无障碍服务在已启用列表里但未绑定（进程被杀/崩溃后常见），按未开启处理"
                    )
                }
            }
            return bound
        }

        /** 会话层注入入口：服务未连接时直接回失败，不静默丢掉。 */
        fun inject(events: List<DecodedEvent>): InjectResult {
            val svc = instance
                ?: return InjectResult.Failed(
                    "无障碍服务未开启：请在系统设置 → 无障碍中开启 LinkSpace 远程输入",
                    InputFailure.ACCESSIBILITY_DISABLED
                )
            return svc.injectEvents(events)
        }

        /**
         * 文本直通（协议 4.9，B2）：成品文本经输入连接 commitText 直接上屏。
         * 返回 null 表示已提交，否则是失败（code + 原因），会话层回
         * `input.error` 并报 UI。`commitText` 本身会结束当前组字，因此
         * B1 切到 B2 时未选的拼音按输入法行为结束（见协议 §4.9 模式互斥）。
         * 服务未连接 / 无连接 / Android < 13 时回明确失败，不静默丢掉。
         */
        fun commitText(text: String): InputFailure? {
            val svc = instance
                ?: return InputFailure(
                    InputFailure.ACCESSIBILITY_DISABLED,
                    "无障碍服务未开启：请在系统设置 → 无障碍中开启 LinkSpace 远程输入"
                )
            return svc.commitTextInternal(text)
        }

        /** 会话结束/断连时抬起全部按住的键与鼠标键（防卡键）。 */
        fun releaseAll() {
            instance?.releaseAllState()
        }

        /**
         * 远程被控启动时唤醒息屏并自动上滑解除锁屏界面（无密码锁屏直接进桌面，有密码则弹出密码框供远程输入）。
         */
        @Suppress("DEPRECATION")
        fun wakeAndUnlock(context: Context) {
            runCatching {
                val pm = context.getSystemService(Context.POWER_SERVICE) as? android.os.PowerManager
                val km = context.getSystemService(Context.KEYGUARD_SERVICE) as? android.app.KeyguardManager
                val wasInteractive = pm?.isInteractive ?: true
                val wasLocked = km?.isKeyguardLocked ?: false
                if (!wasInteractive && pm != null) {
                    val wl = pm.newWakeLock(
                        android.os.PowerManager.SCREEN_BRIGHT_WAKE_LOCK or
                            android.os.PowerManager.ACQUIRE_CAUSES_WAKEUP or
                            android.os.PowerManager.ON_AFTER_RELEASE,
                        "linkspace:remote_wake"
                    )
                    wl.acquire(5000L)
                }
                val svc = instance ?: return@runCatching
                if (!wasInteractive || wasLocked) {
                    android.os.Handler(android.os.Looper.getMainLooper()).postDelayed({
                        runCatching {
                            val m = svc.resources.displayMetrics
                            val cx = m.widthPixels / 2f
                            val startY = m.heightPixels * 0.82f
                            val endY = m.heightPixels * 0.18f
                            svc.dispatchStroke(listOf(PointF(cx, startY), PointF(cx, endY)), 220L)
                            Log.i(TAG, "已触发亮屏与上滑解锁手势 (${m.widthPixels}x${m.heightPixels})")
                        }
                    }, if (!wasInteractive) 300L else 80L)
                }
            }.onFailure {
                Log.w(TAG, "wakeAndUnlock 异常: ${it.message}")
            }
        }
    }

    private val lock = Any()

    /** 最近一次 move 的落点（本机像素）；down/up/wheel 都以它为锚点 */
    private var pointerX = 0f
    private var pointerY = 0f

    /** 按键配对状态（左/右/中键语义见 MouseButtonTracker） */
    private val buttonTracker = MouseButtonTracker()

    /** 按下期间攒下的拖拽轨迹（含锚点）；松手时一次发出 */
    private var dragPoints: MutableList<PointF>? = null

    /** 当前按住的 Android keyCode（会话结束时逐个抬起，防卡键） */
    private val heldKeys = mutableSetOf<Int>()

    override fun onServiceConnected() {
        super.onServiceConnected()
        synchronized(lock) {
            instance = this
            // 落点初值取屏幕中心：控制端还没发过 move 就点按时，
            // 不至于落在 (0,0) 的状态栏角落。
            val m = resources.displayMetrics
            pointerX = m.widthPixels / 2f
            pointerY = m.heightPixels / 2f
            buttonTracker.reset()
            dragPoints = null
            heldKeys.clear()
        }
        Log.i(TAG, "无障碍服务已连接，远程输入注入就绪")
        // 系统绑定服务可能晚于 Activity onResume。这里主动回填状态，
        // 否则 UI 仍显示“未开启”，控制请求也会走错误的门禁分支。
        runCatching { LinkSpaceService.get(applicationContext).refreshAccessibilityState() }
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        synchronized(lock) {
            if (instance === this) instance = null
            resetStateLocked()
        }
        Log.i(TAG, "无障碍服务已解绑，远程输入注入已停用")
        return super.onUnbind(intent)
    }

    override fun onInterrupt() {
        // 系统要求中断时复位 bookkeeping；在途手势没有公开的取消
        // API，下一批事件从干净状态重新开始。
        synchronized(lock) { resetStateLocked() }
        Log.i(TAG, "无障碍服务被中断，注入状态已复位")
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // 本服务只做注入，不消费无障碍事件。
    }

    override fun onDestroy() {
        synchronized(lock) {
            if (instance === this) instance = null
            resetStateLocked()
        }
        super.onDestroy()
    }

    // ---------- InputInjector ----------

    override fun inject(events: List<DecodedEvent>): InjectResult = injectEvents(events)

    override fun releaseAll() = releaseAllState()

    // ---------- 内部实现 ----------

    private fun injectEvents(events: List<DecodedEvent>): InjectResult {
        synchronized(lock) {
            for (ev in events) {
                val failure = applyEventLocked(ev)
                if (failure != null) return InjectResult.Failed(failure.reason, failure.code)
            }
            return InjectResult.Ok
        }
    }

    /**
     * 落单条事件。返回 null 表示成功，否则是失败（code + 原因，
     * 调用方停批并上报）。
     */
    private fun applyEventLocked(ev: DecodedEvent): InputFailure? {
        return when (ev) {
            is DecodedEvent.Move -> {
                pointerX = ev.x.toFloat()
                pointerY = ev.y.toFloat()
                if (buttonTracker.trackMove()) {
                    val pts = dragPoints
                    if (pts != null && pts.size < MAX_DRAG_POINTS) {
                        pts += PointF(pointerX, pointerY)
                    }
                }
                null
            }
            is DecodedEvent.Down -> {
                if (!buttonTracker.onDown(ev.button)) {
                    Log.i(TAG, "重复 down（已有按键按住），忽略")
                    return null
                }
                // 只有左键攒拖拽轨迹；右/中键只记按住态，抬起时发系统动作
                if (ev.button == ControlledInputInjector.Button.LEFT) {
                    dragPoints = mutableListOf(PointF(pointerX, pointerY))
                }
                null
            }
            is DecodedEvent.Up -> {
                val action = buttonTracker.onUp(ev.button)
                if (action == null) {
                    Log.i(TAG, "无匹配 down 的 up，忽略")
                    return null
                }
                when (action) {
                    PressAction.TAP -> {
                        val pts = dragPoints ?: mutableListOf(PointF(pointerX, pointerY))
                        pts += PointF(pointerX, pointerY)
                        dragPoints = null
                        val duration = dragDurationMs(pts)
                        if (!dispatchStroke(pts, duration)) {
                            InputFailure(InputFailure.INJECT_FAILED, "手势分发被系统拒绝（button=${ev.button}，服务可能已断开）")
                        } else null
                    }
                    // 右键返回 / 中键主页：系统全局动作，抬起时触发。
                    // 失败回明确原因（会话层上报），不静默丢掉。
                    PressAction.BACK -> {
                        dragPoints = null
                        if (!performGlobalAction(GLOBAL_ACTION_BACK)) {
                            InputFailure(InputFailure.INJECT_FAILED, "返回动作被系统拒绝（右键，服务可能已断开）")
                        } else null
                    }
                    PressAction.HOME -> {
                        dragPoints = null
                        if (!performGlobalAction(GLOBAL_ACTION_HOME)) {
                            InputFailure(InputFailure.INJECT_FAILED, "主页动作被系统拒绝（中键，服务可能已断开）")
                        } else null
                    }
                }
            }
            is DecodedEvent.Wheel -> {
                // 滚轮没有系统级手势：按滚动方向在落点处发一段短滑动。
                // dy>0 向下滚 = 内容上移 = 手指向上滑。
                val dist = 120f
                val endX = (pointerX - ev.dx * dist)
                    .coerceIn(0f, resources.displayMetrics.widthPixels.toFloat())
                val endY = (pointerY - ev.dy * dist)
                    .coerceIn(0f, resources.displayMetrics.heightPixels.toFloat())
                if (endX == pointerX && endY == pointerY) {
                    Log.i(TAG, "滚轮滑动已到屏幕边缘，忽略")
                    return null
                }
                val pts = listOf(PointF(pointerX, pointerY), PointF(endX, endY))
                if (!dispatchStroke(pts, WHEEL_SWIPE_MS)) {
                    InputFailure(InputFailure.INJECT_FAILED, "滚轮滑动手势分发被系统拒绝（服务可能已断开）")
                } else null
            }
            is DecodedEvent.Key -> dispatchKeyReasonLocked(ev.keyCode, ev.down)
        }
    }

    /**
     * 发一条手势划线。单点路径（点按）补 1px：零长度路径会被
     * 手势分发拒绝。返回 dispatchGesture 的接受与否——只是
     * “系统接没接这个手势”，异步完成/取消不在此回执里。
     */
    private fun dispatchStroke(points: List<PointF>, durationMs: Long): Boolean {
        if (points.isEmpty()) return true
        val path = Path()
        path.moveTo(points[0].x, points[0].y)
        for (i in 1 until points.size) path.lineTo(points[i].x, points[i].y)
        if (points.size == 1) path.lineTo(points[0].x + 1f, points[0].y)
        val stroke = GestureDescription.StrokeDescription(path, 0, durationMs)
        val desc = GestureDescription.Builder().addStroke(stroke).build()
        return dispatchGesture(desc, null, null)
    }

    private fun dragDurationMs(points: List<PointF>): Long {
        if (points.size <= 1) return TAP_MS
        var dist = 0f
        for (i in 1 until points.size) {
            dist += Math.hypot(
                (points[i].x - points[i - 1].x).toDouble(),
                (points[i].y - points[i - 1].y).toDouble()
            ).toFloat()
        }
        // 约 4px/ms，下限 100ms、上限 1500ms。
        return (100 + dist / 4).toLong().coerceIn(100, 1500)
    }

    /**
     * 发单个按键。返回 null 表示已发出，否则是失败（code + 原因，
     * 调用方停批并上报，不静默）。
     */
    private fun dispatchKeyReasonLocked(keyCode: Int, down: Boolean): InputFailure? {
        val now = SystemClock.uptimeMillis()
        if (down) heldKeys += keyCode
        val meta = metaStateLocked()
        val action = if (down) KeyEvent.ACTION_DOWN else KeyEvent.ACTION_UP
        val failure = dispatchKeyToSystemLocked(KeyEvent(now, now, action, keyCode, 0, meta))
        if (failure == null) {
            if (!down) heldKeys -= keyCode
            return null
        }
        if (down) heldKeys -= keyCode
        return failure
    }

    /**
     * 按键的三档公开路线（见类注释“按键”一节）：
     * 系统键走全局动作/音量；其余按键走 API 33+ 输入连接；
     * 无路可走时回失败（code + 原因）。返回 null 表示已发出。
     */
    private fun dispatchKeyToSystemLocked(event: KeyEvent): InputFailure? {
        when (event.keyCode) {
            KeyEvent.KEYCODE_BACK -> {
                if (event.action == KeyEvent.ACTION_DOWN) return null
                return if (performGlobalAction(GLOBAL_ACTION_BACK)) null else InputFailure(InputFailure.INJECT_FAILED, "返回动作被系统拒绝")
            }
            KeyEvent.KEYCODE_HOME -> {
                if (event.action == KeyEvent.ACTION_DOWN) return null
                return if (performGlobalAction(GLOBAL_ACTION_HOME)) null else InputFailure(InputFailure.INJECT_FAILED, "主页动作被系统拒绝")
            }
            KeyEvent.KEYCODE_APP_SWITCH -> {
                if (event.action == KeyEvent.ACTION_DOWN) return null
                return if (performGlobalAction(GLOBAL_ACTION_RECENTS)) null else InputFailure(InputFailure.INJECT_FAILED, "最近任务动作被系统拒绝")
            }
            KeyEvent.KEYCODE_POWER -> {
                if (event.action == KeyEvent.ACTION_DOWN) return null
                return if (performGlobalAction(GLOBAL_ACTION_POWER_DIALOG)) null else InputFailure(InputFailure.INJECT_FAILED, "电源菜单动作被系统拒绝")
            }
            KeyEvent.KEYCODE_VOLUME_UP -> {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    audioManager()?.adjustVolume(AudioManager.ADJUST_RAISE, AudioManager.FLAG_SHOW_UI)
                }
                return null
            }
            KeyEvent.KEYCODE_VOLUME_DOWN -> {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    audioManager()?.adjustVolume(AudioManager.ADJUST_LOWER, AudioManager.FLAG_SHOW_UI)
                }
                return null
            }
            KeyEvent.KEYCODE_VOLUME_MUTE -> {
                if (event.action == KeyEvent.ACTION_DOWN) {
                    audioManager()?.adjustVolume(AudioManager.ADJUST_TOGGLE_MUTE, AudioManager.FLAG_SHOW_UI)
                }
                return null
            }
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return InputFailure(InputFailure.UNSUPPORTED_VERSION, "本机 Android 低于 13，按键注入需要输入连接（API 33+），本次按键未发出")
        }
        val method = runCatching { inputMethod }.getOrNull()
            ?: return InputFailure(InputFailure.ACCESSIBILITY_DISABLED, "无障碍输入法未就绪（FLAG_INPUT_METHOD_EDITOR 未生效），按键未发出")
        val connection = runCatching { method.currentInputConnection }.getOrNull()
            ?: return InputFailure(InputFailure.NO_FOCUS, "当前没有获得焦点的输入框，按键只能落在文本输入处，本次按键未发出")
        return try {
            connection.sendKeyEvent(event)
            null
        } catch (e: Exception) {
            InputFailure(InputFailure.INJECT_FAILED, "输入连接发送失败：${e.message}")
        }
    }

    /**
     * 文本直通落点（协议 4.9，B2）：复用按键通道的同一个输入连接句柄。
     * 白名单核实（android-35 android.jar）：`AccessibilityInputConnection`
     * 的 `commitText(CharSequence, int, TextAttribute)` 返回 void——没有
     * 成功回执，不抛异常即视为已提交；目标输入框是否真接受（有 ROM /
     * 输入法会静默忽略）只能真机验证。`finishComposingText` 不在白名单
     * 内，不可用（`commitText` 本身会结束组字）。
     * 调用方（会话层）须在同一把锁内串行调用，与按键注入不并发。
     */
    private fun commitTextInternal(text: String): InputFailure? {
        // 与按键注入同一把锁串行：B1 组字中途不得插入 B2 提交（协议 §4.9 模式互斥）。
        synchronized(lock) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            return InputFailure(
                InputFailure.UNSUPPORTED_VERSION,
                "本机 Android 低于 13，文本直通需要输入连接（API 33+），本次文本未提交"
            )
        }
        val method = runCatching { inputMethod }.getOrNull()
            ?: return InputFailure(
                InputFailure.ACCESSIBILITY_DISABLED,
                "无障碍输入法未就绪（FLAG_INPUT_METHOD_EDITOR 未生效），文本未提交"
            )
        val connection = runCatching { method.currentInputConnection }.getOrNull()
            ?: return InputFailure(
                InputFailure.NO_FOCUS,
                "当前没有获得焦点的输入框，文本只能提交到文本输入处，请先点一下输入框"
            )
        return try {
            connection.commitText(text, 1, null)
            null
        } catch (e: Exception) {
            InputFailure(InputFailure.INJECT_FAILED, "输入连接提交失败：${e.message}")
        }
        }
    }

    private fun audioManager(): AudioManager? =
        runCatching { getSystemService(Context.AUDIO_SERVICE) as? AudioManager }.getOrNull()

    private fun metaStateLocked(): Int {
        var meta = 0
        if (heldKeys.contains(KeyEvent.KEYCODE_SHIFT_LEFT)) {
            meta = meta or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON
        }
        if (heldKeys.contains(KeyEvent.KEYCODE_SHIFT_RIGHT)) {
            meta = meta or KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_RIGHT_ON
        }
        if (heldKeys.contains(KeyEvent.KEYCODE_CTRL_LEFT)) {
            meta = meta or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON
        }
        if (heldKeys.contains(KeyEvent.KEYCODE_CTRL_RIGHT)) {
            meta = meta or KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_RIGHT_ON
        }
        if (heldKeys.contains(KeyEvent.KEYCODE_ALT_LEFT)) {
            meta = meta or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON
        }
        if (heldKeys.contains(KeyEvent.KEYCODE_ALT_RIGHT)) {
            meta = meta or KeyEvent.META_ALT_ON or KeyEvent.META_ALT_RIGHT_ON
        }
        return meta
    }

    /** 抬起全部按住的键，复位手势状态。会话结束/断连/撤销时调用。 */
    private fun releaseAllState() {
        synchronized(lock) {
            for (keyCode in heldKeys.toList()) {
                // 抬键也走同一路线；发不出去只记日志，不因此报错——
                // 会话已经结束了，bookkeeping 清掉最重要。
                val reason = dispatchKeyReasonLocked(keyCode, false)
                if (reason != null) Log.w(TAG, "抬起按键 keyCode=$keyCode 未发出：${reason.reason}")
            }
            resetStateLocked()
        }
    }

    private fun resetStateLocked() {
        buttonTracker.reset()
        dragPoints = null
        heldKeys.clear()
        val m = runCatching { resources.displayMetrics }.getOrNull()
        if (m != null) {
            pointerX = m.widthPixels / 2f
            pointerY = m.heightPixels / 2f
        }
    }
}
