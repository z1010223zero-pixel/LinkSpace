package cn.linkspace.client.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.layout.onSizeChanged
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.FloatingControlPill
import cn.linkspace.client.StreamView
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService
import kotlin.math.roundToInt

/**
 * 投屏画面：桌面虚拟屏的视频流全屏渲染，触摸按画面比例映射为绝对
 * 坐标事件回传（与键鼠注入同一基准，无需额外换算）。
 * 从 MainActivity.kt 原样搬移（docs/ui-redesign-android.md §5），
 * 触控与手势逻辑不动；B 线只加一层表现：根部包局部深色 token
 * （docs/ui-redesign-android.md §2.1：只包 ScreenMirrorScreen，
 * 不做全局深色模式；此前靠硬编码 Color.Black 撑场）。
 * 标题栏见 [StreamTopBar]：设备名 · 画质徽章常驻，工具栏默认折叠；
 * 延迟位等服务层补字段后再填数，不编造。
 *
 * 手势语义（VNC 惯例）：
 *   - 单指滑动 = 移动光标（绝对坐标，无按键）
 *   - 轻点（<250ms 无位移）= 左键单击
 *   - 静置 300ms 后拖动 = 按住左键拖拽（抬起释放）
 *   - 双指滑动 = 滚轮
 */
