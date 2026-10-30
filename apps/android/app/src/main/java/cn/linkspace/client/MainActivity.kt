package cn.linkspace.client

import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.os.Bundle
import android.provider.OpenableColumns
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.input.pointer.changedToDown
import androidx.compose.ui.input.pointer.changedToUp
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.input.pointer.positionChange
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import cn.linkspace.client.service.ClipboardSync
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.OutgoingFile
import cn.linkspace.client.service.TransferTask
import kotlinx.coroutines.launch

class MainActivity : ComponentActivity() {
    /**
     * 剪贴板同步只在界面前台时运行。
     *
     * Android 10 起后台应用读取剪贴板会被系统拒绝（getPrimaryClip 返回空
     * 或直接抛异常），这不是权限问题，申请也拿不到。因此不放到服务里常驻，
     * 而是在 onResume / onPause 之间挂接——代价是应用退到后台后不再同步，
     * 这符合平台约束，也比静默失败好。
     */
    private val clipboardIo = object : ClipboardSync.ClipboardIo {
        private fun manager(): ClipboardManager? =
            getSystemService(ClipboardManager::class.java)

        override fun readText(): String {
            val clip = runCatching { manager()?.primaryClip }.getOrNull() ?: return ""
            if (clip.itemCount == 0) return ""
            return clip.getItemAt(0)?.coerceToText(this@MainActivity)?.toString() ?: ""
        }

        /**
         * 写剪贴板走主线程：控制消息到达时服务在 IO 线程上，
         * 直接 setPrimaryClip 在部分版本上会被拒绝。
         */
        override fun writeText(text: String) {
            runOnUiThread {
                runCatching {
                    manager()?.setPrimaryClip(
                        android.content.ClipData.newPlainText("LinkSpace", text)
                    )
                }.onFailure {
                    android.util.Log.w("LinkSpace/Clipboard", "写入剪贴板失败: ${it.message}")
                }
            }
        }
    }

    private val clipboardListener =
        ClipboardManager.OnPrimaryClipChangedListener { serviceOf()?.pollClipboard() }

    private fun serviceOf(): LinkSpaceService? = LinkSpaceService.get(this)

