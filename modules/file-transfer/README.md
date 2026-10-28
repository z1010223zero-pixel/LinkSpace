# modules/file-transfer — 文件传输

架构 L3 层。

## 职责

- 分块上传/下载（默认块大小 4 MiB）
- 块级与整体摘要校验
- 进度回报（节流 ≥200ms）
- 取消、失败重试、断点续传
- 接收确认与覆盖保护

## 协议

消息定义见 `docs/protocol.md` 第 4.5 节与第 5 节。控制消息走 WebSocket，数据走同一 TLS 端口的 HTTPS 路由。

## 关键规则

- **接收方必须确认保存路径后才开始传输**（`transfer.accept`）
- 同名文件默认重命名，覆盖需显式确认，**绝不静默覆盖**
- 断点续传基于接收方已确认的连续偏移 `committedOffset`
- 断点信息不写历史记录

## 状态

未开始。验收项见 `docs/mvp-acceptance.md` 第 4 组。
