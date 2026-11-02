package cn.linkspace.client.service

import cn.linkspace.client.service.ControlledInputInjector.Button
import cn.linkspace.client.service.ControlledInputInjector.MouseButtonTracker
import cn.linkspace.client.service.ControlledInputInjector.PressAction
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [MouseButtonTracker] 的配对语义单测（线 2 左右键映射）。
 * 纯 JVM：不碰 Android 框架。落点语义以走查清单 2.6 为准——
 * 左键点按/拖拽（TAP）、右键返回（BACK）、中键主页（HOME），
 * 动作在抬起时决议。
 */
class MouseButtonTrackerTest {

    @Test
    fun `left down up resolves to TAP`() {
        val t = MouseButtonTracker()
        assertTrue(t.onDown(Button.LEFT))
        assertEquals(Button.LEFT, t.heldButton)
        assertTrue(t.isLeftDown)
        assertTrue(t.trackMove())
        assertEquals(PressAction.TAP, t.onUp(Button.LEFT))
        assertNull(t.heldButton)
        assertFalse(t.isLeftDown)
    }

    @Test
    fun `right down up resolves to BACK`() {
        val t = MouseButtonTracker()
        assertTrue(t.onDown(Button.RIGHT))
        assertEquals(Button.RIGHT, t.heldButton)
        assertFalse(t.isLeftDown)
        // 右键按住期间的 move 不进拖拽轨迹
        assertFalse(t.trackMove())
        assertEquals(PressAction.BACK, t.onUp(Button.RIGHT))
        assertNull(t.heldButton)
    }

    @Test
    fun `middle down up resolves to HOME`() {
        val t = MouseButtonTracker()
        assertTrue(t.onDown(Button.MIDDLE))
        assertEquals(PressAction.HOME, t.onUp(Button.MIDDLE))
    }

    @Test
    fun `up without down is ignored`() {
        val t = MouseButtonTracker()
        assertNull(t.onUp(Button.LEFT))
        assertNull(t.onUp(Button.RIGHT))
        assertNull(t.onUp(Button.MIDDLE))
        assertNull(t.heldButton)
    }

    @Test
    fun `mismatched up is ignored and held button survives`() {
        val t = MouseButtonTracker()
        assertTrue(t.onDown(Button.LEFT))
        // 左键按住时抬起右键：忽略，左键拖拽不被破坏
        assertNull(t.onUp(Button.RIGHT))
        assertEquals(Button.LEFT, t.heldButton)
        assertTrue(t.isLeftDown)
        assertEquals(PressAction.TAP, t.onUp(Button.LEFT))
    }

    @Test
    fun `second down while held is rejected`() {
        val t = MouseButtonTracker()
        assertTrue(t.onDown(Button.RIGHT))
        assertFalse(t.onDown(Button.LEFT))
        assertFalse(t.onDown(Button.RIGHT))
        assertEquals(Button.RIGHT, t.heldButton)
        // 仍按第一次的键决议
        assertEquals(PressAction.BACK, t.onUp(Button.RIGHT))
    }

    @Test
    fun `reset clears held button`() {
        val t = MouseButtonTracker()
        assertTrue(t.onDown(Button.MIDDLE))
        t.reset()
        assertNull(t.heldButton)
        assertNull(t.onUp(Button.MIDDLE))
        assertTrue(t.onDown(Button.LEFT))
        assertEquals(PressAction.TAP, t.onUp(Button.LEFT))
    }
}
