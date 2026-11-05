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
import androidx.compose.material3.*
import androidx.compose.runtime.*
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import cn.linkspace.client.ui.ScreenMirrorScreen
import cn.linkspace.client.ui.ControlRequestDialog
import cn.linkspace.client.ui.ReverseStreamRequestDialog
import cn.linkspace.client.ui.WaitingControlDialog
import cn.linkspace.client.ui.TouchpadScreen
import cn.linkspace.client.service.ClipboardSync
import cn.linkspace.client.service.DiscoveredService
import cn.linkspace.client.service.InputController
import cn.linkspace.client.service.LinkSpaceService
import cn.linkspace.client.service.OutgoingFile
import cn.linkspace.client.service.Protocol
import cn.linkspace.client.service.ReverseScreenStreamer
import cn.linkspace.client.service.LinkSpaceForegroundService
import cn.linkspace.client.ui.AppNavShell
import cn.linkspace.client.ui.ControlledByBanner
import cn.linkspace.client.ui.DeviceDetailInfo
import cn.linkspace.client.ui.DeviceDetailSheet
import cn.linkspace.client.ui.DevicesPage
import cn.linkspace.client.ui.FilesPage
import cn.linkspace.client.ui.LinkSpaceTheme
import cn.linkspace.client.ui.NavPage
import cn.linkspace.client.ui.NoticeBoard
import cn.linkspace.client.ui.NoticeList
import cn.linkspace.client.ui.OverviewPage
import cn.linkspace.client.ui.ReverseStreamBanner
import cn.linkspace.client.ui.ScreenPage
import cn.linkspace.client.ui.SettingsPage
import cn.linkspace.client.ui.appVersionName
import cn.linkspace.client.ui.formatBytes
import cn.linkspace.client.ui.isOnline
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

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

/**
 * 主界面瘦身后只剩：导航壳 + 会话接管 + 弹窗挂载点。
 * 各页内容拆进 ui/ 包（OverviewPage / DevicesPage / ScreenPage /
 * FilesPage / SettingsPage）；通知由 NoticeBoard 统一分级管理。
 *
 * 视觉效果待用户在小新平板 Pro GT 真机上验收。
 */
