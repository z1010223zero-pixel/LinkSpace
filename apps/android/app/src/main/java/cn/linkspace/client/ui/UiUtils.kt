package cn.linkspace.client.ui

import android.content.Context
import android.net.wifi.WifiManager
import android.os.Build
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Computer
import androidx.compose.material.icons.filled.DevicesOther
import androidx.compose.material.icons.filled.PhoneAndroid
import androidx.compose.material.icons.filled.PhoneIphone
import androidx.compose.material.icons.filled.TabletAndroid
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import cn.linkspace.client.service.Discovery
import cn.linkspace.client.service.TransferTask

/**
 * 主界面共用的小工具：文案映射、在线判定、本机信息。
 * 全部只做表现层映射，不改协议与服务层。
 */

@Composable
internal fun SectionTitle(text: String) {
    Text(
        text,
        style = MaterialTheme.typography.titleSmall,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = LinkSpaceSpacing.sm),
    )
}

internal fun formatBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "${n / 1024} KB"
    n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1024.0 / 1024.0)
    else -> "%.2f GB".format(n / 1024.0 / 1024.0 / 1024.0)
}

internal fun stateLabel(state: String): String = when (state) {
    TransferTask.OFFERED -> "等待确认"
    TransferTask.ACCEPTED -> "进行中"
    TransferTask.COMPLETED -> "已完成"
    TransferTask.FAILED -> "失败"
    TransferTask.CANCELLED -> "已取消"
    else -> state
}

/** 授权范围原文 → 中文（protocol.json defaultGrantScope：file / clipboard）。 */
internal fun scopeLabel(scope: String): String = when (scope) {
    "file" -> "文件传输"
    "clipboard" -> "剪贴板同步"
    "input" -> "键鼠控制"
    "screen" -> "屏幕查看"
    else -> scope
}

/** 能力原文 → 中文（桌面端 announce 的 caps：file / clipboard / scrcpy / input）。 */
internal fun capsLabel(cap: String): String = when (cap) {
    "file" -> "文件"
    "clipboard" -> "剪贴板"
    "scrcpy" -> "投屏"
    "input" -> "键鼠"
    else -> cap
}

/** 设备类型原文 → 系统图标。未见过的值落到通用图标，不编造具体系统。 */
internal fun deviceTypeIcon(deviceType: String): ImageVector {
    val t = deviceType.lowercase()
    return when {
        "windows" in t || "mac" in t || "linux" in t || "desktop" in t || "pc" in t ->
            Icons.Filled.Computer
        "ipad" in t -> Icons.Filled.TabletAndroid
        "iphone" in t || "ios" in t -> Icons.Filled.PhoneIphone
        "tablet" in t -> Icons.Filled.TabletAndroid
        "android" in t -> Icons.Filled.PhoneAndroid
        else -> Icons.Filled.DevicesOther
    }
}

/** 设备类型原文 → 中文系统名。未见过的值原样显示，不猜。 */
internal fun deviceTypeLabel(deviceType: String): String {
    val t = deviceType.lowercase()
    return when {
        "windows" in t -> "Windows 电脑"
        "mac" in t -> "Mac 电脑"
        "linux" in t -> "Linux 电脑"
        "ipad" in t -> "iPad"
        "iphone" in t || "ios" in t -> "iPhone"
        "tablet" in t -> "Android 平板"
        "android" in t -> "Android 手机"
        "desktop" in t || "pc" in t -> "电脑"
        deviceType.isBlank() -> "未知设备"
        else -> deviceType
    }
}

/**
 * 在线判定：lastSeen 在软过期阈值内即在线。阈值复用 Discovery.STALE_MS
 *（300s；NSD 上报间隔实测 30–60s+，桌面端 12s 阈值在安卓端会误判离线）。
 * lastSeen 为 0（无通告记录）按离线算。
 */
internal fun isOnline(lastSeen: Long, now: Long): Boolean =
    lastSeen > 0 && now - lastSeen < Discovery.STALE_MS

/** 本机 Wi-Fi IP（ACCESS_WIFI_STATE 已声明）。拿不到返回 null，调用方改显示指纹·端口。 */
internal fun localIpAddress(context: Context): String? {
    val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
        ?: return null
    @Suppress("DEPRECATION")
    val ip = wifi.connectionInfo?.ipAddress ?: 0
    if (ip == 0) return null
    return "%d.%d.%d.%d".format(ip and 0xff, ip shr 8 and 0xff, ip shr 16 and 0xff, ip shr 24 and 0xff)
}

/** 应用版本号（运行时读包信息，不硬编码）。 */
internal fun appVersionName(context: Context): String = runCatching {
    val pm = context.packageManager
    val info = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
        pm.getPackageInfo(context.packageName, android.content.pm.PackageManager.PackageInfoFlags.of(0))
    } else {
        @Suppress("DEPRECATION")
        pm.getPackageInfo(context.packageName, 0)
    }
    info.versionName ?: ""
}.getOrNull().orEmpty()
