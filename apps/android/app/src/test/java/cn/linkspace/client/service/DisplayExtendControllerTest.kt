package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.json.JSONObject

/**
 * 扩展屏控制端状态机的 JVM 单测（协议 4.3，sessionType: 'display-extend'）。
 *
 * 覆盖最容易错的路径：请求参数的形状（希望尺寸 + 档位）、accept 里
 * virtualScreen 的校验（缺失/非法按失败回落）、会话状态机的来源校验
 * （旁观连接不得操作别人的会话）、断连与超时回落。
 */
class DisplayExtendControllerTest {

    private class Harness {
        val sent = mutableListOf<Triple<String, String, JSONObject>>()
        var activeEvents: ((String, String, DisplayExtendController.VirtualScreen) -> Unit)? = null
        var ended: ((String) -> Unit)? = null
        var waiting: ((String) -> Unit)? = null

        fun make(): DisplayExtendController = DisplayExtendController(
            send = { peerId, type, payloadFn ->
                sent += Triple(peerId, type, JSONObject().apply(payloadFn))
            },
            listener = object : DisplayExtendController.Listener {
                override fun onSessionActive(peerId: String, sessionId: String, virtualScreen: DisplayExtendController.VirtualScreen) {
                    activeEvents?.invoke(peerId, sessionId, virtualScreen)
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

    private fun acceptPayload(sessionId: String, x: Int = 1920, y: Int = 0, w: Int = 2560, h: Int = 1440): JSONObject =
        JSONObject().apply {
            put("sessionId", sessionId)
            put("virtualScreen", JSONObject().apply {
                put("x", x)
                put("y", y)
                put("w", w)
                put("h", h)
            })
        }

    @Test
    fun `request 发出 session_start 且进入等待态`() {
        val h = Harness()
        var waitingPeer: String? = null
        h.waiting = { waitingPeer = it }
        val c = h.make()

        c.request("dev_peer_0001", DisplayExtendController.PreferredSize(2560, 1440), 1920, "测试平板")

        assertEquals(1, h.sent.size)
        val (peerId, type, payload) = h.sent[0]
        assertEquals("dev_peer_0001", peerId)
        assertEquals(Protocol.TYPE_SESSION_START, type)
        assertEquals(Protocol.SESSION_TYPE_DISPLAY_EXTEND, payload.getString("sessionType"))
        val params = payload.getJSONObject("params")
        assertEquals(2560, params.getInt("width"))
        assertEquals(1440, params.getInt("height"))
        assertEquals(1920, params.getInt("scaleWidth"))
        assertEquals("测试平板", params.getString("displayName"))
        assertEquals("dev_peer_0001", waitingPeer)
        assertFalse(c.extending)
    }

    @Test
    fun `request 不带希望尺寸时 params 不含宽高`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")

        val params = h.sent[0].third.getJSONObject("params")
        assertFalse(params.has("width"))
        assertFalse(params.has("height"))
        assertEquals(1920, params.getInt("scaleWidth"))
    }

    @Test
    fun `accept 后进入扩展态并记录虚拟显示器矩形`() {
        val h = Harness()
        var activeVs: DisplayExtendController.VirtualScreen? = null
        h.activeEvents = { _, _, vs -> activeVs = vs }
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sid))

        assertTrue(c.extending)
        assertEquals("dev_peer_0001", c.extendingTo)
        assertEquals(DisplayExtendController.VirtualScreen(1920, 0, 2560, 1440), c.virtualScreen)
        assertEquals(DisplayExtendController.VirtualScreen(1920, 0, 2560, 1440), activeVs)
        assertEquals(sid, c.activeSessionId)
    }

    @Test
    fun `他端伪造的 accept 被忽略`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_other_0002", acceptPayload(sid))

        assertFalse(c.extending)
        assertNull(c.virtualScreen)
    }

    @Test
    fun `缺 virtualScreen 的 accept 按失败回落且可再次发起`() {
        val h = Harness()
        var ended: String? = null
        h.ended = { ended = it }
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_peer_0001", JSONObject().apply { put("sessionId", sid) })

        assertFalse(c.extending)
        assertTrue(ended!!.contains("虚拟显示器"))
        // 失败后挂起已清，可再次发起
        c.request("dev_peer_0001", null, 1920, "测试平板")
        assertEquals(2, h.sent.size)
    }

    @Test
    fun `virtualScreen 宽高非法时 accept 被拒绝`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sid, w = 0, h = 1440))

        assertFalse(c.extending)
    }

    @Test
    fun `virtualScreen x_y 可为负`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sid, x = -1920, y = 0, w = 1920, h = 1080))

        assertTrue(c.extending)
        assertEquals(-1920, c.virtualScreen?.x)
    }

    @Test
    fun `reject 后回到空闲态`() {
        val h = Harness()
        var ended: String? = null
        h.ended = { ended = it }
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onRejected("dev_peer_0001", JSONObject().apply {
            put("sessionId", sid)
            put("reason", "denied by user")
        })

        assertFalse(c.extending)
        assertTrue(ended!!.contains("denied by user"))
    }

    @Test
    fun `stop 发 session_stop 并收起扩展屏`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sid))
        c.stop("stopped by user")

        assertFalse(c.extending)
        assertEquals(Protocol.TYPE_SESSION_STOP, h.sent.last().second)
        assertEquals(sid, h.sent.last().third.getString("sessionId"))
        assertEquals("stopped by user", h.sent.last().third.getString("reason"))
    }

    @Test
    fun `对端 stop 只认自己的会话`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        val sid = h.sent[0].third.getString("sessionId")
        c.onAccepted("dev_peer_0001", acceptPayload(sid))
        // 他端 stop 与错 sessionId 的 stop 都忽略
        c.onStopped("dev_other_0002", JSONObject().apply { put("sessionId", sid) })
        c.onStopped("dev_peer_0001", JSONObject().apply { put("sessionId", "other-session") })
        assertTrue(c.extending)
        c.onStopped("dev_peer_0001", JSONObject().apply { put("sessionId", sid) })
        assertFalse(c.extending)
    }

    @Test
    fun `断连清掉等待中的请求与活动会话`() {
        val h = Harness()
        val c = h.make()

        c.request("dev_peer_0001", null, 1920, "测试平板")
        c.onPeerDisconnected("dev_peer_0001")
        assertFalse(c.extending)
        // 断连后可再次发起
        c.request("dev_peer_0001", null, 1920, "测试平板")
        assertEquals(2, h.sent.size)
    }
}
