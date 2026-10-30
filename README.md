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

**阶段 2：文件共享与配对 —— 已完成（2026-10-29）**

- [x] 设备身份证书与 TLS 数据面（自签 + 指纹）
- [x] 分块传输核心：进度 / 取消 / 断点续传 / 整体 SHA-256 校验 / 不覆盖命名
- [x] 局域网设备发现（mDNS，`_linkspace._tcp`，与 Android NSD 双向互通）
- [x] 配对与信任清单：配对码人工确认、信任持久化、随时撤销（撤销即断连并级联取消挂起任务）
- [x] 控制通道（WebSocket over TLS，与文件传输共用端口）
- [x] 无头验证扩到十套（verify / transfer / pairing / e2e / layout / net / heartbeat / clipboard / input / mdns），端到端跑通「发现 → 配对 → 传输 → 取消 → 剪贴板」
- [x] 监听地址自动收窄 + 来源地址门禁：唯一局域网 IPv4 时绑定之，多网卡回落 `0.0.0.0`（`LINKSPACE_BIND_IP` 可指定）；入站来源不属于局域网 / 链路本地 / ULA 范围在 TLS 握手阶段断开（`verify:net`）
- [x] Android 客户端（Kotlin + Compose）主体完成并经真机验证：发现、配对、双向文件、双向剪贴板、安卓→电脑远控
- [x] 两轮代码审查与安全修复（见 [`docs/desktop-review-2026-10-29.md`](docs/desktop-review-2026-10-29.md) 与 [`docs/project-review-2026-10-29.md`](docs/project-review-2026-10-29.md)）：身份锚定到 TLS 证书（无证书冒充已修）、数据面 token / 块摘要、路径穿越、撤销级联
- [x] Windows NSIS 安装包 + SBOM 生成链路（`npm run dist` / `npm run sbom`），安装版冒烟（防火墙授权、菜单退出）通过

**阶段 3：体验完善 —— 主体已完成（2026-10-29，f423ea4）**

- [x] 剪贴板同步（文本，双向，回环抑制，512 KiB 上限；开关持久化且默认关）
- [x] 跨电脑键鼠共享：Windows ↔ Windows 边缘穿越、被控确认弹窗与状态条、断线即恢复本机输入
- [x] 安卓→电脑远控（平板作触控板，桌面被控端，协议 4.6）
- [x] 控制通道 maxPayload 与消息限频（`verify:heartbeat` 洪泛用例钉死）
- [ ] scrcpy 窗口内输入（鼠标键盘 / 中文输入法）与断网恢复仍待人工走查（[`docs/scrcpy-manual-checklist.md`](docs/scrcpy-manual-checklist.md)）
- [ ] 多显示器副屏贴边误触发等 P3 残余（见审查报告 2.4 节）

**阶段 4 前置：IddCx 虚拟显示器 —— PoC 进行中**

- [x] EWDK 环境下驱动构建与测试签名（2026-10-30，独立 PoC，不进主构建）
- [ ] 安装验证（technical-validation 3.2.1 / 3.2.2）——需管理员授权与重启，暂缓

**发行路线**：已定 GPL-2.0/3.0（决策记录见 [`docs/license-inventory.md`](docs/license-inventory.md)），LICENSE 文件尚未落地。

已验证范围与缺口见 [`docs/mvp-acceptance.md`](docs/mvp-acceptance.md)。
跑桌面端见 [`apps/desktop/README.md`](apps/desktop/README.md)（含 5 个本机环境踩坑与解法）。
阶段 3 真机人工走查清单见 [`docs/manual-walkthrough-stage3.md`](docs/manual-walkthrough-stage3.md)。

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
| [`docs/desktop-review-2026-10-29.md`](docs/desktop-review-2026-10-29.md) | 桌面端代码审查与修复报告（安全缺口 / 修复方式 / 验证结论） |
| [`docs/project-review-2026-10-29.md`](docs/project-review-2026-10-29.md) | 第二次全项目审查报告（桌面 / Android 首审 / 文档一致性 / 修复优先级） |
| [`docs/manual-walkthrough-stage3.md`](docs/manual-walkthrough-stage3.md) | 阶段 3 真机人工走查清单（键鼠 / 边缘穿越 / 断线安全 / 剪贴板） |
| [`docs/agent-division.md`](docs/agent-division.md) | 双 Agent 分工、协议契约与移交清单（共享文件） |

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
