package cn.linkspace.client.service

import org.json.JSONObject

/**
 * 与桌面端 `docs/protocol.md` 对齐的协议常量与消息模型。
 * 两端必须逐字一致，改一处就要同步改另一端。
 */
object Protocol {
    const val VERSION = 1
    const val SERVICE_TYPE = "_linkspace._tcp."
    const val CHUNK_SIZE = 4 * 1024 * 1024

    /** 文件数据面路由。控制通道挂在同一个端口上 */
    const val CONTROL_PATH = "/linkspace/v1/control"
    fun chunkPath(transferId: String) = "/linkspace/v1/transfer/$transferId/chunk"

    const val HEADER_DEVICE_ID = "X-Device-Id"
    const val HEADER_TRANSFER_TOKEN = "X-Transfer-Token"
    const val HEADER_CHUNK_SIZE = "X-Chunk-Size"
    const val HEADER_CHUNK_DIGEST = "X-Chunk-Digest"

    const val TYPE_ANNOUNCE = "device.announce"
    /** 本机改名广播（5.4）：payload 只带 displayName，两端语义一致 */
    const val TYPE_RENAME = "device.rename"
    const val TYPE_PAIR_REQUEST = "pair.request"
    const val TYPE_PAIR_CHALLENGE = "pair.challenge"
    const val TYPE_PAIR_SUBMIT = "pair.submit"
    const val TYPE_PAIR_APPROVE = "pair.approve"
    const val TYPE_PAIR_REJECT = "pair.reject"
    const val TYPE_PAIR_REVOKE = "pair.revoke"
    const val TYPE_PAIR_ERROR = "pair.error"
    const val TYPE_HEARTBEAT = "device.heartbeat"
    const val TYPE_TRANSFER_OFFER = "transfer.offer"
    const val TYPE_TRANSFER_ACCEPT = "transfer.accept"
    const val TYPE_TRANSFER_REJECT = "transfer.reject"
    const val TYPE_TRANSFER_CANCEL = "transfer.cancel"
    const val TYPE_TRANSFER_COMPLETE = "transfer.complete"
    const val TYPE_TRANSFER_ERROR = "transfer.error"
    const val TYPE_CLIPBOARD_SHARE = "clipboard.share"

    /**
     * 配对默认授予的范围，与桌面端 `DEFAULT_GRANT_SCOPE` 一致。
     * control 不在其中：让对端操作本机必须另行授权。
     */
    val DEFAULT_GRANT_SCOPE: List<String> = listOf("file", "clipboard")
}

/** 控制消息信封，字段与桌面端一致 */
data class Envelope(
    val v: Int,
    val type: String,
    val id: String,
    val from: String,
    val to: String,
    val ts: Long,
    val payload: JSONObject
)

/** 已发现的局域网服务 */
data class DiscoveredService(
    val serviceName: String,
    val displayName: String,
    val idPrefix: String,
    val deviceType: String,
    val caps: List<String>,
    val host: String,
    val port: Int,
    val paired: Boolean
)

/** 传输任务 */
data class TransferTask(
    val id: String,
    val direction: String,
    val peerId: String,
    val state: String,
    val files: List<TransferFile>,
    val totalSize: Long,
    val transferred: Long,
    val createdAt: Long,
    /** 失败原因，仅 state = failed 时有值 */
    val error: String? = null
) {
    companion object {
        const val OFFERED = "offered"
        const val ACCEPTED = "accepted"
        const val COMPLETED = "completed"
        const val FAILED = "failed"
        const val CANCELLED = "cancelled"
    }
}

data class TransferFile(
    val name: String,
    val size: Long,
    var savePath: String? = null,
    var digest: String? = null
)
