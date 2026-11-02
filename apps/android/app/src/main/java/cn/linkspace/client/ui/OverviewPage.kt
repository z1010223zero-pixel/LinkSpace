package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.ContentCopy
import androidx.compose.material3.Button
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboardManager
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.AnnotatedString
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.TransferTask
import cn.linkspace.client.service.TrustStore

/**
 * 概览页：本机卡 + 连接可视化 + 双向方向卡 + 设备行 + 配对卡。
 * 旧首页 10 个区块平铺的替代品；剪贴板/被控的长篇说明已移入设置页。
 *
 * 延迟：服务层没有延迟字段，三处常驻延迟全部不显示、不编数字
 *（设计文档 §6），连接卡只画“本机 ↔ 对端 · 局域网直连”。
 */
@Composable
fun OverviewPage(
    service: LinkSpaceService,
    now: Long,
    board: NoticeBoard,
    onClipboardToggle: (Boolean) -> Unit,
    onOpenAccessibilitySettings: () -> Unit,
    onNavigateToDevices: () -> Unit,
    onDeviceClick: (DeviceDetailInfo) -> Unit,
    modifier: Modifier = Modifier,
) {
    val selfName by service.selfName.collectAsStateWithLifecycle()
    val fingerprintText by service.fingerprintText.collectAsStateWithLifecycle()
    val port by service.port.collectAsStateWithLifecycle()
    val discovered by service.discovered.collectAsStateWithLifecycle()
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val pairings by service.pendingPairings.collectAsStateWithLifecycle()
    val transfers by service.transfers.collectAsStateWithLifecycle()
    val clipboardEnabled by service.clipboardEnabled.collectAsStateWithLifecycle()
    val accessibilityEnabled by service.accessibilityEnabled.collectAsStateWithLifecycle()
    val inputState by service.inputState.collectAsStateWithLifecycle()
    val controlledBy by service.controlledBy.collectAsStateWithLifecycle()
    val reverseStatus by service.reverseStreamStatus.collectAsStateWithLifecycle()
    val context = LocalContext.current

    val trustedByFullId = trusted.associateBy { it.deviceId }
    fun trustedOf(d: DiscoveredService): TrustStore.Entry? =
        trustedByFullId[service.fullPeerIdOf(d.idPrefix)]
    fun statusMarkOf(d: DiscoveredService): String? {
        val fullId = service.fullPeerIdOf(d.idPrefix)
        return when {
            inputState.phase == "active" && inputState.peerId != null &&
                (inputState.peerId == fullId || inputState.peerId!!.startsWith(d.idPrefix)) -> "控制中"
            reverseStatus?.active?.peerId == fullId -> "推流中"
            else -> null
        }
    }

    LazyColumn(
        modifier.fillMaxSize().padding(horizontal = LinkSpaceSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.md),
    ) {
        item { Spacer(Modifier.height(LinkSpaceSpacing.xs)) }

        // ---------- 待确认的配对请求 ----------
        items(pairings, key = { it.id }) { p ->
            PairingCard(
                pairing = p,
                onReject = { service.rejectPairing(p.id) },
                onCopied = { board.success("配对码已复制") },
            )
        }

        // ---------- 被控授权引导常驻卡（配好之前一直挂着，不是一次性弹窗） ----------
        if (!accessibilityEnabled) {
            item {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.primaryContainer,
                    ),
                    modifier = Modifier.fillMaxWidth(),
                ) {
                    Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                        Text(
                            "还没开启被控授权",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        Text(
                            "想让电脑控制这台平板，需要先开启无障碍服务：设置 → 无障碍 → LinkSpace 远程输入。",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onPrimaryContainer,
                        )
                        OutlinedButton(
                            onClick = onOpenAccessibilitySettings,
                            modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                        ) { Text("去开启") }
                    }
                }
            }
        }

        // ---------- 本机卡 ----------
        item {
            val ip = localIpAddress(context)
            val ready = port > 0 && fingerprintText.isNotEmpty()
            val clipboardManager = LocalClipboardManager.current
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Column(Modifier.weight(1f)) {
                            Text("本机", style = MaterialTheme.typography.titleSmall)
                            Text(
                                selfName,
                                style = MaterialTheme.typography.titleMedium,
                            )
                        }
                        if (ready) {
                            Icon(
                                Icons.Filled.CheckCircle,
                                contentDescription = "就绪",
                                tint = LinkSpaceStatusColors.Online,
                            )
                        }
                    }
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                    ) {
                        Text(
                            if (ip != null) "$ip · 端口 $port" else "指纹 ${fingerprintText.take(17)}… · 端口 $port",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                            modifier = Modifier.weight(1f),
                        )
                        if (ip != null) {
                            IconButton(onClick = {
                                clipboardManager.setText(AnnotatedString(ip))
                                board.success("已复制本机 IP")
                            }) {
                                Icon(Icons.Filled.ContentCopy, contentDescription = "复制 IP")
                            }
                        }
                    }
                }
            }
        }

        // ---------- 连接可视化（无延迟数字） ----------
        item {
            val controllingPeerName: String? = inputState.peerId?.let { peerId ->
                discovered.firstOrNull {
                    peerId == service.fullPeerIdOf(it.idPrefix) || peerId.startsWith(it.idPrefix)
                }?.displayName
                    ?: trusted.firstOrNull { it.deviceId == peerId }?.displayName
            }
            val pairedOnline = discovered.filter {
                it.paired && isOnline(it.lastSeen, now)
            }
            Card(Modifier.fillMaxWidth()) {
                Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                    Text("连接", style = MaterialTheme.typography.titleSmall)
                    when {
                        controllingPeerName != null -> Text(
                            "正在控制 $controllingPeerName",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                        )
                        pairedOnline.isNotEmpty() -> Text(
                            "本机 ↔ ${pairedOnline.first().displayName} · 局域网直连",
                            style = MaterialTheme.typography.bodyMedium,
                            modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                        )
                        else -> Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                        ) {
                            Text(
                                "暂无已配对的在线设备",
                                style = MaterialTheme.typography.bodyMedium,
                                modifier = Modifier.weight(1f),
                            )
                            TextButton(onClick = onNavigateToDevices) { Text("去设备页") }
                        }
                    }
                    if (pairedOnline.size > 1) {
                        Text(
                            "另有 ${pairedOnline.size - 1} 台已配对设备在线",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        // ---------- 方向卡 A：平板 → 电脑 ----------
        item {
            DirectionCard(title = "平板 → 电脑", subtitle = "这台平板控制电脑") {
                DirectionRow(
                    name = "键鼠控制",
                    description = "在设备页选一台已配对的电脑发起控制",
                ) {
                    TextButton(onClick = onNavigateToDevices) { Text("去设备页") }
                }
                DirectionRow(
                    name = "画面投屏",
                    description = "控制会话中点「投屏」，电脑画面流到本机",
                ) {
                    Text(
                        if (inputState.phase == "active") "控制进行中" else "会话中可用",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (inputState.phase == "active") LinkSpaceStatusColors.Online
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DirectionRow(
                    name = "剪贴板同步",
                    description = "与已配对设备双向同步（双向共用同一开关）",
                ) {
                    Switch(checked = clipboardEnabled, onCheckedChange = onClipboardToggle)
                }
                val activeTransfers = transfers.count { it.state == TransferTask.ACCEPTED }
                DirectionRow(
                    name = "文件传输",
                    description = "已配对设备之间互发文件",
                ) {
                    Text(
                        if (activeTransfers > 0) "进行中 $activeTransfers 个" else "就绪",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // ---------- 方向卡 B：电脑 → 平板 ----------
        item {
            DirectionCard(title = "电脑 → 平板", subtitle = "电脑控制这台平板") {
                DirectionRow(
                    name = "远程控制",
                    description = if (accessibilityEnabled)
                        "无障碍服务已开启：电脑请求控制时本机弹确认框"
                    else
                        "无障碍服务未开启：电脑的控制请求会被直接拒绝",
                ) {
                    OutlinedButton(onClick = onOpenAccessibilitySettings) {
                        Text(if (accessibilityEnabled) "查看设置" else "去开启")
                    }
                }
                val reverseActive = reverseStatus?.active
                DirectionRow(
                    name = "屏幕推流",
                    description = "电脑请求后本机确认，画面实时推给电脑",
                ) {
                    Text(
                        if (reverseActive != null) "推流中" else "待电脑发起",
                        style = MaterialTheme.typography.bodySmall,
                        color = if (reverseActive != null) LinkSpaceStatusColors.Online
                        else MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                DirectionRow(
                    name = "剪贴板同步",
                    description = "与已配对设备双向同步（双向共用同一开关）",
                ) {
                    Switch(checked = clipboardEnabled, onCheckedChange = onClipboardToggle)
                }
                val pendingReceives = transfers.count {
                    it.state == TransferTask.OFFERED && it.direction == "receive"
                }
                DirectionRow(
                    name = "文件接收",
                    description = "电脑发来的文件会出现在文件页",
                ) {
                    Text(
                        if (pendingReceives > 0) "待接收 $pendingReceives 个" else "就绪",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            }
        }

        // ---------- 设备行（前 5 台） ----------
        if (discovered.isNotEmpty()) {
            item { SectionTitle("设备") }
            items(discovered.take(5), key = { it.serviceName }) { d ->
                Card(Modifier.fillMaxWidth()) {
                    DeviceRow(
                        name = d.displayName,
                        subtitle = "${deviceTypeLabel(d.deviceType)} · 局域网 · ${d.host}",
                        deviceType = d.deviceType,
                        online = isOnline(d.lastSeen, now),
                        statusMark = statusMarkOf(d),
                        onClick = {
                            onDeviceClick(
                                detailFor(
                                    discovered = d,
                                    trusted = trustedOf(d),
                                    service = service,
                                    inputPeerId = inputState.peerId,
                                    controlledByName = controlledBy,
                                    streamingPeerId = reverseStatus?.active?.peerId,
                                    now = now,
                                ),
                            )
                        },
                    )
                }
            }
            item {
                Button(
                    onClick = onNavigateToDevices,
                    modifier = Modifier.fillMaxWidth(),
                ) { Text("查看全部设备") }
            }
        }

        item { Spacer(Modifier.height(LinkSpaceSpacing.lg)) }
    }
}
