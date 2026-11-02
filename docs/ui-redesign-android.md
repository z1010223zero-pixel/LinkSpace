# LinkSpace 安卓端 UI 重设计方案

> 分支：`decision/line2-accessibility-first`（本文档只存在于本分支，不动 master）
> 日期：2026-11-02。目标设备：联想小新平板 Pro GT（横竖屏都要能用）。
> 依据：
> - 对标调研 `~/workspace/linkspace-ui-benchmark/android-research.md`（TwinDesk / ToDesk 安卓端，公开资料 + 截图逐张看过，未在真机上安装使用过这两款应用）
> - UI 审计 `~/workspace/linkspace-ui-benchmark/android-audit.md`（分支头 `6a934a7`，`apps/android` 静态审读，23 条问题）
> - 桌面端重设计方案：本分支 `docs/ui-redesign.md`（163 行，2026-11-02）
> - 截图：`~/workspace/linkspace-ui-benchmark/images-android/`（16 张）与 `~/workspace/linkspace-ui-benchmark/images/`（桌面端 8 张）
> 原则：抄布局与信息架构，不抄品牌色与 logo；保持中文界面；只改表现层，不改协议、服务层逻辑、功能行为；不引入新依赖。

---

## 0. 结论先行

现状是全部正式 UI 挤在 `MainActivity.kt` 一个 1,493 行文件里的一页纵向滚动单栏：无导航、10 个区块平铺、发现设备与信任设备是两套长得不一样的卡片、投屏画面没有任何标题栏、界面用默认 Material3 紫色。新设计改成**横屏 80dp `NavigationRail` / 竖屏底部 `NavigationBar`** 的导航壳 + 五页（概览 / 设备 / 屏幕 / 文件 / 设置，与桌面端同名同序）；设备行统一为“状态点 + 系统图标 + 设备名 + 一行小字 + `本设备` 标签 + 行内控制中标记”；对称互控的核心是概览页的**双向方向卡**（平板→电脑 / 电脑→平板，每行一个能力 + 开关）；投屏画面补常驻标题栏（设备名 · 延迟 · 画质徽章），悬浮球保留为触控形态。品牌色沿用 LinkSpace 现有的 `#2F6BFF`，不抄 TwinDesk、ToDesk 的蓝。

**与调研稿的一处纠正**：调研 `android-research.md` §3.3 建议“横屏复用桌面端 200px 侧边栏”。审计 `android-audit.md` §4.1 纠正：小新平板 Pro GT 竖屏宽度约 800dp 级，200dp 侧栏占去四分之一宽度，横屏也挤占投屏/触控区；Material3 在平板上的规范形态是横屏 `NavigationRail`（80dp 窄轨）+ 竖屏 `NavigationBar`。**本文档以审计为准**：不搬 200px 侧边栏，导航项与桌面端五项一致，选中态用 rail/bar 的选中态指示器（`primaryContainer` 底）。

---

## 1. 对标结论：每家取什么、不取什么

### 1.1 TwinDesk 取什么

| 取什么 | 来源与截图 |
|---|---|
| **手机底部页签 / 平板左侧边栏的自适应导航**：手机底部 5 个页签（Overview、Screen、Cursor、Files、More），平板完整左侧边栏，与桌面端同款 | README "The Android app" 一节（https://github.com/InukaAsith/TwinDesk）："tabs at the bottom on a phone, a full sidebar on a tablet"；截图 `images-android/twindesk-android-phone.jpg`（5 屏拼图，已目视验证）。安卓端落地时平板侧栏按 §0 纠正改为 80dp `NavigationRail`，名称与顺序与桌面端五页一致 |
| **Overview 结构：连接状态大卡 + 按“方向 × 功能”的开关矩阵**。顶栏字标 + 对端名 + 链路与延迟（`USB · 6 ms`）；本机卡片（设备名、本机 IP、连线示意、Connected）；蓝色实心大按钮 + `Disconnect`；下方每个功能按方向独立开关，而不是一个总开关 | 截图 `images-android/twindesk-android-phone.jpg` 第一屏（已目视验证）；README "The phone app" 表格。LinkSpace 的对称互控正好需要“谁控谁、每个方向各开什么”一目了然 |
| **Screen 页分段控件 Mirror / Extend + Fastest / Smooth**，附手势说明（点按 / 长按右键 / 拖拽 / 双指滚动） | 截图 `images-android/twindesk-android-phone.jpg` 第二屏 + `images-android/twindesk-second-screen.jpg`（桌面 Share screen 设置 + 平板扩展屏实拍，已目视验证）。直接对应 LinkSpace 线 3（平板当扩展屏）与投屏画质档位；手势说明做成页内小字，不另开帮助页 |
| **链路 + 延迟常驻顶栏**，如 `6 ms · USB` / `38 ms · Bluetooth` / `3 ms · Wi-Fi` | README "Connections"、官网 "Connections" 一节；截图 `images-android/twindesk-android-phone.jpg` 第一屏。LinkSpace 桌面端已有“延迟常驻”，安卓端照做，放在顶栏同一位置（见 §6 诚实缺口：延迟字段服务层目前没有） |
| **配对引导常驻卡片**：无线调试 / 授权没配好之前，Overview 下方一直挂一张步骤卡片，配好才消失；不要只用一次性的弹窗 | README "Android in detail / Wireless debugging" 一节；截图 `images-android/twindesk-desktop-overview-pairing.jpg`（注意：这张是**桌面端** Overview，仅作配对流程对照）。对 LinkSpace“授权设置入口”有直接参考价值 |
| **系统级入口：分享菜单 + 快捷设置磁贴 + 常驻通知（带 Exit/断开）** | 截图 `images-android/twindesk-share-files.jpg`（安卓分享菜单 `Send to computer` / `Copy to computer`、收文件系统通知，已目视验证）；README "The phone app / And outside the app"。“正在被控 / 正在推流”状态要做到系统通知里去，常驻、可一键断开，而不只在应用内显示 |

