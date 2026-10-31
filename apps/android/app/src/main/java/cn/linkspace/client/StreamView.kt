package cn.linkspace.client

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.view.View

/**
 * 投屏画面渲染视图：解码线程产出 Bitmap，主线程 [submit] 后 invalidate
 * 重绘。等比拉伸填满视图（黑边由外层 letterbox 布局负责）。
 *
 * 为什么是自绘 View 而不是 TextureView/SurfaceView：解码走 ByteBuffer
 * 模式（本 ROM surface 模式活锁，见 StreamDecoder 类注释），帧数据以
 * Bitmap 形态交付，自绘是零依赖、无 surface 生命周期的渲染面。
 */
class StreamView(context: Context) : View(context) {

    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val dst = Rect()
    private val cursorPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
        style = android.graphics.Paint.Style.FILL
    }

    /** invalidate 已排队未消费（合流：解码再快主线程也只按 vsync 重绘一次，
     *  否则解码线程的逐帧 post 会洪泛主线程把输入事件饿出 ANR） */
    @Volatile
    private var invalidateQueued = false

    @Volatile
    private var bitmap: Bitmap? = null

    /** 远端光标（视频宽高比例 0..1）；null = 未收到过坐标 */
    @Volatile
    private var cursorFraction: Pair<Float, Float>? = null

    /** 解码线程任意线程调用；位图实例由解码器复用，onDraw 时可能正被
     *  下一帧覆盖（视觉撕裂可容忍，绝不阻塞解码） */
    fun submit(bmp: Bitmap) {
        bitmap = bmp
        if (!invalidateQueued) {
            invalidateQueued = true
            postInvalidateOnAnimation()
        }
    }

    /** 解码线程/控制流更新光标比例，按 vsync 合流重绘 */
    fun setCursor(fx: Float, fy: Float) {
        cursorFraction = fx to fy
        if (!invalidateQueued) {
            invalidateQueued = true
            postInvalidateOnAnimation()
        }
    }

    override fun onDraw(canvas: Canvas) {
        invalidateQueued = false
        val bmp = bitmap ?: return
        dst.set(0, 0, width, height)
        canvas.drawBitmap(bmp, null, dst, paint)
        // 光标覆盖层：白底黑圈圆点（采集已 draw_mouse=0，光标只能本地画）
        cursorFraction?.let { (fx, fy) ->
            if (fx in 0f..1f && fy in 0f..1f) {
                val cx = fx * width
                val cy = fy * height
                cursorPaint.color = android.graphics.Color.WHITE
                canvas.drawCircle(cx, cy, 14f, cursorPaint)
                cursorPaint.color = android.graphics.Color.BLACK
                cursorPaint.strokeWidth = 4f
                cursorPaint.style = android.graphics.Paint.Style.STROKE
                canvas.drawCircle(cx, cy, 14f, cursorPaint)
                cursorPaint.style = android.graphics.Paint.Style.FILL
            }
        }
    }
}
