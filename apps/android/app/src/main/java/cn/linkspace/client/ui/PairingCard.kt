package cn.linkspace.client.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Card
import androidx.compose.material3.LinearProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import cn.linkspace.client.service.LinkSpaceService
import kotlinx.coroutines.delay

/**
 * 配对码展示卡：配对码 32sp 等宽展示 + 复制按钮 + 倒计时 + 拒绝。
 * 替换旧的配对卡（MainActivity.kt:419-448）：旧卡无复制、无倒计时。
 *
 * 倒计时以 PendingPairing.expiresAt 为准（协议配对码 TTL 60s），
 * 每秒刷新；过期后服务层会清掉这条请求，这里只做防御性展示。
 */
@Composable
fun PairingCard(
    pairing: LinkSpaceService.PendingPairing,
    onReject: () -> Unit,
    onCopied: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val context = LocalContext.current
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(pairing.id) {
        while (true) {
            delay(1000)
            now = System.currentTimeMillis()
        }
    }
    // 配对码 TTL 60s（protocol.json pairingCode.ttlMs）；以 expiresAt 为准
    val totalMs = 60_000L
    val remainingMs = (pairing.expiresAt - now).coerceAtLeast(0L)
    val remainingSec = (remainingMs / 1000).toInt()

    Card(modifier.fillMaxWidth()) {
        Column(Modifier.padding(LinkSpaceSpacing.lg)) {
            Text("${pairing.displayName} 请求配对", style = MaterialTheme.typography.bodyMedium)
            Text(
                "请让对方输入下面这 6 位配对码。配对码只在本机屏幕显示，不会通过网络传递。",
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(LinkSpaceSpacing.md))
            Text(
                pairing.code,
                fontSize = 32.sp,
                fontWeight = FontWeight.Bold,
                fontFamily = FontFamily.Monospace,
                letterSpacing = 6.sp,
            )
            Spacer(Modifier.height(LinkSpaceSpacing.sm))
            Row(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm),
            ) {
                Text(
                    if (remainingSec > 0) "剩余 ${remainingSec} 秒" else "已过期",
                    style = MaterialTheme.typography.bodySmall,
                    color = if (remainingSec > 0) MaterialTheme.colorScheme.onSurfaceVariant
                    else LinkSpaceStatusColors.Danger,
                    modifier = Modifier.weight(1f),
                )
            }
            LinearProgressIndicator(
                progress = { (remainingMs.toFloat() / totalMs).coerceIn(0f, 1f) },
                modifier = Modifier.fillMaxWidth().padding(vertical = LinkSpaceSpacing.sm),
            )
            Row(horizontalArrangement = Arrangement.spacedBy(LinkSpaceSpacing.sm)) {
                OutlinedButton(onClick = {
                    val cm = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
                    cm?.setPrimaryClip(ClipData.newPlainText("LinkSpace 配对码", pairing.code))
                    onCopied()
                }) { Text("复制配对码") }
                OutlinedButton(onClick = onReject) { Text("拒绝") }
            }
        }
    }
}
