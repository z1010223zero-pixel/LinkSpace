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

**核心已实现（2026-10-28）**，代码在 `apps/desktop/src/main/transfer/`：

| 文件 | 内容 |
|---|---|
| `identity.ts` | 自签设备身份证书（2048 位，10 年），DER 的 SHA-256 指纹，持久化到 userData |
| `chunker.ts` | 流式分块读写、整体/块级 SHA-256、`.part` 路径、不覆盖命名 |
| `server.ts` | HTTPS 数据面（ADR-003：与控制通道共用端口）+ 客户端，含连接复用 |
| `manager.ts` | 传输任务状态机：`offered → accepted → completed / failed / cancelled` |

数据面路由：

```
POST /linkspace/v1/transfer/:id/chunk?offset=N    写入分块
GET  /linkspace/v1/transfer/:id/chunk?offset=N    读取分块（下载方向）
```

空体 POST 视为**偏移探针**，只回报 `committedOffset`，不写盘——这是断点续传的基础。

### 实测

`npm run verify:transfer`（同进程内发送方 + 接收方，走真实 TLS + HTTPS）：

- 21 项断言全过
- 1 GB / 4 MiB 块：**14.9 s，≈68.5 MB/s**（本机环路，非真实 Wi-Fi）
- 1 GB / 64 KiB 块：116.9 s —— 每块一次往返，块大小决定吞吐，生产必须用 4 MiB

### 关键实现约束（改代码前必读）

- **偏移必须衔接**：接收方校验 `offset === 已写入字节`，不符返回 409，
  发送方重新对齐。直接追加会静默产生损坏文件。
- **空文件没有分块**：`accept()` 时必须先 `ensureFile()` 建出 `.part`，
  否则 0 字节文件在 `finalize` 的 rename 阶段 ENOENT。
- **`ensureFile` 用 `'a'` 而非 `'w'`**：断点续传时不能截断已有内容。
- **取消标记不能随 `cleanup()` 清除**：否则 `push()` 的异常分支会把
  「用户取消」误判成 `failed`。
- **取消需要通知对端**：发送方取消后接收方还留着 `.part`。目前以
  `cancelRequested` 事件暴露，接入控制通道后应改为真正的 `transfer.cancel` 消息。

### 未完成

- 设备发现与配对（因此 `isKnownDevice` 恒 false，当前不接受任何对端）
- 控制通道：`offer` / `accept` / `cancel` 消息的真实传输
- 块级摘要的接收侧校验（目前靠整体 SHA-256 兜底）
- 传输速率显示
- 绑定 `0.0.0.0` 应改为仅局域网网卡

验收项与缺口见 `docs/mvp-acceptance.md` 第 4.11 节。
