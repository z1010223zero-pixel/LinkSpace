package cn.linkspace.client.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.dp

/**
 * 设备行（四要素 + 标签 + 行内状态标记），替换旧的两套卡片：
 * 发现行（MainActivity.kt:533-575）与信任行（MainActivity.kt:453-473）。
 *
 * 组成：状态点（绿在线 / 灰离线）+ 系统图标 + 设备名 + 一行小字
 * （系统 · 连接方式 · IP）+ `本设备` 标签 + 行内“控制中 / 推流中”标记。
 *
 * 诚实缺口（设计文档 §2.3）：服务层没有在线布尔值与延迟字段——在线由
 * lastSeen + Discovery.STALE_MS 推导（见 UiUtils.isOnline），延迟不显示、
 * 不编数字；设备类型读 DiscoveredService.deviceType / TrustStore.Entry.deviceType。
 */
@Composable
fun DeviceRow(
    name: String,
    subtitle: String,
    deviceType: String,
    online: Boolean,
    modifier: Modifier = Modifier,
    isSelf: Boolean = false,
    /** 行内状态标记，如“控制中”“推流中”“正被控制”，无状态传 null。 */
    statusMark: String? = null,
    onClick: (() -> Unit)? = null,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    Row(
        modifier
            .fillMaxWidth()
            .then(if (onClick != null) Modifier.clickable(onClick = onClick) else Modifier)
            .padding(
                horizontal = LinkSpaceSpacing.md,
                vertical = LinkSpaceSpacing.sm,
            ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // 状态点：绿在线 / 灰离线（不用黄，桌面端 §5）
        Box(
            Modifier
                .size(8.dp)
                .clip(CircleShape)
                .background(
                    if (online) LinkSpaceStatusColors.Online
                    else MaterialTheme.colorScheme.onSurfaceVariant,
                ),
        )
        Spacer(Modifier.width(LinkSpaceSpacing.sm))
        Icon(
            deviceTypeIcon(deviceType),
            contentDescription = deviceTypeLabel(deviceType),
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(24.dp),
        )
        Spacer(Modifier.width(LinkSpaceSpacing.md))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    name,
                    style = MaterialTheme.typography.bodyMedium,
                    maxLines = 1,
                )
                if (isSelf) {
                    Spacer(Modifier.width(LinkSpaceSpacing.sm))
                    SelfTag()
                }
                if (statusMark != null) {
                    Spacer(Modifier.width(LinkSpaceSpacing.sm))
                    Text(
                        statusMark,
                        style = MaterialTheme.typography.bodySmall,
                        color = LinkSpaceStatusColors.Online,
                    )
                }
            }
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
            )
        }
        trailing()
        if (onClick != null) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

/** `本设备` 标签：primaryContainer 底（--accent-soft #EAF0FF）。 */
@Composable
private fun SelfTag() {
    Surface(
        color = MaterialTheme.colorScheme.primaryContainer,
        shape = PillShape,
    ) {
        Text(
            "本设备",
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onPrimaryContainer,
            modifier = Modifier.padding(horizontal = 6.dp, vertical = 2.dp),
        )
    }
}

/** 在线状态文字（与状态点配套用）：在线绿字 / 离线灰字。 */
@Composable
fun OnlineText(online: Boolean) {
    Text(
        if (online) "在线" else "离线",
        style = MaterialTheme.typography.bodySmall,
        color = if (online) LinkSpaceStatusColors.Online
        else MaterialTheme.colorScheme.onSurfaceVariant,
    )
}
