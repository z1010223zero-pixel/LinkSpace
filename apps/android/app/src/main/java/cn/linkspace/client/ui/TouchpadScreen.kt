package cn.linkspace.client.ui

import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Slider
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService

/**
 * 触控板模式：Android 作为键鼠控制端（协议 4.6）。
 * 从 MainActivity.kt 原样搬移（docs/ui-redesign-android.md §5），
 * 逻辑与手势语义不动；B 线只做三处表现层改动：
 * 1. 触控板区保证最小高度 240dp（审计 §2 问题 15：横屏下纵向堆叠
 *    会把 weight(1f) 的触控板压得很小），见下方 Surface 的 defaultMinSize；
 * 2. 两处硬编码 Color.Gray 占位色改主题色 onSurfaceVariant（审计问题 22）；
 * 3. 多显示器选择弹窗移出标题行 Row 作用域，挂到屏根部（审计问题 16）。
 *
 * 交互约定：
 *   - 单指拖动 = 相对移动光标（本地虚拟光标按灵敏度累积，跨手势保持——
 *     抬起再按不跳点；协议仍发绝对坐标，桌面端零改动）
 *   - 轻点 = 左键单击；「按住拖拽」开关 = 左键保持按下
 *   - 双指拖动 = 滚轮（一档约 48px）
 *   - 文本框 = 键盘输入（美式布局字符映射，IME 中文跳过）；
 *     Ctrl/Alt 为粘滞修饰键，输一个字符即自动释放
 */
