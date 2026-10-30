package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 剪贴板回环抑制逻辑的 JVM 单测。
 *
 * 这段逻辑是防无限互推的唯一防线（两端同款），且全部依赖都可注入，
 * 必须在无 Android 环境下钉死边界。对应桌面端 clipboard.ts 的测试语义。
 */
class ClipboardSyncTest {

    /** 可控时钟与可编程 io 的测试台 */
    private class Harness {
        var clock: Long = 1_000_000L
        val sent = mutableListOf<String>()
        val written = mutableListOf<String>()
        val skips = mutableListOf<String>()
        var clipboard = ""

        val io = object : ClipboardSync.ClipboardIo {
            override fun readText(): String = clipboard
            override fun writeText(text: String) {
                written += text
                clipboard = text
            }
        }

        fun make(): ClipboardSync = ClipboardSync(
            io = io,
            send = { sent += it },
            now = { clock },
            onSkip = { skips += it }
        )

        fun advance(ms: Long) {
            clock += ms
        }
    }

    @Test
    fun `启动基线 - 启动前已有内容不广播`() {
        val h = Harness()
        h.clipboard = "启动前就有的内容"
        val sync = h.make()
        sync.start()
        h.advance(10)
        sync.poll()
        assertTrue("基线内容不该被广播", h.sent.isEmpty())
    }

    @Test
    fun `本机变更 - poll 读到新内容即发送`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        h.clipboard = "新内容"
        h.advance(10)
        sync.poll()
        assertEquals(listOf("新内容"), h.sent)
    }

    @Test
    fun `回环抑制 - 收到远端后窗口内不发送`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        sync.receive("远端文本")
        // receive 已把内容写进剪贴板；窗口内系统回调读到同内容
        h.advance(100) // < SUPPRESS_MS(500)
        sync.poll()
        assertTrue("窗口内的回读不得外发", h.sent.isEmpty())
    }

    @Test
    fun `回环抑制 - 窗口外同内容也不回发（基线已更新）`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        sync.receive("远端文本")
        h.advance(600) // > SUPPRESS_MS
        sync.poll()
        assertTrue("窗口结束若回发，说明基线在窗口内被错误更新", h.sent.isEmpty())
    }

    @Test
    fun `回环抑制 - 窗口外真正的新变更正常发送`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        sync.receive("远端文本")
        h.advance(600)
        h.clipboard = "用户复制的新东西"
        sync.poll()
        assertEquals(listOf("用户复制的新东西"), h.sent)
    }

    @Test
    fun `接收 - 远端内容写入本机剪贴板`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        sync.receive("来自电脑的文本")
        assertEquals(listOf("来自电脑的文本"), h.written)
    }

    @Test
    fun `接收 - 空文本忽略`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        sync.receive("")
        assertTrue(h.written.isEmpty())
    }

    @Test
    fun `上限 - 超过 512KiB 的收发两端都拒绝并留痕`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        val big = "x".repeat(512 * 1024 + 1)
        h.clipboard = big
        h.advance(10)
        sync.poll()
        sync.receive(big)
        assertTrue("超大本地内容不该发送", h.sent.isEmpty())
        assertTrue("超大远端内容不该写入", h.written.isEmpty())
        assertEquals(2, h.skips.size)
    }

    @Test
    fun `停止 - stop 之后收发都不动作`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        sync.stop()
        h.clipboard = "停止后的变更"
        h.advance(10)
        sync.poll()
        sync.receive("停止后的远端")
        assertTrue(h.sent.isEmpty())
        assertTrue(h.written.isEmpty())
    }

    @Test
    fun `空变更 - 剪贴板清空不外发`() {
        val h = Harness()
        val sync = h.make()
        sync.start()
        h.clipboard = "有内容"
        h.advance(10)
        sync.poll()
        assertTrue(h.sent.isNotEmpty())
        h.clipboard = ""
        h.advance(10)
        sync.poll()
        assertFalse("清空剪贴板不该被当作变更广播", h.sent.last().isEmpty())
    }
}
