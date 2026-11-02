package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.TransferTask

/**
 * 文件页：传输列表常驻 + 空状态（TransferList）。
 * 发送入口在设备详情里（选一台已配对的电脑 → 发送文件）。
 */
@Composable
fun FilesPage(
    service: LinkSpaceService,
    board: NoticeBoard,
    modifier: Modifier = Modifier,
) {
    val transfers by service.transfers.collectAsStateWithLifecycle()

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(LinkSpaceSpacing.lg),
    ) {
        SectionTitle("文件传输")
        Spacer(Modifier.height(LinkSpaceSpacing.sm))
        TransferList(
            transfers = transfers,
            onAccept = { task ->
                service.acceptTransfer(task.id)
                    .onSuccess { board.success("已开始接收") }
                    .onFailure { board.danger(it.message ?: "接收失败") }
            },
            onReject = { task ->
                service.cancelTransfer(task.id)
            },
        )
        Spacer(Modifier.height(LinkSpaceSpacing.md))
        Text(
            "发送文件：在设备页选一台已配对的电脑 → 发送文件。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
