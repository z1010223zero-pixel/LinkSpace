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
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.*
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import cn.linkspace.client.ui.ScreenMirrorScreen
import cn.linkspace.client.ui.TouchpadScreen
import cn.linkspace.client.service.ClipboardSync
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.OutgoingFile
import cn.linkspace.client.service.ReverseScreenStreamer
import cn.linkspace.client.service.StreamDecoder
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
            when (intent?.action) {
                "cn.linkspace.DEBUG_REQUEST_CONTROL" -> {
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
                "cn.linkspace.DEBUG_SCREEN_STREAM" -> {
                    val display = intent.getIntExtra("display", -1)
                    service.requestScreenStream(display)
                }
            }
        }
    }

    override fun onResume() {
        super.onResume()
        val service = serviceOf() ?: return
        // 无障碍授权状态在系统设置里改：每次回前台刷新一次
        service.refreshAccessibilityState()
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
        // 用法：
        //   am broadcast -a cn.linkspace.DEBUG_REQUEST_CONTROL  发起键鼠会话
        //   am broadcast -a cn.linkspace.DEBUG_SCREEN_STREAM    请求投屏
        // 取 discovered 列表第一张已配对卡片直接发起控制请求
        if (applicationInfo.flags and android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE != 0) {
            val filter = android.content.IntentFilter().apply {
                addAction("cn.linkspace.DEBUG_REQUEST_CONTROL")
                addAction("cn.linkspace.DEBUG_SCREEN_STREAM")
            }
            androidx.core.content.ContextCompat.registerReceiver(
                this,
                debugReceiver,
                filter,
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
    val controlRequest by service.controlRequest.collectAsStateWithLifecycle()
    val controlledBy by service.controlledBy.collectAsStateWithLifecycle()
    val accessibilityEnabled by service.accessibilityEnabled.collectAsStateWithLifecycle()
    val reverseRequest by service.reverseStreamRequest.collectAsStateWithLifecycle()
    val reverseStatus by service.reverseStreamStatus.collectAsStateWithLifecycle()
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

    // 反向投屏：系统录屏授权框（线 2 W7）。MainActivity 发 intent，
    // 用户在系统框点允许后拿 MediaProjection 交给服务开流；取消则明确拒绝。
    var captureRequest by remember { mutableStateOf<ReverseScreenStreamer.ReverseStreamRequest?>(null) }
    val screenCapture = rememberLauncherForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val req = captureRequest
        captureRequest = null
        if (req == null) return@rememberLauncherForActivityResult
        val data = result.data
        if (result.resultCode == android.app.Activity.RESULT_OK && data != null) {
            val projectionManager =
                context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
            val projection = runCatching {
                // 官方顺序：先升前台服务类型，再 getMediaProjection
                service.prepareReverseStreamCapture()
                projectionManager.getMediaProjection(result.resultCode, data)
            }.getOrNull()
            if (projection != null) {
                service.startReverseStreamWithProjection(projection)
            } else {
                service.denyReverseStream(req, "failed to start screen capture")
            }
        } else {
            service.denyReverseStream(req, "denied by user")
        }
    }

    // 键鼠控制中的提示（对端拒绝 / 断连 / 会话结束原因）
    LaunchedEffect(inputMessage) {
        if (inputMessage.isNotEmpty()) {
            notice = inputMessage
            service.clearInputMessage()
        }
    }

    // 控制会话激活时整屏切到触控板；投屏流就绪再切到投屏画面
    val screenStreamInfo by service.screenStream.collectAsStateWithLifecycle()
    if (inputState.phase == "active") {
        val ss = screenStreamInfo
        if (ss != null) {
            ScreenMirrorScreen(service, ss)
        } else {
            TouchpadScreen(service)
        }
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
            Row(verticalAlignment = Alignment.CenterVertically) {
                Column(Modifier.weight(1f)) {
                    Text("被控设置（电脑控平板）", fontSize = 14.sp, fontWeight = FontWeight.Medium)
                    Text(
                        if (accessibilityEnabled) "无障碍服务已开启：已配对的电脑请求控制时，本机会弹确认框，点了“允许”才放行。"
                        else "无障碍服务未开启：电脑的控制请求会被直接拒绝，不会弹确认框。",
                        fontSize = 11.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                    if (!accessibilityEnabled) {
                        Text(
                            "开启路径：点右边的按钮进「设置 → 无障碍」，找到 LinkSpace 远程输入并打开。如在列表里找不到、或开关是灰的：Android 13 起侧载安装的应用会被系统加上“受限设置”，请先到「设置 → 应用 → LinkSpace → 右上角 ⋮ 菜单 → 允许受限设置」，再回无障碍里开启。",
                            fontSize = 11.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                    }
                }
                OutlinedButton(onClick = {
                    context.startActivity(service.accessibilitySettingsIntent())
                }) { Text(if (accessibilityEnabled) "查看设置" else "去开启") }
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

        // ---------- 正被电脑控制：常驻提示 + 随时终止 ----------
        if (controlledBy != null) {
            item {
                Card(
                    colors = CardDefaults.cardColors(
                        containerColor = MaterialTheme.colorScheme.tertiaryContainer
                    )
                ) {
                    Row(
                        Modifier.padding(12.dp).fillMaxWidth(),
                        verticalAlignment = Alignment.CenterVertically
                    ) {
                        Text(
                            "正被 $controlledBy 远程控制",
                            Modifier.weight(1f),
                            fontSize = 13.sp
                        )
                        OutlinedButton(onClick = { service.terminateControl() }) {
                            Text("终止控制")
                        }
                    }
                }
            }
        }

        // ---------- 反向投屏：正在向电脑推流（线 2 W7） ----------
        val activeReverse = reverseStatus?.active
        if (activeReverse != null) {
            item {
                Card {
                    Column(Modifier.padding(14.dp)) {
                        Text("正在向电脑推流", fontWeight = FontWeight.Medium)
                        Text(
                            "${trusted.firstOrNull { it.deviceId == activeReverse.peerId }?.displayName ?: activeReverse.peerId} · ${activeReverse.width}×${activeReverse.height} · ${activeReverse.encoder}",
                            fontSize = 12.sp,
                            color = MaterialTheme.colorScheme.onSurfaceVariant
                        )
                        Spacer(Modifier.height(10.dp))
                        OutlinedButton(onClick = { service.stopReverseStream() }) { Text("停止推流") }
                    }
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

    // ---------- 反向投屏请求：电脑想看本机屏幕（线 2 W7） ----------
    // 每次请求都要过这道确认 + 系统录屏授权框；拒绝/取消都明确回绝，
    // 桌面窗口显示原因。30 秒无人确认由服务侧 TTL 自动拒绝。
    reverseRequest?.let { req ->
        AlertDialog(
            onDismissRequest = { service.denyReverseStream(req, "denied by user") },
            title = { Text("电脑请求查看你的屏幕") },
            text = {
                Text("对方想在电脑上实时查看这台平板的画面。同意后会弹出系统录屏授权框，只有你点了允许才会开始录屏；随时可以在通知栏停止。")
            },
            confirmButton = {
                Button(onClick = {
                    captureRequest = req
                    val manager =
                        context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
                    screenCapture.launch(manager.createScreenCaptureIntent())
                }) { Text("同意") }
            },
            dismissButton = {
                OutlinedButton(onClick = { service.denyReverseStream(req, "denied by user") }) { Text("拒绝") }
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

    // ---------- 电脑请求控制本机：确认弹窗（协议 9.1） ----------
    // 30s 内未确认由会话层自动拒绝；弹窗被划掉按拒绝处理——
    // 确认 UI 未弹出时不放行任何输入。
    if (controlRequest != null) {
        val req = controlRequest!!
        AlertDialog(
            onDismissRequest = { service.denyControl(req.sessionId) },
            title = { Text("允许远程控制本机？") },
            text = {
                Column(verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    Text("“${req.displayName.ifEmpty { req.peerId }}”请求在电脑上操作这台平板（点按、滑动、按键）。")
                    Text(
                        "点了“允许”，对方才能操作；会话结束前可随时在首页点“终止控制”拔掉。30 秒内未确认将自动拒绝。",
                        fontSize = 12.sp,
                        color = MaterialTheme.colorScheme.onSurfaceVariant
                    )
                }
            },
            confirmButton = {
                Button(onClick = { service.approveControl(req.sessionId) }) { Text("允许") }
            },
            dismissButton = {
                OutlinedButton(onClick = { service.denyControl(req.sessionId) }) { Text("拒绝") }
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
