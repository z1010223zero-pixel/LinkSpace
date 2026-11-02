# 线 2 中文输入通道调研：三家核实与推荐方案

> 调研分支：`wip/next-ime-research`，基底 `decision/line2-accessibility-first @ 5895d2d`
> 日期：2026-11-03
> 性质：**只调研、不写实现代码**。本文所有"真机验证"项均未做——手头无真机，全部标注未验证。
> 对应任务：`docs/symmetric-control-tasks.md` 2.3-3（中文输入）。

## 0. 结论先行

**推荐主方案 B：输入连接直通（沿用已选的 AccessibilityService 路线，零新增用户门槛），分两条子通道：**

- **B1 按键直通（默认）**：PC 键盘的原始按键经现有 `input.event`（VK→Android keyCode）→ 平板端 `InputConnection.sendKeyEvent()` → **平板自带的输入法自己做拼音组字、弹候选栏、选词上屏**。这是唯一能字面满足 2.3-3 验收（"在平板自带输入法界面输入中文，候选栏跟随、组词不丢字"）的通道，且零新增协议、零新增用户门槛。
- **B2 文本直通（新消息 `input.text`）**：PC 端输入法已组字完成的中文成品（或长文本）→ 平板端 `InputConnection.commitText()` 直接上屏。这是 RustDesk `seq` 路的翻版，任意 Unicode 都行，但绕过平板 IME 组字，无候选栏过程。

**回退 C：`screen.paste` 反向补齐**（桌面→平板方向目前根本不存在，见 §1.2）。平板写剪贴板 + 注入 Ctrl+V。大段文本、目标应用不吃 `commitText` 时用。定位是回退，不是主通道。

**不推荐 A：自研 `InputMethodService`（LinkSpace 输入法）**。门槛最高（手动启用 + 每次会话切换输入法）、会话期间平板本机打字断裂、IME 能读全部输入的隐私与商店政策风险，且组字仍在 PC 端完成，与 2.3-3"平板自带输入法界面"的验收直接冲突。仅当 B1 真机验证失败、且用户接受改验收标准时作备选。

**降级链（按顺序）**：B1（按键直通）→ B2（文本直通）→ C（剪贴板粘贴）→ A（自研 IME，需改验收标准）。

---

## 1. 仓库现状核实（2026-11-03，决策分支头 5895d2d）

### 1.1 任务 2.3-3 的既定描述

| 任务 | 验收标准（原文） |
|---|---|
| 2.3-3 中文输入：电脑键盘在平板画面窗口里打中文能上屏（候选栏、逐字上屏），不只用 `screen.paste` 粘贴 workaround | 在平板自带输入法界面输入中文，候选栏跟随、组词不丢字、切窗口不乱；写入人工走查清单 |

任务说明另写："以线 1 的中文输入教训为准：vk 通道表达不了 IME 组合输入，须另设通道"。清单末尾未决项："线 2 注入选型 A 路线的中文输入通道具体怎么做未定（候选栏、逐字上屏的通道），见 2.3-3，需实现验证后定。"——本文就是这项未决的调研。

### 1.2 `screen.paste`：只有平板→桌面方向，桌面→平板方向不存在

协议 4.8（`[PROTOCOL] 2026-10-30` 登记，B-7）只定义了语义：`screen.paste { text }`，写被控端剪贴板并注入 Ctrl+V，寄生 input 会话授权，上限 512 KiB。实现现状是**单向**的：

- 平板→桌面：已实现。Android `LinkSpaceService.sendScreenPaste()` 发送（`apps/android/.../service/LinkSpaceService.kt` 约 1398 行）；桌面 `host.ts` 接收后 `clipboard.writeText(text)` 再注入 Ctrl+V（VK 0x11+0x56，走 4.6 注入层）。
- 桌面→平板：**不存在**。Android 端两处控制消息分发（`LinkSpaceService.kt` 约 440–460 行与约 1140–1160 行）都没有 `TYPE_SCREEN_PASTE` 分支；`Protocol.kt` 只有常量定义，无接收处理。线 2 要用粘贴通道，必须先补 Android 接收侧（见 §7 清单 C-1）。

### 1.3 注入能力边界（已核实，与任务背景一致）

- `ControlledInputInjector.kt`：纯逻辑层，只做解码 + 坐标映射 + Windows VK→Android keyCode；VK 映射不上的码整批拒绝；注释明确写"中文输入通道另设，见任务 2.3-3，不在本批用 VK 硬凑"。
- `LinkSpaceAccessibilityService.kt`（选型 A，W5）：手势走 `dispatchGesture`；按键分三档——系统键（返回/主页/最近任务/电源/音量）走 `performGlobalAction` / `AudioManager`；其余按键走 API 33+ 输入连接 `getInputMethod()?.currentInputConnection?.sendKeyEvent()`；无连接或 Android < 13 回明确失败。配置文件 `res/xml/accessibility_service_config.xml` 已设 `flagInputMethodEditor`（这一点比 RustDesk 的配置更贴合官方文档，见 §2.4）。
- 已知结论复核：`AccessibilityService` 没有 `dispatchKeyEvent`（仓库注释称已查 android-35 android.jar 并对照 RustDesk 源码）。本次调研复核 RustDesk 源码属实：其 `InputService` 同样不用 `dispatchKeyEvent`，按键走输入连接（见 §2.1）。

