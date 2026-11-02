package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 每连接消息 id 去重（协议 §3）的 JVM 单测。
 *
 * 去重是重放防护的最后一道：信封 id 由发送方随机生成，同一连接上
 * 同一 id 出现两次只能是重发或重放，第二次必须静默丢弃——
 * 否则一条 input.event / transfer.accept 的重放就能让注入或
 * token 落库走两遍。
 */
class SeenMessageIdsTest {

    @Test
    fun `首次出现的 id 不算重复`() {
        val seen = SeenMessageIds()
        assertFalse(seen.isDuplicate("a"))
        assertFalse(seen.isDuplicate("b"))
        assertEquals(0, seen.duplicateCount)
    }

    @Test
    fun `同一 id 第二次出现算重复`() {
        val seen = SeenMessageIds()
        assertFalse(seen.isDuplicate("a"))
        assertTrue(seen.isDuplicate("a"))
        assertTrue(seen.isDuplicate("a"))
        assertEquals(2, seen.duplicateCount)
    }

    @Test
    fun `不同 id 互不干扰`() {
        val seen = SeenMessageIds()
        assertFalse(seen.isDuplicate("a"))
        assertFalse(seen.isDuplicate("b"))
        assertTrue(seen.isDuplicate("a"))
        assertFalse(seen.isDuplicate("c"))
    }

    @Test
    fun `窗口满后最旧的 id 被淘汰出窗口`() {
        val seen = SeenMessageIds(maxIds = 3)
        assertFalse(seen.isDuplicate("a"))
        assertFalse(seen.isDuplicate("b"))
        assertFalse(seen.isDuplicate("c"))
        assertFalse(seen.isDuplicate("d")) // 窗口 {b, c, d}，a 被淘汰
        // 先断言窗口内的 b：重加已淘汰的 a 会把它挤出窗口，顺序反了必错
        assertTrue("窗口内的 id 仍算重复", seen.isDuplicate("b"))
        assertFalse("淘汰出窗口的 id 再次出现视为新消息", seen.isDuplicate("a"))
    }

    @Test
    fun `默认窗口与协议常量一致`() {
        assertEquals(Protocol.MAX_SEEN_MESSAGE_IDS, 1024)
        val seen = SeenMessageIds()
        repeat(1024) { assertFalse(seen.isDuplicate("id-$it")) }
        assertTrue(seen.isDuplicate("id-0"))
        assertFalse(seen.isDuplicate("id-1024")) // 满窗口后新 id 挤掉最旧的 id-0
        assertFalse("被挤掉的 id-0 再次出现视为新消息", seen.isDuplicate("id-0"))
    }
}
