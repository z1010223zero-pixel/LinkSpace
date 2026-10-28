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

    @Synchronized
    fun fingerprintOf(deviceId: String): String? =
        entries.firstOrNull { it.deviceId == deviceId }?.fingerprint

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
        // 先写临时文件再改名，避免崩溃留下半个 JSON
        val tmp = File(file.parentFile, "${file.name}.tmp")
        tmp.writeText(arr.toString(2))
        tmp.renameTo(file)
    }
}