### 1.2 ToDesk 取什么

| 取什么 | 来源与截图 |
|---|---|
| **“连接本设备”页结构：总开关 + 被控模式三选一 + 权限逐项引导 + 成功后安全提示**。被控端点“连接本设备”→开“允许远程本设备”→选控制模式→依次授权电话 / 录屏 / 辅助功能 / 电池白名单；开辅助功能时有悬浮窗引导动画教用户去系统设置里开无障碍服务；成功后有安全提示弹窗，点“我已知晓”才显示设备代码与连接密码 | 截图 `images-android/todesk-android-connect-this-device.png`（ToDesk 官方博客园文章配图，已目视验证）；配套流程见什么值得买安卓被控教程 https://post.smzdm.com/p/azzrqzmn/。这是“被控端授权设置入口”最完整的现成范本，LinkSpace 被控端授权设置入口照这个四层做：允许被控总开关 → 模式（控制 / 仅投屏 / 仅观看）→ 权限逐项（录屏 / 无障碍 / 电池白名单）→ 成功后安全提示 |
| **被控端确认弹窗结构：谁在连 + 倒计时 + 单次有效**。标题“是否同意「远程控制」连接”；主控账号、主控位置；勾选项“同意连接后主设备是否去解锁被控屏幕”；底部“不同意（42s）”（带倒计时）与“同意连接”；底部小字“此授权单次有效” | 截图 `images-android/todesk-android-consent-verify.png`（ToDesk 官方博客园文章配图，已目视验证）；配套机制见 ToDesk 官方博客 https://www.cnblogs.com/ToDesk-Dass/p/19327936。确认动作要落在被控端，不是主控端 |
| **设备页“快捷功能区摆第一屏”**：点进设备页，文件传输、观看模式、摄像头、终端四个入口和锁屏、重启、关机三个按钮都摆在第一屏 | 文字证据：CSDN 六维度实测对比摘要 https://blog.csdn.net/m0_73367097/article/details/169268144；火山引擎文章摘要 https://developer.volcengine.com/articles/7681254741197258758。LinkSpace 按需取：文件、观看、锁屏；重启/关机是桌面场景，平板端未必需要。桌面端布局参考见截图 `images-android/todesk-desktop-device-list-v4.8.2.png`（**桌面端** v4.8.2.0，仅供参考设备行与详情面板的信息结构） |
| **会话悬浮控件思路（只取思路，不取形态）**：会话中要有一个常驻、可拖动的最小化控件点开工具栏（画质 / 断开 / 键盘 / 旋转），不要让用户退回首页找断开 | 官方帮助中心 https://www.todesk.com/faq/22.html（“点击左侧显示的悬浮球，即可弹出工具栏”）；截图 `images-android/todesk-desktop-toolbar-floatball-1/2/3.png` 是帮助中心同一 FAQ 的三张**桌面端**插图，仅证明“悬浮球唤出工具栏”这一交互模式是 ToDesk 的官方做法。LinkSpace 可以做自己的形态，但“会话中随时可断开”这一点必须有 |

### 1.3 不取什么

- **两家品牌色与 logo**：TwinDesk 是深色底 + 蓝色强调；ToDesk 是白底 + 蓝色主按钮 + 蓝紫渐变推广卡。LinkSpace 用自己的配色与 logo，只借信息结构与交互模式。
- **ToDesk 的“设备代码 + 密码”连接模型**：9 位设备代码 + 临时密码是 ToDesk 的账号/云端连接模型；LinkSpace 是局域网配对一次、比对配对码、之后自动重连（TwinDesk 路线）。不要在安卓端出现“输入对方设备代码”的入口。
- **ToDesk 的推广卡片与 VIP 角标**：首页“专业版低至 ¥0.32/天”推广卡、“远程控制 VIP”角标都是 ToDesk 的付费墙形态；LinkSpace 没有付费墙，不要留这种占位。截图见 `images-android/todesk-android-remote-home-v4.6.2.3.jpg`（v4.6.2.3 远程控制首页，已目视验证；推广卡片在图内，仅作反面教材）。
- **TwinDesk 的“功能全默认关闭、每功能一页开关”的过度拆分**：TwinDesk 有 12 个页面（Overview 到 About），对 LinkSpace 太散；安卓端按桌面端五页收敛，少用的放设置里。
- **ToDesk 的底部导航版本混乱**：两个版本三种底部导航（远程控制 / 设备列表 / 我的 vs 设备列表 / 连接 / 设置）是反面教材。LinkSpace 安卓端导航与桌面端五页一一对应，手机端只是把侧边栏折成底部页签，名称与顺序不变。截图对比：`images-android/todesk-android-remote-home-v4.6.2.3.jpg` vs `images-android/todesk-android-connect-page.png`（连接页：连接远程设备卡 + 连接本设备卡，已目视验证）。
- **不把 Remote（无画面纯输入）与 Screen（带画面）混在一起**。用户 2026-11-02 两次纠正：Remote 页的两个模式都不展示电脑屏幕，Screen 页的 Mirror / Extend 才是第二屏。安卓端重设计保持这个分法，入口、命名、图标都分开。截图 `images-android/twindesk-v23-remote.jpg`（Remote 页：触控板 + 按键行、手柄 Xbox 布局）。

