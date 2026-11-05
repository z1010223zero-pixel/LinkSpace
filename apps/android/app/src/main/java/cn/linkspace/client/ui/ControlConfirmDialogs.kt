package cn.linkspace.client.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import cn.linkspace.client.service.ControlledInputSession
import cn.linkspace.client.service.ReverseScreenStreamer
import kotlinx.coroutines.delay

/**
 * 控制 / 反向投屏确认弹窗的倒计时（B 线，ToDesk 对标：
 * 被控端确认弹窗须写清谁在连、给倒计时、注明“单次有效”；
 * 截图见 android-research.md §2.3(4)，42 秒倒计时 + “此授权单次有效”）。
 * 控制请求 30 秒，反向投屏 90 秒（须覆盖 LinkSpace 同意框 + 系统录屏授权框两次确认）。
 *
 * 倒计时只做展示，超时拒绝以服务侧 TTL 为准：
 * 控制请求用 [ControlledInputSession.ControlRequest.expiresAt]（绝对时间），
 * 反向投屏用 [ReverseScreenStreamer.ReverseStreamRequest.requestedAt] +
 * [ReverseScreenStreamer.REQUEST_TTL_MS]；服务侧到时自动拒绝，弹窗随状态消失。
 */

/** 距 deadline 的剩余整秒（向上取整，刚弹出时显示满格而不是少 1），每秒重算。 */
@Composable
private fun rememberTtlRemainingSeconds(deadlineEpochMs: Long, totalSeconds: Int): Int {
    fun remaining(): Int =
        ((deadlineEpochMs - System.currentTimeMillis() + 999) / 1000)
            .toInt().coerceIn(0, totalSeconds)

    var seconds by remember(deadlineEpochMs) { mutableStateOf(remaining()) }
    LaunchedEffect(deadlineEpochMs) {
        while (seconds > 0) {
            delay(1000)
            seconds = remaining()
        }
    }
    return seconds
}

@Composable
private fun TtlCountdownRow(seconds: Int, totalSeconds: Int, timeoutText: String) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "还剩 $seconds 秒，$timeoutText",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        LinearProgressIndicator(
            progress = { seconds.toFloat() / totalSeconds },
            modifier = Modifier.fillMaxWidth()
        )
    }
}

private data class DurationOption(val label: String, val durationMs: Long)

private val NO_CONFIRM_DURATION_OPTIONS = listOf(
    DurationOption("仅本次", 0L),
    DurationOption("1天", 1L * 86_400_000L),
    DurationOption("3天", 3L * 86_400_000L),
    DurationOption("7天", 7L * 86_400_000L),
    DurationOption("30天", 30L * 86_400_000L),
    DurationOption("永久", -1L)
)

@Composable
private fun NoConfirmDurationSelector(
    selectedMs: Long,
    onSelect: (Long) -> Unit
) {
    Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
        Text(
            "免确认有效期（有效期内再次连接无需弹窗确认）：",
            fontSize = 12.sp,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        NO_CONFIRM_DURATION_OPTIONS.chunked(3).forEach { rowItems ->
            Row(
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                modifier = Modifier.fillMaxWidth()
            ) {
                rowItems.forEach { opt ->
                    val selected = selectedMs == opt.durationMs
                    if (selected) {
                        Button(
                            onClick = { onSelect(opt.durationMs) },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(opt.label, fontSize = 12.sp)
                        }
                    } else {
                        OutlinedButton(
                            onClick = { onSelect(opt.durationMs) },
                            modifier = Modifier.weight(1f)
                        ) {
                            Text(opt.label, fontSize = 12.sp)
                        }
                    }
                }
            }
        }
    }
}

/**
 * 电脑请求控制本机：确认弹窗（协议 9.1）。
 * 支持选择免确认有效期（仅本次 / 1天 / 3天 / 7天 / 30天 / 永久）。
 */
