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

    /** 会话控制（4.3 / 4.6 键鼠共享）：Android 作控制端时使用 */
    const val TYPE_SESSION_START = "session.start"
    const val TYPE_SESSION_ACCEPT = "session.accept"
    const val TYPE_SESSION_REJECT = "session.reject"
    const val TYPE_SESSION_STOP = "session.stop"
    const val TYPE_INPUT_EVENT = "input.event"

    /**
     * 屏幕投屏（寄生在键鼠会话内，[PROTOCOL] 新增）：
     * request 由平板发（需同 peer 的 active 会话）；start/stop/error 由
     * 桌面回。start 携带推流 TCP 端口与虚拟屏物理尺寸（触控映射基准）。
     */
    const val TYPE_SCREEN_STREAM_REQUEST = "screen.stream.request"
    const val TYPE_SCREEN_STREAM_START = "screen.stream.start"
    const val TYPE_SCREEN_STREAM_STOP = "screen.stream.stop"
    const val TYPE_SCREEN_STREAM_ERROR = "screen.stream.error"

    /** 多显示器清单回告（B-2 多显示器选择）：被控端枚举结果 */
    const val TYPE_SCREEN_STREAM_DISPLAYS = "screen.stream.displays"
    const val TYPE_SCREEN_CURSOR = "screen.cursor"

    /**
     * screen.stream.stop 的方向位（协议 4.7）：标识停的是哪一路流。
     * forward = 线 1（桌面 → 平板）；reverse = 反向（平板 → 桌面）。
     * 与桌面端 screen-stream.ts 的 STREAM_DIRECTION_* 同值，
     * 约束见 protocol.json constraints.streamDirections。
     */
    const val STREAM_DIRECTION_FORWARD = "forward"
    const val STREAM_DIRECTION_REVERSE = "reverse"

    /**
     * 解析 screen.stream.stop 的停流方向（与桌面端 screen-stream.ts 的
     * resolveStreamStopDirection 同规则，两端必须一致）：
     * - direction 明确给出 forward/reverse：直接采用；
     * - direction 缺失或为 null（旧版本对端）：单路在跑时停那一路；
     *   双向都在跑时只停 forward（本消息最初的语义），绝不顺手停掉
     *   另一路；两路都没跑返回 null（忽略，不回声）；
     * - direction 非法：返回 null，调用方忽略本消息并记日志。
     * forwardLive / reverseLive 由调用方按发消息的对端取数（只认属于
     * 该对端的流），不要传全局状态。
     */
    fun resolveStreamStopDirection(direction: String?, forwardLive: Boolean, reverseLive: Boolean): String? {
        if (direction == null) {
            return when {
                forwardLive && !reverseLive -> STREAM_DIRECTION_FORWARD
                reverseLive && !forwardLive -> STREAM_DIRECTION_REVERSE
                forwardLive && reverseLive -> STREAM_DIRECTION_FORWARD
                else -> null
            }
        }
        return when (direction) {
            STREAM_DIRECTION_FORWARD, STREAM_DIRECTION_REVERSE -> direction
            else -> null
        }
    }

    /** 投屏粘贴（协议 4.8）：写被控端剪贴板并注入 Ctrl+V，寄生 input 会话 */
    const val TYPE_SCREEN_PASTE = "screen.paste"

    /** 文本直通（协议 4.9）：成品文本经输入连接 commitText 上屏，寄生 input 会话 */
    const val TYPE_INPUT_TEXT = "input.text"

    /** 输入失败回告（协议 4.9）：code + reason，控制端 UI 展示用 */
    const val TYPE_INPUT_ERROR = "input.error"

    /** 单条 input.text 上限（UTF-8 字节），与桌面端 MAX_INPUT_TEXT_BYTES 一致 */
    const val MAX_INPUT_TEXT_BYTES = 8 * 1024

    /** screen.paste 单条上限（协议 4.8，与 4.4 剪贴板一致） */
    const val MAX_PASTE_BYTES = 512 * 1024

    /** sessionId 约束，与桌面端 SESSION_ID_RE 一致 */
    const val SESSION_ID_RE = "[A-Za-z0-9_-]{1,64}"

    /** 单条 input.event 消息的事件数上限，与桌面端 MAX_EVENTS_PER_MESSAGE 一致 */
    const val MAX_EVENTS_PER_MESSAGE = 64

    /**
     * 每连接消息 id 去重窗口（协议 §3）：最近这么多条 id 内的重复只
     * 处理一次，与桌面端 MAX_SEEN_MESSAGE_IDS 一致。
     */
    const val MAX_SEEN_MESSAGE_IDS = 1024

    /** move 事件坐标上限（控制端屏幕绝对坐标），与桌面端 MAX_COORD 一致 */
    const val MAX_COORD = 32768

    /** 数据面请求体上限，与桌面端 MAX_CHUNK_BODY 一致（超限 413） */
    const val MAX_CHUNK_BODY = 32 * 1024 * 1024

    /**
     * 数据面组合键的百分号编码。桌面端按 decodeURIComponent 解码，
     * 把 `+` 还原为空格的是表单编码规则而非 URI 规则——SAF 文件名里
     * 空格与 `+` 都常见，必须用 %20 表示空格、`+` 原样编码成 %2B。
     */
    fun encodeTransferKey(key: String): String =
        java.net.URLEncoder.encode(key, "UTF-8").replace("+", "%20")

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
    val paired: Boolean,
    /** 最后一次收到通告的时间，软过期判定用（对齐桌面端 lastSeen） */
    val lastSeen: Long = 0L
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
