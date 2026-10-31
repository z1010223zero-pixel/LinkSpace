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

    private var bitmap: Bitmap? = null
    private val paint = Paint(Paint.FILTER_BITMAP_FLAG or Paint.ANTI_ALIAS_FLAG)
    private val dst = Rect()

    /** 解码线程回调转发（须已在主线程） */
    fun submit(bmp: Bitmap) {
        bitmap = bmp
        invalidate()
    }

    override fun onDraw(canvas: Canvas) {
        val bmp = bitmap ?: return
        dst.set(0, 0, width, height)
        canvas.drawBitmap(bmp, null, dst, paint)
    }

    override fun onMeasure(widthMeasureSpec: Int, heightMeasureSpec: Int) {
        // AndroidView 的 size() 修饰符给 EXACTLY；兜底 default 逻辑
        super.onMeasure(widthMeasureSpec, heightMeasureSpec)
    }
}
