package cn.linkspace.client.service

import android.view.KeyEvent
import org.json.JSONObject

/**
 * 线 2 被控端注入层：纯逻辑部分（线 2 W5）。
 *
 * 与桌面端 `apps/desktop/src/main/input/protocol.ts` 的 decodeInputEvents /
 * mapPoint 同口径，但只做到「解码 + 坐标映射 + Windows VK → Android keyCode」，
 * 不碰任何 Android 框架调用——因此可以在 JVM 单测里逐字段钉死边界
 * （见 ControlledInputInjectorTest）。
 *
 * 事件形状与线 1 的桌面被控端一致：坐标是**控制端屏幕绝对坐标**，
 * 被控端按两端屏幕尺寸比例映射；批量事件单条消息 ≤ 64 条。
 *
 * 收敛口径（与桌面端一致，任何一处失守都等于给已配对设备开一个
 * 「随意伪造本机输入」的通道）：
 * - 含任何非法事件时整批拒绝（返回 null），不逐条放行；
 * - 坐标必须是 0..MAX_COORD 的有限数，越界直接拒批；
 * - 按键只认 left/right/middle；滚轮钳 ±1000；
 * - Windows VK 只认 0..255，且必须能映射到 Android keyCode——
 *   映射不上的 VK（如 0x01）同样整批拒绝，不静默丢掉（中文输入
 *   通道另设，见任务 2.3-3，不在本批用 VK 硬凑）。
 *
 * 真正的手势/按键落点在 [LinkSpaceAccessibilityService]，它实现
 * [InputInjector]；注入失败以 [InjectResult.Failed] 带明确原因返回，
 * 由 [ControlledInputSession] 记日志并报给 UI，绝不静默丢掉。
 */
object ControlledInputInjector {

    /** 解码后、坐标映射后的单条输入事件（字段名与桌面端 InputEvent 对齐） */
    sealed class DecodedEvent {
        /** 控制端屏幕绝对坐标；会话层按比例映射成本机坐标后再注入 */
        data class Move(val x: Int, val y: Int) : DecodedEvent()
        data class Down(val button: Button) : DecodedEvent()
        data class Up(val button: Button) : DecodedEvent()
        data class Wheel(val dx: Int, val dy: Int) : DecodedEvent()
        /** keyCode 已是 Android KeyEvent 码（VK 在解码时一次映射完） */
        data class Key(val keyCode: Int, val down: Boolean) : DecodedEvent()
    }

    enum class Button { LEFT, RIGHT, MIDDLE }

    /**
     * 鼠标按键一次按下+抬起的落点语义（线 2 左右键映射，走查清单 2.6：
     * 右键返回 / 中键 Home；左键保持点按/拖拽）。
     *
     * 无障碍手势没有左右键之分：右键落不成一次“右键点按”（不弹上下文
     * 菜单），中键也做不了粘贴——语义只能落在系统动作上。动作在抬起
     * （up）时决议，与键盘系统键（KEYCODE_BACK / KEYCODE_HOME 在
     * ACTION_UP 时发全局动作）同口径；按住时长不区分语义，按一次触发一次。
     */
    enum class PressAction { TAP, BACK, HOME }

    /**
     * 鼠标按键配对状态机（纯逻辑，不碰 Android 框架，可 JVM 单测）。
     * 一次只允许一个按键处于按下态：已按住时再 down 直接忽略（与旧的
     * “重复 down 忽略”一致）；up 与按下的键不匹配时忽略，不破坏正在
     * 进行的左键拖拽；右键按住期间的 move 不进拖拽轨迹。
     */
    class MouseButtonTracker {
        private var downButton: Button? = null

        /** 当前按住的键；null = 未按下 */
        val heldButton: Button? get() = downButton

        /** 左键拖拽进行中 */
        val isLeftDown: Boolean get() = downButton == Button.LEFT

        /** 按下：true = 接受为当前按住的键；false = 已有按键按住，本次忽略 */
        fun onDown(button: Button): Boolean {
            if (downButton != null) return false
            downButton = button
            return true
        }

