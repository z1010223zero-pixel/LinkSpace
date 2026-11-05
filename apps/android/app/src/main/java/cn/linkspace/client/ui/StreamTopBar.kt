package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.filled.KeyboardArrowUp
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Surface
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** 投屏分辨率四档（与 FloatingControlPill 的菜单同值：宽 1280/1920/2560/3840） */
internal val STREAM_RESOLUTION_OPTIONS = listOf(
    "720p" to 1280,
    "1080p" to 1920,
    "1440p" to 2560,
    "2160p" to 3840
)

/** 串流管线模式三档：自动（优先硬解，失败回退软解）/ 高性能硬解 / 兼容软解 */
internal val STREAM_MODE_OPTIONS = listOf(
    "自动 (推荐)" to "auto",
    "高性能硬解" to "fast",
    "兼容软解" to "compat"
)

/** scaleWidth → 画质徽章文案；档位外的值不编档位名，只写宽度。 */
internal fun streamQualityLabel(scaleWidth: Int): String =
    STREAM_RESOLUTION_OPTIONS.firstOrNull { it.second == scaleWidth }?.first
        ?: "画质 $scaleWidth"

/**
 * 投屏画面常驻标题栏 + 折叠工具栏（docs/ui-redesign-android.md §2.2，
 * 对标桌面端 ui-redesign.md §3.2 的 ReverseStreamView）。
 *
 * - 标题栏常驻：设备名 · 画质徽章 + chevron + 关闭。
 *   延迟位留空：服务层暂无延迟/RTT 字段（设计文档 §6），字段到位前
 *   不显示、不编造假的毫秒数；[latencyText] 非空时才渲染。
 * - 工具栏默认折叠（桌面端全屏行为：全屏时工具栏自动隐藏；安卓投屏
 *   本就是全屏，所以默认收起，点 chevron 展开；选完一项后自动收起）。
 *   展开后分组：显示（分辨率四档 / 触控模式）/ 控制（剪贴板 toggle）/
 *   断开（danger 单列一组）。
 * - 断开入口与标题栏关闭、悬浮球菜单里的「退出投屏」同为停止推流
 *   （service.stopScreenStream），断开后回到触控板屏，会话本身不断。
 * - 本栏只在 ScreenMirrorScreen 的深色 token 包裹内使用。
 */
