package cn.linkspace.client

import androidx.compose.ui.geometry.Rect
import cn.linkspace.client.ui.letterboxRect
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 投屏 letterbox 等比渲染的几何计算单测（B-2）。
 *
 * 流（如 1920x1200）渲染进宽高比不同的容器（平板 2000x3200 竖屏）时，
 * 显示矩形必须等比缩放、居中、黑边留白；触控映射以该矩形为基准、
 * 黑边触点 clamp 到边缘。几何错了就是画面变形或触点漂移。
 */
class LetterboxRectTest {

    @Test
    fun `竖屏容器放横视频 - 上下留黑边居中`() {
        // 容器 2000x3200（竖屏），视频 1920x1200（横屏）：
        // 按宽度适配 scale=2000/1920≈1.042，显示 2000x1250，上下各留 (3200-1250)/2
        val r = letterboxRect(2000, 3200, 1920, 1200)
        assertEquals(2000f, r.width)
        assertEquals(1250f, r.height)
        assertEquals(0f, r.left)
        assertEquals(975f, r.top)
    }

    @Test
    fun `横屏容器放竖视频 - 左右留黑边居中`() {
        // 容器 3200x2000（横），视频 1200x1920（竖）：按高度适配 scale=2000/1920
        val r = letterboxRect(3200, 2000, 1200, 1920)
        assertEquals(1250f, r.width)
        assertEquals(2000f, r.height)
        assertEquals((3200 - 1250) / 2f, r.left)
        assertEquals(0f, r.top)
    }

    @Test
    fun `同宽高比 - 完全铺满无黑边`() {
        val r = letterboxRect(2000, 3200, 1000, 1600)
        assertEquals(2000f, r.width)
        assertEquals(3200f, r.height)
        assertEquals(0f, r.left)
        assertEquals(0f, r.top)
    }

    @Test
    fun `非法尺寸返回零矩形 - UI 据此暂不渲染`() {
        assertTrue(letterboxRect(0, 100, 1920, 1080).isEmpty)
        assertTrue(letterboxRect(100, 100, 0, 0).isEmpty)
        assertTrue(letterboxRect(-5, -5, 100, 100).isEmpty)
    }

    @Test
    fun `显示矩形保视频宽高比（不拉伸变形）`() {
        // 1.6 宽高比的视频在任何容器里显示矩形都应是 1.6
        listOf(
            letterboxRect(2000, 3200, 1920, 1200),
            letterboxRect(3200, 2000, 1920, 1200),
            letterboxRect(1080, 1080, 1920, 1200)
        ).forEach { r ->
            assertEquals(1.6f, r.width / r.height, 0.01f)
        }
    }

    @Test
    fun `触控映射 - 黑边触点 clamp 后落在视频坐标系内`() {
        // 竖屏容器 2000x3200、视频 1920x1200：触点在视频上方的黑边（y=500）
        // 应被 clamp 到视频顶边，换算出的会话坐标 y=0
        val r = letterboxRect(2000, 3200, 1920, 1200)
        val sessionW = 2880
        val sessionH = 1800
        val vx = (500f - r.left).coerceIn(0f, r.width)
        val vy = (500f - r.top).coerceIn(0f, r.height)
        assertEquals(0f, vy)
        val sx = (vx / r.width * sessionW).toInt()
        val sy = (vy / r.height * sessionH).toInt()
        assertTrue(sx in 0 until sessionW)
        assertEquals(0, sy)
    }
}
