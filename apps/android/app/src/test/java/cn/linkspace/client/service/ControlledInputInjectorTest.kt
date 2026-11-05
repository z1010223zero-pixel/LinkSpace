package cn.linkspace.client.service

import android.view.KeyEvent
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ControlledInputInjector] 的解码/映射/VK 映射单测（线 2 W5）。
 * 纯 JVM：只碰 org.json 与 KeyEvent 常量（编译期常量，不依赖框架）。
 */
class ControlledInputInjectorTest {

    private fun batch(vararg events: JSONObject): JSONObject =
        JSONObject().apply { put("events", JSONArray(events.toList())) }

    private fun move(x: Int, y: Int) = JSONObject().apply {
        put("t", "move"); put("x", x); put("y", y)
    }

    private fun down(b: String) = JSONObject().apply {
        put("t", "down"); put("b", b)
    }

    private fun wheel(dx: Int, dy: Int) = JSONObject().apply {
        put("t", "wheel"); put("dx", dx); put("dy", dy)
    }

    private fun key(vk: Int, down: Boolean) = JSONObject().apply {
        put("t", "key"); put("vk", vk); put("down", down)
    }

    @Test
    fun `decode valid batch of all five types`() {
        val decoded = ControlledInputInjector.decodeInputEvents(
            batch(
                move(960, 540),
                down("left"),
                JSONObject().apply { put("t", "up"); put("b", "left") },
                wheel(0, 3),
                key(0x41, true)
            )
        )
        assertTrue(decoded != null)
        assertEquals(5, decoded!!.size)
        assertEquals(ControlledInputInjector.DecodedEvent.Move(960, 540), decoded[0])
        assertEquals(
            ControlledInputInjector.DecodedEvent.Down(ControlledInputInjector.Button.LEFT),
            decoded[1]
        )
        assertEquals(
            ControlledInputInjector.DecodedEvent.Up(ControlledInputInjector.Button.LEFT),
            decoded[2]
        )
        assertEquals(ControlledInputInjector.DecodedEvent.Wheel(0, 3), decoded[3])
        assertEquals(
            ControlledInputInjector.DecodedEvent.Key(KeyEvent.KEYCODE_A, true),
            decoded[4]
        )
    }

    @Test
    fun `decode right and middle buttons`() {
        // 线格式早有 b 字段（left/right/middle）；本批只定被控端落点语义，
        // 解码层须把右/中键原样解成对应 Button，不许塌成左键。
        val decoded = ControlledInputInjector.decodeInputEvents(
            batch(
                down("right"),
                JSONObject().apply { put("t", "up"); put("b", "right") },
                down("middle"),
                JSONObject().apply { put("t", "up"); put("b", "middle") }
            )
        )
        assertEquals(
            listOf(
                ControlledInputInjector.DecodedEvent.Down(ControlledInputInjector.Button.RIGHT),
                ControlledInputInjector.DecodedEvent.Up(ControlledInputInjector.Button.RIGHT),
                ControlledInputInjector.DecodedEvent.Down(ControlledInputInjector.Button.MIDDLE),
                ControlledInputInjector.DecodedEvent.Up(ControlledInputInjector.Button.MIDDLE)
            ),
            decoded
        )
    }

    @Test
    fun `empty batch rejected`() {
        assertNull(ControlledInputInjector.decodeInputEvents(batch()))
    }

    @Test
    fun `batch over 64 rejected wholesale`() {
        val many = (1..65).map { move(1, 1) }.toTypedArray()
        assertNull(ControlledInputInjector.decodeInputEvents(batch(*many)))
    }

    @Test
    fun `one illegal event rejects whole batch`() {
        // 合法 move + 非法坐标：整批拒绝，不逐条放行
        assertNull(
            ControlledInputInjector.decodeInputEvents(
                batch(move(10, 10), move(40000, 10))
            )
        )
        assertNull(
            ControlledInputInjector.decodeInputEvents(
                batch(move(10, 10), move(-1, 10))
            )
        )
        // 未知类型
        assertNull(
            ControlledInputInjector.decodeInputEvents(
                batch(move(10, 10), JSONObject().apply { put("t", "swipe") })
            )
        )
        // 非法按键名
        assertNull(
            ControlledInputInjector.decodeInputEvents(
                batch(move(10, 10), down("side"))
            )
        )
        // VK 越界
        assertNull(
            ControlledInputInjector.decodeInputEvents(
                batch(move(10, 10), key(300, true))
            )
        )
        // key 缺 down 字段
        assertNull(
            ControlledInputInjector.decodeInputEvents(
                batch(JSONObject().apply { put("t", "key"); put("vk", 0x41) })
            )
        )
        // 无 events 数组
        assertNull(ControlledInputInjector.decodeInputEvents(JSONObject()))
    }

