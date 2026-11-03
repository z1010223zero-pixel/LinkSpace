package cn.linkspace.client.service

import org.json.JSONArray
import org.json.JSONObject
import java.io.File

/**
 * 信任清单。与桌面端 `transfer/trust.ts` 同一套语义：
 *   发现不等于可信，只有 pair.approve 之后才写入；撤销立即生效；
 *   scope 显式列出授权能力，控制类能力不默认授予。
 *
 * 用 org.json（Android 内置）而不是引一个 JSON 库。
 */
class TrustStore(private val file: File) {

    data class Entry(
        val deviceId: String,
        val displayName: String,
        val deviceType: String,
        val fingerprint: String,
        val scope: List<String>,
        val trustedAt: Long
    )

    private val entries = mutableListOf<Entry>()

    @Synchronized
    fun load() {
        if (!file.exists()) return
        runCatching {
            val arr = JSONArray(file.readText())
            entries.clear()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                entries += Entry(
                    deviceId = o.getString("deviceId"),
                    displayName = o.getString("displayName"),
                    deviceType = o.getString("deviceType"),
                    fingerprint = o.getString("fingerprint"),
                    scope = o.getJSONArray("scope").let { a -> (0 until a.length()).map { a.getString(it) } },
                    trustedAt = o.getLong("trustedAt")
                )
            }
        }.onFailure {
            // 清单损坏不应导致应用无法启动
            entries.clear()
        }
    }

    @Synchronized
    fun isKnown(deviceId: String): Boolean = entries.any { it.deviceId == deviceId }

    @Synchronized
    fun hasScope(deviceId: String, scope: String): Boolean =
        entries.any { it.deviceId == deviceId && it.scope.contains(scope) }

    /**
     * 按设备 ID 前缀判定授权，发送方向专用。
     *
     * 桌面端 deviceId 是 20 字符（`dev_` + 16 位指纹），而 mDNS TXT 只广播
     * 前 12 位；发送前的授权预检拿到的只有这 12 位，全等比对永远失配。
     * 存储条目以发现前缀开头即视为同一设备——前缀来自自己的通告，
     * 唯一性由指纹保证，不存在误配空间。
     */
    @Synchronized
    fun hasScopeFor(deviceIdPrefix: String, scope: String): Boolean =
        entries.any { it.deviceId.startsWith(deviceIdPrefix) && it.scope.contains(scope) }

    @Synchronized
    fun fingerprintOf(deviceId: String): String? =
        entries.firstOrNull { it.deviceId == deviceId }?.fingerprint

    /**
     * 把发现层拿到的 12 位前缀还原成对端完整设备 ID。
     * 控制消息信封的 `to` 要填完整 ID：桌面端按全等路由，填前缀会被
     * 静默丢弃（offer 发出去石沉大海）。预检已通过，这里必然能解析。
     */
    @Synchronized
    fun fullDeviceIdOf(deviceIdPrefix: String): String? =
        entries.firstOrNull { it.deviceId.startsWith(deviceIdPrefix) }?.deviceId

    @Synchronized
    fun list(): List<Entry> = entries.toList()

    @Synchronized
    fun grant(entry: Entry) {
        val idx = entries.indexOfFirst { it.deviceId == entry.deviceId }
        if (idx >= 0) entries[idx] = entry else entries += entry
        persist()
    }

    @Synchronized
    fun revoke(deviceId: String): Boolean {
        val before = entries.size
        entries.removeAll { it.deviceId == deviceId }
        val changed = entries.size != before
        if (changed) persist()
        return changed
    }

    /**
     * 给已配对设备追加一个授权范围（Bug 2：`control.no-confirm`）。
     * 只对信任清单内已有的设备生效——未配对的设备没有条目可写，
     * 绝不凭空建信任（fail-closed）。已含该范围时不重复写盘。
     */
    @Synchronized
    fun grantScope(deviceId: String, scope: String): Boolean {
        val idx = entries.indexOfFirst { it.deviceId == deviceId }
        if (idx < 0 || entries[idx].scope.contains(scope)) return false
        entries[idx] = entries[idx].copy(scope = entries[idx].scope + scope)
        persist()
        return true
    }

    /**
     * 从单个设备上收回一个授权范围（Bug 2：设置页撤销单个信任）。
     * 只摘掉该范围，设备本身仍在信任清单里、仍保持配对。
     */
    @Synchronized
    fun revokeScope(deviceId: String, scope: String): Boolean {
        val idx = entries.indexOfFirst { it.deviceId == deviceId }
        if (idx < 0 || !entries[idx].scope.contains(scope)) return false
        entries[idx] = entries[idx].copy(scope = entries[idx].scope - scope)
        persist()
        return true
    }

    /**
     * 从全部设备上收回一个授权范围（Bug 2：设置页一键清空信任清单）。
     * 同样只摘范围、不动配对关系。返回被改动的设备数。
     */
    @Synchronized
    fun clearScope(scope: String): Int {
        var changed = 0
        for (i in entries.indices) {
            if (entries[i].scope.contains(scope)) {
                entries[i] = entries[i].copy(scope = entries[i].scope - scope)
                changed++
            }
        }
        if (changed > 0) persist()
        return changed
    }

    /**
     * 更新对端显示名（device.rename，5.4）。与桌面端 trust.ts 同一语义：
     * 只对信任清单内的设备生效，返回是否有实际变更。
     */
    @Synchronized
    fun rename(deviceId: String, displayName: String): Boolean {
        val idx = entries.indexOfFirst { it.deviceId == deviceId }
        if (idx < 0 || entries[idx].displayName == displayName) return false
        entries[idx] = entries[idx].copy(displayName = displayName)
        persist()
        return true
    }

    private fun persist() {
        val arr = JSONArray()
        entries.forEach { e ->
            arr.put(
                JSONObject().apply {
                    put("deviceId", e.deviceId)
                    put("displayName", e.displayName)
                    put("deviceType", e.deviceType)
                    put("fingerprint", e.fingerprint)
                    put("scope", JSONArray(e.scope))
                    put("trustedAt", e.trustedAt)
                }
            )
        }
        file.parentFile?.mkdirs()
        // 先写临时文件再改名，避免崩溃留下半个 JSON。
        // 改名用 Files.move(REPLACE_EXISTING)：File.renameTo 在
        // Windows 上目标已存在时直接失败（且不报错），第二次及以后的
        // 持久化会静默丢失——JVM 单测就在 Windows 上跑，reload 测例
        // 靠它；Android/Linux 上 rename 本就能覆盖，行为不变。
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(arr.toString(2))
        java.nio.file.Files.move(
            tmp.toPath(), file.toPath(),
            java.nio.file.StandardCopyOption.REPLACE_EXISTING
        )
    }
}