        /**
         * 抬起：返回本次按下+抬起的落点语义；无匹配 down（或键不匹配）
         * 时返回 null，调用方忽略、不破坏现有按下态。
         */
        fun onUp(button: Button): PressAction? {
            if (downButton != button) return null
            downButton = null
            return when (button) {
                Button.LEFT -> PressAction.TAP
                Button.RIGHT -> PressAction.BACK
                Button.MIDDLE -> PressAction.HOME
            }
        }

        /** move 是否应追加进拖拽轨迹：只在左键按住时 */
        fun trackMove(): Boolean = isLeftDown

        fun reset() {
            downButton = null
        }
    }

    /**
     * 文本/粘贴类输入失败：code 供控制端 UI 分流（如无焦点时提示点输入框），
     * reason 人读（中文）。与协议 4.9 `input.error` 的 code 一一对应，
     * 两端必须一致。
     */
    data class InputFailure(val code: String, val reason: String) {
        companion object {
            /** 当前没有获得焦点的输入框 */
            const val NO_FOCUS = "no-focus"
            /** 无障碍服务未开启 */
            const val ACCESSIBILITY_DISABLED = "accessibility-disabled"
            /** 被控端 Android 低于 13，输入连接不可用 */
            const val UNSUPPORTED_VERSION = "unsupported-version"
            /** 其他注入失败（手势/输入连接被拒等） */
            const val INJECT_FAILED = "inject-failed"
            /** 单条文本超限 */
            const val TOO_LARGE = "too-large"
        }
    }

    /** 注入结果：成功，或带明确原因的失败（调用方必须上报，不许吞掉） */
    sealed class InjectResult {
        object Ok : InjectResult()
        data class Failed(val reason: String, val code: String = InputFailure.INJECT_FAILED) : InjectResult()
    }

    /** 事件注入出口。到达时已完成解码与坐标映射。 */
    interface InputInjector {
        fun inject(events: List<DecodedEvent>): InjectResult

        /** 会话结束/断连时抬起全部按住的键与鼠标键（防卡键） */
        fun releaseAll()
    }

    /**
     * 校验并收敛一批输入事件。返回收敛后的事件数组；
     * 含任何非法事件时整批拒绝（返回 null）。
     */
    fun decodeInputEvents(payload: JSONObject): List<DecodedEvent>? {
        val arr = payload.optJSONArray("events") ?: return null
        if (arr.length() == 0 || arr.length() > Protocol.MAX_EVENTS_PER_MESSAGE) return null
        val out = ArrayList<DecodedEvent>(arr.length())
        for (i in 0 until arr.length()) {
            val ev = arr.optJSONObject(i) ?: return null
            when (ev.optString("t")) {
                "move" -> {
                    val x = coordNumber(ev.opt("x")) ?: return null
                    val y = coordNumber(ev.opt("y")) ?: return null
                    out += DecodedEvent.Move(x, y)
                }
                "down", "up" -> {
                    val b = parseButton(ev.optString("b")) ?: return null
                    out += if (ev.optString("t") == "down") DecodedEvent.Down(b)
                    else DecodedEvent.Up(b)
                }
                "wheel" -> {
                    val dx = wheelNumber(ev.opt("dx")) ?: return null
                    val dy = wheelNumber(ev.opt("dy")) ?: return null
                    out += DecodedEvent.Wheel(dx, dy)
                }
                "key" -> {
                    val vk = vkNumber(ev.opt("vk")) ?: return null
                    val down = ev.opt("down") as? Boolean ?: return null
                    // VK 映射不上 Android keyCode 时整批拒绝：调用方
                    // （桌面控制端）按 VK 0..255 发，0x01 这类无对应按键
                    // 的码不许静默吞掉——吞掉会让一次按键“凭空消失”。
                    val keyCode = vkToKeyCode(vk) ?: return null
                    out += DecodedEvent.Key(keyCode, down)
                }
                else -> return null // 未知事件类型：整批拒绝而非跳过
            }
        }
        return out
    }

