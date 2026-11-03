package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.Card
import androidx.compose.material3.CardDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.VerticalDivider
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.TrustStore

/**
 * 设备页：分组列表（最近连接 / 已信任 / 局域网内其他）。
 * 空分组显示空状态，不消失（设计文档 §4.2/§6）。
 *
 * 分组口径沿用桌面端：最近连接 = 已信任 ∩ mDNS 可见取前 5。
 * 横屏双窗格：左侧列表 + 右侧详情卡；竖屏列表 + ModalBottomSheet
 *（Sheet 由 MainScreen 挂载，本页只负责选中态）。
 *
 * 顶部说明如实写清配对缺口：安卓端暂不能主动发起配对（设计文档
 * §2.3 第 2 项、§3 问题 5），不做假的“发起配对”按钮。
 */
@Composable
fun DevicesPage(
    service: LinkSpaceService,
    now: Long,
    isLandscape: Boolean,
    selected: DeviceDetailInfo?,
    onSelect: (DeviceDetailInfo) -> Unit,
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
    val discovered by service.discovered.collectAsStateWithLifecycle()
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val inputState by service.inputState.collectAsStateWithLifecycle()
    val extendState by service.extendState.collectAsStateWithLifecycle()
    val controlledBy by service.controlledBy.collectAsStateWithLifecycle()
    val reverseStatus by service.reverseStreamStatus.collectAsStateWithLifecycle()

    val trustedByFullId = trusted.associateBy { it.deviceId }
    fun trustedOf(d: DiscoveredService): TrustStore.Entry? =
        trustedByFullId[service.fullPeerIdOf(d.idPrefix)]
    fun statusMarkOf(d: DiscoveredService): String? {
        val fullId = service.fullPeerIdOf(d.idPrefix)
        return when {
            inputState.phase == "active" && inputState.peerId != null &&
                (inputState.peerId == fullId || inputState.peerId!!.startsWith(d.idPrefix)) -> "控制中"
            reverseStatus?.active?.peerId == fullId -> "推流中"
            controlledBy == d.displayName -> "正被控制"
            else -> null
        }
    }
    fun detailOf(d: DiscoveredService): DeviceDetailInfo = detailFor(
        discovered = d,
        trusted = trustedOf(d),
        service = service,
        inputPeerId = inputState.peerId,
        controlledByName = controlledBy,
        streamingPeerId = reverseStatus?.active?.peerId,
        extendPeerId = extendState.peerId,
        now = now,
    )
    fun detailOfTrusted(t: TrustStore.Entry): DeviceDetailInfo {
        val d = discovered.firstOrNull { service.fullPeerIdOf(it.idPrefix) == t.deviceId }
        return detailFor(
            discovered = d,
            trusted = t,
            service = service,
            inputPeerId = inputState.peerId,
            controlledByName = controlledBy,
            streamingPeerId = reverseStatus?.active?.peerId,
            extendPeerId = extendState.peerId,
            now = now,
        )
    }

    // 最近连接：已信任 ∩ mDNS 可见，按信任时间倒序取前 5
    val recent = trusted
        .mapNotNull { t ->
            discovered.firstOrNull { service.fullPeerIdOf(it.idPrefix) == t.deviceId }
                ?.let { d -> d to t }
        }
        .sortedByDescending { (_, t) -> t.trustedAt }
        .take(5)
        .map { (d, _) -> d }
    val others = discovered.filter { trustedOf(it) == null }
    // 信任条目 → 当前发现条目（按完整 deviceId 匹配，需 fullPeerIdOf 换算）
    val liveOf: (TrustStore.Entry) -> DiscoveredService? = { t ->
        discovered.firstOrNull { service.fullPeerIdOf(it.idPrefix) == t.deviceId }
    }

    if (isLandscape) {
        Row(modifier.fillMaxSize()) {
            Box(Modifier.weight(1f).fillMaxHeight()) {
                DeviceList(
                    recent = recent,
                    trusted = trusted,
                    others = others,
                    discovered = discovered,
                    now = now,
                    liveOf = liveOf,
                    statusMarkOf = ::statusMarkOf,
                    onSelectDiscovered = { onSelect(detailOf(it)) },
                    onSelectTrusted = { onSelect(detailOfTrusted(it)) },
                )
            }
            VerticalDivider()
            Box(
                Modifier.weight(1f).fillMaxHeight()
                    .padding(LinkSpaceSpacing.lg),
            ) {
                if (selected != null) {
                    Card(Modifier.fillMaxSize()) {
                        Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                            DeviceDetailContent(
                                info = selected,
                                onControl = onControl,
                                onExtend = onExtend,
                                onSendFiles = onSendFiles,
                                onRevoke = onRevoke,
                                onEndControl = onEndControl,
                                onTerminateControl = onTerminateControl,
                                onStopStream = onStopStream,
                                onStopExtend = onStopExtend,
                            )
                        }
                    }
                } else {
                    Column(
                        Modifier.fillMaxSize().padding(LinkSpaceSpacing.xl),
                    ) {
                        Text(
                            "从左侧选一台设备查看详情",
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }
    } else {
        DeviceList(
            recent = recent,
            trusted = trusted,
            others = others,
            discovered = discovered,
            now = now,
            liveOf = liveOf,
            statusMarkOf = ::statusMarkOf,
            onSelectDiscovered = { onSelect(detailOf(it)) },
            onSelectTrusted = { onSelect(detailOfTrusted(it)) },
            modifier = modifier,
        )
    }
}

@Composable
private fun DeviceList(
    recent: List<DiscoveredService>,
    trusted: List<TrustStore.Entry>,
    others: List<DiscoveredService>,
    discovered: List<DiscoveredService>,
    now: Long,
    liveOf: (TrustStore.Entry) -> DiscoveredService?,
    statusMarkOf: (DiscoveredService) -> String?,
    onSelectDiscovered: (DiscoveredService) -> Unit,
    onSelectTrusted: (TrustStore.Entry) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(
        modifier.fillMaxSize().padding(horizontal = LinkSpaceSpacing.lg),
        verticalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm),
    ) {
        item { Spacer(Modifier.height(LinkSpaceSpacing.xs)) }

        item {
            Card(
                colors = CardDefaults.cardColors(
                    containerColor = MaterialTheme.colorScheme.primaryContainer,
                ),
                modifier = Modifier.fillMaxWidth(),
            ) {
                Text(
                    "配对由电脑端发起：对方在桌面端发起配对后，本机会弹出 6 位配对码，核对一致即完成。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onPrimaryContainer,
                    modifier = Modifier.padding(LinkSpaceSpacing.md),
                )
            }
        }

        // ---------- 最近连接 ----------
        item { SectionTitle("最近连接") }
        if (recent.isEmpty()) {
            item { EmptyGroupText("暂无最近连接的设备") }
        } else {
            items(recent, key = { it.serviceName }) { d ->
                Card(Modifier.fillMaxWidth()) {
                    DeviceRow(
                        name = d.displayName,
                        subtitle = "${deviceTypeLabel(d.deviceType)} · 局域网 · ${d.host}",
                        deviceType = d.deviceType,
                        online = isOnline(d.lastSeen, now),
                        statusMark = statusMarkOf(d),
                        onClick = { onSelectDiscovered(d) },
                    )
                }
            }
        }

        // ---------- 已信任 ----------
        item { SectionTitle("已信任") }
        if (trusted.isEmpty()) {
            item { EmptyGroupText("暂无已信任的设备") }
        } else {
            items(trusted, key = { it.deviceId }) { t ->
                // 在线状态以发现列表为准：信任但未发现 = 离线
                val liveEntry = liveOf(t)
                Card(Modifier.fillMaxWidth()) {
                    DeviceRow(
                        name = t.displayName,
                        subtitle = "${deviceTypeLabel(t.deviceType)} · " +
                            if (liveEntry != null) "局域网 · ${liveEntry.host}" else "当前未在局域网内发现",
                        deviceType = t.deviceType,
                        online = liveEntry != null && isOnline(liveEntry.lastSeen, now),
                        statusMark = liveEntry?.let(statusMarkOf),
                        onClick = { onSelectTrusted(t) },
                    )
                }
            }
        }

        // ---------- 局域网内其他 ----------
        item { SectionTitle("局域网内其他") }
        if (discovered.isEmpty()) {
            item {
                Text(
                    "正在搜索…若桌面端已启动 LinkSpace 应会出现在这里。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        } else if (others.isEmpty()) {
            item { EmptyGroupText("局域网内没有其他未配对设备") }
        } else {
            items(others, key = { it.serviceName }) { d ->
                Card(Modifier.fillMaxWidth()) {
                    DeviceRow(
                        name = d.displayName,
                        subtitle = "${deviceTypeLabel(d.deviceType)} · 局域网 · ${d.host} · 未配对",
                        deviceType = d.deviceType,
                        online = isOnline(d.lastSeen, now),
                        statusMark = statusMarkOf(d),
                        onClick = { onSelectDiscovered(d) },
                    )
                }
            }
        }

        item { Spacer(Modifier.height(LinkSpaceSpacing.lg)) }
    }
}

@Composable
private fun EmptyGroupText(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier.padding(vertical = LinkSpaceSpacing.xs),
    )
}
