package cn.linkspace.client.service

import cn.linkspace.client.service.ControlledInputInjector.InputFailure
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * [ControlledInputSession] 的中文输入单测（线 2，任务 2.3-3，协议 §4.9 / §4.8）：
 * input.text 分发、screen.paste 分发、input.error 回告与节流。
 * commitText / paste 用假实现，不碰 Android 框架；时钟可注入。
 */
class ControlledInputSessionImeTest {

    private val sent = mutableListOf<Triple<String, String, JSONObject>>()
    private val committed = mutableListOf<String>()
    private var commitFailure: InputFailure? = null
    private val pasted = mutableListOf<String>()
    private var pasteFailure: InputFailure? = null
    private val injectErrors = mutableListOf<String>()
    private var clock: Long = 1_000_000L

    private fun newSession() = ControlledInputSession(
        isPeerAuthorized = { it == "peer-1" },
        localScreen = { InputController.Screen(1080, 2400) },
        send = { peerId, type, payloadFn ->
            sent += Triple(peerId, type, JSONObject().apply(payloadFn))
        },
        isAccessibilityReady = { true },
        listener = object : ControlledInputSession.Listener {
            override fun onControlRequested(request: ControlledInputSession.ControlRequest) {}
            override fun onChanged() {}
            override fun onAccessibilityNotEnabled() {}
            override fun onInjectError(sessionId: String, reason: String) {
                injectErrors += "$sessionId:$reason"
            }
        },
        commitText = { text ->
            committed += text
            commitFailure
        },
        paste = { text ->
            pasted += text
            pasteFailure
        },
        now = { clock }
    )

    private fun startPayload() = JSONObject().apply {
        put("sessionType", "input")
        put("sessionId", "sess-1")
        put("params", JSONObject().apply {
            put("screen", JSONObject().apply { put("w", 1920); put("h", 1080) })
            put("displayName", "PC")
        })
    }

    private fun activeSession(): ControlledInputSession {
        val s = newSession()
        s.onStart("peer-1", startPayload())
        assertTrue(s.approve("sess-1"))
        sent.clear()
        return s
    }

    private fun inputErrors() = sent.filter { it.second == Protocol.TYPE_INPUT_ERROR }

    @Test
    fun `input text committed when session active`() {
        val s = activeSession()
        s.onText("peer-1", JSONObject().apply {
            put("sessionId", "sess-1")
            put("text", "你好世界")
        })
        assertEquals(listOf("你好世界"), committed)
        assertTrue(inputErrors().isEmpty())
        assertTrue(injectErrors.isEmpty())
    }

    @Test
    fun `input text ignored without active session or from wrong peer`() {
        val s = newSession()
        s.onText("peer-1", JSONObject().apply { put("sessionId", "sess-1"); put("text", "你好") })
        assertTrue(committed.isEmpty())
        val a = activeSession()
        a.onText("peer-2", JSONObject().apply { put("sessionId", "sess-1"); put("text", "你好") })
        assertTrue(committed.isEmpty())
        a.onText("peer-1", JSONObject().apply { put("sessionId", "sess-other"); put("text", "你好") })
        assertTrue(committed.isEmpty())
        assertTrue(inputErrors().isEmpty())
    }

    @Test
    fun `input text empty ignored silently`() {
        val s = activeSession()
        s.onText("peer-1", JSONObject().apply { put("sessionId", "sess-1"); put("text", "") })
        assertTrue(committed.isEmpty())
        assertTrue(inputErrors().isEmpty())
    }

    @Test
    fun `input text over 8 KiB rejected whole with too-large error`() {
        val s = activeSession()
        val big = "a".repeat(8 * 1024 + 1)
        s.onText("peer-1", JSONObject().apply { put("sessionId", "sess-1"); put("text", big) })
        assertTrue(committed.isEmpty())
        val errs = inputErrors()
        assertEquals(1, errs.size)
        assertEquals("too-large", errs[0].third.optString("code"))
        assertEquals("sess-1", errs[0].third.optString("sessionId"))
    }