### 1.4 仓库内已记录的 scrcpy 中文坑

`docs/scrcpy-manual-checklist.md` 2.5–2.7（未打勾）："scrcpy 通过 `input` 注入文本，带候选栏的输入法常出现「候选栏位置不跟随」与「逐字提交」"，"不通过会直接影响「把平板当第二屏来打字」的可用性，属于**决定是否继续投入**的判据之一"。这是仓库内部记录，未经本次真机验证；外部核实见 §4。

---

## 2. RustDesk：Android 被控端中文输入怎么走（源码核实）

### 2.1 机制：无障碍服务 + 输入连接，文本走 `commitText`

被控端是 `InputService`（`AccessibilityService`，即用户在系统设置里开的"RustDesk Input"），Rust 核心经 JNI 回调 `rustKeyEventInput` 把按键事件交给它。关键代码（rustdesk/rustdesk 仓库 master，文件 `flutter/android/app/src/main/kotlin/com/carriez/flutter_hbb/InputService.kt`，最后一次改动 2026-10-22，提交 `f010d33`）：

- 协议层：`KeyEvent`（`libs/base/protos/message.proto`）的 `oneof union` 有 `control_key` / `chr`（Unicode 码位）/ `unicode` / **`seq`（string，整段文本）** / `win2win_hotkey`，另有 `mode`（`KeyboardMode`：Legacy / Translate）。
- `onKeyEvent` 的分流逻辑：
  - `seq` 有值 → `textToCommit = seq`（整段已组字文本）；
  - Legacy 模式 + `chr` 有值 + 按下 → `textToCommit` = 单个字符；
  - Android ≥ 33：`getInputMethod()?.currentInputConnection` 拿到连接后，`textToCommit` 非空 → **`inputConnection.commitText(text, 1, null)`**；否则 → `inputConnection.sendKeyEvent(event)`（`press` 时补发 ACTION_UP）。
  - Android < 33：无输入连接可用，改走无障碍节点路径——遍历 `possibleAccessibiltyNodes()`，用一个假 EditText 算好文本状态后经 `AccessibilityNodeInfo.ACTION_SET_TEXT` 改节点文本（`updateTextForAccessibilityNode`）。
  - 音量/电源键单独特判，不走输入连接。
- 控制端产 `seq` 的入口：`src/ui_session_interface.rs` 的 `input_string(value)`——任意字符串包成 `KeyEvent.set_seq(value)` 发出（移动端软键盘打字、操作系统密码自动填入都走这里）。

一句话：**RustDesk 的中文成品（控制端已组字好的字符串）走 `seq` → `commitText` 直接上屏；单个按键在 Legacy 模式走 `chr` → `commitText` 单字；Translate 模式走按键码 → `sendKeyEvent`，由被控端输入法自己处理。**

### 2.2 没有自研输入法，没有剪贴板打字通道

- 仓库内无 `InputMethodService` 实现：Android 被控端输入只走 `InputService` 这一条无障碍服务 + 输入连接。**没有自研输入法/剪贴板通道/输入连接直通之外的第四条路**——"输入连接直通"本身就是 RustDesk 的路。
- 剪贴板同步另有其事（双向同步存在），但只是剪贴板同步，不承担"打字上屏"职责；把剪贴板内容变成输入框文字仍需一次粘贴动作。

### 2.3 用户侧门槛

- 被控端须在"设置 → 无障碍 → 已安装的服务"里手动开启 **RustDesk Input**；
- Android 13+ 上从非商店渠道安装时，该开关可能是灰色的"受限设置"，须先长按应用图标 → 应用信息 → 右上角菜单 → "允许受限设置"并验证锁屏，才能开无障碍开关（来源：blog.wirelessmoves.com 的实装手记）；
- 无障碍开关常驻一次开启即可，不按会话重复操作。

### 2.4 局限与注意事项（核实到的）

