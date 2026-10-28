package cn.linkspace.client.service

import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.net.wifi.WifiManager
import android.util.Log
import java.net.InetAddress
import java.util.concurrent.ConcurrentHashMap

/**
 * mDNS 设备发现。
 *
 * 用系统 NsdManager 而不是自己实现 multicast-dns：Android 原生支持，
 * 不需要额外权限（只要能收组播），且与桌面端的 `_linkspace._tcp` 互通。
 *
 * 注意两点：
 *   1. 收组播需要 WifiManager.MulticastLock，否则很多设备上 discovery 静默失败
 *   2. NsdManager 的 onServiceLost 只在收到 goodbye 时触发，设备直接断网时没有，
 *      所以保留「超过阈值未再见即移除」的软过期
 */
class Discovery(private val context: Context) {

    private val nsd = context.getSystemService(Context.NSD_SERVICE) as NsdManager
    private val wifi = context.applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager
    private var multicastLock: WifiManager.MulticastLock? = null

    private val seen = ConcurrentHashMap<String, DiscoveredService>()
    private val listeners = mutableListOf<(List<DiscoveredService>) -> Unit>()

    @Volatile
    private var running = false

    /**
     * 每次解析都要新建 listener：NsdManager 的 ResolveListener 同时只能
     * 服务于一次 resolve，复用会抛 "listener already in use"，
     * 表现为「发现了设备但永远拿不到地址」。
     */
    private fun newResolveListener(): NsdManager.ResolveListener = object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, errorCode: Int) {
            Log.w(TAG, "解析服务失败 ${info.serviceName}: $errorCode")
        }

        override fun onServiceResolved(info: NsdServiceInfo) {
            val host: InetAddress = info.host ?: return
            val attrs = info.attributes ?: emptyMap()
            val idPrefix = attrs["id"]?.let { String(it) } ?: ""
            // 自己的通告要跳过：ID 前缀相同即本机
            if (idPrefix.isNotEmpty() && idPrefix == LinkSpaceService.deviceIdPrefix) return

            val svc = DiscoveredService(
                serviceName = info.serviceName,
                displayName = info.serviceName.removePrefix("LinkSpace-"),
                idPrefix = idPrefix,
                deviceType = attrs["type"]?.let { String(it) } ?: "unknown",
                caps = (attrs["caps"]?.let { String(it) } ?: "").split(',').filter { it.isNotBlank() },
                host = host.hostAddress ?: return,
                port = info.port,
                paired = attrs["paired"]?.let { String(it) } == "1"
            )
            seen[svc.serviceName] = svc
            notifyListeners()
        }
    }

    private val discoveryListener = object : NsdManager.DiscoveryListener {
        override fun onDiscoveryStarted(serviceType: String) {
            Log.i(TAG, "mDNS 发现已启动: $serviceType")
        }

        override fun onDiscoveryStopped(serviceType: String) {
            Log.i(TAG, "mDNS 发现已停止")
        }

        override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {
            Log.e(TAG, "启动发现失败: $errorCode")
        }

        override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {
            Log.e(TAG, "停止发现失败: $errorCode")
        }

        override fun onServiceFound(info: NsdServiceInfo) {
            // resolve 是异步的，且必须对每个新发现的服务各做一次
            runCatching { nsd.resolveService(info, newResolveListener()) }
                .onFailure { Log.w(TAG, "resolveService 抛错: ${it.message}") }
        }

        override fun onServiceLost(info: NsdServiceInfo) {
            seen.remove(info.serviceName)
            notifyListeners()
        }
    }

    private val registrationListener = object : NsdManager.RegistrationListener {
        override fun onRegistrationFailed(info: NsdServiceInfo, errorCode: Int) {
            Log.e(TAG, "注册服务失败: $errorCode")
        }

        override fun onUnregistrationFailed(info: NsdServiceInfo, errorCode: Int) {
            Log.e(TAG, "注销服务失败: $errorCode")
        }

        override fun onServiceRegistered(info: NsdServiceInfo) {
            Log.i(TAG, "已通告本机服务: ${info.serviceName}")
        }

        override fun onServiceUnregistered(info: NsdServiceInfo) {
            Log.i(TAG, "已撤销本机服务通告")
        }
    }

    /** 通告本机存在。TXT 记录只含公开非身份信息 */
    fun advertise(port: Int, caps: List<String>, paired: Boolean) {
        val info = NsdServiceInfo().apply {
            serviceName = "LinkSpace-${LinkSpaceService.displayName}"
            serviceType = Protocol.SERVICE_TYPE
            setPort(port)
            // NsdManager 的 TXT 值不能含 '=' 且总长受限，保持简短。
            // 注意 API 收的是 String 而非 ByteArray。
            setAttribute("id", LinkSpaceService.deviceIdPrefix)
            setAttribute("type", LinkSpaceService.deviceType)
            setAttribute("caps", caps.joinToString(","))
            setAttribute("paired", if (paired) "1" else "0")
        }
        nsd.registerService(info, NsdManager.PROTOCOL_DNS_SD, registrationListener)
    }

    fun stopAdvertising() {
        runCatching { nsd.unregisterService(registrationListener) }
    }

    fun start() {
        if (running) return
        running = true
        // 没有组播锁，NsdManager 在部分设备上收不到任何应答
        multicastLock = wifi.createMulticastLock("linkspace-mdns").apply {
            setReferenceCounted(false)
            acquire()
        }
        nsd.discoverServices(Protocol.SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discoveryListener)
    }

    fun stop() {
        if (!running) return
        running = false
        runCatching { nsd.stopServiceDiscovery(discoveryListener) }
        runCatching { multicastLock?.release() }
        multicastLock = null
        seen.clear()
    }

    fun current(): List<DiscoveredService> = seen.values.sortedBy { it.displayName }

    fun onChange(cb: (List<DiscoveredService>) -> Unit) {
        listeners.add(cb)
    }

    private fun notifyListeners() {
        val snapshot = current()
        listeners.forEach { it(snapshot) }
    }

    companion object {
        private const val TAG = "LinkSpace/Discovery"
    }
}