    /** 走查驱动（见 onCreate 的注册说明），仅 debug build 生效 */
    private val debugReceiver = object : android.content.BroadcastReceiver() {
        override fun onReceive(context: Context?, intent: android.content.Intent?) {
            val service = serviceOf() ?: return
            val peer = service.discovered.value.firstOrNull { it.paired } ?: run {
                android.util.Log.w("LinkSpace/Debug", "没有已配对的发现条目")
                return
            }
            val m = resources.displayMetrics
            this@MainActivity.lifecycleScope.launch {
                service.requestInputControl(
                    peer = peer,
                    screen = InputController.Screen(
                        m.widthPixels.coerceAtLeast(1),
                        m.heightPixels.coerceAtLeast(1)
                    ),
                    displayName = service.selfName.value
                ).onFailure { android.util.Log.w("LinkSpace/Debug", "发起控制失败: ${it.message}") }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        val service = serviceOf() ?: return
        // 剪贴板同步只在开关开启且界面前台时运行（开关默认关：
        // 剪贴板会经过密码与令牌，默认静默同步有泄露面）
        if (service.clipboardEnabled.value) {
            service.enableClipboardSync(clipboardIo)
            android.util.Log.i("LinkSpace/Clipboard", "界面已到前台，剪贴板同步已启用")
            runCatching {
                getSystemService(ClipboardManager::class.java)
                    ?.addPrimaryClipChangedListener(clipboardListener)
            }
        }
    }

    override fun onPause() {
        runCatching {
            getSystemService(ClipboardManager::class.java)
                ?.removePrimaryClipChangedListener(clipboardListener)
        }
        serviceOf()?.disableClipboardSync()
        super.onPause()
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val service = LinkSpaceService.get(this)
        // 前台服务随应用启动：保活连接，杀后台不再「随时消失」（任务 B-③）
        cn.linkspace.client.service.LinkSpaceForegroundService.start(this)

        // 走查驱动入口（仅 debug build 注册）：ZUI 下 adb 注入的 ACTION_UP
        // 不可靠，Button onClick 不触发，自动化走查点不了「控制电脑」。
        // 用法：adb shell am broadcast -a cn.linkspace.DEBUG_REQUEST_CONTROL
        // 取 discovered 列表第一张已配对卡片直接发起控制请求
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            androidx.core.content.ContextCompat.registerReceiver(
                this,
                debugReceiver,
                android.content.IntentFilter("cn.linkspace.DEBUG_REQUEST_CONTROL"),
                androidx.core.content.ContextCompat.RECEIVER_EXPORTED
            )
        }

        setContent {
            MaterialTheme {
                Surface(modifier = Modifier.fillMaxSize()) {
                    MainScreen(
                        service,
                        onClipboardToggle = { on ->
                            service.setClipboardSyncEnabled(on)
                            if (on) {
                                // 前台内立即生效，不等下一次 onResume
                                service.enableClipboardSync(clipboardIo)
                                runCatching {
                                    getSystemService(ClipboardManager::class.java)
                                        ?.addPrimaryClipChangedListener(clipboardListener)
                                }
                            } else {
                                runCatching {
                                    getSystemService(ClipboardManager::class.java)
                                        ?.removePrimaryClipChangedListener(clipboardListener)
                                }
                            }
                        }
                    )
                }
            }
        }
    }
}

@Composable
fun MainScreen(service: LinkSpaceService, onClipboardToggle: (Boolean) -> Unit) {
    val pairings by service.pendingPairings.collectAsStateWithLifecycle()
    val discovered by service.discovered.collectAsStateWithLifecycle()
    val transfers by service.transfers.collectAsStateWithLifecycle()
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val port by service.port.collectAsStateWithLifecycle()
    val selfName by service.selfName.collectAsStateWithLifecycle()
    val inputState by service.inputState.collectAsStateWithLifecycle()
    val inputMessage by service.inputMessage.collectAsStateWithLifecycle()
    val clipboardEnabled by service.clipboardEnabled.collectAsStateWithLifecycle()
    val fingerprintText by service.fingerprintText.collectAsStateWithLifecycle()
    var notice by remember { mutableStateOf("") }

    val context = LocalContext.current

    // Android 13+ 前台服务需要通知权限才展示通知；拒绝不阻塞运行，
    // 只是通知不显示（服务照常保活）
    if (android.os.Build.VERSION.SDK_INT >= 33) {
        val notifPermission = rememberLauncherForActivityResult(
            ActivityResultContracts.RequestPermission()
        ) { }
        LaunchedEffect(Unit) {
            notifPermission.launch(android.Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    // 键鼠控制中的提示（对端拒绝 / 断连 / 会话结束原因）
    LaunchedEffect(inputMessage) {
        if (inputMessage.isNotEmpty()) {
            notice = inputMessage
            service.clearInputMessage()
        }
    }

    // 控制会话激活时整屏切到触控板
    if (inputState.phase == "active") {
        TouchpadScreen(service)
        return
    }

    // ---------- 本机改名（5.4） ----------
    var showRenameDialog by remember { mutableStateOf(false) }
    var nameDraft by remember { mutableStateOf("") }

    // ---------- 发送文件 ----------
    var sendTarget by remember { mutableStateOf<DiscoveredService?>(null) }
    var pendingFiles by remember { mutableStateOf<List<OutgoingFile>>(emptyList()) }
    var sending by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    // SAF 选文件：只回 Uri 不回路径，名字与大小在回调里一并查好，
    // 对话框展示的就是将要发送的东西，不再有第二次转换
    val pickFiles = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris.isNotEmpty()) pendingFiles = context.outgoingFiles(uris)
    }

    LazyColumn(
        modifier = Modifier.fillMaxSize().padding(16.dp),
        verticalArrangement = Arrangement.spacedBy(10.dp)
    ) {
        item {
            Text("LinkSpace", fontSize = 24.sp, fontWeight = FontWeight.Bold)
            Text(
                "本机名称 $selfName",
                fontSize = 13.sp,
                fontWeight = FontWeight.Medium
            )
            Text(
                if (fingerprintText.isEmpty()) "身份初始化中…"
                else "本机指纹 ${fingerprintText.take(17)}… · 端口 $port",
                fontSize = 12.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
            Row {
                TextButton(onClick = {
                    nameDraft = selfName
                    showRenameDialog = true
                }) { Text("修改本机名称") }
                TextButton(onClick = {
                    // 用户主动退出 = 彻底下线：断开全部连接（含键鼠会话）
                    // 并停掉前台服务（任务 B-③ 的退出语义）
                    cn.linkspace.client.service.LinkSpaceForegroundService.exit(context)
                    (context as? android.app.Activity)?.finish()
                }) { Text("退出") }
            }
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("剪贴板同步", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    Text(
                        "与已配对设备互相同步剪贴板文本。默认关闭：内容会经过本机网络。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
                Switch(checked = clipboardEnabled, onCheckedChange = onClipboardToggle)
            }
            Spacer(Modifier.height(4.dp))
        }

        if (notice.isNotEmpty()) {
            item {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.errorContainer
                    )
                ) {
                    Text(notice, modifier = Modifier.padding(12.dp), fontSize = 13.sp)
                }
            }
        }

        // ---------- 配对请求：展示配对码并允许确认 ----------
        if (pairings.isNotEmpty()) {
            item { SectionTitle("待确认的配对请求") }
            items(pairings, key = { it.id }) { p ->
                Card {
                    Column(Modifier.padding(14.dp)) {
                        Text("${p.displayName} 请求配对", fontWeight = FontWeight.Medium)
                        Text(
                            "请让对方输入下面这 6 位配对码。配对码只在本机屏幕显示，不会通过网络传递。",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(10.dp))
                        Text(
                            p.code,
                            fontSize = 32.sp,
                            fontWeight = FontWeight.Bold,
                            fontFamily = FontFamily.Monospace,
                            letterSpacing = 6.sp
                        )
                        Spacer(Modifier.height(10.dp))
                        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                            OutlinedButton(onClick = {
                                service.rejectPairing(p.id)
                            }) { Text("拒绝") }
                        }
                    }
                }
            }
        }

        // ---------- 已信任设备 ----------
        if (trusted.isNotEmpty()) {
            item { SectionTitle("已信任的设备") }
            items(trusted, key = { it.deviceId }) { t ->
                Card {
                    Row(
                        Modifier.padding(14.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Column(Modifier.weight(1f)) {
                            Text(t.displayName, fontWeight = FontWeight.Medium)
                            Text(
                                "授权范围：${t.scope.joinToString(", ")}",
                                fontSize = 12.sp,
                                color = MaterialTheme.colorScheme.onSurfaceVariant
                            )
                        }
                        TextButton(onClick = {
                            service.revokeTrust(t.deviceId)
                            notice = "已撤销对 ${t.displayName} 的信任"
                        }) { Text("撤销") }
                    }
                }
            }
        }

        // ---------- 传输任务 ----------
        if (transfers.isNotEmpty()) {
            item { SectionTitle("文件传输") }
            items(transfers, key = { it.id }) { t ->
                Card {
                    Column(Modifier.padding(14.dp)) {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Text(
                                t.files.joinToString { it.name },
                                Modifier.weight(1f),
                                fontWeight = FontWeight.Medium
                            )
                            Badge { Text(stateLabel(t.state)) }
                        }
                        Text(
                            "${formatBytes(t.totalSize)} · ${t.direction}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        if (t.state == TransferTask.ACCEPTED) {
                            Spacer(Modifier.height(8.dp))
                            LinearProgressIndicator(
                                progress = { if (t.totalSize == 0L) 0f else t.transferred.toFloat() / t.totalSize },
                                modifier = Modifier.fillMaxWidth()
                            )
                        }
                        // 接收/拒绝只属于接收方向的任务：发送任务也会短暂处于
                        // OFFERED（等对方确认），点了「接收」会走错分支
                        if (t.state == TransferTask.OFFERED && t.direction == "receive") {
                            Spacer(Modifier.height(8.dp))
                            Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
                                Button(onClick = {
                                    service.acceptTransfer(t.id)
                                        .onSuccess { notice = "已开始接收" }
                                        .onFailure { notice = it.message ?: "接收失败" }
                                }) { Text("接收") }
                                OutlinedButton(onClick = { service.cancelTransfer(t.id) }) {
                                    Text("拒绝")
                                }
                            }
                        }
                    }
                }
            }
        }

        // ---------- 发现的设备 ----------
        item { SectionTitle("局域网内的其他设备") }
        if (discovered.isEmpty()) {
            item {
                Text(
                    "正在搜索…若桌面端已启动 LinkSpace 应会出现在这里。",
                    fontSize = 13.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
        }
        items(discovered, key = { it.serviceName }) { d ->
            Card {
                Row(
                    Modifier.padding(14.dp).fillMaxWidth(),
                    verticalAlignment = Alignment.CenterVertically
                ) {
                    Column(Modifier.weight(1f)) {
                        Text(d.displayName, fontWeight = FontWeight.Medium)
                        Text(
                            "${d.host}:${d.port} · ${d.caps.joinToString(", ")}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                    if (d.paired) {
                        Badge { Text("已配对") }
                        Spacer(Modifier.height(8.dp))
                        Button(onClick = {
                            sendTarget = d
                            pickFiles.launch(arrayOf("*/*"))
                        }) {
                            Text("发送文件")
                        }
                        // 安卓→电脑远控（协议 4.6）：桌面被控端会弹确认框。
                        // 请求前必须先建出站控制连接（T7 走查 Bug3）：桌面端
                        // 只向自己 accept 进来的连接投递消息，没有连接时
                        // session.start 会石沉大海。失败原因显示在 notice
                        Button(onClick = {
                            val metrics = context.resources.displayMetrics
                            scope.launch {
                                service.requestInputControl(
                                    peer = d,
                                    screen = InputController.Screen(
                                        metrics.widthPixels.coerceAtLeast(1),
                                        metrics.heightPixels.coerceAtLeast(1)
                                    ),
                                    displayName = selfName
                                ).onFailure { notice = it.message ?: "请求失败" }
                            }
                        }) {
                            Text("控制电脑")
                        }
                    }
                }
            }
        }

        item {
            Spacer(Modifier.height(24.dp))
            Text(
                "投屏与被控由桌面端完成；本机可发送/接收文件，也可作为触控板控制已配对的电脑。",
                fontSize = 11.sp,
                color = MaterialTheme.colorScheme.onSurfaceVariant
            )
        }
    }

    // ---------- 发送确认对话框 ----------
    sendTarget?.let { target ->
        AlertDialog(
            onDismissRequest = {
                // 发送进行中不允许误触关闭：服务层没有取消通道，
                // 界面先松手会让任务状态没人认领
                if (!sending) {
                    sendTarget = null
                    pendingFiles = emptyList()
                }
            },
            title = { Text("发送文件") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("目标：${target.displayName}")
                    if (pendingFiles.isEmpty()) {
                        Text("尚未选择文件")
                        OutlinedButton(onClick = { pickFiles.launch(arrayOf("*/*")) }) {
                            Text("选择文件")
                        }
                    } else {
                        pendingFiles.take(5).forEach { f ->
                            Text("· ${f.name}（${formatBytes(f.size)}）", fontSize = 12.sp)
                        }
                        if (pendingFiles.size > 5) {
                            Text("… 共 ${pendingFiles.size} 个文件", fontSize = 12.sp)
                        }
                    }
                }
            },
            confirmButton = {
                Button(
                    enabled = pendingFiles.isNotEmpty() && !sending,
                    onClick = {
                        sending = true
                        scope.launch {
                            service.sendFiles(target, pendingFiles)
                                .onSuccess { notice = "已向 ${target.displayName} 发送 $it 个文件" }
                                .onFailure { notice = it.message ?: "发送失败" }
                            sending = false
                            sendTarget = null
                            pendingFiles = emptyList()
                        }
                    }
                ) { Text(if (sending) "发送中…" else "发送") }
            },
            dismissButton = {
                OutlinedButton(
                    enabled = !sending,
                    onClick = {
                        sendTarget = null
                        pendingFiles = emptyList()
                    }
                ) { Text("取消") }
            }
        )
    }

    // ---------- 等待对端确认控制请求 ----------
    val inputStateForDialog = inputState
    if (inputStateForDialog.phase == "waiting") {
        AlertDialog(
            onDismissRequest = { service.input.stop() },
            title = { Text("正在请求控制对方电脑") },
            text = { Text("请在电脑上确认 LinkSpace 弹出的授权提示。请求 30 秒内未确认会自动失效。") },
            confirmButton = {},
            dismissButton = {
                OutlinedButton(onClick = { service.input.stop() }) { Text("取消") }
            }
        )
    }

    // ---------- 本机改名对话框（5.4） ----------
    if (showRenameDialog) {
        AlertDialog(
            onDismissRequest = { showRenameDialog = false },
            title = { Text("修改本机名称") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text(
                        "对端设备会看到这个名字，最长 60 字符。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    OutlinedTextField(
                        value = nameDraft,
                        onValueChange = { nameDraft = it },
                        singleLine = true,
                        label = { Text("显示名") }
                    )
                }
            },
            confirmButton = {
                Button(
                    onClick = {
                        service.setDisplayName(nameDraft)
                            .onSuccess { clean ->
                                notice = "已改名为「$clean」"
                                showRenameDialog = false
                            }
                            .onFailure { notice = it.message ?: "改名失败" }
                    }
                ) { Text("确定") }
            },
            dismissButton = {
                OutlinedButton(onClick = { showRenameDialog = false }) { Text("取消") }
            }
        )
    }
}

@Composable
private fun SectionTitle(text: String) {
    Text(
        text,
        fontSize = 13.sp,
        fontWeight = FontWeight.SemiBold,
        color = MaterialTheme.colorScheme.primary,
        modifier = Modifier.padding(top = 8.dp)
    )
}

private fun stateLabel(state: String): String = when (state) {
    TransferTask.OFFERED -> "等待确认"
    TransferTask.ACCEPTED -> "接收中"
    TransferTask.COMPLETED -> "已完成"
    TransferTask.FAILED -> "失败"
    TransferTask.CANCELLED -> "已取消"
    else -> state
}

private fun formatBytes(n: Long): String = when {
    n < 1024 -> "$n B"
    n < 1024 * 1024 -> "${n / 1024} KB"
    n < 1024L * 1024 * 1024 -> "%.1f MB".format(n / 1024.0 / 1024.0)
    else -> "%.2f GB".format(n / 1024.0 / 1024.0 / 1024.0)
}

/**
 * 把 SAF 返回的 Uri 转成发送所需的流式描述。
 * 名字与大小从 OpenableColumns 查询，查不到再退回 openFileDescriptor 的 statSize；
 * 查询失败的 Uri 直接跳过——发一半坏文件比不发更糟。
 */
private fun Context.outgoingFiles(uris: List<Uri>): List<OutgoingFile> =
    uris.mapNotNull { uri ->
        runCatching {
            var name: String? = null
            var size: Long? = null
            contentResolver.query(
                uri,
                arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE),
                null, null, null
            )?.use { c ->
                if (c.moveToFirst()) {
                    name = c.getString(0)
                    if (!c.isNull(1)) size = c.getLong(1)
                }
            }
            OutgoingFile(
                name = name ?: uri.lastPathSegment ?: "未命名",
                size = size
                    ?: contentResolver.openFileDescriptor(uri, "r")?.use { it.statSize }
                    ?: 0L,
                open = { contentResolver.openInputStream(uri) ?: error("无法读取文件：$uri") }
            )
        }.getOrNull()
    }


