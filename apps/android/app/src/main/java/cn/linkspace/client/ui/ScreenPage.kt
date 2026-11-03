package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.ReverseScreenStreamer

/**
 * 屏幕页：投屏设置 + 反向流状态 + 扩展屏占位。
 *
 * 诚实缺口：
 * - 投屏画质档位是“请求参数”，只在控制会话中由 requestScreenStream
 *   发出（悬浮球菜单同款调用）；会话接管期间本页不可见，因此这里只
 *   显示当前档位 + 说明切换位置，不做一点就报“没有到桌面的控制连接”
 *   的假下拉（requestScreenStream 在无会话时会写 inputMessage）。
 * - 反向流分辨率由请求方（电脑）定档位，本机无设置入口，只显示状态。
 * - 扩展屏是线 3 内容：会话与画面流已接线（设备详情页入口），本页
 *   只做说明，不放可点的 Mirror / Extend 按钮。
 */
@Composable
fun ScreenPage(
    service: LinkSpaceService,
    modifier: Modifier = Modifier,
) {
    val reverseStatus by service.reverseStreamStatus.collectAsStateWithLifecycle()
    val streamScaleWidth by service.streamScaleWidth.collectAsStateWithLifecycle()
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val inputState by service.inputState.collectAsStateWithLifecycle()

    Column(
        modifier.fillMaxSize().verticalScroll(rememberScrollState())
            .padding(LinkSpaceSpacing.lg),
    ) {
        SectionTitle("观看电脑画面（投屏）")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                Text(
                    "控制电脑后点「投屏」，电脑画面实时流到本机。投屏进行中，在画面窗口的悬浮球菜单里切换画质档位。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(Modifier.padding(top = LinkSpaceSpacing.md)) {
                    Text(
                        "当前画质档位：",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        presetLabel(streamScaleWidth),
                        style = MaterialTheme.typography.bodyMedium,
                    )
                }
                if (inputState.phase == "active") {
                    Text(
                        "控制进行中：去控制画面点「投屏」开始观看。",
                        style = MaterialTheme.typography.bodySmall,
                        color = LinkSpaceStatusColors.Online,
                        modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                    )
                }
            }
        }

        SectionTitle("本机画面推给电脑（反向推流）")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                val active = reverseStatus?.active
                if (active != null) {
                    val peerName = trusted.firstOrNull { it.deviceId == active.peerId }?.displayName
                        ?: active.peerId
                    Text(
                        "正在向 $peerName 推流",
                        style = MaterialTheme.typography.bodyMedium,
                    )
                    Text(
                        "${active.width}×${active.height} · ${active.encoder} · " +
                            tierLabel(reverseStatus?.tier ?: 0),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = LinkSpaceSpacing.xs),
                    )
                    OutlinedButton(
                        onClick = { service.stopReverseStream() },
                        modifier = Modifier.padding(top = LinkSpaceSpacing.md),
                    ) { Text("停止推流") }
                } else {
                    Text(
                        "由电脑端发起：对方请求后，本机点「同意」并完成系统录屏授权即开始推流；随时可以在通知栏停止。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        SectionTitle("平板当扩展屏")
        Card(
            colors = CardDefaults.cardColors(
                containerColor = MaterialTheme.colorScheme.surfaceVariant,
            ),
            modifier = Modifier.fillMaxWidth(),
        ) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                Text(
                    "扩展屏（线 3）",
                    style = MaterialTheme.typography.bodyMedium,
                )
                Text(
                    "在设备详情里点「扩展屏」发起，电脑端确认后本机显示扩展屏画面。画面上的触控要点按需先建立键鼠控制（只看画面不用）。镜像仍走投屏入口。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                Row(Modifier.padding(top = LinkSpaceSpacing.md)) {
                    Button(onClick = {}, enabled = false) { Text("镜像") }
                    Spacer(Modifier.padding(horizontal = LinkSpaceSpacing.xs))
                    OutlinedButton(onClick = {}, enabled = false) { Text("扩展") }
                }
                Text(
                    "本页按钮仅作说明，入口在设备详情页。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                )
            }
        }

        SectionTitle("手势说明")
        Text(
            "投屏画面上手势：单指滑动移动光标 · 轻点单击 · 静置后拖动 · 双指滚动。触控板页：单指移动 · 轻点单击 · 双指滚动。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(bottom = LinkSpaceSpacing.lg),
        )
    }
}

/** scaleWidth → 档位名（与 ReverseScreenStreamer.STREAM_PRESETS 同值）。 */
private fun presetLabel(scaleWidth: Int): String = when (scaleWidth) {
    1280 -> "720p"
    1920 -> "1080p"
    2560 -> "1440p"
    3840 -> "2160p"
    else -> "${scaleWidth}p 宽"
}

/** 反向流码率档位序号 → 标签（与 ReverseScreenStreamer.STREAM_TIERS 同值）。 */
private fun tierLabel(tier: Int): String =
    ReverseScreenStreamer.STREAM_TIERS.getOrNull(tier)?.label ?: "t$tier"
