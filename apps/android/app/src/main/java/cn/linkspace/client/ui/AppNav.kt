package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Dashboard
import androidx.compose.material.icons.filled.Devices
import androidx.compose.material.icons.filled.Folder
import androidx.compose.material.icons.filled.Settings
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.NavigationBar
import androidx.compose.material3.NavigationBarItem
import androidx.compose.material3.NavigationRail
import androidx.compose.material3.NavigationRailItem
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.unit.dp

/**
 * 导航：横屏 80dp NavigationRail / 竖屏底部 NavigationBar。
 * 五项与桌面端同名同序（概览 / 设备 / 屏幕 / 文件 / 设置），不搬桌面端
 * 200px 侧边栏（审计 §4.1：竖屏 800dp 级宽度下 200dp 侧栏占去四分之一）。
 * 选中态用 rail/bar 的选中态指示器（primaryContainer 底）。
 */
enum class NavPage(val label: String, val icon: ImageVector) {
    OVERVIEW("概览", Icons.Filled.Dashboard),
    DEVICES("设备", Icons.Filled.Devices),
    SCREEN("屏幕", Icons.Filled.Cast),
    FILES("文件", Icons.Filled.Folder),
    SETTINGS("设置", Icons.Filled.Settings),
}

@Composable
fun AppNavShell(
    isLandscape: Boolean,
    current: NavPage,
    onSelect: (NavPage) -> Unit,
    onlineText: String,
    versionName: String,
    modifier: Modifier = Modifier,
    content: @Composable () -> Unit,
) {
    if (isLandscape) {
        Row(modifier.fillMaxSize()) {
            NavigationRail(
                modifier = Modifier.fillMaxHeight().width(80.dp),
                header = {
                    Text(
                        "LS",
                        style = MaterialTheme.typography.titleMedium,
                        color = MaterialTheme.colorScheme.primary,
                    )
                },
            ) {
                NavPage.values().forEach { page ->
                    NavigationRailItem(
                        selected = current == page,
                        onClick = { onSelect(page) },
                        icon = { Icon(page.icon, contentDescription = page.label) },
                        label = { Text(page.label, style = MaterialTheme.typography.labelSmall) },
                    )
                }
                Spacer(Modifier.weight(1f))
                Text(
                    versionName,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(bottom = LinkSpaceSpacing.md),
                )
            }
            Column(Modifier.weight(1f)) {
                TopBar(current.label, onlineText)
                Box(Modifier.weight(1f)) { content() }
            }
        }
    } else {
        Column(modifier.fillMaxSize()) {
            TopBar(current.label, onlineText)
            Box(Modifier.weight(1f)) { content() }
            NavigationBar(Modifier.fillMaxWidth()) {
                NavPage.values().forEach { page ->
                    NavigationBarItem(
                        selected = current == page,
                        onClick = { onSelect(page) },
                        icon = { Icon(page.icon, contentDescription = page.label) },
                        label = { Text(page.label, style = MaterialTheme.typography.labelSmall) },
                    )
                }
            }
        }
    }
}

/** 顶栏：页标题 + 在线 X/Y。延迟字段服务层目前没有，不写假数字（设计文档 §6）。 */
@Composable
private fun TopBar(title: String, onlineText: String) {
    Row(
        Modifier.fillMaxWidth().padding(
            horizontal = LinkSpaceSpacing.lg,
            vertical = LinkSpaceSpacing.md,
        ),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(title, style = MaterialTheme.typography.titleLarge, modifier = Modifier.weight(1f))
        Text(
            onlineText,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}
