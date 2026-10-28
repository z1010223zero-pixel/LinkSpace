# apps/android — LinkSpace Android 客户端

Kotlin + Jetpack Compose。**当前是接收方**：通告自身、接受配对、接收文件。
投屏与控制由桌面端 scrcpy 经 adb 完成，不经过本应用。

## 职责

- 广播自身存在（mDNS）并响应配对
- 文件传输的接收与发送端
- 剪贴板同步
- 扩展屏幕的接收端（P2）
- 被控时的可见授权提示

## 边界

- **投屏与控制不经过本客户端**：由 scrcpy 的 server 端完成。本客户端不重复实现视频采集与输入注入。
- 不实现跨设备键鼠的输入注入（第一阶段）。

## 设备角色差异（方案 2.3）

| | 手机 | 平板 |
|---|---|---|
| 投屏 | 支持（经 scrcpy） | 不适用 |
| 文件 / 剪贴板 | 支持 | 支持 |
| 扩展显示接收 | 不适用 | 目标能力（P2） |

## 状态

**接收端主体已实现（2026-10-29）**，等待真机联调。阶段 2（文件共享）才真正需要本客户端。

---

## 构建环境

本机没有 Android Studio，工具链装在 `.toolchain/`（已加入 `.gitignore`）：

```bash
export JAVA_HOME="/c/Program Files/Java/jdk-22"
export ANDROID_HOME="/d/test/testforai/LinkSpace/.toolchain/android-sdk"
export GRADLE_USER_HOME="/d/test/testforai/LinkSpace/.toolchain/gradle-home"

# 构建
/d/test/testforai/LinkSpace/.toolchain/gradle-8.10.2/bin/gradle :app:assembleDebug

# 安装到已连接设备
/d/test/testforai/LinkSpace/.toolchain/android-sdk/platform-tools/adb.exe install -r app/build/outputs/apk/debug/app-debug.apk

# 看日志
/d/test/testforai/LinkSpace/.toolchain/android-sdk/platform-tools/adb.exe logcat -s \
  LinkSpace/Service LinkSpace/Transfer LinkSpace/WS LinkSpace/Identity LinkSpace/Discovery
```

### 踩坑

- **`GRADLE_USER_HOME` 必须显式指定**。本机环境里它指向 `D:\dev\gradle`，不可写，
  Gradle 直接报 `journal-1.lock (拒绝访问)`。指到 `.toolchain/gradle-home` 即可。
- **Gradle 官方源 TLS 吊销检查失败**（`CRYPT_E_REVOCATION_OFFLINE`）。
  用腾讯云镜像：`https://mirrors.cloud.tencent.com/gradle/gradle-8.10.2-bin.zip`。
- **mDNS 必须拿组播锁**：`WifiManager.MulticastLock`。不加的话 NsdManager
  在部分设备上静默收不到任何应答，且不报错。
- **TLS 证书要运行时生成并持久化**：Android 没有公开的「从 Keystore 密钥签自签证书」
  API，用 BouncyCastle（`bcpkix`）。系统内置的 BC 是重打包内部类，不能依赖。

---

## 架构

```
service/
├── Protocol.kt              协议常量与消息模型，字段与桌面端逐字对应
├── Identity.kt              自签证书 + SHA-256 指纹（BouncyCastle，持久化到 filesDir）
├── TrustStore.kt            信任清单，语义与桌面端 transfer/trust.ts 一致
├── Discovery.kt             mDNS 通告与浏览（系统 NsdManager）
├── WebSocketConnection.kt   最小 WebSocket 服务端（RFC 6455 子集）
├── TransferServer.kt        HTTPS 数据面 + 控制通道，共用同一端口
└── LinkSpaceService.kt      编排层，对应桌面端 host.ts
```

### 为什么自己写 HTTPS/WS 服务而不用 NanoHTTPD

控制通道必须与文件传输**共用同一个 TLS 端口**（ADR-003）。NanoHTTPD 的 HTTPS
API 要求从一个 KeyStore InputStream 构造，而我们的证书是运行时生成的，
需要额外序列化一层；协议本身只有几条路由，自己实现更可控也更容易审查。

代价是要自己维护 HTTP/1.1 解析与 WS 帧编解码——**这部分最需要测试覆盖**，
目前只有真机联调验证，缺单元测试。

---

## 已验证 / 未验证

**已验证**：见 `docs/technical-validation.md`。

**未验证**：

- 大文件接收（>100 MB）
- 断点续传在 Android 侧的行为
- 传输中途杀掉应用后的 `.part` 清理
- 多设备同时连接
- Android 10 以下的分区存储适配（minSdk 26，理论上覆盖）

---

## 已知限制

- **只做接收方**：不主动连接桌面端推送文件
- 保存目录固定为 `getExternalFilesDir(null)/LinkSpace`，未做用户选择
- 界面没有发送文件的入口
- 无前台服务，应用被切到后台可能被系统回收导致传输中断

## 待定

- 是否需要常驻前台服务（影响保活与兼容性）
- 无线调试的引导方式
