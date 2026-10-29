# LinkSpace 第三方依赖与许可证清单

> 状态：初版，2026-10-28 核实。
> 核实方式：GitHub REST API 的 `license` 字段（读取仓库 LICENSE 文件后自动判定）。
> **本文件不构成法律意见。** 正式发行前需按第 5 节流程复核，必要时请专业人士审查。

---

## 1. 已核实结论

| 项目 | 仓库 | 许可证 | 维护状态 | 最后推送 | 对 LinkSpace 的影响 |
|---|---|---|---|---|---|
| scrcpy | Genymobile/scrcpy | **Apache-2.0** | 活跃 | 2026-10-26 | 可安全集成与再分发（需履行署名与声明义务） |
| TwinDesk | InukaAsith/TwinDesk | **GPL-3.0** | 活跃（760★，创建于 2026-10-14） | 2026-10-28 | **强传染**，复用其代码将约束整体发行方式 |
| Input Leap | input-leap/input-leap | **NOASSERTION** | **已归档（archived）** | 2025-12-01 | 见下方警告 |
| Deskreen | pavlobu/deskreen | **AGPL-3.0** | 低频维护 | 2026-07-08 | 强传染（含网络交互条款），建议仅作参考 |
| deskflow | deskflow/deskflow | **GPL-2.0** | 活跃（30k★） | 2026-10-27 | Input Leap 的活跃替代品，同为强传染 |
| Barrier | debauchee/barrier | NOASSERTION | 已 fork 自 deskflow | — | 不再独立演进，不建议依赖 |

### 1.1 对方案第三节的修正建议

**方案 3.3 需要更新。** 原文建议「先验证 Input Leap」，但该仓库已归档、停止维护，且 GitHub 无法识别其许可证（通常为多许可混合或自定义文本，需人工读取 LICENSE 全文确认）。

建议改为：

- **主候选改为 deskflow**（GPL-2.0，持续维护，协议成熟）。
- 若最终不想承担 GPL 传染，**不要复用其代码**，而是只研究其边缘穿越算法与屏幕布局模型，自行实现。方案第八节列出的能力（坐标系、边缘规则、焦点切换、断线恢复）本就是需要自研的部分，自研反而更可控。
- 另一条低风险路径：**以独立进程方式调用** deskflow/Input Leap 的可执行文件，而非链接其库。但「进程调用」是否构成衍生作品存在解释空间，发行前必须做法律评估，不能默认安全。

**状态复核（2026-10-29）**：

- Deskflow 仍是最活跃的上游：v1.27.0（2026-10），GPL-2.0 含 OpenSSL 例外，
  Symless 赞助。网络协议同时兼容 Barrier 与 Synergy 1。
- **Input Leap 已彻底归档**：维护者 2026-05 宣布不再继续，仓库 2026-07 转为只读。
  作为「主候选」的可能性已经消失，只剩 Deskflow 一条 GPL 路线。
- Barrier 自 2021-11 起无发布。

自研方案（不含任何 GPL 代码）已落到 `docs/design/input-sharing.md`，
含 Windows 输入捕获/注入要点与协议草案。

### 1.2 TwinDesk 的定位重申

TwinDesk 是**最接近本项目定位**的参考实现（Electron、无云、跨 Windows/Android、含文件与剪贴板），因此诱惑也最大。但它是 GPL-3.0：

- 参考其**产品架构与交互设计**：无风险。
- 复制其**代码**：整体发行将被 GPL-3.0 约束，闭源商业发行路线基本关闭。
- 折中：只借鉴抽象设计（数据模型、消息形状），由本项目独立实现，不逐行对照改写。**注意**：即使是"对照改写"也可能被认定为衍生作品，风险不低。

建议：在明确发行路线（第 2 节）之前，不阅读其具体实现代码，只读 README、架构说明与界面截图。这是控制法律风险的实际做法，不是形式主义。

---

### 1.3 scrcpy 5.0.1 发行包实际组件（实测 2026-10-28）

逐文件列出官方 Windows 发行包内容，作为再分发时的合规依据：

| 文件 | 组件 | 版本 | 许可证 | 状态 |
|---|---|---|---|---|
| `scrcpy.exe` | scrcpy | 5.0.1 | Apache-2.0 | ✅ 已确认（LICENSE.txt 随包） |
| `scrcpy-server` | scrcpy Android 端 | 5.0.1 | Apache-2.0 | ✅ 同源，733930 B，运行时推送到设备 |
| `adb.exe` | Android Debug Bridge | 1.0.41 | Apache-2.0 | ✅ |
| `AdbWinApi.dll` / `AdbWinUsbApi.dll` | ADB Windows API | — | Apache-2.0 | ✅ |
| `SDL3.dll` | **SDL 3**（不是 SDL2） | 3.4.18 | zlib | ⚠️ 方案第四章写的是 SDL2，实际已升级为 SDL3 |
| `libusb-1.0.dll` | libusb | 1.0 | LGPL-2.1 | ⚠️ 需随包附许可证 |
| `avcodec-63.dll` | FFmpeg libavcodec | 63.1.102 | **取决于构建选项** | ⚠️ 待确认 |
| `avformat-63.dll` | FFmpeg libavformat | 63 | 同上 | ⚠️ 待确认 |
| `avutil-61.dll` | FFmpeg libavutil | 61 | 同上 | ⚠️ 待确认 |
| `swresample-7.dll` | FFmpeg swresample | 7 | 同上 | ⚠️ 待确认 |