### 1.4 用户实测结论（优先于 README 宣称）

- 2026-11-02，小新平板 Pro GT：**平板当扩展屏可以**；**电脑控平板一开始没跑通，后来确认确实可以**（需无线调试配对）。
- Remote 页的两个模式（游戏手柄模式、触控板 + 键盘模式）都不展示电脑屏幕，操作时看的是电脑自己的显示器；“扩展/镜像屏时触控当鼠标”是 Screen 页（Mirror / Extend，平板上显示电脑画面）的功能，不是 Remote 页的模式。

### 1.5 查不到的部分（写查不到，不要编）

1. **TwinDesk 平板侧边栏的真实截图没拿到**。README 只给了手机 5 屏拼图（`twindesk-android-phone.jpg`），平板侧边栏只有文字描述（"a full sidebar on tablets"）。仓库 `.github/assets/` 里没有平板端截图；官网也只有手机与桌面图。安卓端横屏导航以审计 §4.1 的 80dp `NavigationRail` 为准，不按未见过的侧边栏反推尺寸。
2. **ToDesk 安卓端设备列表的真实截图没拿到**。Google Play 页返回 404；小米应用商店页只读到权限列表，截图是 JS 加载未取到；APKPure 被 Cloudflare 拦截。设备列表的描述目前只有 CSDN 与火山引擎的文字（实时缩略图、多端混排、第一屏四个入口 + 三个按钮）。
3. **ToDesk 移动端会话中工具栏（悬浮球）的截图没拿到**。官方 FAQ 只给了桌面端三张插图；移动端悬浮球长什么样、工具栏里有哪些按钮，未查到。
4. **ToDesk 平板横屏布局未知**。没找到任何 ToDesk 平板横屏截图或说明，不知道它在平板横屏时是否变侧边栏、还是拉伸手机布局。
5. **两家应用的精确配色、字号、圆角、间距没量到**。公开截图能看出“深色 + 蓝”（TwinDesk）与“白底 + 蓝按钮”（ToDesk）的大方向，但没有设计 token；重设计以 LinkSpace 自己的设计语言为准（见 §2），不必反推它们的色值。
6. **TwinDesk 安卓端“正在被控”状态如何展示，没查到**。README 只写了常驻通知“显示连接状态，带 Exit”，没有被控端收到控制请求时的弹窗截图；TwinDesk 的控制请求确认流程（是否弹窗、长什么样）未在公开资料里出现。LinkSpace 的被控确认弹窗目前只能参考 ToDesk 的（§1.2 第二行）。
7. **版本号口径**：TwinDesk 官网下载区写 latest v2.3.0、README 写 Download 2.4；ToDesk 安卓截图有 v4.6.2.3 与更新的 5.2.2.0（下载站标注）两个版本，底部导航在版本间变过。引用时以截图上实际显示的版本为准。

---

## 2. 与桌面端设计语言的对应关系（桌面端 `docs/ui-redesign.md` §5 → Compose）

原则与桌面端 §6 一致：**只改表现层，不改协议与功能行为；不引入新依赖**（`material-icons-extended`、`material3` 已有，直接用）。

### 2.1 Token 映射

| 桌面端 token（`ui-redesign.md` §5） | Compose 落点（具体数值） | 现状 |
|---|---|---|
| `--accent #2f6bff` | `lightColorScheme(primary = Color(0xFF2F6BFF), onPrimary = White)`；`primaryContainer = Color(0xFFEAF0FF)`（即 `--accent-soft`）；hover/按下 `#2559D6` 用 `ButtonDefaults.buttonColors` 或 `colorScheme` 的 `primary` 深色变体表达 | 默认 M3 紫；`#2F6BFF` 只在启动图标里（`ic_launcher_foreground.xml` 3 处），界面上没有 |
| `--accent-soft #eaf0ff` | `primaryContainer`；选中态导航 pill 与 `本设备` 标签底色 | 无 |
| 间距 4/8/12/16/20/24px | `object LinkSpaceSpacing { val xs = 4.dp; sm = 8.dp; md = 12.dp; lg = 16.dp; xl = 20.dp; xxl = 24.dp }`，全文件替换散值（当前 16/14/12/10/8/6/4dp 混用） | 散值，见 §3 问题 10 |
| 字号 12/13/14/16/20px | `Typography`：页标题 20sp/600（`titleLarge` 定制）、区块标题 13sp/600（`titleSmall` 定制，替代现 `SectionTitle` 13sp SemiBold）、正文 14sp（`bodyLarge`）、小字 12sp（`bodySmall`）、辅助 11sp（`labelSmall`）；删掉现有的 15sp 输入框字号与 18sp 触控板标题，统一进档 | 11/12/13/14/15/18/24sp 七档散写，见 §3 问题 10 |
| 圆角 6/8/10/12/999px | `Shapes(small = 6.dp, medium = 8.dp, large = 12.dp)`；卡片 12dp、菜单项 8dp、胶囊标签 `RoundedCornerShape(999.dp)`；`FloatingControlPill` 菜单 12dp、菜单项 8dp 已是此值，收进 token 即可 | 默认 shapes + 文件内自定 |
| 深色 token（画面窗口） | `darkColorScheme(background = 0xFF161617, surface = 0xFF1E1E1F, surfaceVariant = 0xFF232325, onSurface = 0xFFE8EAED, onSurfaceVariant = 0xFF9AA0A6, outline = 0xFF2C3138, primary = 0xFF2F6BFF)`，**只包 `ScreenMirrorScreen`（局部 `MaterialTheme(colorScheme = DarkStreamScheme)`），不做全局深色模式** | 硬编码黑/白，见 §3 问题 9 |
| 状态色三档 | 在线/成功绿 `Color(0xFF1E8E3E)`、进行中黄 `Color(0xFFF9AB00)`（只用于过渡态）、危险/被控红 `Color(0xFFD92D20)`；离线用灰 `onSurfaceVariant` + “离线”文字（不用黄，桌面端 §5 原文）。三档做成 `object LinkSpaceStatusColors`，别散落在 `errorContainer` / `tertiaryContainer` 里 | `errorContainer` 当通知色、`tertiaryContainer` 当被控色，见 §3 问题 2 |
| 危险按钮 hover | Material3 的 `Button` 按下态由涟漪（ripple）承担，不用另写 hover；`撤销` / `终止控制` / `断开` 统一用 `ButtonDefaults.outlinedButtonColors(contentColor = 危险红)` 或 `filledTonalButtonColors(containerColor = errorContainer)`，禁用态 `opacity 0.5 + 文字说明` | `撤销`是无色 `TextButton`，`退出`无确认 |
| focus 样式 | 平板以触控为主，`focus-visible` 对应 Compose 的 `Modifier.focusable()` + 键盘 Tab 导航场景才需要；触控板屏的自绘键盘已有焦点逻辑，暂不单独立项，随导航重构时补 `focusRequester` 即可 | 无 |

