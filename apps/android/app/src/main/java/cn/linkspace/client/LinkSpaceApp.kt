package cn.linkspace.client

import android.app.Application
import cn.linkspace.client.service.LinkSpaceService

class LinkSpaceApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 服务随进程启动而就绪：设备需要能被桌面端随时发现，
        // 不能等用户点开某个按钮才开始监听。
        LinkSpaceService.get(this).start()
    }

    override fun onTerminate() {
        LinkSpaceService.get(this).stop()
        super.onTerminate()
    }
}
