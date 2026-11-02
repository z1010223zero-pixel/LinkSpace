package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier

/**
 * 方向卡：一方向一张卡，每行一个能力 + 说明小字 + 尾部控件。
 * 替换散落在首页的剪贴板行与被控行（MainActivity.kt:328-359）。
 *
 * 尾部控件按能力真实形态走：真开关（剪贴板同步）用 Switch；会话型
 * 能力（投屏 / 控制）用状态文字或操作按钮；`›` 现在无详情页可进，
 * 不挂点击、不做假入口（设计文档 §6），因此本组件不画 `›`。
 */
@Composable
fun DirectionCard(
    title: String,
    subtitle: String,
    modifier: Modifier = Modifier,
    content: @Composable ColumnScope.() -> Unit,
) {
    Card(modifier.fillMaxWidth()) {
        Column(
            Modifier.fillMaxWidth().padding(LinkSpaceSpacing.lg),
        ) {
            Text(title, style = MaterialTheme.typography.titleSmall)
            Text(
                subtitle,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = LinkSpaceSpacing.xs),
            )
            Spacer(Modifier.padding(top = LinkSpaceSpacing.sm))
            content()
        }
    }
}

/** 方向卡内的一行能力：能力名 + 说明小字 + 尾部控件（Switch / 状态 / 按钮）。 */
@Composable
fun DirectionRow(
    name: String,
    description: String,
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit,
) {
    Row(
        modifier.fillMaxWidth().padding(vertical = LinkSpaceSpacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f)) {
            Text(name, style = MaterialTheme.typography.bodyMedium)
            Text(
                description,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        Spacer(Modifier.width(LinkSpaceSpacing.md))
        trailing()
    }
}