**两个关键发现**：

1. **发行包内只有一份 Apache-2.0 的 LICENSE.txt，不含 FFmpeg / SDL3 / libusb 的许可证文本。** 再分发 LinkSpace 时必须自行补齐这些组件的许可证与版权声明，否则构成合规缺口。
2. **FFmpeg 的 LGPL/GPL 取决于构建选项。** scrcpy 官方发行版通常按 LGPL 配置构建（不含 x264 等 GPL-only 组件），但**必须核实后才能确定**，不能默认。核实方法：查看 scrcpy 官方构建配置或发布说明；或检查 avcodec 是否导出 GPL-only 编解码器。

动态链接（均为 `.dll`）对再分发相对友好，但仍需履行署名与许可证随附义务。

---

## 2. 发行路线决策（待定，阻塞多项工作）

| 路线 | 允许的复用范围 | 代价 |
|---|---|---|
| A 开源优先（GPL 兼容） | 可自由复用 TwinDesk / deskflow 代码 | 整体需开源，商业授权空间有限 |
| B 保留闭源商业发行 | 仅可复用 Apache-2.0 / MIT / BSD 类组件；GPL 系只能作**独立进程调用**或纯设计参考 | 需自研键鼠共享核心，工作量上升 |

**当前建议：默认按路线 B 推进，保留转向 A 的余地。** 理由：路线 B 是更严格的约束，按 B 做出的设计在后期转向 A 时无需返工；反之则可能需要大规模替换代码。

这条决策阻塞：`modules/input-sharing` 的实现方式选择。需在原型阶段前给出结论。

---

## 3. 待核查项

在编写任何集成代码前完成：

- [ ] **Input Leap LICENSE 全文**：读取仓库根目录 LICENSE，确认实际条款与例外（其历史上含 GPL-2 与例外声明）。
- [ ] **deskflow 许可证细节**：确认是否有例外条款或双许可选项。
- [x] **scrcpy 发行包的实际依赖**：已核实，见下方 1.3
- [x] **scrcpy server（Android 端）**：随发行版分发，733930 字节，与 scrcpy 同源（Apache-2.0）
- [x] **Electron 依赖树**：已用 `license-checker` 扫描（2026-10-29），生产依赖 54 个，全为 MIT / BSD / ISC / Apache-2.0 / 0BSD 宽松许可，见 `apps/desktop/sbom/third-party-licenses.json`。
- [ ] **Vue 及前端依赖**：已包含在上条扫描结果内（@vue/* 传递依赖），无额外缺口。
- [ ] **Android 端依赖**：Kotlin/Compose 相关库逐个记录。
- [ ] **OpenDisplay**：方案给的是文档站，需定位实际代码仓库并确认许可证后再决定是否参考。
- [ ] **Windows IddCx 示例**：微软示例代码的许可证（通常为 MIT），需确认具体示例。

---

## 4. SBOM 维护

**状态（2026-10-29）**：工具已落地。`apps/desktop` 下运行 `npm run sbom`，
用 `license-checker` 扫描生产依赖，加上 scrcpy 发行包的手工原生组件条目
（与 §1.3 逐文件核实表同步维护），输出 `apps/desktop/sbom/third-party-licenses.json`。

**最低字段**：组件名、版本、许可证 SPDX ID、来源 URL、链接方式。FFmpeg 四个
DLL 因「许可证取决于构建选项、尚未核实」如实标记 UNKNOWN，脚本会在生成时
打印警告，发布前必须消零。

**scrcpy 等原生二进制无法被 npm 工具扫描，必须手工维护**，这部分最容易遗漏，
已列入发布检查表（见 `mvp-acceptance.md` 9.6）。每次构建发布产物时重新生成，
随发布归档。

---

## 5. 发布前合规检查表

- [ ] SBOM 已生成且覆盖全部组件（含原生二进制）
- [ ] 所有 GPL/AGPL 组件已确认：未链接、未改写，或已确认接受其条款
- [ ] 安装包内实际包含的每个文件都可追溯来源
- [ ] Apache-2.0 组件的 NOTICE 文件已随附，修改处已标注
- [ ] 版权声明与许可证全文随安装包分发
- [ ] 源代码修改记录（若有）可对外提供
- [ ] 已复核二进制与其依赖的再分发条件
- [ ] 必要时已完成专业许可证审查

---

## 6. 记录规范

新增任何第三方依赖时，在本文件追加一行并注明日期与核查人。禁止先引入后补记——补记时往往已经写完了依赖它的代码，替换成本极高。