/**
 * 触控板模式：Android 作为键鼠控制端（协议 4.6）。
 *
 * 交互约定：
 *   - 单指拖动 = 相对移动光标（本地虚拟光标按灵敏度累积，跨手势保持——
 *     抬起再按不跳点；协议仍发绝对坐标，桌面端零改动）
 *   - 轻点 = 左键单击；「按住拖拽」开关 = 左键保持按下
 *   - 双指拖动 = 滚轮（一档约 48px）
 *   - 文本框 = 键盘输入（美式布局字符映射，IME 中文跳过）；
 *     Ctrl/Alt 为粘滞修饰键，输一个字符即自动释放
 */
@Composable
fun TouchpadScreen(service: LinkSpaceService) {
    val controller = service.input
    val context = LocalContext.current

    // 事件坐标空间 = 请求时声明的本机屏幕尺寸，两者必须一致
    val metrics = remember { context.resources.displayMetrics }
    val screenW = remember { metrics.widthPixels.coerceAtLeast(1) }
    val screenH = remember { metrics.heightPixels.coerceAtLeast(1) }

    var dragLeft by remember { mutableStateOf(false) }
    var ctrlSticky by remember { mutableStateOf(false) }
    var altSticky by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    var scrollAccum by remember { mutableStateOf(0f) }

    // 相对移动的虚拟光标：初始在屏幕中央，跨手势保持（T7 走查：绝对映射
    // 导致「抬起再按从手指新位置开始」的滑移感 + 灵敏度被屏幕比例钉死）
    var curX by remember { mutableStateOf(screenW / 2f) }
    var curY by remember { mutableStateOf(screenH / 2f) }
    // 灵敏度可调并持久化（T7 走查：绝对映射下移动很慢且无法调节）
    val prefs = remember { context.getSharedPreferences("linkspace", Context.MODE_PRIVATE) }
    var sensitivity by remember {
        mutableStateOf(prefs.getFloat("touchpadSensitivity", 2.0f))
    }
    // 自绘键盘面板（可选展开）：系统 IME 的 composition 不可控
    var keyboardOpen by remember { mutableStateOf(false) }
    var shiftSticky by remember { mutableStateOf(false) }
    var numericLayer by remember { mutableStateOf(false) }

    fun send(events: List<org.json.JSONObject>) {
        // 每条消息上限 64 条（协议 4.6），分段发送
        events.chunked(PROTO_MAX_EVENTS).forEach { controller.sendEvents(it) }
    }

    fun typeChar(c: Char): List<org.json.JSONObject> {
        val pair = Vk.forChar(c)
        val vk = pair.first
        val needShift = pair.second
        if (vk == 0) return emptyList()
        val events = mutableListOf<org.json.JSONObject>()
        if (ctrlSticky) events += InputController.key(0x11, true)
        if (altSticky) events += InputController.key(0x12, true)
        if (needShift) events += InputController.key(0x10, true)
        events += InputController.key(vk, true)
        events += InputController.key(vk, false)
        if (needShift) events += InputController.key(0x10, false)
        if (altSticky) events += InputController.key(0x12, false)
        if (ctrlSticky) events += InputController.key(0x11, false)
        return events
    }

    Column(Modifier.fillMaxSize().padding(12.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Column(Modifier.weight(1f)) {
                Text("正在控制电脑", fontWeight = FontWeight.Bold, fontSize = 18.sp)
                Text(
                    "单指移动 · 轻点单击 · 双指滚动 · 下方输入文字",
                    fontSize = 12.sp,
                    color = MaterialTheme.colorScheme.onSurfaceVariant
                )
            }
            Button(onClick = {
                if (dragLeft) {
                    send(listOf(InputController.up("left")))
                    dragLeft = false
                }
                controller.stop()
            }) { Text("结束控制") }
        }

        // ---------- 特殊按键行 ----------
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp), modifier = Modifier.padding(vertical = 6.dp)) {
            FilledTonalButton(onClick = { send(listOf(InputController.key(0x1B, true), InputController.key(0x1B, false))) }) { Text("Esc") }
            FilledTonalButton(onClick = { send(InputController.tap(0x09)) }) { Text("Tab") }
            FilledTonalButton(onClick = { send(InputController.tap(0x0D)) }) { Text("Enter") }
            FilledTonalButton(onClick = { send(InputController.tap(0x08)) }) { Text("退格") }
        }
        Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            FilledTonalButton(onClick = { send(InputController.tap(0x25)) }) { Text("←") }
            FilledTonalButton(onClick = { send(InputController.tap(0x26)) }) { Text("↑") }
            FilledTonalButton(onClick = { send(InputController.tap(0x28)) }) { Text("↓") }
            FilledTonalButton(onClick = { send(InputController.tap(0x27)) }) { Text("→") }
            Spacer(Modifier.weight(1f))
            FilledTonalButton(
                onClick = { keyboardOpen = !keyboardOpen },
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (keyboardOpen) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.secondaryContainer
                )
            ) { Text("键盘") }
            FilledTonalButton(
                onClick = { ctrlSticky = !ctrlSticky },
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (ctrlSticky) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.secondaryContainer
                )
            ) { Text("Ctrl") }
            FilledTonalButton(
                onClick = { altSticky = !altSticky },
                colors = ButtonDefaults.filledTonalButtonColors(
                    containerColor = if (altSticky) MaterialTheme.colorScheme.primary
                    else MaterialTheme.colorScheme.secondaryContainer
                )
            ) { Text("Alt") }
        }

        // ---------- 自绘键盘（可选展开）----------
        // 为什么不用上方文本框吃所有输入：系统输入法（豆包/搜狗）的
        // composition 在 String 重载的文本框上行为不可控——拼音逐字母
        // 下发到电脑、选字后整段退格重输还发不出中文；自绘键盘点击
        // 直接发键码，零 IME 依赖。文本框保留给英文 IME 用户
        if (keyboardOpen) {
            val rows = if (numericLayer) {
                listOf("1234567890", "@/#$&_+-()/", "*'\":;!?=")
            } else {
                listOf("qwertyuiop", "asdfghjkl", "zxcvbnm,.")
            }
            Column(verticalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.padding(vertical = 4.dp)) {
                rows.forEachIndexed { ri, row ->
                    Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                        when {
                            ri == 0 -> KeyCap(if (numericLayer) "ABC" else "123", Modifier.weight(1.2f), numericLayer) {
                                numericLayer = !numericLayer
                            }
                            ri == 1 -> KeyCap("⇧", Modifier.weight(1.2f), shiftSticky) { shiftSticky = !shiftSticky }
                            ri == 2 -> Spacer(Modifier.weight(1f))
                        }
                        row.forEach { ch ->
                            KeyCap(ch.uppercaseChar().toString(), Modifier.weight(1f)) {
                                val c = if (shiftSticky && ch in 'a'..'z') ch.uppercaseChar() else ch
                                send(typeChar(c))
                                // 单字符即释放粘滞键（与文本框路径同一语义）
                                shiftSticky = false
                                ctrlSticky = false
                                altSticky = false
                            }
                        }
                        when (ri) {
                            1 -> KeyCap("⌫", Modifier.weight(1.2f)) { send(listOf(InputController.key(0x08, true), InputController.key(0x08, false))) }
                            2 -> Spacer(Modifier.weight(1f))
                        }
                    }
                }
                Row(horizontalArrangement = Arrangement.spacedBy(3.dp)) {
                    KeyCap("空格", Modifier.weight(5f)) { send(typeChar(' ')) }
                    KeyCap("↵", Modifier.weight(1.5f)) { send(InputController.tap(0x0D)) }
                }
            }
        }

        // ---------- 文本输入（美式布局映射；中文等 IME 内容跳过） ----------
        BasicTextField(
            value = text,
            onValueChange = { new ->
                val events = diffToKeyEvents(text, new, ::typeChar)
                text = new
                // 输入即用掉粘滞修饰键
                ctrlSticky = false
                altSticky = false
                send(events)
            },
            modifier = Modifier.fillMaxWidth().height(44.dp).padding(vertical = 4.dp),
            textStyle = TextStyle(fontSize = 15.sp),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Ascii),
            decorationBox = { inner ->
                Surface(shape = MaterialTheme.shapes.small, color = MaterialTheme.colorScheme.surfaceVariant) {
                    Box(Modifier.padding(horizontal = 10.dp, vertical = 10.dp)) {
                        if (text.isEmpty()) {
                            Text("在此输入文字（英文），将键入到电脑", fontSize = 13.sp, color = Color.Gray)
                        }
                        inner()
                    }
                }
            }
        )

        // ---------- 灵敏度调节（相对移动倍率，持久化） ----------
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("灵敏度", fontSize = 12.sp)
            Slider(
                value = sensitivity,
                onValueChange = {
                    sensitivity = it
                    prefs.edit().putFloat("touchpadSensitivity", it).apply()
                },
                valueRange = 0.5f..5f,
                modifier = Modifier.weight(1f).padding(horizontal = 10.dp)
            )
            Text("%.1fx".format(sensitivity), fontSize = 12.sp, modifier = Modifier.width(44.dp))
        }

        // ---------- 触控板 ----------
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = MaterialTheme.colorScheme.surfaceVariant,
            modifier = Modifier
                .weight(1f)
                .fillMaxWidth()
                .padding(vertical = 8.dp)
                .pointerInput(Unit) {
                    awaitPointerEventScope {
                        var downAt = 0L
                        var moved = false
                        var twoFinger = false
                        // move 攒批：每帧一条消息的话 TLS+TCP 开销会让指针
                        // 视觉卡顿（用户实测）。攒满 16 条或 30ms 合并发送，
                        // 一条消息多个事件由桌面一次 SendInput 注入。
                        // up/轻点/滚轮不攒——flush 保证 move 先于 click 落地
                        val moveBatch = mutableListOf<org.json.JSONObject>()
                        var lastFlushAt = 0L
                        fun flushMoves() {
                            if (moveBatch.isNotEmpty()) {
                                send(moveBatch)
                                moveBatch.clear()
                            }
                            lastFlushAt = System.currentTimeMillis()
                        }
                        while (true) {
                            val event = awaitPointerEvent()
                            val pressed = event.changes.filter { it.pressed }
                            if (pressed.size >= 2) {
                                flushMoves()
                                // 双指滚动：纵向位移累计成一档档的滚轮刻度。
                                // 上滑 = 内容向上 = 滚轮向上（Windows 正值 = 向上滚）
                                twoFinger = true
                                var dy = 0f
                                pressed.forEach { dy += it.positionChange().y }
                                scrollAccum += dy / pressed.size
                                while (kotlin.math.abs(scrollAccum) >= 48f) {
                                    val tick = if (scrollAccum > 0) -1 else 1
                                    send(listOf(InputController.wheel(0, tick)))
                                    scrollAccum -= tick * 48f
                                }
                                event.changes.forEach {
                                    if (it.positionChange() != androidx.compose.ui.geometry.Offset.Zero) it.consume()
                                }
                            } else if (pressed.size == 1) {
                                val c = pressed.first()
                                if (c.changedToDown()) twoFinger = false
                                if (!twoFinger) {
                                    if (c.changedToDown()) {
                                        downAt = System.currentTimeMillis()
                                        moved = false
                                    }
                                    val delta = c.positionChange()
                                    if (delta != androidx.compose.ui.geometry.Offset.Zero) {
                                        moved = moved || kotlin.math.abs(delta.x) > 2f ||
                                            kotlin.math.abs(delta.y) > 2f
                                        // 相对移动：位移 × 灵敏度累积进虚拟光标，
                                        // 手指抬起再按不重置（滑移修复）
                                        curX = (curX + delta.x * sensitivity)
                                            .coerceIn(0f, (screenW - 1).toFloat())
                                        curY = (curY + delta.y * sensitivity)
                                            .coerceIn(0f, (screenH - 1).toFloat())
                                        moveBatch.add(InputController.move(curX.toInt(), curY.toInt()))
                                        val now = System.currentTimeMillis()
                                        if (moveBatch.size >= 16 || now - lastFlushAt >= 30) flushMoves()
                                        c.consume()
                                    }
                                }
                            } else {
                                // 全部抬起：先发掉攒着的 move 再判轻点（保序）——
                                // 抬起帧 pressed=0，轻点判定放在 pressed.size==1
                                // 分支里永远不可达（移交清单 Bug1 死代码）
                                flushMoves()
                                val up = event.changes.firstOrNull { it.changedToUp() }
                                if (up != null && !twoFinger &&
                                    System.currentTimeMillis() - downAt < 250 && !moved
                                ) {
                                    send(listOf(InputController.down("left"), InputController.up("left")))
                                }
                                twoFinger = false
                                scrollAccum = 0f
                            }
                        }
                    }
                }
        ) {
            Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                Text("触控板", color = Color.Gray)
            }
        }

        // ---------- 鼠标键 ----------
        Row(horizontalArrangement = Arrangement.spacedBy(8.dp)) {
            Button(
                modifier = Modifier.weight(1f),
                onClick = { send(listOf(InputController.down("left"), InputController.up("left"))) }
            ) { Text("左键") }
            Button(
                modifier = Modifier.weight(1f),
                colors = ButtonDefaults.buttonColors(
                    containerColor = if (dragLeft) MaterialTheme.colorScheme.tertiary
                    else MaterialTheme.colorScheme.primary
                ),
                onClick = {
                    if (dragLeft) {
                        send(listOf(InputController.up("left")))
                    } else {
                        send(listOf(InputController.down("left")))
                    }
                    dragLeft = !dragLeft
                }
            ) { Text(if (dragLeft) "松开拖拽" else "按住拖拽") }
            Button(
                modifier = Modifier.weight(1f),
                onClick = { send(listOf(InputController.down("right"), InputController.up("right"))) }
            ) { Text("右键") }
        }
    }
}