    /**
     * 控制端坐标 → 被控端坐标的比例映射，与桌面端 mapPoint 同式：
     * round 后钳进目标屏幕边界。from/to 的 w/h 均 ≥ 1（会话层已校验），
     * 不会除零。
     */
    fun mapPoint(
        x: Int,
        y: Int,
        from: InputController.Screen,
        to: InputController.Screen
    ): Pair<Int, Int> {
        val mx = minOf(to.w - 1, maxOf(0, Math.round(x.toDouble() * to.w / from.w).toInt()))
        val my = minOf(to.h - 1, maxOf(0, Math.round(y.toDouble() * to.h / from.h).toInt()))
        return mx to my
    }

    /** 整数化坐标并钳制进合法范围，越界值直接拒绝该事件（返回 null） */
    private fun coordNumber(v: Any?): Int? {
        val n = (v as? Number)?.toDouble() ?: return null
        if (!n.isFinite()) return null
        val r = Math.round(n)
        if (r < 0 || r > Protocol.MAX_COORD) return null
        return r.toInt()
    }

    /** 滚轮刻度钳制：正常一帧不会超过 ±10 刻度，钳住极端值 */
    private fun wheelNumber(v: Any?): Int? {
        val n = (v as? Number)?.toDouble() ?: return null
        if (!n.isFinite()) return null
        return Math.round(n).toInt().coerceIn(-1000, 1000)
    }

    /** VK 码 0..255，越界一律拒绝 */
    private fun vkNumber(v: Any?): Int? {
        val n = (v as? Number)?.toDouble() ?: return null
        if (!n.isFinite()) return null
        val vk = Math.round(n).toInt()
        if (vk < 0 || vk > 255) return null
        return vk
    }

    private fun parseButton(b: String): Button? = when (b) {
        "left" -> Button.LEFT
        "right" -> Button.RIGHT
        "middle" -> Button.MIDDLE
        else -> null
    }

