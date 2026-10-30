package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONArray
import org.json.JSONObject

/**
 * 键鼠共享控制端状态机的 JVM 单测（协议 4.6）。
 *
 * 覆盖三块最容易错的路径：事件编码的边界钳制、会话状态机的来源校验
 * （旁观连接不得操作别人的会话）、外发批次的上限语义。
 */
class InputControllerTest {

    private class Harness {
        val sent = mutableListOf<Triple<String, String, JSONObject>>()
        var activeEvents: ((String, String, InputController.Screen) -> Unit)? = null
        var ended: ((String) -> Unit)? = null
        var waiting: ((String) -> Unit)? = null

        fun make(): InputController = InputController(
            send = { peerId, type, payloadFn ->
                sent += Triple(peerId, type, JSONObject().apply(payloadFn))
            },
            listener = object : InputController.Listener {
                override fun onSessionActive(peerId: String, sessionId: String, remoteScreen: InputController.Screen) {
                    activeEvents?.invoke(peerId, sessionId, remoteScreen)
                }

                override fun onSessionEnded(reason: String) {
                    ended?.invoke(reason)
                }

                override fun onWaiting(peerId: String) {
                    waiting?.invoke(peerId)
                }
            }
        )
    }

    private fun acceptPayload(sessionId: String, w: Int = 1920, h: Int = 1080): JSONObject =
        JSONObject().apply {
            put("sessionId", sessionId)
            put("screen", JSONObject().apply { put("w", w); put("h", h) })
        }

    // ---------- 事件编码 ----------

    @Test
    fun `move 坐标钳制进 0 到 MAX_COORD`() {
        assertEquals(0, InputController.move(-5, 0).getInt("x"))
        assertEquals(Protocol.MAX_COORD, InputController.move(Protocol.MAX_COORD + 1, 0).getInt("x"))
        assertEquals(100, InputController.move(100, 200).getInt("x"))
        assertEquals(200, InputController.move(100, 200).getInt("y"))
    }

    @Test
    fun `wheel 刻度钳制正负 1000`() {
        assertEquals(-1000, InputController.wheel(0, -5000).getInt("dy"))
        assertEquals(1000, InputController.wheel(5000, 0).getInt("dx"))
    }

    @Test
    fun `key 键码钳制 0 到 255 且按下态保真`() {
        val ev = InputController.key(300, true)
        assertEquals(255, ev.getInt("vk"))
        assertEquals(true, ev.getBoolean("down"))
        assertEquals("key", ev.getString("t"))
    }

    @Test
    fun `tap 产生 down 加 up 成对事件`() {
        val events = InputController.tap(0x41)
        assertEquals(2, events.size)
        assertEquals(true, events[0].getBoolean("down"))
        assertEquals(false, events[1].getBoolean("down"))
    }

    @Test
    fun `鼠标按钮名白名单语义由发送侧保证`() {
        // b 字段只应出现协议约定的三个值
        listOf("left", "right", "middle").forEach { b ->
            assertEquals(b, InputController.down(b).getString("b"))
            assertEquals(b, InputController.up(b).getString("b"))
        }
    }

    // ---------- 会话状态机 ----------

    @Test
    fun `request 发出 session_start 且进入等待态`() {
        val h = Harness()
        var waitingPeer: String? = null
        h.waiting = { waitingPeer = it }
        val c = h.make()

        c.request("dev_peer_0001", InputController.Screen(2000, 1200), "测试机")

        val start = h.sent.single { it.second == "session.start" }
        assertEquals("dev_peer_0001", start.first)
        val payload = start.third
        assertEquals("input", payload.getString("sessionType"))
        val sessionId = payload.getString("sessionId")
        assertTrue(Regex(Protocol.SESSION_ID_RE).matches(sessionId))
        assertEquals(2000, payload.getJSONObject("params").getJSONObject("screen").getInt("w"))
        assertEquals("测试机", payload.getJSONObject("params").getString("displayName"))
        assertEquals("dev_peer_0001", waitingPeer)
    }

    @Test
    fun `已有会话时 request 被拒`() {
        val h = Harness()
        var endedReason = ""
        h.ended = { endedReason = it }
        val c = h.make()

        c.request("dev_a", InputController.Screen(100, 100), "A")
        c.request("dev_b", InputController.Screen(100, 100), "B")

        assertTrue("第二个请求应当被本地拒绝", endedReason.isNotEmpty())
        // 只发出了第一个请求
        assertEquals(1, h.sent.count { it.second == "session.start" })
    }

