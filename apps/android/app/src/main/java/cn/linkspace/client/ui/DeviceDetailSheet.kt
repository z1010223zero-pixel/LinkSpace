package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Cast
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.FileUpload
import androidx.compose.material.icons.filled.TouchApp
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.TrustStore
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * 设备详情：竖屏 ModalBottomSheet / 横屏右侧详情列共用同一份内容
 *（DeviceDetailContent）。大图标阵 + 键值详情 + 危险操作二次确认。
 *
 * 替换旧入口：发现行按钮（MainActivity.kt:547-575）与信任行“撤销”
 *（MainActivity.kt:467-470）并入此处；行内不再塞两个 Button。
 */

enum class ControlState { NONE, CONTROLLING, CONTROLLED_BY, STREAMING_TO, EXTENDING }

/** 详情页的展示数据（服务层字段的只读投影，不含任何新状态）。 */
data class DeviceDetailInfo(
    val displayName: String,
    val deviceType: String,
    val host: String?,
    val port: Int?,
    val online: Boolean,
    val paired: Boolean,
    val scope: List<String>,
    val trustedAt: Long?,
    val caps: List<String>,
    /** 已信任设备的完整 deviceId（撤销用）；未配对为 null。 */
    val deviceId: String?,
    /** 在局域网内发现时的原始条目（控制 / 发文件用）；仅信任未发现时为 null。 */
    val discovered: DiscoveredService?,
    val controlState: ControlState,
)

/**
 * 从发现条目 + 信任条目拼出详情数据。
 *
 * 匹配口径：信任条目按完整 deviceId 认；控制会话的 peerId 是完整 id，
 * 与 discovered.idPrefix 的换算走 service.fullPeerIdOf；controlledBy
 * 只有对端自报的显示名，只能按显示名匹配（服务层无 id 字段，见设计文档
 * §2.3——显示名重名时可能误标，待服务层补字段后改精确匹配）。
 */
