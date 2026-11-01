package cn.linkspace.client

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.gestures.detectDragGestures
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import kotlin.math.abs
import kotlin.math.roundToInt

/**
 * 投屏悬浮控制球（ToDesk 式交互，用户 2026-10-31 提出「右上角按钮经常
 * 点不到」后重做）：
 * - 小球可拖动到屏幕任意位置，松手自动吸附到最近左右边缘——永远不会
 *   被系统状态栏遮挡，也不挡常看区域
 * - 点按小球展开控制菜单（触控模式切换 / 退出投屏），菜单项为大号
 *   Surface，hit 区远大于此前的文字按钮
 * - 球面字标随模式变化：「指」= 点哪指哪，「跟」= 滑动跟随
 */
@Composable
fun FloatingControlPill(
    relativeMode: Boolean,
    onToggleMode: () -> Unit,
    scaleWidth: Int,
    onSelectScaleWidth: (Int) -> Unit,
    onExit: () -> Unit,
    modifier: Modifier = Modifier
) {
    val density = LocalDensity.current
    val pillPx = with(density) { 52.dp.toPx().roundToInt() }
    val marginPx = with(density) { 8.dp.toPx().roundToInt() }

    var offset by remember { mutableStateOf(IntOffset(-1, -1)) } // x=-1 未初始化
    var menuExpanded by remember { mutableStateOf(false) }
    var dragMoved by remember { mutableStateOf(false) }
    var containerSize by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }

    fun clampTo(pos: IntOffset): IntOffset {
        if (containerSize.width <= 0) return pos
        return IntOffset(
            pos.x.coerceIn(marginPx, (containerSize.width - pillPx - marginPx).coerceAtLeast(marginPx)),
            pos.y.coerceIn(marginPx, (containerSize.height - pillPx - marginPx).coerceAtLeast(marginPx))
        )
    }

    Box(
        modifier
            .fillMaxSize()
            .onSizeChanged { containerSize = it }
    ) {
        // 首次位置：右上角、状态栏下方
        if (offset.x < 0 && containerSize.width > 0) {
            offset = clampTo(
                IntOffset(containerSize.width - pillPx - marginPx, with(density) { 64.dp.toPx().roundToInt() })
            )
        }

        // 菜单：贴在小球左侧
        if (menuExpanded && offset.x >= 0) {
            Surface(
                shape = RoundedCornerShape(12.dp),
                color = Color.Black.copy(alpha = 0.85f),
                shadowElevation = 6.dp,
                modifier = Modifier
                    .offset {
                        IntOffset(
                            (offset.x - with(density) { 190.dp.toPx().roundToInt() })
                                .coerceAtLeast(marginPx),
                            offset.y
                        )
                    }
            ) {
                Column(Modifier.padding(6.dp)) {
                    MenuAction(
                        label = if (relativeMode) "触控：滑动跟随 ✓" else "触控：点哪指哪 ✓",
                        onClick = {
                            onToggleMode()
                            menuExpanded = false
                        }
                    )
                    ResolutionMenu(
                        currentWidth = scaleWidth,
                        onSelect = { width ->
                            onSelectScaleWidth(width)
                            menuExpanded = false
                        }
                    )
                    MenuAction(label = "退出投屏", onClick = {
                        onExit()
                        menuExpanded = false
                    })
                }
            }
        }

        // 小球本体
        Box(
            Modifier
                .offset { IntOffset(offset.x.coerceAtLeast(marginPx), offset.y.coerceAtLeast(marginPx)) }
                .size(52.dp)
                .background(Color.Black.copy(alpha = 0.55f), CircleShape)
                .border(1.dp, Color.White.copy(alpha = 0.5f), CircleShape)
                .pointerInput(containerSize) {
                    awaitPointerEventScope {
                        var startTouch = Offset.Zero
                        var startOffset = Offset.Zero
                        while (true) {
                            val ev = awaitPointerEvent()
                            val c = ev.changes.firstOrNull() ?: continue
                            if (c.changedToDown()) {
                                startTouch = c.position
                                startOffset = Offset(offset.x.toFloat(), offset.y.toFloat())
                                dragMoved = false
                            }
                            val delta = c.positionChange()
                            if (c.pressed && delta != Offset.Zero) {
                                if (!dragMoved &&
                                    (abs(c.position.x - startTouch.x) > 12f ||
                                        abs(c.position.y - startTouch.y) > 12f)
                                ) {
                                    dragMoved = true
                                }
                                if (dragMoved) {
                                    offset = clampTo(
                                        IntOffset(
                                            startOffset.x.roundToInt() + (c.position.x - startTouch.x).roundToInt(),
                                            startOffset.y.roundToInt() + (c.position.y - startTouch.y).roundToInt()
                                        )
                                    )
                                }
                                c.consume()
                            }
                            if (c.changedToUp()) {
                                if (!dragMoved) {
                                    menuExpanded = !menuExpanded
                                } else {
                                    // 吸附到最近左右边缘
                                    val dockLeft = offset.x < (containerSize.width - pillPx) / 2
                                    offset = IntOffset(
                                        if (dockLeft) marginPx else containerSize.width - pillPx - marginPx,
                                        offset.y
                                    )
                                }
                                c.consume()
                            }
                        }
                    }
                },
            contentAlignment = Alignment.Center
        ) {
            Text(
                if (relativeMode) "跟" else "指",
                color = Color.White,
                fontSize = 20.sp,
                fontWeight = androidx.compose.ui.text.font.FontWeight.Bold
            )
        }
    }
}

private val RESOLUTION_OPTIONS = listOf(
    "720p" to 1280,
    "1080p" to 1920,
    "1440p" to 2560,
    "2160p" to 3840
)

@Composable
private fun ResolutionMenu(
    currentWidth: Int,
    onSelect: (Int) -> Unit
) {
    Column {
        Text(
            "分辨率",
            color = Color.White.copy(alpha = 0.6f),
            fontSize = 12.sp,
            modifier = Modifier.padding(horizontal = 14.dp, vertical = 4.dp)
        )
        RESOLUTION_OPTIONS.forEach { (label, width) ->
            MenuAction(
                label = if (width == currentWidth) "$label ✓" else label,
                onClick = { onSelect(width) }
            )
        }
    }
}

@Composable
private fun MenuAction(label: String, onClick: () -> Unit) {
    Surface(
        color = Color.Transparent,
        onClick = onClick,
        shape = RoundedCornerShape(8.dp),
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            label,
            color = Color.White,
            fontSize = 15.sp,
            modifier = Modifier
                .padding(horizontal = 14.dp, vertical = 12.dp)
                .fillMaxWidth()
        )
    }
}