/** 协议常量的本文件别名，避免与 Compose 命名冲突 */
private const val PROTO_MAX_EVENTS = 64

/** 自绘键盘的键帽。modifier 由调用点带 RowScope.weight 决定行内宽度，active 为粘滞键高亮 */
@Composable
private fun KeyCap(
    label: String,
    modifier: Modifier = Modifier,
    active: Boolean = false,
    onClick: () -> Unit
) {
    FilledTonalButton(
        onClick = onClick,
        modifier = modifier.height(40.dp),
        colors = if (active) {
            ButtonDefaults.filledTonalButtonColors(containerColor = MaterialTheme.colorScheme.primary)
        } else {
            ButtonDefaults.filledTonalButtonColors()
        },
        contentPadding = PaddingValues(horizontal = 2.dp, vertical = 1.dp)
    ) {
        Text(
            label,
            fontSize = 12.sp,
            maxLines = 1,
            modifier = Modifier.fillMaxWidth(),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center
        )
    }
}

/**
 * 文本框内容差分 → 键盘事件。
 * 追加 = 逐字符输入；变短 = 退格；整段替换 = 退格后重输。
 * 一次超过 64 条的批次由 [TouchpadScreen.send] 分段。
 */
private fun diffToKeyEvents(
    last: String,
    new: String,
    typeChar: (Char) -> List<org.json.JSONObject>
): List<org.json.JSONObject> {
    val events = mutableListOf<org.json.JSONObject>()
    val backspace = listOf(InputController.key(0x08, true), InputController.key(0x08, false))
    when {
        new.length > last.length && new.startsWith(last) ->
            new.substring(last.length).forEach { events += typeChar(it) }
        new.length < last.length && last.startsWith(new) ->
            repeat((last.length - new.length).coerceAtMost(64)) { events += backspace }
        else -> {
            repeat(last.length.coerceAtMost(32)) { events += backspace }
            new.take(32).forEach { events += typeChar(it) }
        }
    }
    return events
}

