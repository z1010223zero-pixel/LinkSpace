package cn.linkspace.client.service

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * [TrustStore] 免确认范围（Bug 2：`control.no-confirm` scope）的单测。
 * 覆盖：只给已配对设备授信、持久化后重载仍在、单设备撤销、
 * 一键清空只摘范围不动配对、整条撤销连带清掉标记。
 */
class TrustStoreTest {

    @get:Rule
    val tmp = TemporaryFolder()

    private fun entry(deviceId: String, scope: List<String> = Protocol.DEFAULT_GRANT_SCOPE) =
        TrustStore.Entry(
            deviceId = deviceId,
            displayName = "PC-$deviceId",
            deviceType = "windows",
            fingerprint = "aa".repeat(32),
            scope = scope,
            trustedAt = 1_000L
        )

    private fun newStore() = TrustStore(tmp.newFile("trust.json")).also { it.load() }

    @Test
    fun `grantScope only works for paired device`() {
        val store = newStore()
        // 未配对的设备没有条目可写：绝不凭空建信任
        assertFalse(store.grantScope("dev_unknown", Protocol.SCOPE_NO_CONFIRM))
        assertFalse(store.hasScope("dev_unknown", Protocol.SCOPE_NO_CONFIRM))

        store.grant(entry("dev_aaa"))
        assertTrue(store.grantScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        assertTrue(store.hasScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        // 幂等：重复授予不重复写、不重复加
        assertFalse(store.grantScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        assertEquals(1, store.list().single { it.deviceId == "dev_aaa" }.scope.count { it == Protocol.SCOPE_NO_CONFIRM })
    }

    @Test
    fun `no-confirm survives reload`() {
        val file = tmp.newFile("trust.json")
        TrustStore(file).also {
            it.load()
            it.grant(entry("dev_aaa"))
            it.grantScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM)
        }
        val reloaded = TrustStore(file).also { it.load() }
        assertTrue(reloaded.hasScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        assertTrue(reloaded.hasScope("dev_aaa", "file"))
    }

    @Test
    fun `revokeScope only removes that scope`() {
        val store = newStore()
        store.grant(entry("dev_aaa"))
        store.grantScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM)

        assertTrue(store.revokeScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        assertFalse(store.hasScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        // 设备仍在信任清单里、文件/剪贴板授权不动
        assertTrue(store.isKnown("dev_aaa"))
        assertTrue(store.hasScope("dev_aaa", "file"))
        // 重复撤销返回 false
        assertFalse(store.revokeScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        assertFalse(store.revokeScope("dev_unknown", Protocol.SCOPE_NO_CONFIRM))
    }

    @Test
    fun `clearScope removes flag from all devices but keeps pairing`() {
        val store = newStore()
        store.grant(entry("dev_aaa"))
        store.grant(entry("dev_bbb"))
        store.grantScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM)
        store.grantScope("dev_bbb", Protocol.SCOPE_NO_CONFIRM)

        assertEquals(2, store.clearScope(Protocol.SCOPE_NO_CONFIRM))
        assertFalse(store.hasScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
        assertFalse(store.hasScope("dev_bbb", Protocol.SCOPE_NO_CONFIRM))
        assertTrue(store.isKnown("dev_aaa"))
        assertTrue(store.isKnown("dev_bbb"))
        assertEquals(0, store.clearScope(Protocol.SCOPE_NO_CONFIRM))
    }

    @Test
    fun `full revoke drops no-confirm with the entry`() {
        val store = newStore()
        store.grant(entry("dev_aaa"))
        store.grantScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM)
        assertTrue(store.revoke("dev_aaa"))
        assertFalse(store.isKnown("dev_aaa"))
        assertFalse(store.hasScope("dev_aaa", Protocol.SCOPE_NO_CONFIRM))
    }
}
