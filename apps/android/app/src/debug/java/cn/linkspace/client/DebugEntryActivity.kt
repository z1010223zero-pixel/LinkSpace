package cn.linkspace.client

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * 仅 debug 构建的无界面驱动入口（src/debug 源集，不进 release）。
 *
 * 为什么不用广播：部分 ROM（实测 ZUI）会延迟/丢弃发给应用的广播，
 * 且时机飘忽。Activity 启动不受该管控影响，`am start` 直达。
 * Theme.NoDisplay 让它不闪界面，处理完立即 finish。
 *
 * 用法（adb）：
 *   am start -n cn.linkspace.client/.DebugEntryActivity \
 *     -a cn.linkspace.client.DEBUG_REQUEST_INPUT --es prefix dev_xxx
 *   am start ... -a cn.linkspace.client.DEBUG_SEND_EVENTS --es kind move|click|wheel|key
 *   am start ... -a cn.linkspace.client.DEBUG_STOP_INPUT
 *   am start ... -a cn.linkspace.client.DEBUG_SEND_FILE \
 *     --es prefix dev_xxx --es host 192.168.x.x --ei port 1234 --es path /path/to/file
 *   am start ... -a cn.linkspace.client.DEBUG_AUTO_ACCEPT --ez on true
 */
class DebugEntryActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        handle(intent)
        finish()
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        handle(intent)
    }

    private fun handle(intent: Intent?) {
        android.util.Log.i("LinkSpace/Debug", "DebugEntry 收到 action=${intent?.action}")
        if (intent?.action != null) {
            try {
                DebugDriver.handle(this, intent)
            } catch (t: Throwable) {
                android.util.Log.e("LinkSpace/Debug", "handle 失败", t)
            }
        }
    }
}