/**
 * 字符 → Windows 虚拟键码（美式键盘布局），second 表示是否需要 Shift。
 * 映射表覆盖 ASCII 可打印字符与常用控制键；中文等 IME 内容返回 vk=0，
 * 宁可跳过也不猜——错误键码会直接打到电脑上。
 */
private object Vk {
    private val shifted = mapOf(
        '!' to (0x31 to true), '@' to (0x32 to true), '#' to (0x33 to true), '$' to (0x34 to true),
        '%' to (0x35 to true), '^' to (0x36 to true), '&' to (0x37 to true), '*' to (0x38 to true),
        '(' to (0x39 to true), ')' to (0x30 to true), '`' to (0xC0 to false), '~' to (0xC0 to true),
        '-' to (0xBD to false), '_' to (0xBD to true), '=' to (0xBB to false), '+' to (0xBB to true),
        '[' to (0xDB to false), '{' to (0xDB to true), ']' to (0xDD to false), '}' to (0xDD to true),
        '\\' to (0xDC to false), '|' to (0xDC to true), ';' to (0xBA to false), ':' to (0xBA to true),
        '\'' to (0xDE to false), '"' to (0xDE to true), ',' to (0xBC to false), '<' to (0xBC to true),
        '.' to (0xBE to false), '>' to (0xBE to true), '/' to (0xBF to false), '?' to (0xBF to true)
    )

    fun forChar(c: Char): Pair<Int, Boolean> = when (c) {
        in 'a'..'z' -> (0x41 + (c - 'a')) to false
        in 'A'..'Z' -> (0x41 + (c - 'A')) to true
        in '0'..'9' -> (0x30 + (c - '0')) to false
        ' ' -> 0x20 to false
        '\n', '\r' -> 0x0D to false
        '\t' -> 0x09 to false
        else -> shifted[c] ?: (0x00 to false)
    }
}
