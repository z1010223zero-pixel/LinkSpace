package cn.linkspace.client.service

import android.view.KeyEvent
import cn.linkspace.client.service.ControlledInputInjector.DecodedEvent
import cn.linkspace.client.service.ControlledInputInjector.InjectResult
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ControlledInputSession] 的 W5 接线单测：无障碍门禁、注入调用、
 * 注入失败上报、会话结束抬键（线 2 W5）。注入层用假实现，不碰
 * Android 框架；Timer 是 daemon，不阻塞单测退出。
 */
class ControlledInputSessionW5Test {

    private val sent = mutableListOf<Triple<String, String, JSONObject>>()
    private var ready = true
    private val injected = mutableListOf<DecodedEvent>()
    private var injectResult: InjectResult = InjectResult.Ok
    private var releaseCount = 0
    private var authNotEnabled = 0
    private val injectErrors = mutableListOf<String>()
    private var requested: ControlledInputSession.ControlRequest? = null

    private fun newSession(autoApprove: Boolean = false) = ControlledInputSession(
        isPeerAuthorized = { it == "peer-1" },
        isAutoApprovePeer = { autoApprove && it == "peer-1" },
        localScreen = { InputController.Screen(1080, 2400) },
        send = { peerId, type, payloadFn ->
            sent += Triple(peerId, type, JSONObject().apply(payloadFn))
        },
        isAccessibilityReady = { ready },
        inject = { events, _ ->
            injected += events
            injectResult
        },
        releaseAll = { releaseCount++ },
        listener = object : ControlledInputSession.Listener {
            override fun onControlRequested(request: ControlledInputSession.ControlRequest) {
                requested = request
            }

            override fun onChanged() {}

            override fun onAccessibilityNotEnabled() {
                authNotEnabled++
            }

            override fun onInjectError(sessionId: String, reason: String) {
                injectErrors += "$sessionId:$reason"
            }
        }
    )

    private fun startPayload() = JSONObject().apply {
        put("sessionType", "input")
        put("sessionId", "sess-1")
        put("params", JSONObject().apply {
            put("screen", JSONObject().apply { put("w", 1920); put("h", 1080) })
            put("displayName", "PC")
        })
    }

    private fun eventPayload(vararg events: JSONObject) = JSONObject().apply {
        put("sessionId", "sess-1")
        put("events", JSONArray(events.toList()))
    }

    @Test
    fun `accessibility disabled rejects start explicitly`() {
        ready = false
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertNull(s.pendingRequest)
        assertNull(requested)
        assertEquals(1, authNotEnabled)
        assertEquals(1, sent.size)
        assertEquals(Protocol.TYPE_SESSION_REJECT, sent[0].second)
        assertEquals("accessibility disabled", sent[0].third.optString("reason"))
    }

    /**
     * 信任设备免确认（Bug 2）：门禁全过后直接放行，不调确认回调、
     * 不挂 pending，会话直接进入 active 并回 session.accept。
     */
    @Test
    fun `trusted device auto approves without prompt`() {
        val s = newSession(autoApprove = true)
        s.onStart("peer-1", startPayload())
        assertNull(requested)
        assertNull(s.pendingRequest)
        assertEquals("peer-1", s.activeSession?.peerId)
        assertEquals(1, sent.size)
        assertEquals(Protocol.TYPE_SESSION_ACCEPT, sent[0].second)
    }

    /** 未标记信任的设备仍走确认框：onStart 只挂 pending，不自动放行 */
    @Test
    fun `untrusted device still prompts`() {
        val s = newSession(autoApprove = false)
        s.onStart("peer-1", startPayload())
        assertTrue(requested != null)
        assertTrue(s.pendingRequest != null)
        assertNull(s.activeSession)
        assertTrue(sent.isEmpty())
    }

    /**
     * 免确认也不绕门禁：无障碍未开启时，信任设备同样被拒绝、
     * 不进 pending、不弹确认框。
     */
    @Test
    fun `trusted device still rejected when accessibility disabled`() {
        ready = false
        val s = newSession(autoApprove = true)
        s.onStart("peer-1", startPayload())
        assertNull(requested)
        assertNull(s.pendingRequest)
        assertNull(s.activeSession)
        assertEquals(1, sent.size)
        assertEquals(Protocol.TYPE_SESSION_REJECT, sent[0].second)
        assertEquals("accessibility disabled", sent[0].third.optString("reason"))
    }

    @Test
    fun `approve then events injected with mapped coords`() {
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertTrue(requested != null)
        assertTrue(s.approve("sess-1"))
        assertEquals(Protocol.TYPE_SESSION_ACCEPT, sent[0].second)
        assertEquals(1080, sent[0].third.optJSONObject("screen")?.optInt("w"))
        assertEquals(2400, sent[0].third.optJSONObject("screen")?.optInt("h"))

        // 控制端 1920x1080 的 (960,540) → 本机 1080x2400 的 (540,1200)
        s.onEvent(
            "peer-1",
            eventPayload(
                JSONObject().apply { put("t", "move"); put("x", 960); put("y", 540) },
                JSONObject().apply { put("t", "key"); put("vk", 0x41); put("down", true) }
            )
        )
        assertEquals(
            listOf(
                DecodedEvent.Move(540, 1200),
                DecodedEvent.Key(KeyEvent.KEYCODE_A, true)
            ),
            injected
        )
        assertTrue(injectErrors.isEmpty())
    }

    @Test
    fun `inject failure reported not swallowed`() {
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertTrue(s.approve("sess-1"))
        injectResult = InjectResult.Failed("手势分发被系统拒绝（服务可能已断开）")
        s.onEvent(
            "peer-1",
            eventPayload(JSONObject().apply { put("t", "move"); put("x", 10); put("y", 10) })
        )
        assertEquals(1, injectErrors.size)
        assertTrue(injectErrors[0].contains("手势分发被系统拒绝"))
    }

    @Test
    fun `illegal batch never reaches injector`() {
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertTrue(s.approve("sess-1"))
        // 含非法坐标的整批：解码拒批，注入层收不到任何事件
        s.onEvent(
            "peer-1",
            eventPayload(
                JSONObject().apply { put("t", "move"); put("x", 10); put("y", 10) },
                JSONObject().apply { put("t", "move"); put("x", 99999); put("y", 10) }
            )
        )
        assertTrue(injected.isEmpty())
        assertTrue(injectErrors.isEmpty())
    }

    @Test
    fun `approve rechecks accessibility and denies if disabled meanwhile`() {
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertTrue(requested != null)
        // 用户点“允许”前服务被关掉：不放行，改回拒绝
        ready = false
        assertEquals(false, s.approve("sess-1"))
        assertNull(s.activeSession)
        assertEquals(1, authNotEnabled)
        assertEquals(Protocol.TYPE_SESSION_REJECT, sent.last().second)
        assertEquals("accessibility disabled", sent.last().third.optString("reason"))
    }

    @Test
    fun `session end releases held keys`() {
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertTrue(s.approve("sess-1"))
        s.onStop("peer-1", JSONObject().apply { put("sessionId", "sess-1") })
        assertNull(s.activeSession)
        assertEquals(1, releaseCount)
    }

    @Test
    fun `untrusted peer never reaches confirm UI`() {
        val s = newSession()
        s.onStart("stranger", startPayload())
        assertNull(requested)
        assertEquals(Protocol.TYPE_SESSION_REJECT, sent[0].second)
        assertEquals("not trusted", sent[0].third.optString("reason"))
    }
}