### 2.2 组件映射

| 桌面端组件（`ui-redesign.md` §4） | Compose 对应（Material3，无新依赖） | 安卓端现状与落点 |
|---|---|---|
| `SidebarNav.vue`（200px 侧边栏） | **不搬 200px 侧栏**，见 §0 与 §4：横屏用 `NavigationRail`（80dp，图标 + 文字），竖屏用 `NavigationBar`（底部 5 项） | 无导航；`MainScreen` 单栏 |
| `DeviceRow.vue`（状态点 + 系统图标 + 设备名 + 一行小字 + `本设备` 标签 + 行内“控制中”标记） | 新 `DeviceRow`：`Box(8.dp, CircleShape, 状态色)` + `Icon(Icons.Filled.Computer / Tablet / Phone, …)`（`material-icons-extended` 已有依赖，0 使用）+ `Column`（设备名 14sp Medium / 小字 12sp `onSurfaceVariant`：系统 · 连接方式 · IP）+ `本设备` 用 `AssistChip` 或 `Badge(containerColor = primaryContainer)` + 控制中用绿色文字标记 | 发现行（`MainActivity.kt:533-575`）与信任行（`MainActivity.kt:453-473`）是两套长得不一样的卡片，都没有状态点、图标、标签 |
| `DirectionCard.vue`（一方向一行能力 + toggle + ›） | 新 `DirectionCard`：`Card` + 每行 `Row`（能力名 14sp + 一行小字说明 12sp + `Switch` + `Icon(Icons.AutoMirrored.Filled.KeyboardArrowRight)`）；`›` 现在无详情页可进——先只做行内说明 + toggle，详情页待后续（**不要做假入口**） | 无；两个方向的能力开关散在首页：剪贴板在 `MainActivity.kt:328-338`、被控在 `MainActivity.kt:339-359`、投屏/反向流无开关 |
| `DetailCard.vue`（大图标阵 + 键值详情） | 选中设备用 `ModalBottomSheet`（竖屏）/ 右侧详情列（横屏双窗格，见 §4）：图标阵用 `FilledTonalButton` + `Icon` + 文字竖排（控制 / 发送文件 / 剪贴板 / 扩展屏 / 断开），下方键值行（系统/IP/连接方式/延迟） | 无详情卡；操作按钮只在发现行（已配对才出现） |
| `SessionBanner.vue`（分级通知横条 + 控制中/被控中横条，带操作按钮） | 新 `SessionBanner`：`Card(containerColor 按级别)` + `Icon`（级别图标）+ 文字 + 操作按钮（`终止控制` / `停止推流` / `查看`）+ 关闭 `IconButton`；`notice: String` 改成 `notices: List<Notice(level, text)>`，多条并存、成功 3 秒自动消失、danger 常驻到关闭 | 单条 `notice` + 固定 `errorContainer`（`MainActivity.kt:363-373`）；被控/推流各一张异形卡（`MainActivity.kt:376-417`） |
| `TransferList.vue`（常驻 + 空状态 + 进度/速率/取消） | 新 `TransferList`：空时显示空状态（不是整个区块消失）；每行文件名 + `LinearProgressIndicator` + 状态 `Badge` + 速率/剩余时间（**速率需服务层补 `transferred` 差分计算，UI 侧可先显示已传/总量**）+ 接收确认按钮；失败行显示 `error` 文本（`Protocol.kt:128` 字段已有，UI 未用） | 区块随 `transfers.isEmpty()` 整体消失（`MainActivity.kt:477`）；无速率、无失败原因、无空状态 |
| `ReverseStreamView.vue`（折叠工具栏 + token 深色主题 + 状态行） | `ScreenMirrorScreen` 改造：顶部常驻标题栏（设备名 · 延迟 · 画质徽章 + chevron + 关闭）+ 默认折叠的工具栏（显示：分辨率下拉 / 控制：剪贴板 toggle / 断开 danger 单列）+ 状态行只留分辨率与控制状态，帧数/码率等调试信息进“详情”展开项；**现有 `FloatingControlPill` 悬浮球可保留作为折叠工具栏的触控形态**（用户 2026-10-31 提出“右上角按钮经常点不到”后重做的方案，别轻易推翻），标题栏是新增的缺口 | 无标题栏；悬浮球菜单是唯一入口；无延迟、无画质徽章 |