fun detailFor(
    discovered: DiscoveredService?,
    trusted: TrustStore.Entry?,
    service: LinkSpaceService,
    inputPeerId: String?,
    controlledByName: String?,
    streamingPeerId: String?,
    extendPeerId: String? = null,
    now: Long,
): DeviceDetailInfo {
    val fullId = discovered?.let { service.fullPeerIdOf(it.idPrefix) } ?: trusted?.deviceId
    val displayName = discovered?.displayName ?: trusted?.displayName ?: ""
    val controlState = when {
        inputPeerId != null && fullId != null &&
            (inputPeerId == fullId || (discovered != null && inputPeerId.startsWith(discovered.idPrefix))) ->
            ControlState.CONTROLLING
        extendPeerId != null && fullId != null &&
            (extendPeerId == fullId || (discovered != null && extendPeerId.startsWith(discovered.idPrefix))) ->
            ControlState.EXTENDING
        streamingPeerId != null && fullId != null && streamingPeerId == fullId ->
            ControlState.STREAMING_TO
        controlledByName != null && controlledByName == displayName ->
            ControlState.CONTROLLED_BY
        else -> ControlState.NONE
    }
    return DeviceDetailInfo(
        displayName = displayName,
        deviceType = discovered?.deviceType ?: trusted?.deviceType ?: "",
        host = discovered?.host,
        port = discovered?.port,
        online = discovered != null && isOnline(discovered.lastSeen, now),
        paired = discovered?.paired == true || trusted != null,
        scope = trusted?.scope ?: emptyList(),
        trustedAt = trusted?.trustedAt,
        caps = discovered?.caps ?: emptyList(),
        deviceId = trusted?.deviceId,
        discovered = discovered,
        controlState = controlState,
    )
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun DeviceDetailSheet(
    info: DeviceDetailInfo,
    onDismiss: () -> Unit,
    onControl: (DiscoveredService) -> Unit,
    onExtend: (DiscoveredService) -> Unit,
    onSendFiles: (DiscoveredService) -> Unit,
    onRevoke: (deviceId: String, displayName: String) -> Unit,
    onEndControl: () -> Unit,
    onTerminateControl: () -> Unit,
    onStopStream: () -> Unit,
    onStopExtend: () -> Unit,
) {
    ModalBottomSheet(onDismissRequest = onDismiss) {
        DeviceDetailContent(
            info = info,
            onControl = onControl,
            onExtend = onExtend,
            onSendFiles = onSendFiles,
            onRevoke = onRevoke,
            onEndControl = onEndControl,
            onTerminateControl = onTerminateControl,
            onStopStream = onStopStream,
            onStopExtend = onStopExtend,
            modifier = Modifier.padding(
                start = LinkSpaceSpacing.lg,
                end = LinkSpaceSpacing.lg,
                bottom = LinkSpaceSpacing.xxl,
            ),
        )
    }
}

/** 详情内容本体：Sheet 与横屏右侧详情列共用。 */
@Composable
fun DeviceDetailContent(
    info: DeviceDetailInfo,
    onControl: (DiscoveredService) -> Unit,
    onExtend: (DiscoveredService) -> Unit,
    onSendFiles: (DiscoveredService) -> Unit,
    onRevoke: (deviceId: String, displayName: String) -> Unit,
    onEndControl: () -> Unit,
    onTerminateControl: () -> Unit,
    onStopStream: () -> Unit,
    onStopExtend: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var showRevokeConfirm by remember { mutableStateOf(false) }
    val canReach = info.discovered != null

    Column(modifier.fillMaxWidth()) {
        // ---------- 头：图标 + 名 + 状态 ----------
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                deviceTypeIcon(info.deviceType),
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(32.dp),
            )
            Spacer(Modifier.width(LinkSpaceSpacing.md))
            Column(Modifier.weight(1f)) {
                Text(info.displayName, style = MaterialTheme.typography.titleMedium)
                Row(verticalAlignment = Alignment.CenterVertically) {
                    OnlineText(info.online)
                    if (info.paired) {
                        Text(
                            " · 已配对",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    when (info.controlState) {
                        ControlState.CONTROLLING -> Text(
                            " · 控制中",
                            style = MaterialTheme.typography.bodySmall,
                            color = LinkSpaceStatusColors.Online,
                        )
                        ControlState.CONTROLLED_BY -> Text(
                            " · 正被控制",
                            style = MaterialTheme.typography.bodySmall,
                            color = LinkSpaceStatusColors.Danger,
                        )
                        ControlState.STREAMING_TO -> Text(
                            " · 推流中",
                            style = MaterialTheme.typography.bodySmall,
                            color = LinkSpaceStatusColors.Online,
                        )
                        ControlState.EXTENDING -> Text(
                            " · 扩展屏",
                            style = MaterialTheme.typography.bodySmall,
                            color = LinkSpaceStatusColors.Online,
                        )
                        ControlState.NONE -> Unit
                    }
                }
            }
        }

        Spacer(Modifier.height(LinkSpaceSpacing.lg))

        // ---------- 大图标阵 ----------
        Row(
            Modifier.fillMaxWidth(),
            horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm),
        ) {
            DetailAction(
                icon = { Icon(Icons.Filled.TouchApp, contentDescription = null) },
                label = "控制",
                enabled = info.paired && canReach && info.controlState != ControlState.CONTROLLING,
                onClick = { info.discovered?.let(onControl) },
                modifier = Modifier.weight(1f),
            )
            DetailAction(
                icon = { Icon(Icons.Filled.FileUpload, contentDescription = null) },
                label = "发送文件",
                enabled = info.paired && canReach,
                onClick = { info.discovered?.let(onSendFiles) },
                modifier = Modifier.weight(1f),
            )
            // 扩展屏：线 3 会话类型已落地（3.2-2），画面流接线在 3.2-1；
            // 会话建立后桌面创建虚拟显示器，画面流到后进 Screen 页观看。
            DetailAction(
                icon = { Icon(Icons.Filled.Cast, contentDescription = null) },
                label = "扩展屏",
                enabled = info.paired && canReach,
                onClick = { info.discovered?.let(onExtend) },
                modifier = Modifier.weight(1f),
            )
            DetailAction(
                icon = { Icon(Icons.Filled.Computer, contentDescription = null) },
                label = "撤销信任",
                enabled = info.deviceId != null,
                danger = true,
                onClick = { showRevokeConfirm = true },
                modifier = Modifier.weight(1f),
            )
        }
        if (info.paired && !canReach) {
            Text(
                "当前未在局域网内发现该设备，控制与发送文件暂不可用。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
            )
        }

        // ---------- 会话中断开入口（有会话时才出现） ----------
        when (info.controlState) {
            ControlState.CONTROLLING -> OutlinedButton(
                onClick = onEndControl,
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = LinkSpaceStatusColors.Danger,
                ),
                modifier = Modifier.fillMaxWidth().padding(top = LinkSpaceSpacing.md),
            ) { Text("结束控制") }
            ControlState.CONTROLLED_BY -> OutlinedButton(
                onClick = onTerminateControl,
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = LinkSpaceStatusColors.Danger,
                ),
                modifier = Modifier.fillMaxWidth().padding(top = LinkSpaceSpacing.md),
            ) { Text("终止控制") }
            ControlState.STREAMING_TO -> OutlinedButton(
                onClick = onStopStream,
                modifier = Modifier.fillMaxWidth().padding(top = LinkSpaceSpacing.md),
            ) { Text("停止推流") }
            ControlState.EXTENDING -> OutlinedButton(
                onClick = onStopExtend,
                colors = ButtonDefaults.outlinedButtonColors(
                    contentColor = LinkSpaceStatusColors.Danger,
                ),
                modifier = Modifier.fillMaxWidth().padding(top = LinkSpaceSpacing.md),
            ) { Text("结束扩展") }
            ControlState.NONE -> Unit
        }

        Spacer(Modifier.height(LinkSpaceSpacing.lg))

        // ---------- 未配对说明：安卓端不能主动发起配对 ----------
        if (!info.paired) {
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "配对需由电脑端发起：对方在桌面端发起配对后，本机会弹出 6 位配对码，核对一致即完成。安卓端暂不能主动发起配对（待服务层提供发起能力）。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(LinkSpaceSpacing.md),
                )
            }
            Spacer(Modifier.height(LinkSpaceSpacing.lg))
        }

        // ---------- 键值详情 ----------
        DetailRow("系统", deviceTypeLabel(info.deviceType))
        DetailRow("地址", if (info.host != null) "${info.host}:${info.port}" else "当前未在局域网内发现")
        DetailRow("连接方式", "局域网")
        DetailRow("状态", if (info.online) "在线" else "离线")
        DetailRow(
            "授权范围",
            if (info.scope.isEmpty()) "未配对" else info.scope.joinToString("、") { scopeLabel(it) },
        )
        if (info.caps.isNotEmpty()) {
            DetailRow("能力", info.caps.joinToString("、") { capsLabel(it) })
        }
        DetailRow(
            "信任时间",
            info.trustedAt?.let {
                SimpleDateFormat("yyyy-MM-dd HH:mm", Locale.getDefault()).format(Date(it))
            } ?: "—",
        )
    }

    // ---------- 撤销信任二次确认 ----------
    if (showRevokeConfirm && info.deviceId != null) {
        AlertDialog(
            onDismissRequest = { showRevokeConfirm = false },
            title = { Text("撤销对「${info.displayName}」的信任？") },
            text = {
                Text("撤销后对方将无法再连接本机，正在进行的会话也会断开。需要重新配对才能恢复连接。")
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        showRevokeConfirm = false
                        onRevoke(info.deviceId, info.displayName)
                    },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = LinkSpaceStatusColors.Danger,
                    ),
                ) { Text("撤销信任") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showRevokeConfirm = false }) { Text("取消") }
            },
        )
    }
}

@Composable
private fun DetailAction(
    icon: @Composable () -> Unit,
    label: String,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subLabel: String? = null,
    danger: Boolean = false,
) {
    FilledTonalButton(
        onClick = onClick,
        enabled = enabled,
        modifier = modifier.height(64.dp),
        colors = if (danger) {
            ButtonDefaults.filledTonalButtonColors(
                containerColor = MaterialTheme.colorScheme.errorContainer,
                contentColor = MaterialTheme.colorScheme.onErrorContainer,
            )
        } else {
            ButtonDefaults.filledTonalButtonColors()
        },
    ) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            icon()
            Text(
                label,
                style = MaterialTheme.typography.bodySmall,
                fontWeight = FontWeight.Medium,
            )
            if (subLabel != null) {
                Text(
                    subLabel,
                    style = MaterialTheme.typography.labelSmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }
    }
}

@Composable
private fun DetailRow(key: String, value: String) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = LinkSpaceSpacing.xs),
    ) {
        Text(
            key,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.width(72.dp),
        )
        Text(value, style = MaterialTheme.typography.bodyMedium, modifier = Modifier.weight(1f))
    }
}
