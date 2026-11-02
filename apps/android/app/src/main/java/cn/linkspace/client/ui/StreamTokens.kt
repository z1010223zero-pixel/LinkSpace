package cn.linkspace.client.ui

import androidx.compose.material3.darkColorScheme
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/**
 * B 线本地设计 token：数值取自 docs/ui-redesign-android.md §2.1。
 *
 * A 线的 ui/LinkSpaceTheme.kt 尚未合入，本分支也没有主界面的改动；
 * B 线先在这里把画面窗口 / 确认弹窗实际用到的 token 硬编码为常量，
 * 待 A 线合入后改接 LinkSpaceTheme，本文件随之删除。
 * 只含 B 线用到的 token，不另建全局 theme、不碰主界面配色。
 */
internal object StreamTokens {
    /** 品牌主色 #2F6BFF（只存在于启动图标，界面上此前是默认 M3 紫） */
    val Accent = Color(0xFF2F6BFF)

    /** 品牌浅底 #EAF0FF（--accent-soft） */
    val AccentSoft = Color(0xFFEAF0FF)

    /** 主色按下态 #2559D6 */
    val AccentPressed = Color(0xFF2559D6)

    // ---- 状态色三档（docs/ui-redesign-android.md §2.1） ----
    /** 在线 / 成功绿 */
    val Success = Color(0xFF1E8E3E)

    /** 进行中黄（只用于过渡态） */
    val InProgress = Color(0xFFF9AB00)

    /** 危险 / 被控红 */
    val Danger = Color(0xFFD92D20)

    /** 成功态卡片底（绿的浅底） */
    val SuccessContainer = Color(0xFFE6F4EA)

    /** 危险态卡片底（红的浅底） */
    val DangerContainer = Color(0xFFFDECEA)

    // ---- 间距 token（4/8/12/16/20/24） ----
    val SpaceXs = 4.dp
    val SpaceSm = 8.dp
    val SpaceMd = 12.dp
    val SpaceLg = 16.dp
    val SpaceXl = 20.dp
    val SpaceXxl = 24.dp

    // ---- 圆角 token（6/8/10/12/999） ----
    val CornerSm = 6.dp
    val CornerMd = 8.dp
    val CornerLg = 12.dp

    // ---- 字号 token（12/13/14/16/20 档里 B 线用到的） ----
    /** 投屏标题栏设备名 */
    val TitleSize = 16.sp

    /** 正文 */
    val BodySize = 14.sp

    /** 小字 */
    val SmallSize = 12.sp

    /**
     * 画面窗口深色 token（docs/ui-redesign-android.md §2.1）：
     * 只包 ScreenMirrorScreen（局部 MaterialTheme），不做全局深色模式。
     * 画面窗口此前靠硬编码 Color.Black 撑场。
     */
    val DarkStreamScheme = darkColorScheme(
        primary = Accent,
        background = Color(0xFF161617),
        surface = Color(0xFF1E1E1F),
        surfaceVariant = Color(0xFF232325),
        onSurface = Color(0xFFE8EAED),
        onSurfaceVariant = Color(0xFF9AA0A6),
        outline = Color(0xFF2C3138)
    )

    // ---- 悬浮球 FloatingControlPill 的 token 化数值 ----
    // 球面 / 菜单本就是深色半透明叠加在画面上（画面窗口深色 token 的
    // 实际形态），颜色值不变，只把散写在文件里的数值收进 token。
    /** 小球直径 52dp（用户 2026-10-31“右上角按钮点不到”重做方案的尺寸，不动） */
    val PillSize = 52.dp

    /** 小球边缘留白 */
    val PillMargin = 8.dp

    /** 菜单宽 190dp、圆角 12dp（= CornerLg）；菜单项圆角 8dp（= CornerMd） */
    val PillMenuWidth = 190.dp

    /** 小球字标 20sp */
    val PillLabelSize = 20.sp

    /** 菜单项文字 15sp → 收进 14sp 正文档（与全文件统一进档，见审计问题 4） */
    val PillMenuItemSize = 14.sp
}