### 2.3 映射前置：服务层缺的三样东西（UI 画不出来的部分）

以下三项桌面端设计默认存在，安卓端服务层目前没有，映射时须先补（只记录，不在本任务里改）：

1. **延迟字段**：`LinkSpaceService` 无任何 RTT/延迟 `StateFlow`（见 §3 问题 3）。桌面端三处常驻延迟在安卓端对应：概览页连接可视化、设备行小字、投屏标题栏——全等字段到位。
2. **设备在线状态与设备类型**：`DiscoveredService`（发现行用的字段：`displayName/host/port/caps/paired/serviceName`）无在线/离线布尔值与系统类型；`TrustStore.Entry` 有 `deviceType` 字段（`TrustStore.kt:16-22`）但 UI 从不读它。设备行四要素里的状态点与系统图标等这两个字段。
3. **传输速率与发送取消**：速率可由 UI 侧对 `transferred` 做差分估算（不改协议）；发送中取消需服务层补取消通道（发送确认弹窗注释 `MainActivity.kt:594-601` 已写明目前没有）。

---

## 3. 现状问题清单（审计 23 条里最重要的 10 条）

审计原文见 `android-audit.md` §2；行号以分支头 `6a934a7` 的克隆为准。其余 13 条（被控设置长篇堆首页、会话入口文案无区分、30 秒 TTL 无倒计时、控制中标记只在首页横条、传输缺速率/失败原因、多显示器弹窗嵌标题行、零图标零无障碍描述、原始协议字符串上屏、占位色硬编码 `Color.Gray`、粘滞键激活态颜色不统一、触控板屏横屏挤占风险、反向流状态偏少）已记在审计报告里，随重设计顺手修，不另立项。

| # | 问题 | 位置 | 严重度 |
|---|---|---|---|
| 1 | **无导航、无分组，全部平铺在一条滚动流里**。页头、剪贴板、被控设置、通知、三个会话卡、配对、信任、传输、发现、页脚共 10 个区块按固定顺序堆叠；传输、发现等高频入口在页面底部，平板横屏时单列大宽屏更浪费。与桌面端重设计前的问题 1 完全相同 | `MainActivity.kt:299-585` | 🔴 |
| 2 | **通知只有一条，且成功与失败共用红色**。`notice` 是单个 `String` state，后一条覆盖前一条；容器色固定 `errorContainer`——“已改名为「…」”“已开始接收”“已撤销信任”等成功反馈也显示为红色错误卡 | `MainActivity.kt:218, 363-373` | 🔴 |
| 3 | **无延迟显示**。服务层 15 个公开 `StateFlow` 里没有任何延迟/RTT 字段；全仓库搜 `latency\|rtt` 只有 FFmpeg 的 `zerolatency` 调参。桌面端把延迟常驻三处当作局域网产品的核心卖点，安卓端目前是 0 处——**这不是 UI 欠账，是服务层缺字段** | `LinkSpaceService.kt:99-1354`、`ReverseScreenStreamer.kt:823` | 🔴 |
| 4 | **设备行没有在线/离线状态**。发现设备行只显示 `host:port · caps`，无状态点、无“在线”文字；已信任设备行只显示名 + 授权范围，连是否在线都不知道 | `MainActivity.kt:533-575`、`MainActivity.kt:453-473` | 🔴 |
| 5 | **安卓端无法主动发起配对**。发现设备行里，未配对设备没有任何按钮；配对流程只能由桌面端发起、本机展示配对码。桌面端 §3.3 要求“配对发起 + 配对码提交/展示”两个入口，安卓端只有后者的一半（展示码，无提交码的输入框） | `MainActivity.kt:533-575`（只有 `if (d.paired)` 分支里才有操作） | 🔴 |
| 6 | **“退出”按钮放在页头、无二次确认**。与 `修改本机名称` 并排的两个 `TextButton`，点 `退出` 立即断开全部连接并停前台服务；误触代价大。`撤销`信任同样点即执行 | `MainActivity.kt:316-327`、`MainActivity.kt:467-470` | 🔴 |
| 7 | **会话中的操作入口只有悬浮球菜单一处**。投屏画面的断开、分辨率、模式切换全收在 52dp 小球点开的菜单里，无标题栏、无常驻断开；桌面端画面窗口要求标题栏常驻 + 折叠工具栏 + 断开至少两处，安卓端目前是 0 处常驻入口 | `MainActivity.kt:1186-1393`、`FloatingControlPill.kt` | 🔴 |
| 8 | **品牌色只存在于启动图标，不在界面上**。`#2F6BFF` 全仓库只出现在 `ic_launcher_foreground.xml`（3 处）；Compose 界面用默认 Material3 配色（紫色 `primary`），`SectionTitle` 的 `primary` 色实际是默认紫，不是 LinkSpace 蓝 | `MainActivity.kt:173-175`、`MainActivity.kt:757` | 🔴 |
| 9 | **深色主题不存在，画面窗口靠硬编码黑色撑场**。`themes.xml` 只有 `Theme.Material.Light.NoActionBar` 一行；`FloatingControlPill` 通篇硬编码 `Color.Black.copy(alpha=…)` / `Color.White`；`ScreenMirrorScreen` 根 `Box` 硬编码 `Color.Black`；`StreamView` 光标硬编码白/黑 | `res/values/themes.xml`、`FloatingControlPill.kt:82, 123, 133`、`MainActivity.kt:1224` | 🔴 |
| 10 | **字号 11/12/13/14/15/18/24sp 七档散写，无层级 token；间距与圆角全是散值**。页头 24sp、触控板标题 18sp、正文 14sp、说明 12sp、辅助 11sp、输入框 15sp、`SectionTitle` 13sp SemiBold；外边距 16dp、卡内边距 14dp/12dp、行间距 10dp/8dp/6dp/4dp；圆角只用默认 shapes | `MainActivity.kt:300, 405, 424, 456, 370`、`MainActivity.kt:752-761` | ⚪ |

