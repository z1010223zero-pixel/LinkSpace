package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 协议常量与编解码工具的 JVM 单测。
 *
 * 数据面组合键的编解码是文件传输的咽喉：桌面端按 decodeURIComponent
 * 语义解码，这里必须逐字对齐——空格用 %20 而非表单编码的 +，字面的
 * + 编码为 %2B，否则含空格/加号的文件名（SAF 场景极常见）必坏。
 */
class ProtocolTest {

    @Test
    fun `组合键编码 - 空格用百分号二十而不是加号`() {
        val key = "tr-test-01:hello world.txt"
        val encoded = Protocol.encodeTransferKey(key)
        assertTrue("空格必须编码为 %20（桌面端按 URI 语义解码，+ 是字面加号）", encoded.contains("%20"))
        assertFalse(encoded.contains(" "))
    }

    @Test
    fun `组合键编码 - 字面加号编码为百分号二 B`() {
        val key = "tr-test-01:a+b.txt"
        val encoded = Protocol.encodeTransferKey(key)
        assertTrue("+ 必须编码为 %2B，否则解码端会把它还原成空格", encoded.contains("%2B"))
    }

    @Test
    fun `组合键编码 - 冒号也被编码保证 URL 路径安全`() {
        val encoded = Protocol.encodeTransferKey("tr-test-01:a:b.txt")
        assertTrue(encoded.contains("%3A"))
    }

    @Test
    fun `组合键编码 - 中文按 UTF-8 百分号编码`() {
        val encoded = Protocol.encodeTransferKey("tr-x:报告.txt")
        assertTrue(encoded.contains("%E6%8A%A5")) // 「报」的 UTF-8 首字节
    }

    @Test
    fun `组合键编解码往返一致（配对 TransferServer 的解码）`() {
        val names = listOf(
            "hello world.txt",
            "a+b&c=d.txt",
            "报告 最终版 (v2) #1.txt",
            "100%完成.xlsx"
        )
        names.forEach { name ->
            val key = "tr-roundtrip:$name"
            val decoded = TransferServer.decodeUriComponent(Protocol.encodeTransferKey(key))
            assertEquals("往返必须还原原值: $name", key, decoded)
        }
    }

    @Test
    fun `chunkPath 拼接格式与桌面端路由一致`() {
        assertEquals(
            "/linkspace/v1/transfer/tr-1-abcdef01/chunk",
            Protocol.chunkPath("tr-1-abcdef01")
        )
    }

    @Test
    fun `常量与桌面端冻结值一致`() {
        assertEquals(1, Protocol.VERSION)
        assertEquals(4 * 1024 * 1024, Protocol.CHUNK_SIZE)
        assertEquals(64, Protocol.MAX_EVENTS_PER_MESSAGE)
        assertEquals(32768, Protocol.MAX_COORD)
        assertEquals(32 * 1024 * 1024, Protocol.MAX_CHUNK_BODY)
        assertEquals(listOf("file", "clipboard"), Protocol.DEFAULT_GRANT_SCOPE)
    }

    @Test
    fun `screen stream stop 方向常量与桌面端一致`() {
        assertEquals("forward", Protocol.STREAM_DIRECTION_FORWARD)
        assertEquals("reverse", Protocol.STREAM_DIRECTION_REVERSE)
    }

    @Test
    fun `stop 方向解析 - 显式方向直接采用`() {
        assertEquals("forward", Protocol.resolveStreamStopDirection("forward", false, false))
        assertEquals("reverse", Protocol.resolveStreamStopDirection("reverse", false, false))
        assertEquals("forward", Protocol.resolveStreamStopDirection("forward", false, true))
        assertEquals("reverse", Protocol.resolveStreamStopDirection("reverse", true, false))
    }

    @Test
    fun `stop 方向解析 - 缺失时单路在跑停那一路`() {
        assertEquals("forward", Protocol.resolveStreamStopDirection(null, true, false))
        assertEquals("reverse", Protocol.resolveStreamStopDirection(null, false, true))
    }

    @Test
    fun `stop 方向解析 - 缺失时双向在跑只停 forward`() {
        assertEquals("forward", Protocol.resolveStreamStopDirection(null, true, true))
    }

    @Test
    fun `stop 方向解析 - 缺失且无流在跑时忽略`() {
        assertEquals(null, Protocol.resolveStreamStopDirection(null, false, false))
    }

    @Test
    fun `stop 方向解析 - 非法值忽略`() {
        assertEquals(null, Protocol.resolveStreamStopDirection("sideways", true, true))
        assertEquals(null, Protocol.resolveStreamStopDirection("", true, false))
    }
}