- **IME 组字问题是 RustDesk 的公开慢性病**：Windows→Windows 用仓颉输入法打不出中文（Discussion #11297，1.3.8）；Android 控制 Windows 时韩文组字断裂、选词后只上屏首字（Issue #7727，1.2.3）。`commitText` 是"成品直上"，组字过程发生在控制端；控制端与被控端两边输入法状态不同步时就出这类问题。——这对 LinkSpace 是直接警示：B2（`commitText`）能解决"能上屏"，解决不了"组字过程不出错"。
- **配置异常（待验证，不下结论）**：RustDesk 当前 master 的 `accessibility_service_config.xml` 只有 `flagDefault`，**没有声明 `flagInputMethodEditor`**，但 `onKeyEvent` 却调用 `getInputMethod()`。Android 官方文档明确写："Accessibility services also need to set the `AccessibilityServiceInfo.FLAG_INPUT_METHOD_EDITOR` flag to use input method APIs." 其代码以空判断兜底（拿不到连接时静默跳过本分支），所以该路径在其配置下是否实际生效，须真机/源码实测确认，不能直接断言。LinkSpace 的配置已设该 flag，这一点上比 RustDesk 更贴合官方文档。
- `AccessibilityInputConnection.sendKeyEvent` 的官方语义是"像普通按键事件一样分发"到当前焦点视图；平板输入法（Gboard 等）是否据此触发拼音组字、弹出候选栏，是任何照搬 RustDesk 的方案都必须真机验证的点——RustDesk 的 issue 史说明这条路在不同输入法/ROM 上表现并不一致。

来源：

- RustDesk 源码（gh api 核实，master）：`flutter/android/app/src/main/kotlin/com/carriez/flutter_hbb/InputService.kt`（`onKeyEvent` 约 444–517 行，`trySendKeyEvent` 约 653 行起）、`libs/base/protos/message.proto`（`message KeyEvent`）、`src/ui_session_interface.rs`（`input_string`）、`flutter/android/app/src/main/res/xml/accessibility_service_config.xml`
- Android Developers：`AccessibilityService` InputMethod API 文档（flag 要求与 `getCurrentInputConnection` 语义）
- https://github.com/rustdesk/rustdesk/discussions/11297 （仓颉输入法问题）
- https://deepwiki.com/ovftank/rustdesk/3.4-android-platform （InputService 架构概述）
- https://blog.wirelessmoves.com/2025/10/remote-android-support-with-rustdesk-part-1.html （RustDesk Input 开启步骤与受限设置）

## 3. ToDesk：Android 被控端中文输入方案（查到的与查不到的）

### 3.1 查到的

- **被控端门槛是无障碍服务，免 root**：安卓被控端开"允许远程本设备"→ 选"控制模式" → 跳无障碍设置开 ToDesk 服务；官方应用商店文案称"免 root 远程控制安卓手机"（来源：CSDN 教程、应用宝/官网介绍页）。
- **手机控电脑方向有明确的输入法直通做法**：控制端调出手机原生输入法直接打字；官方教程建议**电脑端输入法切英文**，再用手机端中文输入法打字，"避免双重输入法冲突导致的乱码"（来源：ToDesk 官网、todesk.st 教程、TapTap 横测）。TapTap 横测另称 ToDesk"自动匹配手机的原生输入法……词库、云联想、语音输入全部正常使用"，而向日葵/AnyDesk 用 App 内置键盘、没有词库联想。
- **"智能输入"开关**：多个第三方下载站的故障排查写"无法输入文字：可能是输入法冲突，请切换到系统自带输入法，或在 ToDesk 设置中关闭'智能输入'"。**该说法未在 ToDesk 官网或官方 FAQ 核实到，机理不明，记为未核实**，不作为推荐依据。
- **剪贴板同步是设置项**：第三方指南称须在设置里开"剪贴板同步"才能复制粘贴；与中文输入通道的关系未见说明。

### 3.2 查不到的（明说）

- **桌面控安卓方向的中文输入实现机制查不到**：ToDesk 闭源，无源码可查；官方 FAQ（todesk.com/faq/92.html）无安卓被控中文输入专项说明；第三方教程对"电脑控安卓"只写到"直接用电脑键盘输入文字""批量输入"为止，没有讲按键如何落到安卓输入法、是否经过输入连接、有无自研输入法、中文组字在哪一端完成。
- 因此 ToDesk **不能作为实现参考**，只能作为"门槛形态"参考：无障碍服务 + 免 root + 控制端原生输入法直通（手机控电脑方向）。

来源：

- https://www.todesk.com/faq/92.html （官方 FAQ，无相关条目）
- https://www.todesk.com/ （官网，"手机远控打字……自动匹配手机原生的输入法"）
- https://www.todesk.st/blog/861264410288197.html （手机控电脑打字教程：电脑端切英文）
- https://blog.csdn.net/loveyelong/article/details/124614096 （安卓被控无障碍开启步骤）
- https://www.taptap.cn/moment/844275498027584601 （横测：原生输入法适配）
- https://zamew.com/todesk/ （第三方指南：剪贴板同步等）
- "智能输入"说法来源：https://sites.google.com/view/todeskzhongwenbanxiazai-1-4vr （第三方下载站，非官方，未核实）

## 4. scrcpy：中文输入的既有机制与局限（官方文档 v5.0.1 核实）

### 4.1 三条键盘模式（`doc/keyboard.md`）