---

## 4. 新布局结构

### 4.1 导航形态（与桌面端 §3.1 的对应关系）

- 导航项与桌面端 5 项一致（概览 / 设备 / 屏幕 / 文件 / 设置），名称与顺序不变；选中态整行 pill 改为 rail/bar 的选中态指示器（`primaryContainer` 底）。
- **横屏用 `NavigationRail`（80dp，图标 + 短文字）**，不搬 200px 侧边栏（理由见 §0）。
- **竖屏用 `NavigationBar`（底部 5 项）**。
- 控制会话（触控板/投屏）仍是整屏接管，与导航无关；但退出控制后应回到**之前所在的导航页**，而不是固定回首页（现状 early return 无此概念，见 `MainActivity.kt:271-279`）。

### 4.2 横屏布局（宽 > 高，如 1280×800dp 级）

```
┌──────────┬────────────────────────────────────────────────────────┐
│ 概览 ●   │ 顶栏：本机名 · 在线 X/Y · 剪贴板开关 · 刷新              │
│ 设备     ├────────────────────────────────────────────────────────┤
│ 屏幕     │ ┌─ 概览页 ───────────────────────────────────────────┐ │
│ 文件     │ │ 本机卡：名 · IP · [复制] · 就绪绿勾                  │ │
│ 设置     │ │ 连接可视化：[本机] ═══ 7 ms ═══ [平板]               │ │
│          │ │ 方向卡A 平板→电脑：画面 · 键鼠 · 剪贴板 · 文件       │ │
│ 80dp     │ │ 方向卡B 电脑→平板：画面 · 键鼠 · 剪贴板 · 文件       │ │
│ Rail     │ │ 设备行：● 平板名  Android · Wi-Fi · IP  [本设备]    │ │
│          │ └────────────────────────────────────────────────────┘ │
│ v0.1.0   │ 通知横条（分级 info/warn/danger，可多条并存，贴顶栏下）  │
└──────────┴────────────────────────────────────────────────────────┘
```

- **设备页横屏用双窗格**：左侧分组列表（最近连接 / 已信任 / 局域网内其他，空分组显示空状态不消失）+ 右侧详情卡（大图标阵 + 键值详情），与桌面端设备页同构。
- **屏幕页横屏**：投屏设置（画质三档下拉 + 说明）与反向流设置（分辨率四档下拉 + 说明）分两组左右并排；扩展屏设置（Extend / Mirror 分段 + 尺寸下拉 + Apply）在**线 3 未完成前显示“研制中”占位，不可点进假功能**（桌面端 §3.1 原文）。
- 方向卡在横屏并排（竖屏上下叠放，见 §4.3）。

### 4.3 竖屏布局（高 > 宽，如 800×1280dp 级）

```
┌─────────────────────────────────────────────┐
│ 顶栏：LinkSpace · 本机名 · 在线 X/Y · [刷新]  │
├─────────────────────────────────────────────┤
│ 通知横条（分级，可多条并存，可关闭）           │
├─────────────────────────────────────────────┤
│                                             │
│  ┌─ 概览页 ───────────────────────────────┐ │
│  │ 本机卡：名 · IP · [复制] · 就绪绿勾     │ │
│  │ 连接可视化：[本机] ═══ 7 ms ═══ [平板]  │ │
│  │ 方向卡A 平板→电脑                      │ │
│  │ 方向卡B 电脑→平板                      │ │
│  │ 设备行列表（四要素 + 本设备标签）        │ │
│  └────────────────────────────────────────┘ │
│                                             │
├─────────────────────────────────────────────┤
│ 概览    设备    屏幕    文件    设置  （底部导航栏）│
└─────────────────────────────────────────────┘
```

- 底部导航 5 项与桌面端 5 页一一对应；**选中设备详情用 `ModalBottomSheet` 上滑弹出**（竖屏无横向空间放右侧详情列）。
- 方向卡在竖屏上下叠放；设备行在竖屏保持单列，行内操作（控制/发送文件）收进详情 Sheet，不挤在行内——现状发现行把两个 `Button` 直接塞进卡片行内（`MainActivity.kt:547-575`），竖屏下行高与误触都是问题。
- 触控板屏竖屏：标题行 + 按键区可横向滚动（`horizontalScroll`）或折叠进“键盘”开关，触控板区保证最小高度（建议 `weight(1f)` + `defaultMinSize(minHeight = 240.dp)`），避免现状无滚动 `Column` 在横屏下挤占触控区的问题（审计 §2 问题 15）。

---

## 5. 新组件清单

全部放在 `apps/android/app/src/main/java/cn/linkspace/client/` 下新建的 `ui/` 包里（与现有 `service/` 包平级），`MainActivity.kt` 只留导航壳与会话接管逻辑；**不新增依赖**。

