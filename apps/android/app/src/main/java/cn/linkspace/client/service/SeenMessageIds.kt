package cn.linkspace.client.service

/**
 * 每连接消息 id 去重（协议 §3）：同一 id 只处理一次。
 * 纯逻辑，不依赖 Android 框架，可 JVM 单测。按插入顺序淘汰最旧
 * 的 id，窗口固定为最近 [Protocol.MAX_SEEN_MESSAGE_IDS] 条——
 * 连接生命周期内无界增长等于给对端留一个内存耗尽口子。
 */
class SeenMessageIds(private val maxIds: Int = Protocol.MAX_SEEN_MESSAGE_IDS) {
    private val ids = HashSet<String>()
    private val order = ArrayDeque<String>()

    /** 调用方看到的重复消息累计数（日志节流用） */
    var duplicateCount: Int = 0
        private set

    /** 已见过返回 true；首次见返回 false 并记入窗口 */
    @Synchronized
    fun isDuplicate(id: String): Boolean {
        if (ids.contains(id)) {
            duplicateCount++
            return true
        }
        ids += id
        order += id
        while (order.size > maxIds) {
            ids -= order.removeFirst()
        }
        return false
    }
}