    @Test
    fun `input text exactly 8 KiB accepted`() {
        val s = activeSession()
        val exact = "a".repeat(8 * 1024)
        s.onText("peer-1", JSONObject().apply { put("sessionId", "sess-1"); put("text", exact) })
        assertEquals(listOf(exact), committed)
        assertTrue(inputErrors().isEmpty())
    }

    @Test
    fun `input text multibyte size counted in UTF-8 bytes`() {
        val s = activeSession()
        // 2731 个汉字 = 8193 字节 > 8 KiB，整条丢弃
        s.onText("peer-1", JSONObject().apply { put("sessionId", "sess-1"); put("text", "汉".repeat(2731)) })
        assertTrue(committed.isEmpty())
        assertEquals(1, inputErrors().size)
    }

    @Test
    fun `commit failure reported as input error with code and to UI`() {
        val s = activeSession()
        commitFailure = InputFailure(InputFailure.NO_FOCUS, "当前没有获得焦点的输入框")
        s.onText("peer-1", JSONObject().apply { put("sessionId", "sess-1"); put("text", "你好") })
        assertEquals(listOf("你好"), committed)
        val errs = inputErrors()
        assertEquals(1, errs.size)
        assertEquals("no-focus", errs[0].third.optString("code"))
        assertTrue(errs[0].third.optString("reason").contains("没有获得焦点的输入框"))
        assertEquals(1, injectErrors.size)
    }

    @Test
    fun `screen paste dispatched when session active`() {
        val s = activeSession()
        s.onScreenPaste("peer-1", JSONObject().apply { put("text", "粘贴文本") })
        assertEquals(listOf("粘贴文本"), pasted)
        assertTrue(inputErrors().isEmpty())
    }

    @Test
    fun `screen paste over 512 KiB rejected whole with too-large error`() {
        val s = activeSession()
        s.onScreenPaste("peer-1", JSONObject().apply { put("text", "a".repeat(512 * 1024 + 1)) })
        assertTrue(pasted.isEmpty())
        assertEquals(1, inputErrors().size)
        assertEquals("too-large", inputErrors()[0].third.optString("code"))
    }

    @Test
    fun `screen paste failure reported as input error`() {
        val s = activeSession()
        pasteFailure = InputFailure(InputFailure.NO_FOCUS, "当前没有获得焦点的输入框")
        s.onScreenPaste("peer-1", JSONObject().apply { put("text", "粘贴文本") })
        assertEquals(1, inputErrors().size)
        assertEquals("no-focus", inputErrors()[0].third.optString("code"))
    }

    @Test
    fun `screen paste ignored from wrong peer or without session`() {
        val s = newSession()
        s.onScreenPaste("peer-1", JSONObject().apply { put("text", "x") })
        assertTrue(pasted.isEmpty())
        val a = activeSession()
        a.onScreenPaste("peer-2", JSONObject().apply { put("text", "x") })
        assertTrue(pasted.isEmpty())
        assertTrue(inputErrors().isEmpty())
    }

    @Test
    fun `input error throttled per code within 5s`() {
        val s = activeSession()
        val payload = JSONObject().apply { put("sessionId", "sess-1"); put("text", "你好") }
        commitFailure = InputFailure(InputFailure.NO_FOCUS, "当前没有获得焦点的输入框")
        s.onText("peer-1", payload)
        s.onText("peer-1", payload)
        s.onText("peer-1", payload)
        assertEquals(1, inputErrors().size)
        // 换一个 code 立即放行
        commitFailure = InputFailure(InputFailure.INJECT_FAILED, "输入连接提交失败")
        s.onText("peer-1", payload)
        assertEquals(2, inputErrors().size)
        // 回到 no-focus：code 与上次不同，立即放行；紧接着重复一次被节流
        commitFailure = InputFailure(InputFailure.NO_FOCUS, "当前没有获得焦点的输入框")
        s.onText("peer-1", payload)
        assertEquals(3, inputErrors().size)
        s.onText("peer-1", payload)
        assertEquals(3, inputErrors().size)
        // 5 秒后同一 code 复发
        clock += 5_000L
        s.onText("peer-1", payload)
        assertEquals(4, inputErrors().size)
        assertEquals("no-focus", inputErrors()[3].third.optString("code"))
    }
}