| 模式 | 机制 | 中文 |
|---|---|---|
| `--keyboard=sdk`（默认） | Android API 层注入按键/文本事件 | **限 ASCII 与部分字符** |
| `--keyboard=uhid`（`-K`） | 用设备端 UHID 内核模块模拟物理 HID 键盘 | 全字符与 IME 都行；TCP/IP 也可用；须先配一次键盘布局；旧 Android 可能因权限失败 |
| `--keyboard=aoa` | AOAv2 协议模拟物理 HID 键盘 | 全字符与 IME；只走 USB；Windows 下仅 OTG 模式可用（镜像时打不开 USB 设备） |

### 4.2 默认模式的两条事件路与中文陷阱

`--keyboard=sdk` 下打字产生两种事件：按键事件（key events）与文本事件（text events）。默认字母走按键事件（为保游戏里 WASD 行为）、数字与特殊字符走文本事件；`--prefer-text` 可改全走文本（但会破坏游戏按键），`--raw-key-events` 反向强制全走按键。

中文能不能打，取决于 PC 端当前输入法状态（机理说明见第三方文档，官方文档只给 ASCII 限制与 key/text 分流，两者互相印证）：

- **PC 输入法英文态** → 原始按键直达设备 → **设备端输入法自己做拼音组字、弹候选栏** → 中文能打；
- **PC 输入法中文态** → PC 端先组字，组好的中文走文本事件 → 文本事件经 `KeyCharacterMap.getEvents()` 生成，只覆盖 ASCII，中文返回 null → **中文被丢弃**。

所以 scrcpy 的中文输入本质上是"按键直通 + 设备端输入法组字"，与本文推荐的 B1 是同一条路；它的代价就是**控制端打中文时必须切英文输入法**，否则无声丢字。

### 4.3 剪贴板粘贴（`doc/control.md`）

- 剪贴板双向自动同步；Ctrl+V 在"电脑剪贴板同步到设备"后粘贴；MOD+Shift+V 把电脑剪贴板文本按按键序列注入（**会破坏非 ASCII 内容**）；`--legacy-paste` 让 Ctrl+V/MOD+V 也按按键序列注入；`--no-clipboard-autosync` 可关自动同步。
- 官方警告原文大意：经 Ctrl+V 或 MOD+V 粘贴会把内容写进 Android 剪贴板，**任何 Android 应用都可能读到**，敏感内容（密码）不要这样粘。
- 粘贴不是打字：无候选栏、无逐字上屏；且目标应用须支持粘贴（部分应用如 Termux 不接受粘贴，须走按键序列注入）。

### 4.4 门槛与局限

- 门槛：须 adb（USB 调试）或无线 adb；部分设备须在开发者选项里开额外选项；设备端不装 App；OTG 模式可无 adb 但无镜像。**与 LinkSpace 选型 A 的"无 adb、无无线调试"目标不兼容**——scrcpy 路线在 2.1-1 已定为过渡/备选，本文不再推荐它作中文主通道。
- 局限对照 2.3-3：key 路径依赖设备输入法对注入按键的响应；仓库 checklist 2.5–2.7 已把"候选栏不跟随、逐字提交"列为决定是否继续投入的判据——这正是 key 路径在真机上最需要验证的两项。

来源：

- Genymobile/scrcpy 仓库（gh api 核实，v5.0.1）：`doc/keyboard.md`、`doc/control.md`、`doc/otg.md`
- https://github.com/wcai018/scrcpy-wireless-launcher/blob/HEAD/docs/README_EN.md （key 路径 INJECT_KEYCODE 与 text 路径 INJECT_TEXT 的中文机理说明）
- https://www.redpacketsecurity.com/scrcpy-display-and-control-your-android-device/ （v1.24 README 镜像，HID 与 ASCII 限制的旧版表述）

## 5. 对比表