| 建议的新 Composable | 建议文件 | 职责 | 来源/替换 |
|---|---|---|---|
| `LinkSpaceTheme`（`lightColorScheme` + `darkColorScheme`（仅投屏）+ `Typography` + `Shapes` + `LinkSpaceSpacing` + `LinkSpaceStatusColors`） | `ui/LinkSpaceTheme.kt`（新） | 收敛 §2.1 全部 token；`#2F6BFF` 主色、`#EAF0FF` 容器色、深色 token、状态色三档、间距/字号/圆角 | 现状：默认 `MaterialTheme`（`MainActivity.kt:173-175`）、`themes.xml` 只有亮色空壳 |
| `AppNav`（横屏 `NavigationRail` / 竖屏 `NavigationBar`，按 `BoxWithConstraints` 或窗口尺寸类切换） | `ui/AppNav.kt`（新） | 5 项导航（概览/设备/屏幕/文件/设置）+ 底部版本号；选中态 pill | 现状：无导航 |
| `DeviceRow` | `ui/DeviceRow.kt`（新） | 状态点 + 系统图标 + 设备名 + 一行小字 + `本设备` 标签 + 行内“控制中/推流中”标记；点击进详情 | 替换发现行（`MainActivity.kt:533-575`）与信任行（`MainActivity.kt:453-473`）两套卡片 |
| `DirectionCard` | `ui/DirectionCard.kt`（新） | 一方向一行能力 + 说明小字 + `Switch` + `›`（暂无详情页，先不挂点击） | 替换散落的剪贴板行（`MainActivity.kt:328-338`）与被控行（`MainActivity.kt:339-359`） |
| `SessionBanner` | `ui/SessionBanner.kt`（新） | 分级通知横条（info/warn/danger）+ 控制中/被控中/推流中横条（带操作按钮 + 关闭） | 替换通知卡（`MainActivity.kt:363-373`）、被控卡（`MainActivity.kt:376-398`）、推流卡（`MainActivity.kt:400-417`）三张异形卡 |
| `TransferList`（+ `TransferRow`） | `ui/TransferList.kt`（新） | 常驻列表 + 空状态 + 进度/速率/失败原因/接收确认 | 替换传输区（`MainActivity.kt:476-520`） |
| `DeviceDetailSheet` | `ui/DeviceDetailSheet.kt`（新） | `ModalBottomSheet`：大图标阵（控制/发送文件/剪贴板/扩展屏/断开）+ 键值详情 + 危险操作二次确认 | 现状无；发现行按钮（`MainActivity.kt:547-575`）与信任行 `撤销`（`MainActivity.kt:467-470`）并入此处 |
| `PairingCard`（配对码展示卡） | `ui/PairingCard.kt`（新） | 配对码 32sp 等宽展示 + 复制按钮 + 30 秒倒计时 + `拒绝` | 现状配对卡（`MainActivity.kt:419-448`）：无复制、无倒计时 |
| `StreamTopBar`（投屏标题栏 + 折叠工具栏） | `ui/StreamTopBar.kt`（新） | 常驻标题栏（设备名 · 延迟 · 画质徽章 + chevron + 关闭）+ 折叠工具栏（显示/控制/断开分组）；`FloatingControlPill` 保留为触控形态，二者不重复造入口 | 现状投屏无标题栏（`ScreenMirrorScreen`，`MainActivity.kt:1186-1393`） |
| `TouchpadScreen` / `ScreenMirrorScreen`（拆出） | `ui/TouchpadScreen.kt`、`ui/ScreenMirrorScreen.kt`（新，从 `MainActivity.kt` 移出） | 触控板与投屏逻辑原样搬移，只做两处改：根布局加滚动/最小高度保护（审计 §2 问题 15）、占位色 `Color.Gray` 改主题色（`MainActivity.kt:1030`、`MainActivity.kt:1161`） | 现状在 `MainActivity.kt:822-1185` 与 `MainActivity.kt:1186-1393`，与首页同文件 |
| `MainScreen`（瘦身后） | `MainActivity.kt`（改，只留壳） | 只剩：导航壳 + 会话接管（`phase == "active"` 切触控板/投屏）+ 5 个弹窗挂载点；各页内容拆进上面组件 | 现状 1,493 行单文件含全部 UI |

**不建议新建的**：独立的 `SettingsScreen` 文件可以先不建——设置页内容（改名、剪贴板、被控设置、端口/指纹、关于、退出）先收进 `DeviceRow`/`DirectionCard` 复用后的 `SettingsPage`，放在 `ui/AppNav.kt` 同级的 `ui/SettingsPage.kt`，等导航壳落地后再拆；扩展屏设置在**线 3 完成前只做“研制中”占位**，不要为它新建组件。`KeyCap` / `Vk` / `diffToKeyEvents` / `letterboxRect`（`MainActivity.kt:1415-1492`）原样搬移，随 `TouchpadScreen.kt` 走，不动行为。

---

## 6. 诚实缺口