    /**
     * Windows 虚拟键码 → Android KeyEvent 码。只覆盖键鼠共享需要的
     * 常规键盘；组合输入（IME、中文）不在 VK 通道里，走另设的通道
     * （任务 2.3-3），这里不硬凑。
     */
    fun vkToKeyCode(vk: Int): Int? = when (vk) {
        0x08 -> KeyEvent.KEYCODE_DEL
        0x09 -> KeyEvent.KEYCODE_TAB
        0x0D -> KeyEvent.KEYCODE_ENTER
        0x10 -> KeyEvent.KEYCODE_SHIFT_LEFT
        0x11 -> KeyEvent.KEYCODE_CTRL_LEFT
        0x12 -> KeyEvent.KEYCODE_ALT_LEFT
        0x1B -> KeyEvent.KEYCODE_ESCAPE
        0x20 -> KeyEvent.KEYCODE_SPACE
        0x21 -> KeyEvent.KEYCODE_PAGE_UP
        0x22 -> KeyEvent.KEYCODE_PAGE_DOWN
        0x23 -> KeyEvent.KEYCODE_MOVE_END
        0x24 -> KeyEvent.KEYCODE_MOVE_HOME
        0x25 -> KeyEvent.KEYCODE_DPAD_LEFT
        0x26 -> KeyEvent.KEYCODE_DPAD_UP
        0x27 -> KeyEvent.KEYCODE_DPAD_RIGHT
        0x28 -> KeyEvent.KEYCODE_DPAD_DOWN
        0x2E -> KeyEvent.KEYCODE_FORWARD_DEL
        0x30 -> KeyEvent.KEYCODE_0
        0x31 -> KeyEvent.KEYCODE_1
        0x32 -> KeyEvent.KEYCODE_2
        0x33 -> KeyEvent.KEYCODE_3
        0x34 -> KeyEvent.KEYCODE_4
        0x35 -> KeyEvent.KEYCODE_5
        0x36 -> KeyEvent.KEYCODE_6
        0x37 -> KeyEvent.KEYCODE_7
        0x38 -> KeyEvent.KEYCODE_8
        0x39 -> KeyEvent.KEYCODE_9
        0x41 -> KeyEvent.KEYCODE_A
        0x42 -> KeyEvent.KEYCODE_B
        0x43 -> KeyEvent.KEYCODE_C
        0x44 -> KeyEvent.KEYCODE_D
        0x45 -> KeyEvent.KEYCODE_E
        0x46 -> KeyEvent.KEYCODE_F
        0x47 -> KeyEvent.KEYCODE_G
        0x48 -> KeyEvent.KEYCODE_H
        0x49 -> KeyEvent.KEYCODE_I
        0x4A -> KeyEvent.KEYCODE_J
        0x4B -> KeyEvent.KEYCODE_K
        0x4C -> KeyEvent.KEYCODE_L
        0x4D -> KeyEvent.KEYCODE_M
        0x4E -> KeyEvent.KEYCODE_N
        0x4F -> KeyEvent.KEYCODE_O
        0x50 -> KeyEvent.KEYCODE_P
        0x51 -> KeyEvent.KEYCODE_Q
        0x52 -> KeyEvent.KEYCODE_R
        0x53 -> KeyEvent.KEYCODE_S
        0x54 -> KeyEvent.KEYCODE_T
        0x55 -> KeyEvent.KEYCODE_U
        0x56 -> KeyEvent.KEYCODE_V
        0x57 -> KeyEvent.KEYCODE_W
        0x58 -> KeyEvent.KEYCODE_X
        0x59 -> KeyEvent.KEYCODE_Y
        0x5A -> KeyEvent.KEYCODE_Z
        0x60 -> KeyEvent.KEYCODE_NUMPAD_0
        0x61 -> KeyEvent.KEYCODE_NUMPAD_1
        0x62 -> KeyEvent.KEYCODE_NUMPAD_2
        0x63 -> KeyEvent.KEYCODE_NUMPAD_3
        0x64 -> KeyEvent.KEYCODE_NUMPAD_4
        0x65 -> KeyEvent.KEYCODE_NUMPAD_5
        0x66 -> KeyEvent.KEYCODE_NUMPAD_6
        0x67 -> KeyEvent.KEYCODE_NUMPAD_7
        0x68 -> KeyEvent.KEYCODE_NUMPAD_8
        0x69 -> KeyEvent.KEYCODE_NUMPAD_9
        0x6A -> KeyEvent.KEYCODE_NUMPAD_MULTIPLY
        0x6B -> KeyEvent.KEYCODE_NUMPAD_ADD
        0x6D -> KeyEvent.KEYCODE_NUMPAD_SUBTRACT
        0x6E -> KeyEvent.KEYCODE_NUMPAD_DOT
        0x6F -> KeyEvent.KEYCODE_NUMPAD_DIVIDE
        0x70 -> KeyEvent.KEYCODE_F1
        0x71 -> KeyEvent.KEYCODE_F2
        0x72 -> KeyEvent.KEYCODE_F3
        0x73 -> KeyEvent.KEYCODE_F4
        0x74 -> KeyEvent.KEYCODE_F5
        0x75 -> KeyEvent.KEYCODE_F6
        0x76 -> KeyEvent.KEYCODE_F7
        0x77 -> KeyEvent.KEYCODE_F8
        0x78 -> KeyEvent.KEYCODE_F9
        0x79 -> KeyEvent.KEYCODE_F10
        0x7A -> KeyEvent.KEYCODE_F11
        0x7B -> KeyEvent.KEYCODE_F12
        0xBA -> KeyEvent.KEYCODE_SEMICOLON
        0xBB -> KeyEvent.KEYCODE_EQUALS
        0xBC -> KeyEvent.KEYCODE_COMMA
        0xBD -> KeyEvent.KEYCODE_MINUS
        0xBE -> KeyEvent.KEYCODE_PERIOD
        0xBF -> KeyEvent.KEYCODE_SLASH
        0xC0 -> KeyEvent.KEYCODE_GRAVE
        0xDB -> KeyEvent.KEYCODE_LEFT_BRACKET
        0xDC -> KeyEvent.KEYCODE_BACKSLASH
        0xDD -> KeyEvent.KEYCODE_RIGHT_BRACKET
        0xDE -> KeyEvent.KEYCODE_APOSTROPHE
        else -> null
    }
}