@Composable
fun TouchpadScreen(service: LinkSpaceService) {
    val controller = service.input
    val context = LocalContext.current

    // 事件坐标空间 = 请求时声明的本机屏幕尺寸，两者必须一致
    val metrics = remember { context.resources.displayMetrics }
    val screenW = remember { metrics.widthPixels.coerceAtLeast(1) }
    val screenH = remember { metrics.heightPixels.coerceAtLeast(1) }

    var dragLeft by remember { mutableStateOf(false) }
    var ctrlSticky by remember { mutableStateOf(false) }
    var altSticky by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    var scrollAccum by remember { mutableStateOf(0f) }

    // 相对移动的虚拟光标：初始在屏幕中央，跨手势保持（T7 走查：绝对映射
    // 导致「抬起再按从手指新位置开始」的滑移感 + 灵敏度被屏幕比例钉死）
    var curX by remember { mutableStateOf(screenW / 2f) }
    var curY by remember { mutableStateOf(screenH / 2f) }
    // 灵敏度可调并持久化（T7 走查：绝对映射下移动很慢且无法调节）
    val prefs = remember { context.getSharedPreferences("linkspace", Context.MODE_PRIVATE) }
    var sensitivity by remember {
        mutableStateOf(prefs.getFloat("touchpadSensitivity", 2.0f))
    }
    // 自绘键盘面板（可选展开）：系统 IME 的 composition 不可控
    var keyboardOpen by remember { mutableStateOf(false) }
    var shiftSticky by remember { mutableStateOf(false) }
    var numericLayer by remember { mutableStateOf(false) }

    fun send(events: List<org.json.JSONObject>) {
        // 每条消息上限 64 条（协议 4.6），分段发送
        events.chunked(PROTO_MAX_EVENTS).forEach { controller.sendEvents(it) }
    }

    fun typeChar(c: Char): List<org.json.JSONObject> {
        val pair = Vk.forChar(c)
        val vk = pair.first
        val needShift = pair.second
        if (vk == 0) return emptyList()
        val events = mutableListOf<org.json.JSONObject>()
        if (ctrlSticky) events += InputController.key(0x11, true)
        if (altSticky) events += InputController.key(0x12, true)
        if (needShift) events += InputController.key(0x10, true)
        events += InputController.key(vk, true)
        events += InputController.key(vk, false)
        if (needShift) events += InputController.key(0x10, false)
        if (altSticky) events += InputController.key(0x12, false)
        if (ctrlSticky) events += InputController.key(0x11, false)
        return events
    }

    // 多显示器选择器（B-2）：被控端回报清单即弹，选中后按该屏区域推流。
    // 原先嵌在下方标题行的 Row 作用域里，位置隐蔽；现挂到屏根部，行为不变。
    val displayChoices by service.streamDisplays.collectAsStateWithLifecycle()

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("正在控制电脑", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text(
                    "单指移动 · 轻点单击 · 双指滚动 · 下方输入文字",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Button(onClick = {
                if (dragLeft) {
                    send(listOf(InputController.up("left")))
                    dragLeft = false
                }
                controller.stop()
            }) { Text("结束控制") }

            // 屏幕投屏：桌面画面流到本机全屏显示，触点按画面比例直接
            // 映射成绝对坐标事件（寄生在当前键鼠会话内）
            OutlinedButton(onClick = { service.requestScreenStream() }) { Text("投屏") }
        }

        // ---------- 特殊按键行 ----------
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(vertical = 6.dp)) {
            FilledTonalButton(onClick = { send(listOf(InputController.key(0x1B, true), InputController.key(0x1B, false))) }) { Text("Esc") }
            FilledTonalButton(onClick = { send(InputController.tap(0x09)) }) { Text("Tab") }
            FilledTonalButton(onClick = { send(InputController.tap(0x0D)) }) { Text("Enter") }
            FilledTonalButton(onClick = { send(InputController.tap(0x08)) }) { Text("退格") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilledTonalButton(onClick = { send(InputController.tap(0x25)) }) { Text("←") }
            FilledTonalButton(onClick = { send(InputController.tap(0x26)) }) { Text("↑") }
            FilledTonalButton(onClick = { send(InputController.tap(0x28)) }) { Text("↓") }
            FilledTonalButton(onClick = { send(InputController.tap(0x27)) }) { Text("→") }
            Spacer(Modifier.weight(1f))
            FilledTonalButton(
                onClick = { keyboardOpen = !keyboardOpen },
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (keyboardOpen) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.secondaryContainer
                )
            ) { Text("键盘") }
            // 投屏粘贴（B-7）：文本框内容整段经 screen.paste 上屏——
            // vk 通道表达不了的中文从这里走
            FilledTonalButton(
                onClick = {
                    if (text.isNotEmpty()) {
                        service.sendScreenPaste(text)
                        text = ""
                    }
                }
            ) { Text("粘贴") }
            FilledTonalButton(
                onClick = { ctrlSticky = !ctrlSticky },
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (ctrlSticky) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.secondaryContainer
                )
            ) { Text("Ctrl") }
            FilledTonalButton(
                onClick = { altSticky = !altSticky },
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (altSticky) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.secondaryContainer
                )
            ) { Text("Alt") }
        }

        // ---------- 自绘键盘（可选展开）----------
        // 为什么不用上方文本框吃所有输入：系统输入法（豆包/搜狗）的
        // composition 在 String 重载的文本框上行为不可控——拼音逐字母
        // 下发到电脑、选字后整段退格重输还发不出中文；自绘键盘点击
        // 直接发键码，零 IME 依赖。文本框保留给英文 IME 用户
        if (keyboardOpen) {
            val rows = if (numericLayer) {
                listOf("1234567890", "@/#$&_+-()/", "*'\":;!?=")
            } else {
                listOf("qwertyuiop", "asdfghjkl", "zxcvbnm,.")
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                rows.forEachIndexed { ri, row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        when {
                            ri == 0 -> KeyCap(if (numericLayer) "ABC" else "123", Modifier.weight(1.2f), numericLayer) {
                                numericLayer = !numericLayer
                            }
                            ri == 1 -> KeyCap("⇧", Modifier.weight(1.2f), shiftSticky) { shiftSticky = !shiftSticky }
                            ri == 2 -> Spacer(Modifier.weight(1f))
                        }
                        row.forEach { ch ->
                            KeyCap(ch.uppercaseChar().toString(), Modifier.weight(1f)) {
                                val c = if (shiftSticky && ch in 'a'..'z') ch.uppercaseChar() else ch
                                send(typeChar(c))
                                // 单字符即释放粘滞键（与文本框路径同一语义）
                                shiftSticky = false
                                ctrlSticky = false
                                altSticky = false
                            }
                        }
                        when (ri) {
                            1 -> KeyCap("⌫", Modifier.weight(1.2f)) { send(listOf(InputController.key(0x08, true), InputController.key(0x08, false))) }
                            2 -> Spacer(Modifier.weight(1f))
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    KeyCap("空格", Modifier.weight(5f)) { send(typeChar(' ')) }
                    KeyCap("↵", Modifier.weight(1.5f)) { send(InputController.tap(0x0D)) }
                }
            }
        }

        // ---------- 文本输入（美式布局映射；中文等 IME 内容跳过） ----------
        BasicTextField(
            value = text,
            onValueChange = { new ->
                val events = diffToKeyEvents(text, new, ::typeChar)
                text = new
                // 输入即用掉粘滞修饰键
                ctrlSticky = false
                altSticky = false
                send(events)
            },
            modifier = Modifier.fillMaxWidth().height(44.dp).padding(vertical = 4.dp),
            textStyle = TextStyle(fontSize = 15.sp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
            decorationBox = { inner ->
                Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant) {
                    Box(Modifier.padding(horizontal = 10.dp, vertical = 10.dp)) {
                        if (text.isEmpty()) {
                            Text(
                                "在此输入文字（英文），将键入到电脑",
                                fontSize = 13.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        inner()
                    }
                }
            }
        )

        // ---------- 灵敏度调节（相对移动倍率，持久化） ----------
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("灵敏度", fontSize = 12.sp)
            Slider(
                value = sensitivity,
                onValueChange = {
                    sensitivity = it
                    prefs.edit().putFloat("touchpadSensitivity", it).apply()
                },
                valueRange = 0.5f..5f,
                modifier = Modifier.weight(1f).padding(horizontal = 10.dp)
            )
            Text("%.1fx".format(sensitivity), fontSize = 12.sp, modifier = Modifier.width(44.dp))
        }

        // ---------- 触控板 ----------
        // 横屏下纵向堆叠会把触控板压小：weight(1f) 占剩余高度之外，
        // 再保一个 240dp 最小高度（docs/ui-redesign-android.md §4.3 建议值）。
        // 目标机横屏高约 800dp 级时，自绘键盘展开也仍有约 300dp 触控区。
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier
                .weight(1f)
                .defaultMinSize(minHeight = 240.dp)
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        var downAt = 0L
                        var moved = false
                        var twoFinger = false
                        // move 攒批：每帧一条消息的话 TLS+TCP 开销会让指针
                        // 视觉卡顿（用户实测）。攒满 16 条或 30ms 合并发送，
                        // 一条消息多个事件由桌面一次 SendInput 注入。
                        // up/轻点/滚轮不攒——flush 保证 move 先于 click 落地
                        val moveBatch = mutableListOf<org.json.JSONObject>()
                        var lastFlushAt = 0L
                        fun flushMoves() {
                            if (moveBatch.isNotEmpty()) {
                                send(moveBatch)
                                moveBatch.clear()
                            }
                            lastFlushAt = System.currentTimeMillis()
                        }
                        while (true) {
                            val event = awaitPointerEvent()
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.size >= 2) {
                                flushMoves()
                                // 双指滚动：纵向位移累计成一档档的滚轮刻度。
                                // 上滑 = 内容向上 = 滚轮向上（Windows 正值 = 向上滚）
                                twoFinger = true
                                var dy = 0f
                                pressed.forEach { dy += it.positionChange().y }
                                scrollAccum += dy / pressed.size
                                while (kotlin.math.abs(scrollAccum) >= 48f) {
                                    val tick = if (scrollAccum > 0) -1 else 1
                                    send(listOf(InputController.wheel(0, tick)))
                                    scrollAccum -= tick * 48f
                                }
                                event.changes.forEach {
                                    if (it.positionChange() != androidx.compose.ui.geometry.Offset.Zero) it.consume()
                                }
                            } else if (pressed.size == 1) {
                                val c = pressed.first()
                                if (c.changedToDown()) twoFinger = false
                                if (!twoFinger) {
                                    if (c.changedToDown()) {
                                        downAt = System.currentTimeMillis()
                                        moved = false
                                    }
                                    val delta = c.positionChange()
                                    if (delta != androidx.compose.ui.geometry.Offset.Zero) {
                                        moved = moved || kotlin.math.abs(delta.x) > 2f ||
                                            kotlin.math.abs(delta.y) > 2f
                                        // 相对移动：位移 × 灵敏度累积进虚拟光标，
                                        // 手指抬起再按不重置（滑移修复）
                                        curX = (curX + delta.x * sensitivity)
                                            .coerceIn(0f, (screenW - 1).toFloat())
                                        curY = (curY + delta.y * sensitivity)
                                            .coerceIn(0f, (screenH - 1).toFloat())
                                        moveBatch.add(InputController.move(curX.toInt(), curY.toInt()))
                                        val now = System.currentTimeMillis()
                                        if (moveBatch.size >= 16 || now - lastFlushAt >= 30) flushMoves()
                                        c.consume()
                                    }
                                }
                            } else {
                                // 全部抬起：先发掉攒着的 move 再判轻点（保序）——
                                // 抬起帧 pressed=0，轻点判定放在 pressed.size==1
                                // 分支里永远不可达（移交清单 Bug1 死代码）
                                flushMoves()
                                val up = event.changes.firstOrNull { it.changedToUp() }
                                if (up != null && !twoFinger &&
                                    System.currentTimeMillis() - downAt < 250 && !moved
                                ) {
                                    send(listOf(InputController.down("left"), InputController.up("left")))
                                }
                                twoFinger = false
                                scrollAccum = 0f
                            }
                        }
                    }
                }
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("触控板", color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }

        // ---------- 鼠标键 ----------
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                modifier = Modifier.weight(1f),
                onClick = { send(listOf(InputController.down("left"), InputController.up("left"))) }
            ) { Text("左键") }
            Button(
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (dragLeft) MaterialTheme.colorScheme.tertiary
                    else MaterialTheme.colorScheme.primary
                ),
                onClick = {
                    if (dragLeft) {
                        send(listOf(InputController.up("left")))
                    } else {
                        send(listOf(InputController.down("left")))
                    }
                    dragLeft = !dragLeft
                }
            ) { Text(if (dragLeft) "松开拖拽" else "按住拖拽") }
            Button(
                modifier = Modifier.weight(1f),
                onClick = { send(listOf(InputController.down("right"), InputController.up("right"))) }
            ) { Text("右键") }
        }
    }

    // ---------- 多显示器选择 ----------
    // 原先嵌在标题行 Row 里（审计问题 16）；现挂到屏根部，行为不变。
    if (displayChoices.isNotEmpty()) {
        AlertDialog(
            onDismissRequest = { service.clearStreamDisplays() },
            title = { Text("选择要投屏的显示器") },
            text = {
                Column {
                    displayChoices.forEachIndexed { index, d ->
                        TextButton(
                            onClick = {
                                service.clearStreamDisplays()
                                service.requestScreenStream(index)
                            }
                        ) { Text("显示器 ${index + 1}（${d.w}x${d.h}）") }
                    }
                }
            },
            confirmButton = {},
            dismissButton = {
                OutlinedButton(onClick = { service.clearStreamDisplays() }) { Text("取消") }
            }
        )
    }
}
