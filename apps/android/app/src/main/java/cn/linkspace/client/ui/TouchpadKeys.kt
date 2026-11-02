package cn.linkspace.client.ui

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.linkspace.client.service.InputController

/**
 * 触控板 / 投屏共用的键鼠事件工具（从 MainActivity.kt 原样搬移，
 * 行为不动）。随 TouchpadScreen.kt 走，见 docs/ui-redesign-android.md §5。
 */

/** 协议常量的本包别名，避免与 Compose 命名冲突 */
internal const val PROTO_MAX_EVENTS = 64

/** 投屏触控回传：批量分段的发送封装，与 TouchpadScreen.send 同构 */
internal fun sendRemote(controller: InputController, events: List<org.json.JSONObject>) {
    events.chunked(PROTO_MAX_EVENTS).forEach { controller.sendEvents(it) }
}

/** 自绘键盘的键帽。modifier 由调用点带 RowScope.weight 决定行内宽度，active 为粘滞键高亮 */
@Composable
internal fun KeyCap(
    label: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    onClick: () -> Unit
) {
    FilledTonalButton(
        onClick = onClick,
        modifier = modifier.height(40.dp),
        colors = if (active) {
            ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.primary)
        } else {
            ButtonDefaults.filledTonalButtonColors()
        },
        contentPadding = PaddingValues(horizontal = 2.dp, vertical = 1.dp)
    ) {
        Text(
            label,
            fontSize = 12.sp,
            maxLines = 1,
            modifier = Modifier.fillMaxWidth(),
            textAlign = TextAlign.Center
        )
    }
}

/**
 * 文本框内容差分 → 键盘事件。
 * 追加 = 逐字符输入；变短 = 退格；整段替换 = 退格后重输。
 * 一次超过 64 条的批次由 [TouchpadScreen.send] 分段。
 */
internal fun diffToKeyEvents(
    last: String,
    new: String,
    typeChar: (Char) -> List<org.json.JSONObject>
): List<org.json.JSONObject> {
    val events = mutableListOf<org.json.JSONObject>()
    val backspace = listOf(InputController.key(0x08, true), InputController.key(0x08, false))
    when {
        new.length > last.length && new.startsWith(last) ->
            new.substring(last.length).forEach { events += typeChar(it) }
        new.length < last.length && last.startsWith(new) ->
            repeat((last.length - new.length).coerceAtMost(64)) { events += backspace }
        else -> {
            repeat(last.length.coerceAtMost(32)) { events += backspace }
            new.take(32).forEach { events += typeChar(it) }
        }
    }
    return events
}

/**
 * 字符 → Windows 虚拟键码（美式键盘布局），second 表示是否需要 Shift。
 * 映射表覆盖 ASCII 可打印字符与常用控制键；中文等 IME 内容返回 vk=0，
 * 宁可跳过也不猜——错误键码会直接打到电脑上。
 */
internal object Vk {
    private val shifted = mapOf(
        '!' to (0x31 to true), '@' to (0x32 to true), '#' to (0x33 to true), '$' to (0x34 to true),
        '%' to (0x35 to true), '^' to (0x36 to true), '&' to (0x37 to true), '*' to (0x38 to true),
        '(' to (0x39 to true), ')' to (0x30 to true), '`' to (0xC0 to false), '~' to (0xC0 to true),
        '-' to (0xBD to false), '_' to (0xBD to true), '=' to (0xBB to false), '+' to (0xBB to true),
        '[' to (0xDB to false), '{' to (0xDB to true), ']' to (0xDD to false), '}' to (0xDD to true),
        '\\' to (0xDC to false), '|' to (0xDC to true), ';' to (0xBA to false), ':' to (0xBA to true),
        '\'' to (0xDE to false), '"' to (0xDE to true), ',' to (0xBC to false), '<' to (0xBC to true),
        '.' to (0xBE to false), '>' to (0xBE to true), '/' to (0xBF to false), '?' to (0xBF to true)
    )

    fun forChar(c: Char): Pair<Int, Boolean> = when (c) {
        in 'a'..'z' -> (0x41 + (c - 'a')) to false
        in 'A'..'Z' -> (0x41 + (c - 'A')) to true
        in '0'..'9' -> (0x30 + (c - '0')) to false
        ' ' -> 0x20 to false
        '\n', '\r' -> 0x0D to false
        '\t' -> 0x09 to false
        else -> shifted[c] ?: (0x00 to false)
    }
}
