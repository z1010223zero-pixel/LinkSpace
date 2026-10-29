package cn.linkspace.client

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * 仅 debug 构建的广播驱动入口（src/debug 源集，不进 release）。
 * 实现委托给 [DebugDriver]；本 ROM 实测会延迟投递广播，主要入口是
 * [DebugEntryActivity]（am start 直达），本类作为兼容备用。
 */
class DebugControlReceiver : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != null) {
            DebugDriver.handle(context, intent)
        }
    }
}
