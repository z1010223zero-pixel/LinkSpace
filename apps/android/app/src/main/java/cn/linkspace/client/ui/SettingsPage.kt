package cn.linkspace.client.ui

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Card
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import cn.linkspace.client.service.TrustStore

/**
 * 设置页：改名、剪贴板、被控设置、端口/指纹、关于、退出。
 * 旧首页把被控设置的长篇说明直接堆在主列表里（MainActivity.kt:339-359），
 * 现收进设置页，首页只留状态行 + 入口。
 *
 * 退出是高危操作：点即断开全部连接并停前台服务，加二次确认
 *（旧页头“退出”与“修改本机名称”并排、无确认，MainActivity.kt:316-327）。
 */
@Composable
fun SettingsPage(
    selfName: String,
    fingerprintText: String,
    port: Int,
    clipboardEnabled: Boolean,
    onClipboardToggle: (Boolean) -> Unit,
    accessibilityEnabled: Boolean,
    onOpenAccessibilitySettings: () -> Unit,
    onRenameClick: () -> Unit,
    onExitConfirm: () -> Unit,
    versionName: String,
    /** 信任清单：勾选过“信任此设备”的已配对设备（免确认标记，Bug 2） */
    trustedNoConfirm: List<TrustStore.Entry> = emptyList(),
    onRevokeNoConfirm: (String) -> Unit = {},
    onClearNoConfirm: () -> Unit = {},
    modifier: Modifier = Modifier,
) {
    var showExitConfirm by remember { mutableStateOf(false) }
    var showClearTrustConfirm by remember { mutableStateOf(false) }

    Column(modifier.fillMaxWidth().padding(LinkSpaceSpacing.lg)) {
        SectionTitle("本机")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Column(Modifier.weight(1f)) {
                        Text("本机名称", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            selfName,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    OutlinedButton(onClick = onRenameClick) { Text("修改") }
                }
                Row(
                    Modifier.padding(top = LinkSpaceSpacing.md),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Column(Modifier.weight(1f)) {
                        Text("本机指纹", style = MaterialTheme.typography.bodyMedium)
                        Text(
                            if (fingerprintText.isEmpty()) "身份初始化中…"
                            else "指纹 ${fingerprintText.take(17)}… · 端口 $port",
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
        }

        SectionTitle("同步")
        Card(Modifier.fillMaxWidth()) {
            Row(
                Modifier.padding(LinkSpaceSpacing.lg),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Column(Modifier.weight(1f)) {
                    Text("剪贴板同步", style = MaterialTheme.typography.bodyMedium)
                    Text(
                        "与已配对设备互相同步剪贴板文本。默认关闭：内容会经过本机网络。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Spacer(Modifier.width(LinkSpaceSpacing.md))
                Switch(checked = clipboardEnabled, onCheckedChange = onClipboardToggle)
            }
        }

        SectionTitle("被控设置（电脑控平板）")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                Text(
                    if (accessibilityEnabled) "无障碍服务已开启：已配对的电脑请求控制时，本机会弹确认框，点了“允许”才放行。"
                    else "无障碍服务未开启：电脑的控制请求会被直接拒绝，不会弹确认框。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (!accessibilityEnabled) {
                    Text(
                        "开启路径：点下面的按钮进「设置 → 无障碍」，找到 LinkSpace 远程输入并打开。如在列表里找不到、或开关是灰的：Android 13 起侧载安装的应用会被系统加上“受限设置”，请先到「设置 → 应用 → LinkSpace → 右上角 ⋮ 菜单 → 允许受限设置」，再回无障碍里开启。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                    )
                }
                OutlinedButton(
                    onClick = onOpenAccessibilitySettings,
                    modifier = Modifier.padding(top = LinkSpaceSpacing.md),
                ) { Text(if (accessibilityEnabled) "查看设置" else "去开启") }
            }
        }

        SectionTitle("信任清单")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                Text(
                    "勾选过“信任此设备”的电脑再次请求控制或查看屏幕时，不再弹出 LinkSpace 确认框（系统录屏授权框仍会弹出）。信任默认永久有效；撤销只取消“不再询问”，设备仍保持配对。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
                if (trustedNoConfirm.isEmpty()) {
                    Text(
                        "暂无信任设备：首次确认框里勾选“信任此设备，以后不再询问”即可加入。",
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                        modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
                    )
                } else {
                    trustedNoConfirm.forEach { entry ->
                        Row(
                            Modifier.padding(top = LinkSpaceSpacing.md),
                            verticalAlignment = Alignment.CenterVertically,
                        ) {
                            Column(Modifier.weight(1f)) {
                                Text(entry.displayName, style = MaterialTheme.typography.bodyMedium)
                                Text(
                                    "${deviceTypeLabel(entry.deviceType)} · ${entry.deviceId.take(12)}…",
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                                )
                            }
                            Spacer(Modifier.width(LinkSpaceSpacing.md))
                            OutlinedButton(onClick = { onRevokeNoConfirm(entry.deviceId) }) {
                                Text("撤销")
                            }
                        }
                    }
                    OutlinedButton(
                        onClick = { showClearTrustConfirm = true },
                        colors = ButtonDefaults.outlinedButtonColors(
                            contentColor = LinkSpaceStatusColors.Danger,
                        ),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(top = LinkSpaceSpacing.md),
                    ) { Text("清空全部信任") }
                }
            }
        }

        SectionTitle("关于")
        Card(Modifier.fillMaxWidth()) {
            Column(Modifier.padding(LinkSpaceSpacing.lg)) {
                Text("LinkSpace v$versionName", style = MaterialTheme.typography.bodyMedium)
                Text(
                    "局域网多设备协作：发现、配对、文件与控制都不出网。",
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                )
            }
        }

        SectionTitle("退出")
        OutlinedButton(
            onClick = { showExitConfirm = true },
            colors = ButtonDefaults.outlinedButtonColors(
                contentColor = LinkSpaceStatusColors.Danger,
            ),
            modifier = Modifier.fillMaxWidth(),
        ) { Text("退出 LinkSpace") }

        Text(
            "退出将断开全部连接并停止前台服务。",
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
        )
    }

    if (showExitConfirm) {
        AlertDialog(
            onDismissRequest = { showExitConfirm = false },
            title = { Text("退出 LinkSpace？") },
            text = { Text("退出将断开全部连接（含正在进行的控制与推流），并停止前台服务。下次打开应用会重新上线。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showExitConfirm = false
                        onExitConfirm()
                    },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = LinkSpaceStatusColors.Danger,
                    ),
                ) { Text("退出") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showExitConfirm = false }) { Text("取消") }
            },
        )
    }

    if (showClearTrustConfirm) {
        AlertDialog(
            onDismissRequest = { showClearTrustConfirm = false },
            title = { Text("清空全部信任？") },
            text = { Text("将取消全部设备的“不再询问”，之后每次控制或查看屏幕都会重新弹出确认框。设备仍保持配对，不用重新配对。") },
            confirmButton = {
                TextButton(
                    onClick = {
                        showClearTrustConfirm = false
                        onClearNoConfirm()
                    },
                    colors = ButtonDefaults.textButtonColors(
                        contentColor = LinkSpaceStatusColors.Danger,
                    ),
                ) { Text("清空") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showClearTrustConfirm = false }) { Text("取消") }
            },
        )
    }
}
