package cn.linkspace.client.service

/**
 * 剪贴板文本同步的回环抑制逻辑。
 *
 * 与桌面端 `apps/desktop/src/main/clipboard.ts` 的判定规则逐条对应：
 * 读写由调用方注入（[ClipboardIo]），所以这段逻辑可以脱离 Android 环境验证。
 *
 * 要防的是这件事：收到远端文本 → 写入本机剪贴板 → 系统回调/轮询读到
 * 「剪贴板变了」→ 又把同一段文本发回去 → 对端同样处理 → 无限互推。
 *
 * 关键在抑制窗口内**不更新基线**：窗口里读到的可能还是写入生效前的旧值，
 * 若把它记成已知状态，窗口结束后读到的真值就成了「新变更」，
 * 回环只是被延后一轮，并没有消失。
 */
class ClipboardSync(
    private val io: ClipboardIo,
    private val send: (String) -> Unit,
    private val maxBytes: Int = 512 * 1024,
    /** 注入时间源，测试里才能确定性地验证抑制窗口 */
    private val now: () -> Long = { System.currentTimeMillis() },
    private val onSkip: ((String) -> Unit)? = null
) {
    interface ClipboardIo {
        fun readText(): String
        fun writeText(text: String)
    }

    companion object {
        /** 收到远端文本后的抑制窗口，与桌面端保持一致 */
        const val SUPPRESS_MS = 500L
    }

    private var lastSeen = ""
    private var suppressUntil = 0L
    private var running = false

    /**
     * 开始同步。先读一次基线：启动前剪贴板里的内容不是「用户刚复制的」，
     * 不该在启动瞬间被广播出去。
     */
    fun start() {
        running = true
        lastSeen = io.readText()
    }

    fun stop() {
        running = false
    }

    /** 本机剪贴板可能变了，由调用方驱动 */
    fun poll() {
        if (!running) return
        val cur = io.readText()
        if (now() < suppressUntil) return
        if (cur == lastSeen) return
        lastSeen = cur
        if (cur.isEmpty()) return
        val size = cur.toByteArray(Charsets.UTF_8).size
        if (size > maxBytes) {
            onSkip?.invoke("剪贴板内容 $size 字节超过上限 $maxBytes 字节，未同步")
            return
        }
        send(cur)
    }

    /** 收到对端推来的文本 */
    fun receive(text: String) {
        if (!running) return
        if (text.isEmpty()) return
        val size = text.toByteArray(Charsets.UTF_8).size
        if (size > maxBytes) {
            onSkip?.invoke("远端剪贴板内容 $size 字节超过上限 $maxBytes 字节，已丢弃")
            return
        }
        if (text == lastSeen) return
        io.writeText(text)
        lastSeen = text
        suppressUntil = now() + SUPPRESS_MS
    }
}