@Composable
fun StreamTopBar(
    deviceName: String,
    scaleWidth: Int,
    latencyText: String? = null,
    relativeMode: Boolean,
    onToggleMode: () -> Unit,
    clipboardEnabled: Boolean,
    onClipboardToggle: (Boolean) -> Unit,
    onSelectScaleWidth: (Int) -> Unit,
    onClose: () -> Unit,
    streamMode: String = "auto",
    onSelectStreamMode: (String) -> Unit = {},
    modifier: Modifier = Modifier
) {
    var expanded by remember { mutableStateOf(false) }

    Surface(
        color = MaterialTheme.colorScheme.surface.copy(alpha = 0.85f),
        modifier = modifier
            .fillMaxWidth()
            .statusBarsPadding()
    ) {
        Column {
            // ---------- 常驻标题栏 ----------
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = LinkSpaceSpacing.sm, vertical = LinkSpaceSpacing.xs)
            ) {
                Text(
                    deviceName,
                    fontSize = 16.sp,
                    fontWeight = FontWeight.SemiBold,
                    color = MaterialTheme.colorScheme.onSurface,
                    maxLines = 1,
                    modifier = Modifier.weight(1f, fill = false)
                )
                Spacer(Modifier.width(LinkSpaceSpacing.sm))
                // 画质徽章
                Surface(
                    color = LinkSpaceColors.Brand,
                    shape = PillShape
                ) {
                    Text(
                        streamQualityLabel(scaleWidth),
                        fontSize = 12.sp,
                        fontWeight = FontWeight.Medium,
                        color = androidx.compose.ui.graphics.Color.White,
                        modifier = Modifier.padding(horizontal = 8.dp, vertical = 2.dp)
                    )
                }
                // 延迟：服务层字段到位前不渲染（见本文件头注释）
                if (latencyText != null) {
                    Spacer(Modifier.width(LinkSpaceSpacing.sm))
                    Text(
                        latencyText,
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                IconButton(onClick = { expanded = !expanded }) {
                    Icon(
                        if (expanded) Icons.Filled.KeyboardArrowUp else Icons.Filled.KeyboardArrowDown,
                        contentDescription = if (expanded) "收起工具栏" else "展开工具栏",
                        tint = MaterialTheme.colorScheme.onSurface
                    )
                }
                IconButton(onClick = onClose) {
                    Icon(
                        Icons.Filled.Close,
                        contentDescription = "退出投屏",
                        tint = MaterialTheme.colorScheme.onSurface
                    )
                }
            }

            // ---------- 折叠工具栏（默认折叠） ----------
            if (expanded) {
                Column(
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(
                            horizontal = LinkSpaceSpacing.md,
                            vertical = LinkSpaceSpacing.sm
                        ),
                    verticalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)
                ) {
                    // 显示：分辨率四档 + 触控模式
                    Text(
                        "显示",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)) {
                        STREAM_RESOLUTION_OPTIONS.forEach { (label, width) ->
                            FilterChip(
                                selected = width == scaleWidth,
                                onClick = {
                                    onSelectScaleWidth(width)
                                    expanded = false
                                },
                                label = { Text(label, fontSize = 12.sp) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = LinkSpaceColors.Brand,
                                    selectedLabelColor = androidx.compose.ui.graphics.Color.White
                                )
                            )
                        }
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)) {
                        FilterChip(
                            selected = !relativeMode,
                            onClick = {
                                if (relativeMode) onToggleMode()
                                expanded = false
                            },
                            label = { Text("点哪指哪", fontSize = 12.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = LinkSpaceColors.Brand,
                                selectedLabelColor = androidx.compose.ui.graphics.Color.White
                            )
                        )
                        FilterChip(
                            selected = relativeMode,
                            onClick = {
                                if (!relativeMode) onToggleMode()
                                expanded = false
                            },
                            label = { Text("滑动跟随", fontSize = 12.sp) },
                            colors = FilterChipDefaults.filterChipColors(
                                selectedContainerColor = LinkSpaceColors.Brand,
                                selectedLabelColor = androidx.compose.ui.graphics.Color.White
                            )
                        )
                    }

                    // 串流管线：自动 / 高性能硬解（DXGI+硬编+Surface硬解） / 兼容软解
                    Text(
                        "串流引擎",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    Row(horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)) {
                        STREAM_MODE_OPTIONS.forEach { (label, modeValue) ->
                            FilterChip(
                                selected = streamMode == modeValue,
                                onClick = {
                                    onSelectStreamMode(modeValue)
                                    expanded = false
                                },
                                label = { Text(label, fontSize = 12.sp) },
                                colors = FilterChipDefaults.filterChipColors(
                                    selectedContainerColor = LinkSpaceColors.Brand,
                                    selectedLabelColor = androidx.compose.ui.graphics.Color.White
                                )
                            )
                        }
                    }

                    // 控制：剪贴板同步开关（与首页同一开关，同一回调）
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text(
                                "剪贴板同步",
                                fontSize = 14.sp,
                                color = MaterialTheme.colorScheme.onSurface
                            )
                            Text(
                                "与这台电脑互相同步剪贴板文本",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        Switch(checked = clipboardEnabled, onCheckedChange = onClipboardToggle)
                    }

                    // 断开：danger 单列一组
                    OutlinedButton(
                        onClick = {
                            expanded = false
                            onClose()
                        },
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = LinkSpaceStatusColors.Danger
                        ),
                        modifier = Modifier.fillMaxWidth()
                    ) { Text("断开投屏") }
                }
            }
        }
    }
}