| 维度 | RustDesk（Android 被控） | ToDesk（Android 被控） | scrcpy | LinkSpace 推荐 B（B1+B2） |
|---|---|---|---|---|
| 中文上屏主路径 | `seq`→`commitText`（成品直上）+ `chr`→单字提交；Translate 模式按键→`sendKeyEvent` | 查不到实现；手机控电脑方向为控制端原生输入法直通 | key 路径：设备 IME 组字；text 路径：ASCII only 丢中文；HID：全字符 | B1 按键→`sendKeyEvent`（平板 IME 组字）；B2 成品→`commitText` |
| 候选栏/组字 | 成品直上，无平板侧候选栏过程；按键模式下由平板 IME 组字 | 查不到 | key/HID 路径由设备 IME 组字，有候选栏；text 路径无 | B1 有（平板自带输入法）；B2 无（成品直上） |
| 自研输入法 | 无 | 查不到 | 无（无设备端 App） | 不做（A 路线否决，见 §6.3） |
| 剪贴板打字通道 | 无（剪贴板同步≠打字） | 设置项"剪贴板同步"，与输入关系未见说明 | Ctrl+V 粘贴（写设备剪贴板）+ 按键序列注入 | C 回退：补齐反向 `screen.paste` |
| 用户门槛（被控端） | 开 RustDesk Input 无障碍；Android 13+ 侧载须先"允许受限设置" | 开 ToDesk 无障碍，免 root | adb/开发者选项；HID 须配键盘布局 | **零新增**：复用已开的 LinkSpace 无障碍服务（2.4-1） |
| 协议/实现量 | — | — | — | B1 零新增协议；B2 新增 `input.text` 一条消息；C 补 Android 接收分支 |
| 焦点依赖 | `commitText`/`sendKeyEvent` 都须焦点输入框 | 查不到 | 须焦点输入框 | 同左；无焦点时三条通道全灭，见 §8 |
| 剪贴板污染 | 否 | 未见说明 | 是（官方警告） | B1/B2 否；C 是 |
| 已知组字故障 | 有公开 issue（仓颉、韩文） | 查不到 | checklist 2.5–2.7 已记坑 | B1 须真机验证；B2 绕过组字故无此坑但无候选栏 |


## 6. 推荐方案与论证

### 6.1 推荐：B1（按键直通，默认）+ B2（文本直通）+ C（粘贴回退）

```
电脑键盘 ──B1── input.event(key) ──→ InputConnection.sendKeyEvent()
   │                                  → 平板自带输入法组字、候选栏、选词上屏
   │         PC 端中文输入法已组字好的成品
   ├──B2── input.text { text } ──→ InputConnection.commitText() 直接上屏
   │
   └──C── screen.paste { text } ──→ 写平板剪贴板 + Ctrl+V（回退）
```

**B1 是唯一能字面满足 2.3-3 验收的通道**：验收写的是"在平板自带输入法界面输入中文，候选栏跟随、组词不丢字"——只有让平板自带的输入法自己组字才能满足。B2 与 C 都是"成品直上"，候选栏过程不在平板上发生，只能算"能上屏"，不能算通过 2.3-3 字面验收。

### 6.2 为什么是 B：四条理由

1. **与已选的选型 A 同构，边际成本最低**。B1 就是现有 key 通道的延伸：桌面发 VK → `ControlledInputInjector` 映射 keyCode → `LinkSpaceAccessibilityService` 已实现的 `sendKeyEvent` 分支。零新增协议、零新增 Android 服务、零新增用户授权。B2 只需在同一 `InputConnection` 句柄上加一个 `commitText` 入口 + 一条新消息。RustDesk 与 scrcpy 的核实结论互相印证：两家都没有为中文另起自研输入法，都是"按键直通设备 IME 组字"或"成品文本直通"二选一。
2. **用户门槛零新增**。B1/B2 复用 2.4-1 已要求用户手动开启的无障碍服务（且 LinkSpace 配置已设 `flagInputMethodEditor`，符合官方文档要求）。对照：A 路线要用户再去设置里启用一个输入法、每次会话切换输入法；scrcpy 路线要 adb/开发者选项——都比 B 重。
3. **与 2.3-3 的张力已正面处理**。任务原文说"vk 通道表达不了 IME 组合输入，须另设通道"——这里的"vk 通道"指**线 1 的 Windows VK 注入**（往 Windows 被控端发 VK，中文 IME 组字需要完整的键盘消息序列，VK 注入表达不了）。B1 不是 VK 注入：它是经 Android `InputConnection` 把按键事件交给平板输入法，由输入法自己完成组字，是另一条通道。但这句话留了一个活口：**B1 成立的前提是平板输入法确实响应 `sendKeyEvent` 做组字**——RustDesk 的 issue 史（§2.4）证明这在不同输入法/ROM 上并不一致。所以 B1 必须真机验证；若验证失败，B1 作废，"另设通道"就落到 B2/C/A（见 §8 降级链）。
4. **分工干净**：B1 管"打字过程"（拼音、候选栏、选词、逐字上屏），B2 管"成品文本"（PC 端输入法组字完成后的中文、长文本、emoji/特殊符号），C 管"应用不吃前两条时"的兜底。三条通道寄生同一个 input 会话授权，不新增授权位（与 `screen.paste` 4.8 的口径一致）。

### 6.3 为什么否决 A（自研 InputMethodService）