- **延迟字段服务层没有**：`LinkSpaceService` 15 个公开 `StateFlow` 里无任何 RTT/延迟字段；全仓库搜 `latency|rtt` 只有 FFmpeg 的 `zerolatency` 调参。概览页连接可视化、设备行小字、投屏标题栏三处常驻延迟，全等服务层补字段（§2.3 第 1 项）。**UI 侧不编造延迟数字**——字段到位前这三处留空或不显示，不写假的 `7 ms`。
- **文件行 toggle 的接线口径**：传输速率可由 UI 侧对 `transferred` 做差分估算（不改协议），先显示已传/总量；发送中取消需服务层补取消通道（发送确认弹窗注释 `MainActivity.kt:594-601` 已写明目前没有），UI 侧在通道到位前继续硬拦弹窗误触关闭，不假装能取消。
- **最近连接分组口径**：设备页分组为最近连接 / 已信任 / 局域网内其他，沿用桌面端口径——“最近连接”定义为**已信任 ∩ mDNS 可见取前 5**；服务层若无“最近连接”时间戳字段，列表按该口径静态分组，不另编排序规则。空分组显示空状态，不消失。
- **悬浮球保留的原因**：`FloatingControlPill` 是用户 2026-10-31 提出“右上角按钮经常点不到”后重做的方案（52dp 可拖动圆球，松手吸附左右边缘），别轻易推翻。重设计新增的是它缺的那块——常驻标题栏（设备名 · 延迟 · 画质徽章 + 关闭）；悬浮球继续当折叠工具栏的触控形态，二者不重复造入口。
- **视觉待真机验收**：a1 无显示器，本文档全部结论来自静态读代码与公开截图，未在真机或模拟器上目视验证任何界面。横竖屏布局、触控板屏横屏挤占风险（审计 §2 问题 15）、导航 rail/bar 在小新平板 Pro GT 上的实际观感，须在真机上按横/竖屏核对。
- **方向卡的 `›` 与扩展屏占位**：方向卡 `›` 现在无详情页可进，先只做行内说明 + toggle，不挂点击、不做假入口；扩展屏设置在线 3 完成前只做“研制中”占位，不可点进假功能。

---

## 7. 实现顺序建议（分 A/B 两线并行）

参考桌面端 `ui-redesign.md` §6 的分线做法，各用独立克隆，只动下面列出的文件；不改协议、服务层逻辑、功能行为；不改 master。

### A 线：主界面（导航 + 设备列表 + 方向卡 + 通知）

- 拥有 `ui/LinkSpaceTheme.kt`（全部 token：主色、间距、字号、圆角、状态色三档；深色 token 只定义，不全局启用）。
- 新建：`ui/AppNav.kt`、`ui/DeviceRow.kt`、`ui/DirectionCard.kt`、`ui/SessionBanner.kt`、`ui/TransferList.kt`、`ui/DeviceDetailSheet.kt`、`ui/PairingCard.kt`、`ui/SettingsPage.kt`。
- 改：`MainActivity.kt` 只留导航壳 + 会话接管 + 弹窗挂载点（各页内容拆进上面组件）；`res/values/` 主题色走 `LinkSpaceTheme`，不另起一套。
- 先修 §3 问题 1、2、4、5、6、8、10；问题 3（延迟字段）与问题 5 的配对发起入口等服务层字段到位（见 §2.3）。
- 验收：`./gradlew :app:assembleDebug` 通过；`verify:input`、`verify:protocol` 通过；五页切换、设备行四要素、方向卡开关、通知分级与多条并存、危险操作二次确认逐项核对。

### B 线：画面窗口 + 确认弹窗 + 状态卡片

- 新建：`ui/StreamTopBar.kt`、`ui/TouchpadScreen.kt`、`ui/ScreenMirrorScreen.kt`（从 `MainActivity.kt` 拆出，原样搬移逻辑）。
- 改：投屏标题栏常驻 + 折叠工具栏（显示/控制/断开分组）；触控板屏根布局加滚动/最小高度保护、占位色 `Color.Gray` 改主题色；确认弹窗（控制请求等待、反向投屏请求、电脑请求控制本机）补 30 秒倒计时显示与“单次有效”文案；`FloatingControlPill` 保留，只收圆角/间距进 token。
- B 不动 `LinkSpaceTheme.kt`（token 由 A 定义，B 只消费）；如需新增 token，先在本文档 §2 补记再由 A 落。
- 先修 §3 问题 7、9；问题 3 的投屏标题栏延迟位等服务层字段到位后再填数，不编造。
- 验收：同 A 线构建与验证命令；投屏标题栏常驻、断开至少两处（标题栏关闭 + 工具栏断开）、悬浮球仍可拖动吸附、弹窗倒计时可见。

### 合并规则

- A、B 各用独立克隆，完成后分别合进 `decision/line2-accessibility-first`，不合并进 master。
- `docs/protocol.md` 与 `modules/protocol/protocol.json` 不动；中文输入通道、scrcpy 收敛等别的功能线一律不动。
- 服务层缺的三样东西（延迟字段、设备在线状态与类型、传输速率与发送取消，见 §2.3）另开任务，不混进 UI 两线。
- **视觉效果待用户在小新平板 Pro GT 真机上验收**——a1 无显示器，不编造已目视检查。

---

## 附：核查清单（给重设计对照用）

- [ ] 平板横屏：80dp `NavigationRail` + 五页（概览/设备/屏幕/文件/设置），与桌面端同名同序
- [ ] 手机/平板竖屏：底部 `NavigationBar`，名称与顺序与横屏导航一致
- [ ] Overview：连接状态大卡（对端名 + 链路 + 延迟）+ Disconnect + 按方向×功能的开关矩阵
- [ ] 设备发现与配对：Nearby 列表 + 比对配对码 + 主动发起配对入口；未完成授权时 Overview 常驻引导卡片
- [ ] 被控端确认弹窗：主控设备名 + 账号 + 倒计时 + 单次有效 + 解锁选项
- [ ] 授权设置入口：总开关 + 模式三选一 + 权限逐项引导 + 成功后安全提示
- [ ] 正在被控 / 正在推流状态卡片：应用内卡片 + 系统常驻通知（带断开）
- [ ] 投屏画面窗口：Mirror / Extend 分段控件 + Fastest / Smooth + 画质档位；标题栏常驻
- [ ] 会话工具栏：常驻可唤出（悬浮球保留），断开按钮永远一键可达；Remote（无画面）与 Screen（带画面）入口分开
- [ ] 不出现：对方品牌色/logo、设备代码+密码连接入口、推广卡/VIP 角标、假入口（方向卡 `›`、扩展屏占位）
