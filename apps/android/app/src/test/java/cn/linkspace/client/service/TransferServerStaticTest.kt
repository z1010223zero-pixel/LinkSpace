package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertThrows
import org.junit.Test
import java.io.IOException

/**
 * 传输服务静态工具的 JVM 单测：HTTP 层的编解码与文件名清洗。
 * 接收侧的一切路径拼接都经过这里，穿帮一次就是一次路径穿越。
 */
class TransferServerStaticTest {

    @Test
    fun `sha256Hex 已知向量`() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            TransferServer.sha256Hex("abc".toByteArray())
        )
        assertEquals(64, TransferServer.sha256Hex(ByteArray(0)).length)
    }

    @Test
    fun `解码 - 百分号二十还原为空格`() {
        assertEquals("hello world.txt", TransferServer.decodeUriComponent("hello%20world.txt"))
    }

    @Test
    fun `解码 - 字面加号保持为加号`() {
        // URLDecoder 的表单语义会把 + 还原成空格；先转义成 %2B 再解码
        assertEquals("a+b.txt", TransferServer.decodeUriComponent("a+b.txt"))
        assertEquals("a+b.txt", TransferServer.decodeUriComponent("a%2Bb.txt"))
    }

    @Test
    fun `解码 - 中文按 UTF-8 还原`() {
        assertEquals("报告.txt", TransferServer.decodeUriComponent("%E6%8A%A5%E5%91%8A.txt"))
    }

    @Test
    fun `解码 - 组合键完整往返`() {
        val key = "tr-1-74dd6003:cancel-me.bin"
        assertEquals(key, TransferServer.decodeUriComponent(key))
    }

    @Test
    fun `文件名清洗 - 剥掉正斜杠路径成分`() {
        assertEquals("evil.txt", TransferServer.sanitizeFileName("../../etc/evil.txt"))
        assertEquals("evil.txt", TransferServer.sanitizeFileName("a/b/c/evil.txt"))
    }

    @Test
    fun `文件名清洗 - 剥掉反斜杠路径成分（跨平台发送方）`() {
        assertEquals("evil.exe", TransferServer.sanitizeFileName("..\\..\\Users\\x\\evil.exe"))
    }

    @Test
    fun `文件名清洗 - 纯路径名直接拒绝`() {
        assertThrows(IOException::class.java) {
            TransferServer.sanitizeFileName("../..")
        }
        assertThrows(IOException::class.java) {
            TransferServer.sanitizeFileName(".")
        }
        assertThrows(IOException::class.java) {
            TransferServer.sanitizeFileName("  ")
        }
    }

    @Test
    fun `文件名清洗 - 超长名截断到 255 码元`() {
        val longName = "x".repeat(600) + ".txt"
        assertEquals(255, TransferServer.sanitizeFileName(longName).length)
    }

    @Test
    fun `文件名清洗 - 正常名保持不变`() {
        assertEquals("报告 最终版 (v2) #1.txt", TransferServer.sanitizeFileName("报告 最终版 (v2) #1.txt"))
    }
}