| 否决点 | 说明 |
|---|---|
| 用户门槛最高 | 须用户去"设置 → 系统 → 键盘 → 屏幕键盘"里手动启用 LinkSpace 输入法（Android 出于安全原因强制手动启用，未启用的输入法不会出现在切换列表），且**每次会话都要切换一次输入法**（普通应用无权用代码指定切换输入法；只有 IME 自己能调 `switchInputMethod()` 切走/切回，仍须用户先切进来）。 |
| 会话期间本机打字断裂 | 同一时间只能有一个输入法处于活动状态。LinkSpace IME 激活期间，平板用户点任何输入框弹出的都是 LinkSpace IME 的界面；它若不自带全功能软键盘，用户本机就无法打字——等于为一次远控会话拆掉平板的打字能力。 |
| 隐私与商店政策风险 | IME 能读到用户在所有应用里输入的全部内容（密码、聊天记录），须在 UI 与文档中明示；以"中继"为唯一功能的 IME（无键盘 UI）还可能触碰应用商店对输入法类应用的政策。 |
| 不满足 2.3-3 字面验收 | 自研 IME 自己不做拼音联想（重写一个拼音输入法不现实），只能接收 PC 端组字好的成品 `commitText`——组字在 PC 端完成，候选栏在 PC 端，与验收"在平板自带输入法界面输入中文"直接冲突。采纳 A 须先改验收标准。 |
| 实现量最大 | 新 Service + manifest 声明（`BIND_INPUT_METHOD`）+ 与 `LinkSpaceService` 的同 UID 进程间文本通道 + 切换引导 UI + 断线切回逻辑 + 组字状态管理。 |

**A 的定位**：仅当 B1 真机验证失败（平板输入法不响应 `sendKeyEvent` 组字）**且**用户接受把 2.3-3 验收改成"PC 端组字、平板成品上屏"时，才作备选。实现 A 之前须先拿到用户对"每次切换输入法 + 会话期间本机打字受限"的明确接受。

### 6.4 桌面端要补的模式设计（B1/B2 能成立的前提）

PC 端键盘同一时刻只能有一种含义，必须显性分模式，否则与 scrcpy 同款陷阱（PC 中文态组字后发来的成品走不了按键路）：

- **拼音直通模式（默认，B1）**：桌面窗口捕获原始按键发 `input.event(key)`；窗口内明确提示"请将电脑输入法切到英文，打拼音由平板输入法组字"（scrcpy、ToDesk 手机控电脑方向同款要求）。空格/数字键直通，用于平板候选栏选词。
- **成品输入模式（B2/C）**：用户在 PC 端用自己的中文输入法组字完成（或粘贴大段文本）后，按发送键走 `input.text`（首选）或 `screen.paste`（回退）。此模式与 B1 互斥：一次会话里两种模式混用会打乱平板输入法的组字状态（见 §8.3）。

---

## 7. 实现清单（按依赖顺序，全部未实现）

### 7.1 协议（先登记，后实现；见 2.2-3 冻结口径）

| # | 内容 | 入口 | 验收 |
|---|---|---|---|
| P-1 | `docs/protocol.md` 新增 `input.text`：`{ text }`，控制端→被控端，寄生 input 会话授权（与 4.8 同口径，不新增授权位）；单条文本上限建议 ≤ 8 KiB（约 4000 汉字，同步 Binder 调用防卡顿），超长由控制端分段；标注 `[PROTOCOL]` 日期 | `docs/protocol.md`（新 §4.9） | 协议文档与两端实现一致 |
| P-2 | `screen.paste` 补 Android 接收侧登记：4.8 现只写了发送语义，补"桌面→平板：写剪贴板 + Ctrl+V + 回环抑制（2.4-3）" | `docs/protocol.md` §4.8 | 与 C-1 实现对应 |
| P-3 | `docs/symmetric-control-tasks.md` 2.3-3 备注：登记 B1+B2+C 方案与降级链；把"线 2 注入选型 A 路线的中文输入通道具体怎么做未定"改为已定（本文链接） | `docs/symmetric-control-tasks.md` | 未决项闭环 |

### 7.2 Android 被控端

| # | 内容 | 入口 | 验收 |
|---|---|---|---|
| A-1 | `ControlledInputSession` 增加 `input.text` 分发：会话匹配校验与 `input.event` 同口径（无活动会话/来源不符一律忽略，失败原因明确上报） | `ControlledInputSession.kt` | 非法批次整批拒绝，不静默 |
| A-2 | `LinkSpaceAccessibilityService` 增加 `commitText(text)` 入口：复用现有 `InputConnection` 句柄；无连接（无焦点输入框）/ Android < 13 回明确失败原因；提交前按 `InputConnection` 契约结束当前组字（`commitText` 本身会结束组字，实现时以真机为准） | `LinkSpaceAccessibilityService.kt` | 有焦点时中文成品一次上屏；无焦点时报"请先点一下输入框" |
| A-3 | 补 `screen.paste` 接收分支：`LinkSpaceService` 两处分发加 `TYPE_SCREEN_PASTE` → 写剪贴板（`ClipboardManager.setPrimaryClip`）→ 注入 Ctrl+V（走现有 key 通道）→ **来源标记/抑制窗口**，不触发本机剪贴板同步回推（2.4-3 防回环） | `LinkSpaceService.kt` | 双向各复制一次不循环；超 512 KiB 按 4.8 丢弃留痕 |
| A-4 | B1 零新增代码，但须把现有 `sendKeyEvent` 分支的失败原因透传到桌面端 UI（"无焦点输入框/未开启/低于 Android 13"三类原因已在实现里区分，只需确认上报链路通到 UI） | `LinkSpaceAccessibilityService.kt` + 会话层 | 桌面端能看到"为什么打不上字" |

