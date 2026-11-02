package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.FolderOff
import androidx.compose.material3.Badge
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.Icon
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import cn.linkspace.client.service.TransferTask

/**
 * 文件传输列表：常驻 + 空状态。
 * 替换旧的传输区（MainActivity.kt:476-520）：旧区块随 transfers.isEmpty()
 * 整体消失、无速率、无失败原因、无空状态。
 *
 * 诚实缺口（设计文档 §2.3/§6）：
 * - 速率：服务层没有速率字段；UI 侧显示已传 / 总量（不编造速率数字）。
 * - 发送中取消：服务层没有取消通道（发送确认弹窗注释已写明），发送方
 *   OFFERED 态只显示“等待对方确认”，不假装能取消。
 * - 原始 direction 字符串（send/receive）不再直接上屏，改中文“发送/接收”。
 */
@Composable
fun TransferList(
    transfers: List<TransferTask>,
    onAccept: (TransferTask) -> Unit,
    onReject: (TransferTask) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        if (transfers.isEmpty()) {
            Card(Modifier.fillMaxWidth()) {
                Column(
                    Modifier.fillMaxWidth().padding(LinkSpaceSpacing.xl),
                    horizontalAlignment = Alignment.CenterHorizontally,
                ) {
                    Icon(
                        Icons.Filled.FolderOff,
                        contentDescription = null,
                        tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    Spacer(Modifier.height(LinkSpaceSpacing.sm))
                    Text(
                        "暂无传输任务",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "收到文件或向已配对的电脑发送文件后会出现在这里",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
            return
        }
        Column(verticalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)) {
            transfers.forEach { task ->
                TransferRow(task, onAccept, onReject)
            }
        }
    }
}

@Composable
private fun TransferRow(
    task: TransferTask,
    onAccept: (TransferTask) -> Unit,
    onReject: (TransferTask) -> Unit,
) {
    Card(Modifier.fillMaxWidth()) {
        Column(Modifier.padding(LinkSpaceSpacing.lg)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    task.files.joinToString { it.name },
                    Modifier.weight(1f),
                    style = MaterialTheme.typography.bodyMedium,
                )
                Badge { Text(stateLabel(task.state)) }
            }
            Text(
                "${formatBytes(task.transferred)} / ${formatBytes(task.totalSize)} · " +
                    if (task.direction == "send") "发送" else "接收",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (task.state == TransferTask.ACCEPTED) {
                Spacer(Modifier.height(LinkSpaceSpacing.sm))
                LinearProgressIndicator(
                    progress = {
                        if (task.totalSize == 0L) 0f
                        else task.transferred.toFloat() / task.totalSize
                    },
                    modifier = Modifier.fillMaxWidth(),
                )
            }
            // 失败原因：Protocol.kt:128 的 error 字段已有，旧 UI 从不显示
            if (task.state == TransferTask.FAILED && !task.error.isNullOrBlank()) {
                Spacer(Modifier.height(LinkSpaceSpacing.xs))
                Text(
                    task.error,
                    style = MaterialTheme.typography.bodySmall,
                    color = LinkSpaceStatusColors.Danger,
                )
            }
            // 接收/拒绝只属于接收方向的任务：发送任务也会短暂处于
            // OFFERED（等对方确认），点了「接收」会走错分支
            if (task.state == TransferTask.OFFERED && task.direction == "receive") {
                Spacer(Modifier.height(LinkSpaceSpacing.sm))
                Row(horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)) {
                    Button(onClick = { onAccept(task) }) { Text("接收") }
                    OutlinedButton(onClick = { onReject(task) }) { Text("拒绝") }
                }
            }
            if (task.state == TransferTask.OFFERED && task.direction == "send") {
                Spacer(Modifier.height(LinkSpaceSpacing.xs))
                Text(
                    "等待对方确认",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}
