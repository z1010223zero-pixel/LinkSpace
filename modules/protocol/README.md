# modules/protocol — 通信协议

架构 L3 层。

## 职责

- mDNS 服务注册与浏览
- TLS 控制通道（WebSocket）的建连、心跳、断线处理
- 消息信封的编解码与校验
- 错误码映射

## 规范来源

**所有消息定义以 `docs/protocol.md` 为准。** 本目录只放实现，不另立规范。

## 协议定义（P0 共享层）

- `protocol.json` 是 `docs/protocol.md` 的**机器可读版**：消息类型、信封字段（类型与必填）、错误码、数值约束（会话 ID 正则、事件数上限、坐标上限、分块与剪贴板上限、配对码/心跳/时钟偏差、限频、码率与分辨率档位）全量收录于此。它不是第二份规范——**两者冲突时以 `docs/protocol.md` 为准**，JSON 只负责让机器能比对。
- `transfer.progress` 不在 `protocol.json` 里：已按 `docs/line2-line3-direction.md` §5 的决定删除（无消费方，进度走数据面 `committedOffset` 与 409 偏移对账）。
- 一致性校验：`apps/desktop/scripts/check-protocol.mjs`（无依赖，纯 node 脚本）。它用正则解析 Android 端 `Protocol.kt` / `LinkSpaceService.kt` 与桌面端 `input/protocol.ts`、`control/node.ts` 等处的常量，逐项与 `protocol.json` 比对；不一致时打印差异并以非零退出码退出。
- 在桌面端运行：`cd apps/desktop && npm run verify:protocol`（不需要 `npm install`，直接跑 node 脚本）。

## 实现要点

- 自签证书 + 指纹绑定（TOFU），首次配对需双方确认
- 拒绝明文降级
- 校验 `v` / `to` / `ts` 窗口 / `from` 已知性，任一失败即断开
- 未知消息类型安全忽略

## 状态

未开始。协议 v0 为草案，v1 发布前不保证兼容。