@Composable
fun ScreenMirrorScreen(
    service: LinkSpaceService,
    info: LinkSpaceService.ScreenStreamInfo,
    clipboardEnabled: Boolean,
    onClipboardToggle: (Boolean) -> Unit
) {
    val controller = service.input
    val scrollAccum = remember { floatArrayOf(0f) }
    // 会话声明的本机屏幕（触控坐标空间基准，来自 session.accept）
    val inputState by service.inputState.collectAsStateWithLifecycle()
    // 标题栏设备名：已信任列表里按 peerId 查显示名，查不到就显示原始 peerId
    //（与首页反向推流卡同一口径）；peerId 为空时退回“电脑”。
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val peerName = inputState.peerId?.let { peerId ->
        trusted.firstOrNull { it.deviceId == peerId }?.displayName ?: peerId
    } ?: "电脑"
    // 触控模式：false=点哪指哪（绝对映射）；true=滑动跟随（触控板语义，
    // 用户 2026-10-31 提出可切换）
    var relativeMode by remember { mutableStateOf(false) }
    val streamScaleWidth by service.streamScaleWidth.collectAsStateWithLifecycle()
    val density = LocalDensity.current

    // letterbox：容器尺寸 + 视频显示矩形（等比缩放置中，黑边留白）
    var containerPx by remember { mutableStateOf(androidx.compose.ui.unit.IntSize.Zero) }
    val videoRect = remember(info.w, info.h, containerPx) {
        letterboxRect(containerPx.width, containerPx.height, info.w, info.h)
    }

    // 投屏观看期间保持亮屏：熄屏会销毁渲染面（SurfaceView 随窗口失效）
    // 并让解码线程断流退出——看一半黑掉是最差的失败形态
    val activity = LocalContext.current as? android.app.Activity
    // 触控映射基准 = 本端在 session.start 里申报的屏幕（与桌面 mapPoint
    // 的 from 严格一致）；会话未建时退回当前 metrics
    val ownScreen = inputState.ownScreen ?: run {
        val m = LocalContext.current.resources.displayMetrics
        InputController.Screen(m.widthPixels.coerceAtLeast(1), m.heightPixels.coerceAtLeast(1))
    }
    DisposableEffect(activity) {
        val window = activity?.window
        window?.addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        onDispose {
            window?.clearFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        }
    }

    MaterialTheme(colorScheme = StreamTokens.DarkStreamScheme) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .onSizeChanged { containerPx = it }
        ) {
            if (videoRect.width > 0 && videoRect.height > 0) {
                // 自绘 StreamView：解码器（ByteBuffer 模式）产出 Bitmap 直投，
                // 无 surface 生命周期——本 ROM surface 模式解码活锁，见
                // StreamDecoder 类注释（2026-10-31 绿块排障定论）
                val cursorFraction by service.cursorFraction.collectAsStateWithLifecycle()
                AndroidView(
                    factory = { ctx ->
                        StreamView(ctx).also { service.attachStreamView(it) }
                    },
                    update = { it.setCursor(cursorFraction?.first ?: -1f, cursorFraction?.second ?: -1f) },
                    onRelease = { service.attachStreamView(null) },
                    modifier = Modifier
                        .align(Alignment.Center)
                        .size(
                            with(density) { videoRect.width.toDp() },
                            with(density) { videoRect.height.toDp() }
                        )
                )
            }
            // 触控层盖在画面上（SurfaceView 不消费触摸，事件到 Compose）；
            // 触点先折算进视频显示矩形（黑边 clamp 到边缘），再按比例进会话坐标空间
            Box(
                Modifier
                    .fillMaxSize()
                    .pointerInput(info, videoRect) {
                        awaitPointerEventScope {
                            var downAt = 0L
                            var moved = false
                            var dragArmed = false
                            // 触控坐标空间 = **本机在 session.start 里声明的屏幕**
                            // （桌面 mapPoint 以它为 from 换算到目标屏）——与触控板
                            // 同一空间，不是对端的屏幕/解码尺寸（此前误用
                            // remoteScreen，落点按倍数缩放全偏，用户实测）
                            val sessionScreen = ownScreen
                            // move 攒批（触控板同款：16 条或 30ms 合并），点按/
                            // 拖拽/滚轮前 flush 保序
                            val moveBatch = mutableListOf<org.json.JSONObject>()
                            var lastFlushAt = 0L
                            fun flushMoves() {
                                if (moveBatch.isNotEmpty()) {
                                    sendRemote(controller, moveBatch)
                                    moveBatch.clear()
                                }
                                lastFlushAt = System.currentTimeMillis()
                            }
                            // 相对模式的虚拟光标（触摸即触控板：滑动=相对移动，
                            // 抬起再触从当前位置继续，绝不跳位）
                            var relX = sessionScreen.w / 2f
                            var relY = sessionScreen.h / 2f
                            while (true) {
                                val event = awaitPointerEvent()
                                val pressed = event.changes.filter { it.pressed }
                                if (pressed.size >= 2) {
                                    flushMoves()
                                    var dy = 0f
                                    pressed.forEach { dy += it.positionChange().y }
                                    scrollAccum[0] += dy / pressed.size
                                    while (kotlin.math.abs(scrollAccum[0]) >= 48f) {
                                        val tick = if (scrollAccum[0] > 0) -1 else 1
                                        sendRemote(
                                            controller,
                                            listOf(InputController.wheel(0, tick))
                                        )
                                        scrollAccum[0] -= tick * 48f
                                    }
                                    event.changes.forEach {
                                        if (it.positionChange() != androidx.compose.ui.geometry.Offset.Zero) it.consume()
                                    }
                                } else if (pressed.size == 1) {
                                    val c = pressed.first()
                                    if (c.changedToDown()) {
                                        flushMoves()
                                        downAt = System.currentTimeMillis()
                                        moved = false
                                        dragArmed = false
                                        // 绝对模式必须在 down 时先落点：否则轻点
                                        // 只会把旧光标位置处的 down/up 发出去，
                                        // 用户看到的是“点了但点在别处”。落点
                                        // 后 up 才是真正的“点哪指哪”。
                                        if (!relativeMode) {
                                            val vx = (c.position.x - videoRect.left).coerceIn(0f, videoRect.width)
                                            val vy = (c.position.y - videoRect.top).coerceIn(0f, videoRect.height)
                                            sendRemote(
                                                controller,
                                                listOf(
                                                    InputController.move(
                                                        (vx / videoRect.width * sessionScreen.w).toInt()
                                                            .coerceIn(0, sessionScreen.w - 1),
                                                        (vy / videoRect.height * sessionScreen.h).toInt()
                                                            .coerceIn(0, sessionScreen.h - 1)
                                                    )
                                                )
                                            )
                                        }
                                    }
                                    val delta = c.positionChange()
                                    if (delta != androidx.compose.ui.geometry.Offset.Zero) {
                                        moved = moved || kotlin.math.abs(delta.x) > 2f || kotlin.math.abs(delta.y) > 2f
                                        // 静置长按后进入拖拽：一次 down(left)，此后 move 都带按键
                                        if (!dragArmed && !moved && System.currentTimeMillis() - downAt > 300) {
                                            flushMoves()
                                            dragArmed = true
                                            sendRemote(controller, listOf(InputController.down("left")))
                                        }
                                        if (relativeMode) {
                                            // 相对模式：位移×灵敏度累积进虚拟光标，
                                            // 不跳位（ToDesk 触摸同款）
                                            relX = (relX + delta.x * 2.5f)
                                                .coerceIn(0f, (sessionScreen.w - 1).toFloat())
                                            relY = (relY + delta.y * 2.5f)
                                                .coerceIn(0f, (sessionScreen.h - 1).toFloat())
                                            moveBatch.add(InputController.move(relX.toInt(), relY.toInt()))
                                        } else {
                                            // 绝对模式：黑边 clamp 后触点按比例进会话空间
                                            val vx = (c.position.x - videoRect.left).coerceIn(0f, videoRect.width)
                                            val vy = (c.position.y - videoRect.top).coerceIn(0f, videoRect.height)
                                            moveBatch.add(
                                                InputController.move(
                                                    (vx / videoRect.width * sessionScreen.w).toInt()
                                                        .coerceIn(0, sessionScreen.w - 1),
                                                    (vy / videoRect.height * sessionScreen.h).toInt()
                                                        .coerceIn(0, sessionScreen.h - 1)
                                                )
                                            )
                                        }
                                        val now = System.currentTimeMillis()
                                        if (moveBatch.size >= 16 || now - lastFlushAt >= 30) flushMoves()
                                        c.consume()
                                    }
                                } else {
                                    flushMoves()
                                    val up = event.changes.firstOrNull { it.changedToUp() }
                                    if (up != null) {
                                        if (dragArmed) {
                                            sendRemote(controller, listOf(InputController.up("left")))
                                        } else if (System.currentTimeMillis() - downAt < 250 && !moved) {
                                            // 轻点=左键单击：绝对模式光标已被前面的
                                            // move 带到触点；相对模式光标在原位（无跳位）
                                            sendRemote(
                                                controller,
                                                listOf(InputController.down("left"), InputController.up("left"))
                                            )
                                        }
                                    }
                                    scrollAccum[0] = 0f
                                }
                            }
                        }
                    }
            )
            // 常驻标题栏（B 线新增，审计问题 7/14 的缺口）：设备名 · 画质徽章
            // + chevron + 关闭；工具栏默认折叠。标题栏在触控层之上，
            // 其按钮先消费触摸；栏面空白处触摸会透传到触控层（仍移动光标）。
            StreamTopBar(
                deviceName = peerName,
                scaleWidth = streamScaleWidth,
                // latencyText 暂不传：服务层无延迟字段，见 StreamTopBar 头注释
                relativeMode = relativeMode,
                onToggleMode = { relativeMode = !relativeMode },
                clipboardEnabled = clipboardEnabled,
                onClipboardToggle = onClipboardToggle,
                onSelectScaleWidth = { width ->
                    service.requestScreenStream(displayIndex = -1, scaleWidth = width)
                },
                onClose = { service.stopScreenStream() },
                modifier = Modifier.align(Alignment.TopCenter)
            )
            // 悬浮控制球（ToDesk 式）：拖动可停靠任意位置，点按展开菜单。
            // 独立 hit 区 + 可拖离屏幕边缘，不受系统状态栏/触控层遮挡
            FloatingControlPill(
                relativeMode = relativeMode,
                onToggleMode = { relativeMode = !relativeMode },
                scaleWidth = streamScaleWidth,
                onSelectScaleWidth = { width -> service.requestScreenStream(displayIndex = -1, scaleWidth = width) },
                onExit = { service.stopScreenStream() },
                modifier = Modifier.align(Alignment.TopEnd)
            )
        }
    }
}

/**
 * letterbox 等比缩放置中：视频按宽高比适配容器，返回其在容器内的
 * 显示矩形（居中，黑边留白）。任一维度非法时返回 Rect.Zero（UI 据此
 * 暂不渲染 Surface）。
 */
internal fun letterboxRect(cw: Int, ch: Int, vw: Int, vh: Int): androidx.compose.ui.geometry.Rect {
    if (cw <= 0 || ch <= 0 || vw <= 0 || vh <= 0) return androidx.compose.ui.geometry.Rect.Zero
    val scale = minOf(cw.toFloat() / vw, ch.toFloat() / vh)
    // round 而非截断：浮点误差会把整尺寸算成 N-1（2000/1920×1920 → 1999.9999），
    // 截断丢一行像素且触控映射的除数随之偏移
    val w = (vw * scale).roundToInt().coerceAtLeast(1)
    val h = (vh * scale).roundToInt().coerceAtLeast(1)
    val left = (cw - w) / 2
    val top = (ch - h) / 2
    return androidx.compose.ui.geometry.Rect(
        left.toFloat(), top.toFloat(), (left + w).toFloat(), (top + h).toFloat()
    )
}