    @Test
    fun `accept 建立会话且事件外发携带 sessionId`() {
        val h = Harness()
        var activeSessionId = ""
        h.activeEvents = { _, sessionId, screen ->
            activeSessionId = sessionId
            // accept 回的屏幕尺寸应送达监听者，供坐标映射理解
            assertEquals(2560, screen.w)
        }
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        val pendingId = h.sent.last { it.second == "session.start" }.third.getString("sessionId")

        c.onAccepted("dev_peer_0001", acceptPayload(pendingId, w = 2560, h = 720))
        assertEquals(pendingId, activeSessionId)

        c.sendEvents(listOf(InputController.move(10, 20)))
        val event = h.sent.last { it.second == "input.event" }
        assertEquals(pendingId, event.third.getString("sessionId"))
        val events = event.third.getJSONArray("events")
        assertEquals(1, events.length())
        assertEquals(10, events.getJSONObject(0).getInt("x"))
    }

    @Test
    fun `accept 来源不符被忽略`() {
        val h = Harness()
        var active = false
        h.activeEvents = { _, _, _ -> active = true }
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        val pendingId = h.sent.last { it.second == "session.start" }.third.getString("sessionId")

        // 旁观连接冒充 accept
        c.onAccepted("dev_other_9999", acceptPayload(pendingId))
        assertFalse("来源不符的 accept 不得建立会话", active)

        // 正主再 accept 才生效
        c.onAccepted("dev_peer_0001", acceptPayload(pendingId))
        assertTrue(active)
    }

    @Test
    fun `accept 携带非法 sessionId 被忽略`() {
        val h = Harness()
        var active = false
        h.activeEvents = { _, _, _ -> active = true }
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")

        c.onAccepted("dev_peer_0001", acceptPayload("bad session id with spaces"))
        assertFalse("非法 sessionId 不得建立会话", active)
    }

    @Test
    fun `reject 结束等待并给出原因`() {
        val h = Harness()
        var endedReason = ""
        h.ended = { endedReason = it }
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")

        c.onRejected("dev_peer_0001", JSONObject().apply { put("reason", "not trusted") })
        assertTrue(endedReason.contains("not trusted"))

        // 未激活状态下 sendEvents 是安全空操作
        c.sendEvents(listOf(InputController.move(1, 1)))
        assertTrue(h.sent.none { it.second == "input.event" })
    }

    @Test
    fun `被控端 stop 结束会话且 sessionId 必须匹配`() {
        val h = Harness()
        var ended = false
        h.ended = { ended = true }
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        val sessionId = h.sent.last { it.second == "session.start" }.third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sessionId))

        // 别的 sessionId 的 stop 是别人的会话，忽略
        c.onStopped("dev_peer_0001", JSONObject().apply { put("sessionId", "other-session") })
        assertFalse(ended)

        c.onStopped("dev_peer_0001", JSONObject().apply { put("sessionId", sessionId) })
        assertTrue(ended)

        // 结束后再收到 stop：幂等
        c.onStopped("dev_peer_0001", JSONObject().apply { put("sessionId", sessionId) })
    }

    @Test
    fun `对端断连立即终止会话与等待`() {
        val h = Harness()
        var ended = false
        h.ended = { ended = true }
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        c.onPeerDisconnected("dev_peer_0001")
        assertTrue("等待中的请求应随断连终止", ended)

        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        val sessionId = h.sent.last { it.second == "session.start" }.third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sessionId))
        c.onPeerDisconnected("dev_peer_0001")
        assertTrue("活动会话应随断连终止", ended)
    }

    @Test
    fun `stop 发送 session_stop 且幂等`() {
        val h = Harness()
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        val sessionId = h.sent.last { it.second == "session.start" }.third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sessionId))

        c.stop("走查结束")
        val stops = h.sent.filter { it.second == "session.stop" }
        assertEquals(1, stops.size)
        assertEquals(sessionId, stops[0].third.getString("sessionId"))

        c.stop("再来一次")
        assertEquals("未激活时 stop 是空操作", 1, h.sent.filter { it.second == "session.stop" }.size)
    }

    @Test
    fun `sendEvents 批量超过上限时截断到 64 条`() {
        val h = Harness()
        val c = h.make()
        c.request("dev_peer_0001", InputController.Screen(100, 100), "A")
        val sessionId = h.sent.last { it.second == "session.start" }.third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sessionId))

        val many = (0 until 100).map { InputController.move(it, it) }
        c.sendEvents(many)
        val event = h.sent.last { it.second == "input.event" }
        assertEquals(Protocol.MAX_EVENTS_PER_MESSAGE, event.third.getJSONArray("events").length())
    }
}
