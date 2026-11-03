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
import java.util.concurrent.atomic.AtomicBoolean

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
            this,
            0,
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

        val isMediaProjection = intent?.action == ACTION_START_MEDIA_PROJECTION
        val types = if (isMediaProjection) {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC or
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION
        } else {
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
        }
        startForeground(NOTIFICATION_ID, notification, types)
        mediaProjectionReady.set(isMediaProjection)
        return START_STICKY
    }

    companion object {
        private const val CHANNEL_ID = "linkspace-service"
        private const val NOTIFICATION_ID = 1
        private const val ACTION_EXIT = "cn.linkspace.client.EXIT"
        private const val ACTION_START_MEDIA_PROJECTION =
            "cn.linkspace.client.START_MEDIA_PROJECTION"

        private val mediaProjectionReady = AtomicBoolean(false)

        /** Activity 拿到系统授权后，等前台服务完成 mediaProjection 升级再取 token */
        fun awaitMediaProjectionReady(timeoutMs: Long = 1000L): Boolean {
            val deadline = System.currentTimeMillis() + timeoutMs
            while (System.currentTimeMillis() < deadline) {
                if (mediaProjectionReady.get()) return true
                Thread.sleep(10)
            }
            return mediaProjectionReady.get()
        }

        fun start(context: Context) {
            val intent = Intent(context, LinkSpaceForegroundService::class.java)
            context.startForegroundService(intent)
        }

        fun startMediaProjection(context: Context) {
            val intent = Intent(context, LinkSpaceForegroundService::class.java)
                .setAction(ACTION_START_MEDIA_PROJECTION)
            context.startForegroundService(intent)
        }

        fun exit(context: Context) {
            val intent = Intent(context, LinkSpaceForegroundService::class.java)
                .setAction(ACTION_EXIT)
            context.startService(intent)
        }
    }
}
