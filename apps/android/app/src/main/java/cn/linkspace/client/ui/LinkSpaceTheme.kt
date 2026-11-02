package cn.linkspace.client.ui

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.ColorScheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Shapes
import androidx.compose.material3.Typography
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * LinkSpace 设计 token（A 线拥有，B 线只消费）。
 *
 * 来源：分支内 docs/ui-redesign-android.md §2.1（桌面端 ui-redesign.md §5
 * 的 Compose 映射）。视觉效果待用户在小新平板 Pro GT 真机上验收。
 */

/** 品牌色：沿用启动图标已有的 #2F6BFF，不抄 TwinDesk / ToDesk 的蓝。 */
object LinkSpaceColors {
    val Brand = Color(0xFF2F6BFF)
    val BrandPressed = Color(0xFF2559D6)
    val BrandSoft = Color(0xFFEAF0FF)
    val BrandOnSoft = Color(0xFF1B3A8F)
}

/** 间距 token：4 / 8 / 12 / 16 / 20 / 24dp。 */
object LinkSpaceSpacing {
    val xs: Dp = 4.dp
    val sm: Dp = 8.dp
    val md: Dp = 12.dp
    val lg: Dp = 16.dp
    val xl: Dp = 20.dp
    val xxl: Dp = 24.dp
}

/**
 * 状态色三档。离线用灰（onSurfaceVariant + “离线”文字），不用黄
 * （桌面端 §5 原文）；黄色只用于“进行中”过渡态。
 */
object LinkSpaceStatusColors {
    /** 在线 / 成功 */
    val Online = Color(0xFF1E8E3E)
    val SuccessContainer = Color(0xFFE6F4EA)
    val SuccessOnContainer = Color(0xFF137333)

    /** 进行中（过渡态专用） */
    val InProgress = Color(0xFFF9AB00)
    val WarnContainer = Color(0xFFFEF7E0)
    val WarnOnContainer = Color(0xFF7A5C00)

    /** 危险 / 被控 */
    val Danger = Color(0xFFD92D20)
}

private val LightScheme: ColorScheme = lightColorScheme(
    primary = LinkSpaceColors.Brand,
    onPrimary = Color.White,
    primaryContainer = LinkSpaceColors.BrandSoft,
    onPrimaryContainer = LinkSpaceColors.BrandOnSoft,
    error = LinkSpaceStatusColors.Danger,
)

/**
 * 深色 token：只定义，不全局启用。B 线用它包 ScreenMirrorScreen
 *（局部 MaterialTheme(colorScheme = DarkStreamScheme)），主界面保持亮色。
 */
val DarkStreamScheme: ColorScheme = darkColorScheme(
    background = Color(0xFF161617),
    surface = Color(0xFF1E1E1F),
    surfaceVariant = Color(0xFF232325),
    onSurface = Color(0xFFE8EAED),
    onSurfaceVariant = Color(0xFF9AA0A6),
    outline = Color(0xFF2C3138),
    primary = LinkSpaceColors.Brand,
    onPrimary = Color.White,
    primaryContainer = LinkSpaceColors.BrandSoft,
    onPrimaryContainer = LinkSpaceColors.BrandOnSoft,
    error = LinkSpaceStatusColors.Danger,
)

/**
 * 字号 token：页标题 20sp / 区块标题 13sp / 正文 14sp / 小字 12sp /
 * 辅助 11sp。旧的 15sp 输入框字号与 18sp 触控板标题、24sp 页头已删，
 * 统一进档（触控板屏是 B 线范围，B 线改）。
 */
private val LinkSpaceTypography = Typography(
    titleLarge = TextStyle(fontSize = 20.sp, fontWeight = FontWeight.SemiBold),
    titleMedium = TextStyle(fontSize = 16.sp, fontWeight = FontWeight.SemiBold),
    titleSmall = TextStyle(fontSize = 13.sp, fontWeight = FontWeight.SemiBold),
    bodyLarge = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Normal),
    bodyMedium = TextStyle(fontSize = 14.sp, fontWeight = FontWeight.Medium),
    bodySmall = TextStyle(fontSize = 12.sp, fontWeight = FontWeight.Normal),
    labelSmall = TextStyle(fontSize = 11.sp, fontWeight = FontWeight.Normal),
)

/** 圆角 token：6 / 8 / 10 / 12 / 999dp（卡片 12dp、菜单项 8dp、胶囊 999dp）。 */
private val LinkSpaceShapes = Shapes(
    small = RoundedCornerShape(6.dp),
    medium = RoundedCornerShape(8.dp),
    large = RoundedCornerShape(12.dp),
)

/** 胶囊形状（标签用），Material3 Shapes 里没有 999dp 这一档，单独立。 */
val PillShape = RoundedCornerShape(999.dp)

@Composable
fun LinkSpaceTheme(content: @Composable () -> Unit) {
    MaterialTheme(
        colorScheme = LightScheme,
        typography = LinkSpaceTypography,
        shapes = LinkSpaceShapes,
        content = content,
    )
}
