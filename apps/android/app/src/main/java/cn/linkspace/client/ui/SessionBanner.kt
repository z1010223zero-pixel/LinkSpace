package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.Error
import androidx.compose.material.icons.filled.Info
import androidx.compose.material.icons.filled.Warning
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import kotlinx.coroutines.delay

/**
 * 分级通知横条 + 会话状态横条。
 * 替换旧的三张异形卡：通知卡（errorContainer 单条）、被控卡
 *（tertiaryContainer）、推流卡（MainActivity.kt:363-417）。
 *
 * 旧问题：notice 是单个 String，后一条覆盖前一条；成功反馈也显示为
 * 红色错误卡。现改为多条并存、按级别分色：成功 3 秒自动消失，
 * danger 常驻到手动关闭。
 */
enum class NoticeLevel { INFO, SUCCESS, WARN, DANGER }

data class Notice(val id: Long, val level: NoticeLevel, val text: String)

class NoticeBoard {
    private val _notices = mutableStateListOf<Notice>()
    val notices: List<Notice> get() = _notices

    private var nextId = 0L

    fun show(level: NoticeLevel, text: String) {
        if (text.isBlank()) return
        // 同一条连续重复不刷屏
        if (_notices.lastOrNull()?.text == text) return
        _notices.add(Notice(nextId++, level, text))
        while (_notices.size > 5) _notices.removeAt(0)
    }

    fun info(text: String) = show(NoticeLevel.INFO, text)
    fun success(text: String) = show(NoticeLevel.SUCCESS, text)
    fun warn(text: String) = show(NoticeLevel.WARN, text)
    fun danger(text: String) = show(NoticeLevel.DANGER, text)

    fun dismiss(id: Long) {
        _notices.removeAll { it.id == id }
    }
}

@Composable
fun NoticeList(board: NoticeBoard, modifier: Modifier = Modifier) {
    if (board.notices.isEmpty()) return
    Column(modifier) {
        board.notices.forEach { notice ->
            NoticeBanner(notice, onDismiss = { board.dismiss(notice.id) })
        }
    }
}

@Composable
private fun NoticeBanner(notice: Notice, onDismiss: () -> Unit) {
    // 成功 3 秒自动消失；其余级别常驻到手动关闭
    if (notice.level == NoticeLevel.SUCCESS) {
        LaunchedEffect(notice.id) {
            delay(3000)
            onDismiss()
        }
    }
    val (container, onContainer, icon) = when (notice.level) {
        NoticeLevel.INFO -> Triple(
            MaterialTheme.colorScheme.primaryContainer,
            MaterialTheme.colorScheme.onPrimaryContainer,
            Icons.Filled.Info,
        )
        NoticeLevel.SUCCESS -> Triple(
            LinkSpaceStatusColors.SuccessContainer,
            LinkSpaceStatusColors.SuccessOnContainer,
            Icons.Filled.CheckCircle,
        )
        NoticeLevel.WARN -> Triple(
            LinkSpaceStatusColors.WarnContainer,
            LinkSpaceStatusColors.WarnOnContainer,
            Icons.Filled.Warning,
        )
        NoticeLevel.DANGER -> Triple(
            MaterialTheme.colorScheme.errorContainer,
            MaterialTheme.colorScheme.onErrorContainer,
            Icons.Filled.Error,
        )
    }
    Card(
        colors = CardDefaults.cardColors(containerColor = container),
        modifier = Modifier.fillMaxWidth().padding(
            horizontal = LinkSpaceSpacing.lg,
            vertical = LinkSpaceSpacing.xs,
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(
                horizontal = LinkSpaceSpacing.md,
                vertical = LinkSpaceSpacing.sm,
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(icon, contentDescription = null, tint = onContainer)
            Text(
                notice.text,
                style = MaterialTheme.typography.bodyMedium,
                color = onContainer,
                modifier = Modifier.weight(1f).padding(horizontal = LinkSpaceSpacing.sm),
            )
            IconButton(onClick = onDismiss) {
                Icon(Icons.Filled.Close, contentDescription = "关闭", tint = onContainer)
            }
        }
    }
}

/**
 * 正被电脑控制横条（danger 级）：状态由服务层驱动出现/消失，不可手动关闭；
 * “终止控制”是危险操作，用红色描边按钮（按下态由涟漪承担，不另写 hover）。
 */
@Composable
fun ControlledByBanner(
    controlledBy: String,
    onTerminate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.errorContainer,
        ),
        modifier = modifier.fillMaxWidth().padding(
            horizontal = LinkSpaceSpacing.lg,
            vertical = LinkSpaceSpacing.xs,
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(
                horizontal = LinkSpaceSpacing.md,
                vertical = LinkSpaceSpacing.sm,
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Error,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onErrorContainer,
            )
            Text(
                "正被 $controlledBy 远程控制",
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onErrorContainer,
                modifier = Modifier.weight(1f).padding(horizontal = LinkSpaceSpacing.sm),
            )
            OutlinedButton(
                onClick = onTerminate,
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = LinkSpaceStatusColors.Danger,
                ),
            ) { Text("终止控制") }
        }
    }
}

/** 正在向电脑推流横条：对端名 · 分辨率 · 编码器 + “停止推流”。 */
@Composable
fun ReverseStreamBanner(
    peerName: String,
    detail: String,
    onStop: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Card(
        colors = CardDefaults.cardColors(
            containerColor = MaterialTheme.colorScheme.primaryContainer,
        ),
        modifier = modifier.fillMaxWidth().padding(
            horizontal = LinkSpaceSpacing.lg,
            vertical = LinkSpaceSpacing.xs,
        ),
    ) {
        Row(
            Modifier.fillMaxWidth().padding(
                horizontal = LinkSpaceSpacing.md,
                vertical = LinkSpaceSpacing.sm,
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                Icons.Filled.Info,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onPrimaryContainer,
            )
            Column(Modifier.weight(1f).padding(horizontal = LinkSpaceSpacing.sm)) {
                Text(
                    "正在向电脑推流",
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
                Text(
                    "$peerName · $detail",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                )
            }
            OutlinedButton(onClick = onStop) { Text("停止推流") }
        }
    }
}
