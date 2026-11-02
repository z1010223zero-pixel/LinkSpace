package cn.linkspace.client

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.linkspace.client.ui.LinkSpaceShapes
import cn.linkspace.client.ui.LinkSpaceSpacing
import kotlin.math.abs
import kotlin.math.roundToInt

/** 小球直径 52dp（用户 2026-10-31“右上角按钮点不到”重做方案的尺寸，不动）。 */
private val PillSize = 52.dp

/** 菜单宽 190dp。 */
private val PillMenuWidth = 190.dp

/**
 * 投屏悬浮控制球（ToDesk 式交互，用户 2026-10-31 提出「右上角按钮经常
 * 点不到」后重做）：
 * - 小球可拖动到屏幕任意位置，松手自动吸附到最近左右边缘——永远不会
 *   被系统状态栏遮挡，也不挡常看区域
 * - 点按小球展开控制菜单（触控模式切换 / 退出投屏），菜单项为大号
 *   Surface，hit 区远大于此前的文字按钮
 * - 球面字标随模式变化：「指」= 点哪指哪，「跟」= 滑动跟随
 *
 * B 线 token 收敛（2026-11-02）：圆角 / 尺寸 / 字号改接 LinkSpaceTheme（小球专属尺寸留本文件私有常量）；
 * 颜色改走 ScreenMirrorScreen 深色 token 包裹内的 MaterialTheme
 * （surface / onSurface，画面窗口深色 token 的实际形态），
 * 黑 / 白字面值不变，可拖动吸附与菜单行为一律不动。
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
    val pillPx = with(density) { PillSize.toPx().roundToInt() }
    val marginPx = with(density) { LinkSpaceSpacing.sm.toPx().roundToInt() }

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
                shape = LinkSpaceShapes.large,
                color = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
                shadowElevation = 6.dp,
                modifier = Modifier
                    .offset {
                        IntOffset(
                            (offset.x - with(density) { PillMenuWidth.toPx().roundToInt() })
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
                .size(PillSize)
                .background(MaterialTheme.colorScheme.surface.copy(alpha = 0.55f), CircleShape)
                .border(1.dp, MaterialTheme.colorScheme.onSurface.copy(alpha = 0.5f), CircleShape)
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
                color = MaterialTheme.colorScheme.onSurface,
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
            color = MaterialTheme.colorScheme.onSurface.copy(alpha = 0.6f),
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
        shape = LinkSpaceShapes.medium,
        modifier = Modifier.fillMaxWidth()
    ) {
        Text(
            label,
            color = MaterialTheme.colorScheme.onSurface,
            fontSize = 14.sp,
            modifier = Modifier
                .padding(horizontal = 14.dp, vertical = 12.dp)
                .fillMaxWidth()
        )
    }
}
