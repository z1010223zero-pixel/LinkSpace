# Agent B 开发计划（移动域 · 2026-10-30）

> 依据：`docs/agent-division.md`（B 任务线 + 资源规则）、`docs/project-review-2026-10-29.md`
> （Android 端 P0×3 / P1×5 / P2×6 / P3×8）、`docs/roadmap.md`（阶段门限）。
> 执行模式：无人自主。每条任务线完成即验证、提交、rebase、合并 master、push；
> 跨域事项只进 `agent-division.md` §6 移交清单，不动 A 领地。

---

## 0. 状态基线（本计划起点）

已完成并合入 master：

| 内容 | 提交 |
|---|---|
| Android P0×3 + P1×5 安全基线（指纹钉住 / 索证+闸门 / 先鉴权后读体等） | 0d0f281 |
| 安卓→电脑远控（InputController + 触控板 UI + 键盘映射） | 0d0f281 |
| 前台服务保活 + 退出语义 + README 刷新 | 0d0f281 |
| handlePairRequest 参数遮蔽吸收（对齐 A 端 15dff8a） | 38cef59 |
| TLS 服务端客户端证书放行 + 信封 §3 语义校验 | f547ba3 |
| 走查驱动接收器（仅 debug 构建）+ 移交清单进展 | e2bd219 → 本计划提交 |

远控全流程走查（2026-10-30）：**通过**。会话建立 / accept / move 坐标映射
（3200×2000 → 1920×1080 逐点核对）/ click / wheel / key / stop+releaseAll
全部在真实 TLS 链路验证。唯一未覆盖：真实手指 → MotionEvent → pointerInput
映射——ZUI 安全门屏蔽 adb 触摸注入，已用仅 debug 的广播驱动器替代验证
编解码全链路（见 DebugControlReceiver，release 不含）。

---

## 1. 任务队列（按价值 / 风险比排序）

### T1 剪贴板本地开关 + 抑制窗口同步（审查 P3，服务 mvp 第 9 组）
- Android 端加剪贴板同步开关（界面上一个 Switch），落 SharedPreferences，
  默认**关**（与桌面端 P2-1 的修复方向一致：剪贴板经过密码与令牌，默认同步
  有泄露面）。
- 修 ClipboardSync 抑制窗口的共享变量无同步问题（@Volatile / 单线程约束）。
- 验证：构建 + 真机启动；开关状态跨重启保持。

### T2 finalize 两阶段落盘（审查 P3）
- `TransferServer.finalizeTransfer` 当前逐文件「校验→改名」，第 N 个失败时
  前 N-1 个已改名——部分成功不可回滚。改为：先全部校验（大小+摘要），
  全部通过后再统一改名；任一失败则一个都不改、全部 .part 保留待查或删除。
- 验证：构建；逻辑用真机单文件/多文件接收冒烟。

### T3 死权限与死代码清理（审查 P3）
- `WRITE_EXTERNAL_STORAGE`（maxSdk 28）：落盘走 `getExternalFilesDir`
  （应用专属目录，任何 API 都不需要该权限）——删除声明。
- 清理审查点名的死字段 / 未用导入。
- `transfer.progress` 两端均未实现且无消费方（桌面进度来自 committedOffset
  响应）——不改代码，进移交清单建议 protocol.md 标注「保留未用」，
  由 A 会签。

### T4 Discovery 软过期（审查 P3，对齐桌面 sweep）
- Android 端 Discovery 缺「超过 staleMs 未再通告即判离线」的软过期扫描
  （mDNS goodbye 不可靠，桌面端 discovery.ts 有 sweep 兜底）。
- 实现：seen 表带 lastSeen，定时清扫 + onChange 回流，阈值与桌面一致 12s。
- 验证：构建 + 真机（桌面 Host 停止后平板列表应在 ~12s 内移除该条目）。

### T5 Identity 后台初始化（审查 P3，防首启 ANR）
- 首次启动在主线程做 RSA 2048 生成 + 文件 IO。移到后台线程：
  LinkSpaceService.start() 内 identity.get() 改为协程/线程预热，
  UI（指纹展示、端口）以 StateFlow 等待就绪，未就绪时显示「初始化中」。
- AndroidKeyStore 迁移是更大动作（密钥不可导出会破坏「换机迁移」语义），
  本轮只做技术评估结论写入计划附注，不动代码。

### T6 mvp-acceptance 第 6、7 组重走（分工 §8 门限）
- B 三条任务线 + 上述修复完成后，对照 mvp-acceptance.md 第 6 组（文件共享）
  / 第 7 组（剪贴板）逐项在真机 + 无头 Host 上重走，结论回写
  technical-validation.md（移动侧段落）。
- 涉及桌面 GUI 的项走移交清单请 A 错峰配合。

### T7（挂起，等 A / 用户）真机手指级触控走查
- ZUI 触摸注入门解除（设置里开「USB 调试（安全设置）」）或人工手指操作
  一次，核对轻点单击 / 双指滚动的手感与方向约定。

---

## 2. 执行纪律

1. 每条任务：实现 → 构建（assembleDebug）→ 真机冒烟 → 提交（Conventional
   Commits，中文正文讲为什么）→ rebase origin/master → 合并 master → push。
2. 推送前 `git fetch` 确认远端无 A 的新提交；有则先 rebase，冲突即越界信号，
   回移交清单处理。
3. 协议语义零单方面改动；`transfer.progress` 注记走移交。
4. 真机资源（TB710FU）B 优先，但 A 已在用时错峰；桌面 GUI 不由 B 启动。
5. 全部任务完成后：本计划文档标注逐项状态，移交清单只留跨域项。

## 3. 明确不做（本轮范围外）

- AndroidKeyStore 迁移（T5 只出评估结论）
- 滚轮自然方向 / 中键 / 多手势等触控板交互增强
- 服务端 0.0.0.0 → 单网卡绑定（Android 侧与桌面同款折中，等统一决策）
- 信封校验在桌面端的对称实现（A 领地，已在审查报告中）