### 7.3 桌面控制端

| # | 内容 | 入口 | 验收 |
|---|---|---|---|
| D-1 | 平板画面窗口（2.3-2）加输入模式开关：拼音直通（B1，默认）/ 成品输入（B2/C）；拼音模式下窗口内常驻提示"电脑输入法请切英文" | 平板画面窗口工具栏 | 模式可见、可切换；切模式时平板侧组字状态已复位（见 §8.3） |
| D-2 | 发 `input.text`（B2）：成品文本框 + 发送；超长自动分段（≤ 8 KiB/段）；发送失败（无焦点等）把被控端回的原因原样展示 | 桌面控制端 | 中文成品上屏；失败原因可见 |
| D-3 | 发 `screen.paste`（C，回退）：桌面→平板方向发送侧（与 `LinkSpaceService.sendScreenPaste` 对称的新增）；发送前提示"将覆盖平板剪贴板" | 桌面控制端 | 与 A-3 联调通过，无回环 |
| D-4 | 无焦点兜底 UI：收到被控端"无焦点输入框"失败时，窗口内提示"请先点一下平板画面里的输入框"，不自动点按聚焦（自动点按有误触风险） | 平板画面窗口 | 提示明确；用户手动点按后可继续打字 |

### 7.4 走查清单（并入 2.6，联想小新平板 Pro GT 真机）

- [ ] B1：拼音直通，候选栏跟随光标、连续组词不丢字、数字键/空格选词、退格删组字
- [ ] B1：输入一半切到别的窗口再回来，不重复上屏、组字状态不乱（2.3-3 原验收 + checklist 2.7）
- [ ] B2：PC 端组字好的中文、emoji、特殊字符、全角标点一次上屏
- [ ] C：大段中文粘贴一次到位；粘贴后平板原剪贴板内容被覆盖有提示；双向剪贴板无回环
- [ ] 无焦点：三条通道分别给出明确失败与引导，不静默丢字
- [ ] 断线/息屏/锁屏后恢复：本机输入正常，无残留组字状态（2.4-2 同口径）
- [ ] 目标应用覆盖：系统备忘录/微信输入框/浏览器地址栏/密码框至少各一处（commitText 与粘贴在密码框的表现须单列记录）

---

## 8. 用户侧门槛说明

### 8.1 平板侧（被控端）：零新增

- 只须 2.4-1 已要求的无障碍服务开启（一次开启，常驻有效）。B1/B2/C 都不要求用户再开任何开关、不要求装输入法、不要求切换输入法、不要求 adb/开发者选项。
- 若平板系统版本低于 Android 13：B1/B2 的输入连接路径不可用（现有实现已回明确失败），只剩 C（粘贴）可用；须在会话开始时提示用户。小新平板 Pro GT（TB710FU）的系统版本待真机确认，本文不编。

### 8.2 电脑侧（控制端）：一个使用约束

- 打中文（B1 拼音直通）时，**电脑输入法须切到英文状态**，拼音字母以原始按键发到平板，由平板输入法组字。这是 scrcpy、ToDesk（手机控电脑方向）同款要求，不是 LinkSpace 的特殊限制。
- 不想切英文时改用成品输入模式（B2/C）：在电脑端用自己的中文输入法组字完成再发送，候选栏过程在电脑端。

### 8.3 模式互斥规则（B1 与 B2/C 不可混用）

- 同一输入框内，B1 组字中途（拼音未选词）不得插入 B2 `commitText` 或 C 粘贴——成品提交会结束当前组字，未选的拼音按各输入法行为可能丢字或乱序。
- 实现规则：桌面端切模式时先向被控端发一次组字复位（B2 提交本身会结束组字；切到 B1 前确保上一段成品已提交完成）；会话层对混发批次按到达顺序串行处理，不并发。

## 9. 回退策略