    @Test
    fun `unmappable vk rejects whole batch`() {
        // 0x01 无对应 Android 按键：不静默吞掉，整批拒绝
        assertNull(
            ControlledInputInjector.decodeInputEvents(batch(key(0x01, true)))
        )
        assertNull(
            ControlledInputInjector.decodeInputEvents(batch(key(0xFF, true)))
        )
    }

    @Test
    fun `wheel clamped to +-1000`() {
        val decoded = ControlledInputInjector.decodeInputEvents(batch(wheel(5000, -5000)))
        assertEquals(
            listOf(ControlledInputInjector.DecodedEvent.Wheel(1000, -1000)),
            decoded
        )
    }

    @Test
    fun `mapPoint proportional and clamped`() {
        val from = InputController.Screen(1920, 1080)
        val to = InputController.Screen(1080, 2400)
        assertEquals(540 to 1200, ControlledInputInjector.mapPoint(960, 540, from, to))
        // 越界坐标钳进目标边界（与桌面端 mapPoint 同式）
        assertEquals(9 to 9, ControlledInputInjector.mapPoint(99, 99, InputController.Screen(100, 100), InputController.Screen(10, 10)))
        assertEquals(0 to 0, ControlledInputInjector.mapPoint(0, 0, from, to))
    }

    @Test
    fun `vk mapping covers common keys`() {
        assertEquals(KeyEvent.KEYCODE_ENTER, ControlledInputInjector.vkToKeyCode(0x0D))
        assertEquals(KeyEvent.KEYCODE_DEL, ControlledInputInjector.vkToKeyCode(0x08))
        assertEquals(KeyEvent.KEYCODE_ESCAPE, ControlledInputInjector.vkToKeyCode(0x1B))
        assertEquals(KeyEvent.KEYCODE_DPAD_LEFT, ControlledInputInjector.vkToKeyCode(0x25))
        assertEquals(KeyEvent.KEYCODE_F1, ControlledInputInjector.vkToKeyCode(0x70))
        assertEquals(KeyEvent.KEYCODE_SPACE, ControlledInputInjector.vkToKeyCode(0x20))
        assertEquals(KeyEvent.KEYCODE_CAPS_LOCK, ControlledInputInjector.vkToKeyCode(0x14))
        assertEquals(KeyEvent.KEYCODE_INSERT, ControlledInputInjector.vkToKeyCode(0x2D))
        assertEquals(KeyEvent.KEYCODE_SHIFT_LEFT, ControlledInputInjector.vkToKeyCode(0xA0))
        assertEquals(KeyEvent.KEYCODE_SHIFT_RIGHT, ControlledInputInjector.vkToKeyCode(0xA1))
        assertEquals(KeyEvent.KEYCODE_CTRL_LEFT, ControlledInputInjector.vkToKeyCode(0xA2))
        assertEquals(KeyEvent.KEYCODE_CTRL_RIGHT, ControlledInputInjector.vkToKeyCode(0xA3))
        assertEquals(KeyEvent.KEYCODE_ALT_LEFT, ControlledInputInjector.vkToKeyCode(0xA4))
        assertEquals(KeyEvent.KEYCODE_ALT_RIGHT, ControlledInputInjector.vkToKeyCode(0xA5))
        assertNull(ControlledInputInjector.vkToKeyCode(0x01))
        assertNull(ControlledInputInjector.vkToKeyCode(0xFF))
    }

    @Test
    fun `reverse stream annexB prefix and normalizeNals avoid duplicate start codes`() {
        val annexB4 = byteArrayOf(0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f)
        val annexB3 = byteArrayOf(0, 0, 1, 0x68, 0xce.toByte(), 0x3c, 0x80.toByte())
        val avcc = byteArrayOf(0, 0, 0, 4, 0x67, 0x42, 0x00, 0x1f)
        assertTrue(ReverseScreenStreamer.hasAnnexBPrefix(annexB4))
        assertTrue(ReverseScreenStreamer.hasAnnexBPrefix(annexB3))
        assertTrue(!ReverseScreenStreamer.hasAnnexBPrefix(avcc))
        assertTrue(ReverseScreenStreamer.normalizeNals(annexB4).contentEquals(annexB4))
        assertTrue(ReverseScreenStreamer.normalizeNals(avcc).contentEquals(annexB4))
    }
}
