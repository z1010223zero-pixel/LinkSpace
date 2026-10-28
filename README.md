# LinkSpace

> 让电脑、手机和平板像同一个工作空间中的不同终端一样协作。

局域网内的多设备协作工具：**设备发现与配对、双向文件传输、手机投屏与控制、跨设备键鼠共享**，远期目标是把 Android 平板变成 Windows 真正的第二块显示器。

第一版不依赖任何云服务器，无账号、无遥测。

---

## 当前状态

**阶段 1：桌面原型 —— 已完成（2026-10-28）**

- [x] 项目结构与设计文档
- [x] 第三方许可证核实（主要项）
- [x] scrcpy 环境搭建与自动化验证（采集 / 无线 / 多设备 / 退出码）
- [x] Electron 桌面原型：设备列表界面 + 投屏会话管理（`apps/desktop`）
- [x] ADR-001 复审：Electron 37.10.3，340 MB 内存，继续采用

**阶段 2：文件共享与配对 —— 进行中**

- [x] 设备身份证书与 TLS 数据面（自签 + 指纹）
- [x] 分块传输核心：进度 / 取消 / 断点续传 / 整体 SHA-256 校验 / 不覆盖命名
- [x] 文件传输无头环路测试，21 项断言全过（含 1 GB，≈68.5 MB/s）
- [ ] 局域网设备发现（mDNS）与配对授权 ← 下一步
- [ ] 控制通道（WebSocket）：`transfer.offer` / `accept` / `cancel` 真正打通
- [ ] 传输服务仅绑定局域网网卡（当前为 `0.0.0.0`）
- [ ] scrcpy 人工验证项（鼠标键盘 / 中文输入 / 剪贴板 / 断网）
- [ ] Windows IddCx 虚拟显示器验证（阻塞：本机未装 VS + WDK）
- [ ] 发行路线确定（开源 vs 保留闭源选项）

文件传输的已验证范围与缺口见 [`docs/mvp-acceptance.md`](docs/mvp-acceptance.md) 第 4.11 节。
跑桌面端见 [`apps/desktop/README.md`](apps/desktop/README.md)（含 5 个本机环境踩坑与解法）。

---

## 目录结构

```
apps/
├── desktop/            Electron + Vue 3 + TS 桌面端
└── android/            Kotlin + Compose 客户端
modules/
├── device-management/  设备注册表、信任关系、会话生命周期
├── protocol/           发现、控制通道、消息定义
├── file-transfer/      HTTPS 分块传输、校验与恢复
├── clipboard/          剪贴板同步
├── scrcpy-adapter/     Android 投屏与控制适配
└── input-sharing/      键鼠共享适配
native/
├── windows-helper/     Windows 原生辅助能力
└── virtual-display/    IddCx 虚拟显示器（独立验证）
docs/                   设计文档
```

各模块职责边界见 `docs/architecture.md`。

---

## 文档索引

| 文档 | 内容 |
|---|---|
| [`docs/architecture.md`](docs/architecture.md) | 分层、进程模型、端口规划、状态机、适配层接口、ADR |
| [`docs/protocol.md`](docs/protocol.md) | 通信协议 v0 草案：消息定义、文件传输子协议、错误码 |
| [`docs/mvp-acceptance.md`](docs/mvp-acceptance.md) | 可执行的分组验收清单与发布门限 |
| [`docs/threat-model.md`](docs/threat-model.md) | 资产、信任边界、威胁与缓解 |
| [`docs/license-inventory.md`](docs/license-inventory.md) | 依赖许可证核实结论与合规检查表 |
| [`docs/roadmap.md`](docs/roadmap.md) | 阶段划分、门限与转向判据 |
| [`docs/technical-validation.md`](docs/technical-validation.md) | 第 1 周验证清单与记录模板 |

---

## 开发原则

1. 局域网不等于可信——发现不等于授权，所有控制必须显式确认。
2. 能通过成熟独立程序实现的能力，不立即重写。
3. 需要形成差异化的产品层（设备管理、工作空间、配对授权）自研。
4. 高风险的底层能力（虚拟显示器）独立验证，失败不拖垮主进度。
5. **许可证问题在深度复用之前解决，不在发布之前解决。**

---

## 许可证

待定。发行路线（开源优先 / 保留闭源商业选项）尚未确定，这直接影响可复用哪些第三方代码，详见 `docs/license-inventory.md`。在结论确定前，仓库不附加 LICENSE 文件。