@Composable
fun ControlRequestDialog(
    req: ControlledInputSession.ControlRequest,
    onApprove: (durationMs: Long) -> Unit,
    onDeny: () -> Unit
) {
    val totalSeconds = (ControlledInputSession.REQUEST_TTL_MS / 1000).toInt()
    val seconds = rememberTtlRemainingSeconds(req.expiresAt, totalSeconds)
    var selectedDurationMs by remember { mutableStateOf(7L * 86_400_000L) }
    AlertDialog(
        onDismissRequest = onDeny,
        title = { Text("允许远程控制本机？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("“${req.displayName.ifEmpty { req.peerId }}”请求在电脑上操作这台平板（点按、滑动、按键）。")
                NoConfirmDurationSelector(
                    selectedMs = selectedDurationMs,
                    onSelect = { selectedDurationMs = it }
                )
                Spacer(Modifier.height(4.dp))
                TtlCountdownRow(seconds, totalSeconds, "超时自动拒绝")
            }
        },
        confirmButton = {
            Button(onClick = { onApprove(selectedDurationMs) }) { Text("允许") }
        },
        dismissButton = {
            OutlinedButton(onClick = onDeny) { Text("拒绝（${seconds}s）") }
        }
    )
}

/**
 * 反向投屏请求：电脑想看本机屏幕（线 2 W7）。
 * 支持选择免确认有效期（仅本次 / 1天 / 3天 / 7天 / 30天 / 永久）。
 */
@Composable
fun ReverseStreamRequestDialog(
    req: ReverseScreenStreamer.ReverseStreamRequest,
    onApprove: (durationMs: Long) -> Unit,
    onDeny: () -> Unit
) {
    val totalSeconds = (ReverseScreenStreamer.REQUEST_TTL_MS / 1000).toInt()
    val seconds = rememberTtlRemainingSeconds(
        req.requestedAt + ReverseScreenStreamer.REQUEST_TTL_MS,
        totalSeconds
    )
    var selectedDurationMs by remember { mutableStateOf(7L * 86_400_000L) }
    AlertDialog(
        onDismissRequest = onDeny,
        title = { Text("电脑请求查看你的屏幕") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("对方想在电脑上实时查看这台平板的画面。选择免确认有效期后，有效期内再次连接将直接复用录屏通道，不再弹窗。")
                NoConfirmDurationSelector(
                    selectedMs = selectedDurationMs,
                    onSelect = { selectedDurationMs = it }
                )
                Spacer(Modifier.height(4.dp))
                TtlCountdownRow(seconds, totalSeconds, "超时自动拒绝")
            }
        },
        confirmButton = {
            Button(onClick = { onApprove(selectedDurationMs) }) { Text("同意") }
        },
        dismissButton = {
            OutlinedButton(onClick = onDeny) { Text("拒绝（${seconds}s）") }
        }
    )
}

/**
 * 等待对端确认控制请求：本地 30 秒倒计时展示。
 * InputState 里没有请求发出的时间戳，倒计时从弹窗首次出现起算
 * （与请求发出基本同时）；超时失效以服务侧 TTL 为准，弹窗随
 * phase 离开 waiting 而消失，倒计时本身不触发任何状态变更。
 */
@Composable
fun WaitingControlDialog(onCancel: () -> Unit) {
    val totalSeconds = (ControlledInputSession.REQUEST_TTL_MS / 1000).toInt()
    val deadline = remember { System.currentTimeMillis() + ControlledInputSession.REQUEST_TTL_MS }
    val seconds = rememberTtlRemainingSeconds(deadline, totalSeconds)
    AlertDialog(
        onDismissRequest = onCancel,
        title = { Text("正在请求控制对方电脑") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("请在电脑上确认 LinkSpace 弹出的授权提示。")
                Spacer(Modifier.height(4.dp))
                TtlCountdownRow(seconds, totalSeconds, "未确认自动失效")
            }
        },
        confirmButton = {},
        dismissButton = {
            OutlinedButton(onClick = onCancel) { Text("取消") }
        }
    )
}
