package cn.linkspace.client

import android.content.ClipboardManager
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import cn.linkspace.client.service.ClipboardSync
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.TransferTask

class MainActivity : ComponentActivity() {
    /**
     * 剪贴板同步只在界面前台时运行。
     *
     * Android 10 起后台应用读取剪贴板会被系统拒绝（getPrimaryClip 返回空
     * 或直接抛异常），这不是权限问题，申请也拿不到。因此不放到服务里常驻，
     * 而是在 onResume / onPause 之间挂接——代价是应用退到后台后不再同步，
     * 这符合平台约束，也比静默失败好。
     */
    private val clipboardIo = object : ClipboardSync.ClipboardIo {
        private fun manager(): ClipboardManager? =
            getSystemService(ClipboardManager::class.java)

        override fun readText(): String {
            val clip = runCatching { manager()?.primaryClip }.getOrNull() ?: return ""
            if (clip.itemCount == 0) return ""
            return clip.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
        }

        /**
         * 写剪贴板走主线程：控制消息到达时服务在 IO 线程上，
         * 直接 setPrimaryClip 在部分版本上会被拒绝。
         */
        override fun writeText(text: String) {
            runOnUiThread {
                runCatching {
                    manager()?.setPrimaryClip(
                        android.content.ClipData.newPlainText("LinkSpace", text)
                    )
                }.onFailure {
                    android.util.Log.w("LinkSpace/Clipboard", "写入剪贴板失败: ${it.message}")
                }
            }
        }
    }

    private val clipboardListener =
        ClipboardManager.OnPrimaryClipChangedListener { serviceOf()?.pollClipboard() }

    private fun serviceOf(): LinkSpaceService? = LinkSpaceService.get(this)

    override fun onResume() {
        super.onResume()
        val service = serviceOf() ?: return
        service.enableClipboardSync(clipboardIo)
        android.util.Log.i("LinkSpace/Clipboard", "界面已到前台，剪贴板同步已启用")
        runCatching {
            getSystemService(ClipboardManager::class.java)
                ?.addPrimaryClipChangedListener(clipboardListener)
        }
    }

    override fun onPause() {
        runCatching {
            getSystemService(ClipboardManager::class.java)
                ?.removePrimaryClipChangedListener(clipboardListener)
        }
        serviceOf()?.disableClipboardSync()
        super.onPause()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val service = LinkSpaceService.get(this)

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    MainScreen(service)
                }
            }
        }
    }
}

@Composable
fun MainScreen(service: LinkSpaceService) {
    val pairings by service.pendingPairings.collectAsStateWithLifecycle()
    val discovered by service.discovered.collectAsStateWithLifecycle()
    val transfers by service.transfers.collectAsStateWithLifecycle()
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val port by service.port.collectAsStateWithLifecycle()
    var notice by remember { mutableStateOf("") }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text("LinkSpace", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(
                "本机指纹 ${service.fingerprint.take(17)}… · 端口 $port",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Spacer(Modifier.height(4.dp))
        }

        if (notice.isNotEmpty()) {
            item {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    Text(notice, modifier = Modifier.padding(12.dp), fontSize = 13.sp)
                }
            }
        }

        // ---------- 配对请求：展示配对码并允许确认 ----------
        if (pairings.isNotEmpty()) {
            item { SectionTitle("待确认的配对请求") }
            items(pairings, key = { it.id }) { p ->
                Card {
                    Column(Modifier.padding(14.dp)) {
                        Text("${p.displayName} 请求配对", fontWeight = FontWeight.Medium)
                        Text(
                            "请让对方输入下面这 6 位配对码。配对码只在本机屏幕显示，不会通过网络传递。",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(10.dp))
                        Text(
                            p.code,
                            fontSize = 32.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                            letterSpacing = 6.sp
                        )
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = {
                                service.rejectPairing(p.id)
                            }) { Text("拒绝") }
                        }
                    }
                }
            }
        }

        // ---------- 已信任设备 ----------
        if (trusted.isNotEmpty()) {
            item { SectionTitle("已信任的设备") }
            items(trusted, key = { it.deviceId }) { t ->
                Card {
                    Row(
                        Modifier.padding(14.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(t.displayName, fontWeight = FontWeight.Medium)
                            Text(
                                "授权范围：${t.scope.joinToString(", ")}",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        TextButton(onClick = {
                            service.revokeTrust(t.deviceId)
                            notice = "已撤销对 ${t.displayName} 的信任"
                        }) { Text("撤销") }
                    }
                }
            }
        }

        // ---------- 传输任务 ----------
        if (transfers.isNotEmpty()) {
            item { SectionTitle("文件传输") }
            items(transfers, key = { it.id }) { t ->
                Card {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                t.files.joinToString { it.name },
                                Modifier.weight(1f),
                                fontWeight = FontWeight.Medium
                            )
                            Badge { Text(stateLabel(t.state)) }
                        }
                        Text(
                            "${formatBytes(t.totalSize)} · ${t.direction}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        if (t.state == TransferTask.ACCEPTED) {
                            Spacer(Modifier.height(8.dp))
                            LinearProgressIndicator(
                                progress = { if (t.totalSize == 0L) 0f else t.transferred.toFloat() / t.totalSize },
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        if (t.state == TransferTask.OFFERED) {
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = {
                                    service.acceptTransfer(t.id)
                                        .onSuccess { notice = "已开始接收" }
                                        .onFailure { notice = it.message ?: "接收失败" }
                                }) { Text("接收") }
                                OutlinedButton(onClick = { service.cancelTransfer(t.id) }) {
                                    Text("拒绝")
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---------- 发现的设备 ----------
        item { SectionTitle("局域网内的其他设备") }
        if (discovered.isEmpty()) {
            item {
                Text(
                    "正在搜索…若桌面端已启动 LinkSpace 应会出现在这里。",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        items(discovered, key = { it.serviceName }) { d ->
            Card {
                Row(
                    Modifier.padding(14.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(d.displayName, fontWeight = FontWeight.Medium)
                        Text(
                            "${d.host}:${d.port} · ${d.caps.joinToString(", ")}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (d.paired) {
                        Badge { Text("已配对") }
                    }
                }
            }
        }

        item {
            Spacer(Modifier.height(24.dp))
            Text(
                "第一阶段：本机作为接收方。投屏与控制由桌面端 scrcpy 完成，不经过本应用。",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 8.dp)
    )
}

private fun stateLabel(state: String): String = when (state) {
    TransferTask.OFFERED -> "等待确认"
    TransferTask.ACCEPTED -> "接收中"
    TransferTask.COMPLETED -> "已完成"
    TransferTask.FAILED -> "失败"
    TransferTask.CANCELLED -> "已取消"
    else -> state
}

private fun formatBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "${n / 1024} KB"
    n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1024.0 / 1024.0)
    else -> "%.2f GB".format(n / 1024.0 / 1024.0 / 1024.0)
}
