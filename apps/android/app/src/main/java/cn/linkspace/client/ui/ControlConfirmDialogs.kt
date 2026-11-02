package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.dp
import cn.linkspace.client.service.ControlledInputSession
import cn.linkspace.client.service.ReverseScreenStreamer
import kotlinx.coroutines.delay

/**
 * 控制 / 反向投屏确认弹窗的 30 秒倒计时（B 线，ToDesk 对标：
 * 被控端确认弹窗须写清谁在连、给倒计时、注明“单次有效”；
 * 截图见 android-research.md §2.3(4)，42 秒倒计时 + “此授权单次有效”）。
 *
 * 倒计时只做展示，超时拒绝以服务侧 TTL 为准：
 * 控制请求用 [ControlledInputSession.ControlRequest.expiresAt]（绝对时间），
 * 反向投屏用 [ReverseScreenStreamer.ReverseStreamRequest.requestedAt] +
 * [ReverseScreenStreamer.REQUEST_TTL_MS]；服务侧到时自动拒绝，弹窗随状态消失。
 */

/** 距 deadline 的剩余整秒（向上取整，刚弹出时显示满格 30 而不是 29），每秒重算。 */
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
            fontSize = StreamTokens.SmallSize,
            color = MaterialTheme.colorScheme.onSurfaceVariant
        )
        LinearProgressIndicator(
            progress = { seconds.toFloat() / totalSeconds },
            modifier = Modifier.fillMaxWidth()
        )
    }
}

/**
 * 电脑请求控制本机：确认弹窗（协议 9.1）。
 * 30 秒内未确认由会话层自动拒绝；弹窗被划掉按拒绝处理。
 * 倒计时取请求自带的 expiresAt；文案补“单次有效”。
 */
@Composable
fun ControlRequestDialog(
    req: ControlledInputSession.ControlRequest,
    onApprove: () -> Unit,
    onDeny: () -> Unit
) {
    val totalSeconds = (ControlledInputSession.REQUEST_TTL_MS / 1000).toInt()
    val seconds = rememberTtlRemainingSeconds(req.expiresAt, totalSeconds)
    AlertDialog(
        onDismissRequest = onDeny,
        title = { Text("允许远程控制本机？") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("“${req.displayName.ifEmpty { req.peerId }}”请求在电脑上操作这台平板（点按、滑动、按键）。")
                Text(
                    "此次授权单次有效：点了“允许”只放行本次会话，会话结束需重新确认；" +
                        "会话结束前可随时在首页点“终止控制”拔掉。",
                    fontSize = StreamTokens.SmallSize,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(4.dp))
                TtlCountdownRow(seconds, totalSeconds, "超时自动拒绝")
            }
        },
        confirmButton = {
            Button(onClick = onApprove) { Text("允许") }
        },
        dismissButton = {
            OutlinedButton(onClick = onDeny) { Text("拒绝（${seconds}s）") }
        }
    )
}

/**
 * 反向投屏请求：电脑想看本机屏幕（线 2 W7）。
 * 每次请求都要过这道确认 + 系统录屏授权框；拒绝/取消都明确回绝，
 * 桌面窗口显示原因。30 秒无人确认由服务侧 TTL 自动拒绝。
 * 倒计时取 requestedAt + REQUEST_TTL_MS；文案补“单次有效”。
 */
@Composable
fun ReverseStreamRequestDialog(
    req: ReverseScreenStreamer.ReverseStreamRequest,
    onApprove: () -> Unit,
    onDeny: () -> Unit
) {
    val totalSeconds = (ReverseScreenStreamer.REQUEST_TTL_MS / 1000).toInt()
    val seconds = rememberTtlRemainingSeconds(
        req.requestedAt + ReverseScreenStreamer.REQUEST_TTL_MS,
        totalSeconds
    )
    AlertDialog(
        onDismissRequest = onDeny,
        title = { Text("电脑请求查看你的屏幕") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                Text("对方想在电脑上实时查看这台平板的画面。同意后会弹出系统录屏授权框，只有你点了允许才会开始录屏；随时可以在通知栏停止。")
                Text(
                    "此次授权单次有效：同意只开通本次推流，下次需重新确认。",
                    fontSize = StreamTokens.SmallSize,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
                Spacer(Modifier.height(4.dp))
                TtlCountdownRow(seconds, totalSeconds, "超时自动拒绝")
            }
        },
        confirmButton = {
            Button(onClick = onApprove) { Text("同意") }
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
