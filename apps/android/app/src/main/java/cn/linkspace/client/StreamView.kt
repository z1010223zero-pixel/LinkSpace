package cn.linkspace.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.SurfaceTexture
import android.view.Surface
import android.view.TextureView
import android.view.View
import android.widget.FrameLayout

/**
 * 投屏画面双模渲染视图：
 *
 * - **高性能硬解模式（fast）**：底层 [TextureView] 提供 [Surface]，由 `FastStreamDecoder`
 *   硬件 `MediaCodec` 零 CPU 拷贝直投 GPU 纹理渲染；顶层 [overlayView] 背景透明，只画远端光标。
 * - **兼容软解模式（compat）**：解码线程产出 [Bitmap] 经 [submit] 交给 [overlayView] 绘制，
 *   并在其上叠加远端光标。
 */
class StreamView(context: Context) : FrameLayout(context) {

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val dst = Rect()
    private val cursorPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = Paint.Style.FILL
    }

    @Volatile
    private var invalidateQueued = false

    @Volatile
    private var bitmap: Bitmap? = null

    /** 远端光标（视频宽高比例 0..1）；null = 未收到过坐标 */
    @Volatile
    private var cursorFraction: Pair<Float, Float>? = null

    @Volatile
    var currentSurface: Surface? = null
        private set

    /** Surface 就绪或销毁时回调（供 LinkSpaceService 绑定到 FastStreamDecoder） */
    var onSurfaceChanged: ((Surface?) -> Unit)? = null

    private val textureView = TextureView(context)
    private val overlayView = object : View(context) {
        override fun onDraw(canvas: Canvas) {
            invalidateQueued = false
            val bmp = bitmap
            if (bmp != null) {
                dst.set(0, 0, width, height)
                canvas.drawBitmap(bmp, null, dst, paint)
            }
            // 光标覆盖层：白底黑圈圆点（采集已 draw_mouse=0，光标在平板侧合成）
            cursorFraction?.let { (fx, fy) ->
                if (fx in 0f..1f && fy in 0f..1f) {
                    val cx = fx * width
                    val cy = fy * height
                    cursorPaint.color = android.graphics.Color.WHITE
                    canvas.drawCircle(cx, cy, 14f, cursorPaint)
                    cursorPaint.color = android.graphics.Color.BLACK
                    cursorPaint.strokeWidth = 4f
                    cursorPaint.style = Paint.Style.STROKE
                    canvas.drawCircle(cx, cy, 14f, cursorPaint)
                    cursorPaint.style = Paint.Style.FILL
                }
            }
        }
    }

    init {
        textureView.isOpaque = false
        textureView.surfaceTextureListener = object : TextureView.SurfaceTextureListener {
            override fun onSurfaceTextureAvailable(st: SurfaceTexture, width: Int, height: Int) {
                currentSurface?.release()
                val s = Surface(st)
                currentSurface = s
                onSurfaceChanged?.invoke(s)
            }

            override fun onSurfaceTextureSizeChanged(st: SurfaceTexture, width: Int, height: Int) = Unit

            override fun onSurfaceTextureDestroyed(st: SurfaceTexture): Boolean {
                onSurfaceChanged?.invoke(null)
                currentSurface?.release()
                currentSurface = null
                return true
            }

            override fun onSurfaceTextureUpdated(st: SurfaceTexture) = Unit
        }
        addView(textureView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
        addView(overlayView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))
    }

    /** 兼容软解模式：提交一帧 Bitmap 重绘 */
    fun submit(bmp: Bitmap) {
        bitmap = bmp
        queueOverlayInvalidate()
    }

    /** 切换到高性能硬解模式时清掉软解位图，露出底层 TextureView 硬解画面 */
    fun clearBitmap() {
        bitmap = null
        queueOverlayInvalidate()
    }

    /** 更新远端光标比例，按 vsync 合流重绘覆盖层 */
    fun setCursor(fx: Float, fy: Float) {
        cursorFraction = fx to fy
        queueOverlayInvalidate()
    }

    private fun queueOverlayInvalidate() {
        if (!invalidateQueued) {
            invalidateQueued = true
            overlayView.postInvalidateOnAnimation()
        }
    }
}
