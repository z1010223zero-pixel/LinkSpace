package cn.linkspace.client.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.IBinder
import cn.linkspace.client.MainActivity

/**
 * 前台服务：持有 LinkSpace 服务的运行声明。
 *
 * 没有它，应用切后台后进程随时被系统回收，局域网里的对端会看到本机
 * 「随时消失」——发现、配对、传输、键鼠会话全部中断，与「随时可被
 * 发现」的产品意图矛盾（全项目审查 P2、分工文档 B-任务③）。
 *
 * 退出语义（用户可预期）：
 *   - 用户在界面上点「退出」→ [LinkSpaceService.stopAll] 断开所有连接
 *     （控制会话、传输、剪贴板同步全部终止），前台服务随之停止；
 *   - 用户从最近任务划掉 / 系统杀进程 → 进程连同服务一起消失，
 *     对端按断连处理。不存在「界面没了但连接还在」的中间态。
 */
class LinkSpaceForegroundService : Service() {

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        if (intent?.action == ACTION_EXIT) {
            LinkSpaceService.get(this).stopAll()
            stopSelf()
            return START_NOT_STICKY
        }

        val manager = getSystemService(NotificationManager::class.java)
        manager?.createNotificationChannel(
            NotificationChannel(CHANNEL_ID, "LinkSpace 服务", NotificationManager.IMPORTANCE_LOW).apply {
                description = "保持局域网内可被发现与连接"
                setShowBadge(false)
            }
        )
        val contentIntent = PendingIntent.getActivity(
            this, 0,
            Intent(this, MainActivity::class.java),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT
        )
        val notification: Notification = Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("LinkSpace 运行中")
            .setContentText("局域网内可被发现。点「退出」可彻底下线。")
            .setSmallIcon(android.R.drawable.stat_notify_sync_noanim)
            .setContentIntent(contentIntent)
            .setOngoing(true)
            .build()
        // 前台服务类型：平时只有 dataSync（局域网传输与控制会话）；
        // 反向投屏授权后升级为 dataSync|mediaProjection（线 2 W7）——
        // targetSdk 35 下录屏退后台必须由该类型承接，否则录屏即停。
        // 升级只在用户同意录屏后发生（见 startMediaProjection），平时不占该类型。
        val types = if (intent?.action == ACTION_START_MEDIA_PROJECTION) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
        startForeground(NOTIFICATION_ID, notification, types)
        return START_STICKY
    }

    companion object {
        private const val CHANNEL_ID = "linkspace-service"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_EXIT = "cn.linkspace.client.EXIT"
        private const val ACTION_START_MEDIA_PROJECTION = "cn.linkspace.client.START_MEDIA_PROJECTION"

        /** 界面 onCreate 时调用：随应用启动即进入前台保活 */
        fun start(context: Context) {
            val intent = Intent(context, LinkSpaceForegroundService::class.java)
            context.startForegroundService(intent)
        }

        /**
         * 反向投屏授权后升级前台服务类型（线 2 W7）：调用方是
         * LinkSpaceService.prepareReverseStreamCapture，须在用户于系统
         * 录屏授权框点允许之后、getMediaProjection() 之前调用（官方顺序）。
         * 只是重发一次 start 命令，服务不重启、通知不变。
         */
        fun startMediaProjection(context: Context) {
            val intent = Intent(context, LinkSpaceForegroundService::class.java)
                .setAction(ACTION_START_MEDIA_PROJECTION)
            context.startForegroundService(intent)
        }

        /** 用户主动退出：断开所有连接并停掉前台服务 */
        fun exit(context: Context) {
            val intent = Intent(context, LinkSpaceForegroundService::class.java)
                .setAction(ACTION_EXIT)
            context.startService(intent)
        }
    }
}