| 场景 | 回退 |
|---|---|
| 无焦点输入框 | B1/B2/C 全部无路可走（输入连接与粘贴都须焦点）。桌面端提示"请先点一下平板画面里的输入框"（D-4），用户手动点按聚焦（手势点按已实现）；不自动点按聚焦。 |
| 目标应用不吃 `commitText`（B2 失效） | 降级到 C（`screen.paste` → Ctrl+V）；再不行，桌面端明示"该输入框不支持远程输入"，不静默丢字。 |
| 目标应用不接受粘贴（C 失效，如部分终端类应用） | 降级到 B1（若应用有输入框且接受按键）；三条全灭则明示不支持。 |
| B1 真机验证失败（平板输入法不响应 `sendKeyEvent` 组字） | B1 作废，主通道改为 B2 + C；2.3-3 验收须改写（候选栏过程改在电脑端）；A 路线仅在用户明确接受"每次切换输入法 + 会话期间本机打字受限"后才评估。 |
| 会话中途断线/息屏/锁屏 | B1/B2 无残留状态（输入连接是系统对象，会话结束即失效）；C 的剪贴板内容残留须在会话结束时提示用户（内容已进剪贴板，无法代用户清除）；重连后按 2.4-2 口径恢复或提示重连。 |
| PC 端输入法中文态误入 B1 | 按键会被 PC 端输入法组字拦截，到达平板的是零散按键或成品片段。桌面端在拼音模式下检测到组字中按键时提示切英文；不尝试在桌面端猜测组字状态。 |

## 10. 风险点与未验证项（全部待真机）

1. **B1 的核心不确定性**：平板输入法是否响应经 `InputConnection.sendKeyEvent` 注入的按键做拼音组字、弹候选栏。RustDesk 的 issue 史证明这条路在不同输入法/ROM 上表现不一致。须在小新平板 Pro GT 自带输入法上实测（候选栏跟随、组词、选词键），这是 B1 能否成立的唯一判据。
2. **RustDesk 配置异常的反向启示**：其 `accessibility_service_config.xml` 未设 `flagInputMethodEditor` 却调用 `getInputMethod()`，官方文档要求设该 flag。LinkSpace 已设该 flag，但 `getInputMethod()` 在各 ROM 上的实际返回值仍须真机确认（仓库已有"部分 ROM 读不到本服务"的先例，见 fix(android) 提交说明）。
3. **不同输入法/应用的 `commitText` 行为差异**：微信、浏览器地址栏、WebView 自定义输入框、密码框对 `commitText` 的接受程度不一；`AccessibilityInputConnection` 只暴露白名单方法，实现时须核对白名单（`finishComposingText` 是否在列）。
4. **剪贴板通道的隐私与回环**：C 会覆盖用户剪贴板（scrcpy 官方警告：任何应用可读）；且与 LinkSpace 自身双向剪贴板同步并存时有回环风险（2.4-3，抑制窗口/来源标记必须在 A-3 里做实，不能只写文档）。
5. **B1/B2 混用的组字状态**：规则见 §8.3；实现时须以真机为准，不可想当然。
6. **A 路线的政策风险**：若未来走到 A，须先评估应用商店对"无键盘 UI 的中继型 IME"的政策与 IME 全量输入可见性的隐私披露，未评估不得开工。

## 11. 来源汇总

- RustDesk 源码（gh api 核实，master，2026-11-03 读取）：`InputService.kt`（`onKeyEvent`）、`libs/base/protos/message.proto`（`message KeyEvent`）、`src/ui_session_interface.rs`（`input_string`）、`accessibility_service_config.xml`（未设 `flagInputMethodEditor`）
- https://github.com/rustdesk/rustdesk/discussions/11297
- https://deepwiki.com/ovftank/rustdesk/3.4-android-platform
- https://blog.wirelessmoves.com/2025/10/remote-android-support-with-rustdesk-part-1.html
- https://www.todesk.com/faq/92.html
- https://www.todesk.com/
- https://www.todesk.st/blog/861264410288197.html
- https://blog.csdn.net/loveyelong/article/details/124614096
- https://www.taptap.cn/moment/844275498027584601
- https://zamew.com/todesk/
- Genymobile/scrcpy 仓库（gh api 核实，v5.0.1）：`doc/keyboard.md`、`doc/control.md`、`doc/otg.md`
- https://github.com/wcai018/scrcpy-wireless-launcher/blob/HEAD/docs/README_EN.md
- https://www.redpacketsecurity.com/scrcpy-display-and-control-your-android-device/
- Android Developers：`AccessibilityService` InputMethod API 文档（`FLAG_INPUT_METHOD_EDITOR` 要求）、`InputMethod.AccessibilityInputConnection`（`sendKeyEvent` 语义）、"Create an input method"（IME 须用户在系统设置里手动启用，同一时间只能有一个输入法活动）
- https://www.techbone.net/android/manage-keyboards （第三方键盘须手动启用）
- 仓库内引用：`docs/symmetric-control-tasks.md`（2.3-3、2.4-3、未决项）、`docs/protocol.md` §4.8、`docs/scrcpy-manual-checklist.md` §2.5–2.7 / §3.6、`apps/android/.../service/ControlledInputInjector.kt`、`LinkSpaceAccessibilityService.kt`、`LinkSpaceService.kt`、`Protocol.kt`、`res/xml/accessibility_service_config.xml`、`apps/desktop/src/main/host.ts`（`screen.paste` 接收）

---

*本文只做调研与推荐，不含实现代码；实现按 §7 清单另开任务，真机验证全部待补。*
