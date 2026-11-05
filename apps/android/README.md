# apps/android — LinkSpace Android 客户端

Kotlin + Jetpack Compose。支持设备发现与配对、双向文件高速分块传输、双向剪贴板同步、跨端双向投屏与对称控制（平板控制电脑 + 电脑控制平板），具备系统级无障碍手势注入与自研 H.264 硬件/软解双向视频流。

## 职责

- 广播自身存在（mDNS）并响应配对
- 文件传输的接收与发送端（分块并发、断点续传）
- 剪贴板双向同步（带回环抑制）
- 键鼠共享的控制端（平板→电脑触控板与全屏投屏，协议 4.6）
- 键鼠共享的被控端（电脑→平板无障碍手势与按键注入、锁屏唤醒上滑解锁，协议 4.6）
- 双向高清低延迟投屏与解码（自研 libavcodec / libswscale + MediaProjection 软硬编解码）
- 前台服务保活与「用户退出 = 彻底下线」语义
- 扩展屏幕的接收端（P2）

## 核心设计

- **自研双向视频流**：桌面端推流经裸 H.264 由 Android 客户端多线程切片解码；平板端经 MediaProjection + MediaCodec 实时编码回推至电脑窗口。
- **无障碍输入注入**：被控时由 `LinkSpaceAccessibilityService` 负责手势分发、按键注入与锁屏自动解锁，无需 root。
- **免确认有效期与录屏保活**：支持配置免确认时长，跨会话缓存录屏令牌，秒级无感重连。

## 设备角色差异（方案 2.3）

| | 手机 | 平板 |
|---|---|---|
| 投屏 | 支持（经 scrcpy） | 不适用 |
| 文件 / 剪贴板 | 支持 | 支持 |
| 远控电脑（触控板） | 支持 | 支持 |
| 扩展显示接收 | 不适用 | 目标能力（P2） |

## 状态

**收发 + 远控 + 安全基线已实现（2026-10-29，Agent B）**。与全项目审查
（`docs/project-review-2026-10-29.md`）对应的修复全部落地：TLS 指纹钉住
（P0-1）、服务端索证 + 指纹闸门 + 定向 accept + revoke 校验（P0-2）、
先鉴权后读体 + 32MiB 上限（P0-3）、文件名收敛（P1-4）、配对码 CSPRNG +
错误上限 + 挂起上限（P1-5）、块摘要必校验 + 整体摘要必带（P1-6）、
cancel/complete 绑定连接身份（P1-7）、组合键百分号编码（P1-8）、
配对码不再进 logcat、前台服务保活（P2）。

### 进展（2026-11-05 最新）

- **双向免确认有效期与长效录屏**：支持用户自选免确认控制时长；反向推流结束时复用 `MediaProjection` 与 `VirtualDisplay`，有效期内电脑二次发起投屏时零弹窗秒开。
- **锁屏唤醒与自动上滑解锁**：配置 `WAKE_LOCK`、`DISABLE_KEYGUARD` 与 `showWhenLocked`，被控启动时无障碍服务自动点亮屏幕并注入上滑手势解除锁屏。
- **原生 libswscale 解码与 120Hz 触控直通**：StreamDecoder 启用 4 线程 `FF_THREAD_SLICE` 并行解码与原生 libswscale NEON 零拷贝，单帧转换耗时由 ~45ms 降至 ~1.5ms；触控以 8ms 节流合并下发并本地即时刷新光标。

---

## 构建环境

本机没有 Android Studio，工具链装在 `.toolchain/`（已加入 `.gitignore`）：

```bash
export JAVA_HOME="/c/Program Files/Java/jdk-22"
export ANDROID_HOME="/d/test/testforai/LinkSpace/.toolchain/android-sdk"
# 环境里另有 ANDROID_SDK_ROOT=D:\document\Android\sdk，两者不一致会让
# Gradle 直接拒绝构建，必须一起指到 .toolchain
export ANDROID_SDK_ROOT="$ANDROID_HOME"
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
├── LinkSpaceClient.kt       客户端角色（发送/远控连出），TLS 握手后按信任清单钉指纹
├── InputController.kt       键鼠共享控制端状态机，镜像桌面 input/session.ts
├── LinkSpaceForegroundService.kt  前台服务：保活 + 退出语义
└── LinkSpaceService.kt      编排层，对应桌面端 host.ts
```

### 为什么自己写 HTTPS/WS 服务而不用 NanoHTTPD

控制通道必须与文件传输**共用同一个 TLS 端口**（ADR-003）。NanoHTTPD 的 HTTPS
API 要求从一个 KeyStore InputStream 构造，而我们的证书是运行时生成的，
需要额外序列化一层；协议本身只有几条路由，自己实现更可控也更容易审查。

代价是要自己维护 HTTP/1.1 解析与 WS 帧编解码。**纯逻辑部分已有 JVM 单测**
（`app/src/test/`，`gradle :app:testDebugUnitTest` 运行）：

- `ClipboardSyncTest`——回环抑制全套：启动基线、抑制窗口、窗口外不回发、
  大小上限、停止语义（两端互推的防线，语义与桌面端同款）
- `InputControllerTest`——键鼠控制端状态机：事件编码钳制、来源校验
  （旁观连接不得操作别人的会话）、sessionId 匹配、64 条批次上限、断连清理
- `ProtocolTest`——数据面组合键编解码往返（空格 `%20`、加号 `%2B`）、
  与桌面端冻结的常量对账
- `TransferServerStaticTest`——文件名清洗（路径穿越拒绝）、URL 解码、SHA-256

线程相关（WS 帧编解码、连接循环）仍以真机联调覆盖。

---

## 已验证 / 未验证

**已验证**：见 `docs/technical-validation.md`。2026-10-29（Agent B）：
APK 构建、真机（TB710FU）安装启动、服务栈就绪、前台服务常驻（dataSync）。

**未验证**：

- 大文件接收（>100 MB）
- 断点续传在 Android 侧的行为
- 传输中途杀掉应用后的 `.part` 清理
- 多设备同时连接
- 安卓→电脑远控的全流程真机走查（需桌面端配合弹确认框，移交清单已挂）
- Android 10 以下的分区存储适配（minSdk 26，理论上覆盖）

---

## 已知限制

- 保存目录固定为 `getExternalFilesDir(null)/LinkSpace`，未做用户选择
- **剪贴板同步只在前台有效**：Android 10 起后台应用读不到剪贴板
  （不是权限问题，申请也拿不到）。因此同步挂在 `MainActivity.onResume/onPause`
  之间，退到后台就停。这是平台约束，不是缺陷。
- 远控触控板为 MVP 交互：单指移动 / 轻点单击 / 双指滚动 / 美式布局字符输入；
  IME 中文文本跳过，拖拽需用「按住拖拽」开关
- 服务端监听 `0.0.0.0`，未做来源地址门禁（与桌面端同款折中，见审查报告）

## 待定

- 无线调试的引导方式
- 远控交互的完整形态（滚轮自然方向、中键、多手势）