@Composable
fun MainScreen(service: LinkSpaceService, onClipboardToggle: (Boolean) -> Unit) {
    val discovered by service.discovered.collectAsStateWithLifecycle()
    val trusted by service.trusted.collectAsStateWithLifecycle()
    val inputState by service.inputState.collectAsStateWithLifecycle()
    val inputMessage by service.inputMessage.collectAsStateWithLifecycle()
    val controlRequest by service.controlRequest.collectAsStateWithLifecycle()
    val controlledBy by service.controlledBy.collectAsStateWithLifecycle()
    val accessibilityEnabled by service.accessibilityEnabled.collectAsStateWithLifecycle()
    val reverseRequest by service.reverseStreamRequest.collectAsStateWithLifecycle()
    val reverseStatus by service.reverseStreamStatus.collectAsStateWithLifecycle()
    val clipboardEnabled by service.clipboardEnabled.collectAsStateWithLifecycle()
    val streamMode by service.streamMode.collectAsStateWithLifecycle()
    val selfName by service.selfName.collectAsStateWithLifecycle()
    val fingerprintText by service.fingerprintText.collectAsStateWithLifecycle()
    val port by service.port.collectAsStateWithLifecycle()

    val board = remember { NoticeBoard() }
    val context = LocalContext.current
    val scope = rememberCoroutineScope()

    // 30 秒时钟：在线状态与顶栏“在线 X/Y”刷新用
    var now by remember { mutableStateOf(System.currentTimeMillis()) }
    LaunchedEffect(Unit) {
        while (true) {
            delay(30_000)
            now = System.currentTimeMillis()
        }
    }

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
            scope.launch {
                // getMediaProjection 要求 mediaProjection 类型的前台服务已生效；
                // startForegroundService 是异步的，必须等升级完成再取 token。
                service.prepareReverseStreamCapture()
                val ready = withContext(Dispatchers.IO) {
                    LinkSpaceForegroundService.awaitMediaProjectionReady(1000L)
                }
                val projectionManager =
                    context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
                val projection = if (ready) {
                    runCatching { projectionManager.getMediaProjection(result.resultCode, data) }.getOrNull()
            } else {
                    null
            }
                if (projection != null) {
                    service.startReverseStreamWithProjection(projection)
                } else {
                    service.denyReverseStream(
                        req,
                        if (ready) "failed to get media projection" else "foreground service not ready"
                    )
                }
            }
        } else {
            service.denyReverseStream(req, "denied by user")
        }
    }

    // 键鼠控制中的提示（对端拒绝 / 断连 / 会话结束原因）：danger 级
    LaunchedEffect(inputMessage) {
        if (inputMessage.isNotEmpty()) {
            board.danger(inputMessage)
            service.clearInputMessage()
        }
    }

    // 对端请求确认框必须挂在 early return 之前（线 2 走查 2026-11-03
    // 踩到的 bug）：控制会话激活时下面整屏切到触控板并 return，挂在
    // 后面的确认框永远到不了组合——反向投屏请求在触控板页等 90 秒
    // 过去直接 expired，桌面窗口只看到“反向投屏失败：expired”。
    // 两个框都是 Dialog（独立窗口），放这里一样盖在触控板之上。
    // ---------- 反向投屏请求：电脑想看本机屏幕（线 2 W7） ----------
    // 未信任设备每次请求都要过这道确认 + 系统录屏授权框；拒绝/取消都明确回绝，
    // 桌面窗口显示原因。90 秒无人确认由服务侧 TTL 自动拒绝
    //（覆盖 LinkSpace 同意框 + 系统录屏授权框两次确认）。
    // 信任设备（Bug 2：确认框里勾过“信任此设备”）跳过 LinkSpace 确认框，
    // 直接进系统录屏授权框——系统框跳不过，也不绕过。
    val reverseTrusted = reverseRequest?.let { service.isNoConfirmTrusted(it.peerId) } ?: false
    LaunchedEffect(reverseRequest) {
        val req = reverseRequest
        if (req != null && service.isNoConfirmTrusted(req.peerId)) {
            captureRequest = req
            val manager =
                context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
            screenCapture.launch(manager.createScreenCaptureIntent())
        }
    }
    if (reverseRequest != null && !reverseTrusted) {
        val req = reverseRequest!!
        ReverseStreamRequestDialog(
            req = req,
            onApprove = { durationMs ->
                if (durationMs != 0L) service.grantNoConfirmTrust(req.peerId, durationMs)
                captureRequest = req
                val manager =
                    context.getSystemService(Context.MEDIA_PROJECTION_SERVICE) as android.media.projection.MediaProjectionManager
                screenCapture.launch(manager.createScreenCaptureIntent())
            },
            onDeny = { service.denyReverseStream(req, "denied by user") }
        )
    }

    // ---------- 电脑请求控制本机：确认弹窗（协议 9.1） ----------
    // 30s 内未确认由会话层自动拒绝；弹窗被划掉按拒绝处理——
    // 确认 UI 未弹出时不放行任何输入。同上，控制会话激活时
    // early return 会跳过挂在后面的框，一并提到前面。
    // 信任设备由会话层直接放行（Bug 2），到不了这里；这里只处理
    // 未信任设备的确认，选择免确认有效期随放行一起授信。
    if (controlRequest != null) {
        val req = controlRequest!!
        ControlRequestDialog(
            req = req,
            onApprove = { durationMs -> service.approveControl(req.sessionId, durationMs) },
            onDeny = { service.denyControl(req.sessionId) }
        )
    }

    // 控制会话激活时整屏切到触控板；投屏流就绪再切到投屏画面。
    // 画面窗口是 B 线范围，原样保留不动。
    // 触控板包 LinkSpaceTheme（2026-11-03 视觉重排补记）：early return
    // 在 AppNavShell 的 LinkSpaceTheme 之外，触控板此前一直吃默认
    // M3 紫色主题；只包主题，不动本段的条件与 return 逻辑。
    val screenStreamInfo by service.screenStream.collectAsStateWithLifecycle()
    if (inputState.phase == "active") {
        val ss = screenStreamInfo
        if (ss != null) {
            ScreenMirrorScreen(service, ss, clipboardEnabled, onClipboardToggle)
        } else {
            LinkSpaceTheme {
                TouchpadScreen(service)
            }
        }
        return
    }

    var currentPage by rememberSaveable { mutableStateOf(NavPage.OVERVIEW) }
    var selectedDevice by remember { mutableStateOf<DeviceDetailInfo?>(null) }

    // ---------- 本机改名 ----------
    var showRenameDialog by remember { mutableStateOf(false) }
    var nameDraft by remember { mutableStateOf("") }

    // ---------- 发送文件 ----------
    var sendTarget by remember { mutableStateOf<DiscoveredService?>(null) }
    var pendingFiles by remember { mutableStateOf<List<OutgoingFile>>(emptyList()) }
    var sending by remember { mutableStateOf(false) }

    // SAF 选文件：只回 Uri 不回路径，名字与大小在回调里一并查好，
    // 对话框展示的就是将要发送的东西，不再有第二次转换
    val pickFiles = rememberLauncherForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris ->
        if (uris.isNotEmpty()) pendingFiles = context.outgoingFiles(uris)
    }

    fun requestControl(peer: DiscoveredService) {
        val metrics = context.resources.displayMetrics
        scope.launch {
            service.requestInputControl(
                peer = peer,
                screen = InputController.Screen(
                    metrics.widthPixels.coerceAtLeast(1),
                    metrics.heightPixels.coerceAtLeast(1)
                ),
                displayName = selfName
            ).onFailure { board.danger(it.message ?: "请求失败") }
        }
    }

    /** 线 3：请求把桌面用作扩展屏（display-extend 会话，画面流接线在 3.2-1） */
    fun requestExtend(peer: DiscoveredService) {
        scope.launch {
            service.requestDisplayExtend(peer = peer)
                .onFailure { board.danger(it.message ?: "请求失败") }
        }
    }

    fun revoke(deviceId: String, displayName: String) {
        service.revokeTrust(deviceId)
        selectedDevice = null
        board.success("已撤销对 $displayName 的信任")
    }

    val versionName = remember { appVersionName(context) }
    val onlineCount = discovered.count { isOnline(it.lastSeen, now) }
    val onlineText = "在线 $onlineCount/${discovered.size}"

    BoxWithConstraints(Modifier.fillMaxSize()) {
        val isLandscape = maxWidth > maxHeight
        LinkSpaceTheme {
            AppNavShell(
                isLandscape = isLandscape,
                current = currentPage,
                onSelect = { currentPage = it },
                onlineText = onlineText,
                versionName = versionName,
            ) {
                Column(Modifier.fillMaxSize()) {
                    // 通知与会话横条：贴顶栏下，所有页可见
                    NoticeList(board)
                    if (controlledBy != null) {
                        ControlledByBanner(
                            controlledBy = controlledBy!!,
                            onTerminate = { service.terminateControl() },
                        )
                    }
                    val activeReverse = reverseStatus?.active
                    if (activeReverse != null) {
                        ReverseStreamBanner(
                            peerName = trusted.firstOrNull { it.deviceId == activeReverse.peerId }?.displayName
                                ?: activeReverse.peerId,
                            detail = "${activeReverse.width}×${activeReverse.height} · ${activeReverse.encoder}",
                            onStop = { service.stopReverseStream() },
                        )
                    }
                    Box(Modifier.weight(1f)) {
                        when (currentPage) {
                            NavPage.OVERVIEW -> OverviewPage(
                                service = service,
                                now = now,
                                board = board,
                                onClipboardToggle = onClipboardToggle,
                                onOpenAccessibilitySettings = {
                                    context.startActivity(service.accessibilitySettingsIntent())
                                },
                                onNavigateToDevices = { currentPage = NavPage.DEVICES },
                                onDeviceClick = { selectedDevice = it },
                            )
                            NavPage.DEVICES -> DevicesPage(
                                service = service,
                                now = now,
                                isLandscape = isLandscape,
                                selected = selectedDevice,
                                onSelect = { selectedDevice = it },
                                onControl = ::requestControl,
                                onExtend = ::requestExtend,
                                onSendFiles = { peer ->
                                    sendTarget = peer
                                    pickFiles.launch(arrayOf("*/*"))
                                },
                                onRevoke = ::revoke,
                                onEndControl = { service.input.stop() },
                                onTerminateControl = { service.terminateControl() },
                                onStopStream = { service.stopReverseStream() },
                                onStopExtend = { service.stopDisplayExtend() },
                            )
                            NavPage.SCREEN -> ScreenPage(service = service)
                            NavPage.FILES -> FilesPage(service = service, board = board)
                            NavPage.SETTINGS -> SettingsPage(
                                selfName = selfName,
                                fingerprintText = fingerprintText,
                                port = port,
                                clipboardEnabled = clipboardEnabled,
                                onClipboardToggle = onClipboardToggle,
                                accessibilityEnabled = accessibilityEnabled,
                                onOpenAccessibilitySettings = {
                                    context.startActivity(service.accessibilitySettingsIntent())
                                },
                                onRenameClick = {
                                    nameDraft = selfName
                                    showRenameDialog = true
                                },
                                onExitConfirm = {
                                    cn.linkspace.client.service.LinkSpaceForegroundService.exit(context)
                                    (context as? android.app.Activity)?.finish()
                                },
                                versionName = versionName,
                                trustedNoConfirm = trusted.filter {
                                    service.isNoConfirmTrusted(it.deviceId)
                                },
                                onSetNoConfirmDuration = { deviceId, durationMs ->
                                    service.grantNoConfirmTrust(deviceId, durationMs)
                                    board.success("已更新免确认有效期")
                                },
                                allTrustedDevices = trusted,
                                onRevokeNoConfirm = { deviceId ->
                                    val name = trusted.firstOrNull { it.deviceId == deviceId }?.displayName
                                        ?: deviceId
                                    service.revokeNoConfirmTrust(deviceId)
                                    board.success("已撤销对 $name 的信任，下次再弹确认框")
                                },
                                onClearNoConfirm = {
                                    service.clearNoConfirmTrust()
                                    board.success("已清空信任清单，下次全部重新确认")
                                },
                                streamMode = streamMode,
                                onSelectStreamMode = { mode ->
                                    service.setStreamMode(mode)
                                    board.success("串流模式已切换")
                                },
                            )
                        }
                    }
                }
            }

            // ---------- 设备详情 Sheet（竖屏；横屏用设备页右侧详情列） ----------
            if (!isLandscape && selectedDevice != null) {
                val info = selectedDevice!!
                DeviceDetailSheet(
                    info = info,
                    onDismiss = { selectedDevice = null },
                    onControl = ::requestControl,
                    onExtend = ::requestExtend,
                    onSendFiles = { peer ->
                        selectedDevice = null
                        sendTarget = peer
                        pickFiles.launch(arrayOf("*/*"))
                    },
                    onRevoke = ::revoke,
                    onEndControl = { service.input.stop() },
                    onTerminateControl = { service.terminateControl() },
                    onStopStream = { service.stopReverseStream() },
                    onStopExtend = { service.stopDisplayExtend() },
                )
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
                                        .onSuccess { board.success("已向 ${target.displayName} 发送 $it 个文件") }
                                        .onFailure { board.danger(it.message ?: "发送失败") }
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

            // ---------- 等待对端确认控制请求（B 线：补 30 秒倒计时展示） ----------
            if (inputState.phase == "waiting") {
                WaitingControlDialog(onCancel = { service.input.stop() })
            }

            // 反向投屏请求确认框已提到 early return 之前（见上），
            // 控制会话激活时触控板页也能弹出；此处不再重复挂载。
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
                                        board.success("已改名为「$clean」")
                                        showRenameDialog = false
                                    }
                                    .onFailure { board.danger(it.message ?: "改名失败") }
                            }
                        ) { Text("确定") }
                    },
                    dismissButton = {
                        OutlinedButton(onClick = { showRenameDialog = false }) { Text("取消") }
                    }
                )
            }

            // 电脑请求控制本机确认框已提到 early return 之前（见上），
            // 此处不再重复挂载。
        }
    }
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
