// VDD 驱动生命周期管理器（线 3，⑤）。
//
// 管理开源 Virtual Display Driver（VirtualDrivers/Virtual-Display-Driver）
// 在本机的安装 / 启用 / 禁用 / 设置 / 卸载。驱动本身是 IddCx 间接显示
// 驱动，安装包以官方 driver-only zip 的形式随 LinkSpace 一起分发。
//
// 钉死版本（见 docs/line3-vdd.md ①）：
//   - Release 25.7.23，包 VirtualDisplayDriver-x86.Driver.Only.zip，
//     132,118 字节，SHA-256 E24210…B3A（上游 Release 页不公布哈希，
//     本值是 2026-11-03 从官方直链下载后实测的，见 docs/line3-vdd.md）。
//   - 驱动版本 11.30.4.434（MttVDD.inf DriverVer 12/24/2024），
//     设备节点 ROOT\DISPLAY\0001，设置 C:\VirtualDisplayDriver\vdd_settings.xml。
//
// 安全红线：
//   - 绝不碰 Secure Boot、不开 test signing、不装自签测试证书。
//     VDD 是 SignPath Foundation Authenticode 签名（非 WHQL），
//     静默安装的前提是把 SignPath 发布者证书放进本机 TrustedPublisher，
//     见 ensureInstalled() 里的信任步骤注释。
//   - 安装是用户显式动作：IPC 只暴露 vdd-driver:install，不设任何
//     自动调用点（启动、会话流程里都不调）。
//   - 活体动作（pnputil / Enable-PnpDevice）只在用户机器上由用户触发；
//     本文件的验证全部走注入的 fake runner，不动真实设备状态。
//
// 已知缺口已补（2026-11-03，设备节点创建）：pnputil /add-driver 只是把
// 驱动包暂存进驱动库并装到已存在的匹配设备上；在一台从未装过 VDD 的机器
// 上，设备节点本身（硬件 ID Root\MttVDD）还需另一步创建。本管理器用随包
// 原生助手 linkspace-rootdev.exe（native/winhelper/，自研 SetupDi 序列，
// 即 devcon install 的做法）补这一步，见 ensureInstalled() 第 8 步与
// createDeviceNode()。选型理由见 docs/line3-vdd.md（devcon 二进制不随包、
// SwDeviceCreate 句柄一关节点即删，均不用）。
// zero 上节点 2026-10-28 前后已建好，不受此缺口影响。
//
// 实例 ID 注意：节点实例 ID 由系统生成（全新机器上一般是 ROOT\DISPLAY\0000，
// zero 上是 ROOT\DISPLAY\0001——中段 DISPLAY 是设备类名，不是硬件 ID），
// 因此 status() 按硬件 ID Root\MttVDD 查找节点，不依赖固定实例 ID；
// setDeviceEnabled() 用查到的实际实例 ID 操作。DEVICE_INSTANCE_ID 只作
// 查不到时的回退值。

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { log } from '../log'
import type { VddDriverStatus } from '../../shared/types'

export const PINNED_VERSION = '25.7.23'
export const PINNED_SHA256 = 'E24210692B442B39AF763536330CE78B423F19342B7A7792C26DE3944E418B3A'
export const PINNED_SIZE = 132118
export const DOWNLOAD_URL =
  'https://github.com/VirtualDrivers/Virtual-Display-Driver/releases/download/25.7.23/VirtualDisplayDriver-x86.Driver.Only.zip'
export const VDD_ZIP_NAME = 'VirtualDisplayDriver-x86.Driver.Only.zip'
/** 设备节点硬件 ID（MttVDD.inf [Standard.NTamd64] 节）；status() 按它查找节点 */
export const ROOT_HARDWARE_ID = 'Root\\MttVDD'
/** 节点创建助手 exe 名（随包 resources/winhelper/，见 platform.locateRootdevHelper） */
export const ROOTDEV_HELPER_EXE = 'linkspace-rootdev.exe'
/** 回退用实例 ID（zero 现有节点）；正常走 status() 按硬件 ID 查到的实际实例 ID */
export const DEVICE_INSTANCE_ID = 'ROOT\\DISPLAY\\0001'
export const INF_NAME = 'mttvdd.inf'
export const EXPECTED_DRIVER_VERSION = '11.30.4.434'
export const SETTINGS_PATH = 'C:\\VirtualDisplayDriver\\vdd_settings.xml'
/** .cat 签名者证书的期望主题（CN=SignPath Foundation，见 docs/line3-vdd.md ①） */
export const EXPECTED_SIGNER_SUBJECT = 'SignPath Foundation'
export const CAT_NAME = 'mttvdd.cat'

export interface CommandResult {
  code: number
  stdout: string
  stderr: string
}

export type CommandRunner = (cmd: string, args: string[]) => Promise<CommandResult>

export type VddInstallResult =
  | { ok: true; alreadyInstalled: boolean }
  | { ok: false; reason: string; detail: string }

export type VddSimpleResult = { ok: true } | { ok: false; reason: string; detail: string }

export interface VddSettingsResult {
  ok: boolean
  reason?: string
  detail?: string
  count: number
  created: boolean
  changed: boolean
}

export interface VddDriverManagerOptions {
  /** 随包的驱动 zip 路径（platform.locateVddPackageZip）；null = 未随包，安装直接拒绝 */
  zipPath: string | null
  /** 节点创建助手路径（platform.locateRootdevHelper）；null = 未随包，全新机器上节点创建不可用 */
  helperPath?: string | null
  /** 命令执行层；不传则用真实 execFile。测试注入 fake runner */
  runner?: CommandRunner
  /** vdd_settings.xml 路径；默认 C:\VirtualDisplayDriver\vdd_settings.xml（测试可指到临时目录） */
  settingsPath?: string
  /** 覆盖钉死的哈希/大小——仅供测试用 fixture zip，生产绝不传 */
  pinnedSha256?: string
  pinnedSize?: number
}

/** 默认命令执行层：execFile 直调，超时 120s。失败不断言，统一以 code>0 返回。 */
function defaultRunner(cmd: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { windowsHide: true, timeout: 120_000, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout, stderr) => {
        const code = err
          ? typeof (err as { code?: unknown }).code === 'number'
            ? (err as { code: number }).code
            : 1
          : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}

/** PowerShell 单引号转义：' → '' */
function psQuote(s: string): string {
  return `'${s.replace(/'/g, "''")}'`
}

// ---------- pnputil / Get-PnpDevice 输出解析 ----------
//
// pnputil 在中文 Windows 上输出中文标签（已发布名称/原始名称/
// 驱动程序版本），英文系统上是英文标签。解析只依赖 ASCII 值本身，
// 与系统语言无关：
//   - 含 mttvdd.inf 的块即 VDD 驱动包；块内第一个 oem\d+\.inf 是已发布名，
//     第一个 \d+\.\d+\.\d+\.\d+ 是驱动版本（Class GUID 里的数字带横杠，
//     不会误 match；INF Version 只有两段，也不会误 match）。
// Get-PnpDevice 的 Status / Problem / Present 三个值本身就是 ASCII；
// InstanceId 一并解析（节点实例 ID 由系统生成，全新机器上一般是
// ROOT\DISPLAY\0000，zero 上是 ROOT\DISPLAY\0001，调用方不得硬编码）。

export function parsePnputilDrivers(output: string): {
  installed: boolean
  installedVersion: string | null
  oemInf: string | null
} {
  const blocks = output.split(/\r?\n\s*\r?\n/)
  for (const block of blocks) {
    if (!/mttvdd\.inf/i.test(block)) continue
    const oem = block.match(/oem\d+\.inf/i)?.[0] ?? null
    const version = block.match(/\d+\.\d+\.\d+\.\d+/)?.[0] ?? null
    return { installed: true, installedVersion: version, oemInf: oem }
  }
  return { installed: false, installedVersion: null, oemInf: null }
}

export function parsePnpDevice(output: string): {
  present: boolean
  enabled: boolean
  instanceId: string | null
} {
  const lines = output.split(/\r?\n/)
  let status: string | null = null
  let present: string | null = null
  let instanceId: string | null = null
  for (const line of lines) {
    const m = line.match(/^\s*(InstanceId|Status|Problem|Present)\s*:\s*(.+?)\s*$/i)
    if (!m) continue
    const key = m[1]!.toLowerCase()
    if (key === 'instanceid') instanceId = m[2]!
    else if (key === 'status') status = m[2]!
    else if (key === 'present') present = m[2]!
  }
  if (status === null && present === null) return { present: false, enabled: false, instanceId: null }
  return {
    present: present === null ? true : present.toLowerCase() !== 'false',
    enabled: status === 'OK',
    instanceId
  }
}

// ---------- 默认设置模板 ----------
//
// 与 25.7.23 driver-only 包内自带的 vdd_settings.xml 内容一致
// （5 档分辨率，含 1920×1080@30；全局刷新率 60–244 Hz）。
// 仅 <count> 由调用方指定。zero 现有文件多一条 1600×720@60，
// 那是用户后加的档位——ensureSettings() 读到现有文件时原样保留，
// 只改 count、只追加缺失的 preferred 档位，绝不重写整份文件。

const DEFAULT_SETTINGS_XML = `<?xml version='1.0' encoding='utf-8'?>
<vdd_settings>
    <monitors>
        <count>1</count>
    </monitors>
    <gpu>
        <friendlyname>default</friendlyname>
    </gpu>
	<global>
		<!--These are global refreshrates, any you add in here, will be replicated to all resolutions-->
		<g_refresh_rate>60</g_refresh_rate>
		<g_refresh_rate>90</g_refresh_rate>
		<g_refresh_rate>120</g_refresh_rate>
		<g_refresh_rate>144</g_refresh_rate>
		<g_refresh_rate>165</g_refresh_rate>
		<g_refresh_rate>244</g_refresh_rate>
	</global>
    <resolutions>
        <resolution>
            <width>800</width>
            <height>600</height>
            <refresh_rate>30</refresh_rate>
        </resolution>
        <resolution>
            <width>1366</width>
            <height>768</height>
            <refresh_rate>30</refresh_rate>
        </resolution>
        <resolution>
            <width>1920</width>
            <height>1080</height>
            <refresh_rate>30</refresh_rate>
        </resolution>
        <resolution>
            <width>2560</width>
            <height>1440</height>
            <refresh_rate>30</refresh_rate>
        </resolution>
        <resolution>
            <width>3840</width>
            <height>2160</height>
            <refresh_rate>30</refresh_rate>
        </resolution>
    
        
    </resolutions>
    <options>
		<CustomEdid>false</CustomEdid> <!-- Custom Edid should be named "user_edid.bin"! This does not support emulating resolutions!-->
		<PreventSpoof>false</PreventSpoof> <!--Enable this to prevent manufacturer spoofing when using custom edid. Please only do so if you need to!-->
		<EdidCeaOverride>false</EdidCeaOverride> <!--Enable this to override or add hard coded cea-extension block to custom Edid support allowing you to enable HDR-->
		<HardwareCursor>true</HardwareCursor>
		<SDR10bit>false</SDR10bit>
		<HDRPlus>false</HDRPlus> <!-- If you have SDR10 bit enabled, HDRPlus wont work - there’s a conflict because the display system cannot simultaneously handle both high dynamic range 12-bit and standard dynamic range 10-bit settings. -->
		<logging>false</logging>
        <!-- DEBUG LOGGING FOR EXPERTS ONLY!-->
        <debuglogging>false</debuglogging> 
        <!-- DEBUG LOGS CAN GENERATE 1000+ LINES-->
		<!-- Warning: Leaving logging on too long can lead to excessive filesize. Especially DebugLogging, which should only be used for short periods to log errors. -->
		<!-- Logging: Useful to troubleshoot and determine which GPUs are being used, and if displays are working as intended.-->
		<!-- Debug Logging: Logs local system information with every driver function/event/process. Useful for GitHub Help Tickets.-->
	</options>
</vdd_settings>`

export class VddDriverManager {
  private readonly zipPath: string | null
  private readonly helperPath: string | null
  private readonly runner: CommandRunner
  private readonly settingsPath: string
  private readonly pinnedSha256: string
  private readonly pinnedSize: number

  constructor(opts: VddDriverManagerOptions) {
    this.zipPath = opts.zipPath
    this.helperPath = opts.helperPath ?? null
    this.runner = opts.runner ?? defaultRunner
    this.settingsPath = opts.settingsPath ?? SETTINGS_PATH
    this.pinnedSha256 = opts.pinnedSha256 ?? PINNED_SHA256
    this.pinnedSize = opts.pinnedSize ?? PINNED_SIZE
  }

  private runPs(script: string): Promise<CommandResult> {
    return this.runner('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script])
  }

  /** 当前是否是管理员（驱动安装/启用/卸载的前置条件） */
  private async checkAdmin(): Promise<boolean> {
    try {
      const r = await this.runPs(
        '[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)'
      )
      return r.code === 0 && r.stdout.trim() === 'True'
    } catch (err) {
      log.warn(`[vdd-driver] 管理员检查失败：${String(err)}`)
      return false
    }
  }

  /**
   * 只读状态快照。任一命令失败都按“未装/未知”降级，不抛错——
   * status() 是设置页轮询的读接口，不能因为一次命令失败炸掉 UI。
   */
  async status(): Promise<VddDriverStatus> {
    let installed = false
    let installedVersion: string | null = null
    let oemInf: string | null = null
    try {
      const r = await this.runner('pnputil.exe', ['/enum-drivers'])
      if (r.code === 0) {
        const parsed = parsePnputilDrivers(r.stdout)
        installed = parsed.installed
        installedVersion = parsed.installedVersion
        oemInf = parsed.oemInf
      } else {
        log.warn(`[vdd-driver] pnputil /enum-drivers 失败（code=${r.code}），按未安装处理`)
      }
    } catch (err) {
      log.warn(`[vdd-driver] pnputil 调用异常：${String(err)}`)
    }

    let devicePresent = false
    let deviceEnabled = false
    let deviceInstanceId: string | null = null
    try {
      // 按硬件 ID 找节点，不按固定实例 ID：实例 ID 由系统生成，全新机器上
      // 一般是 ROOT\DISPLAY\0000，zero 上是 ROOT\DISPLAY\0001，硬编码必错。
      const r = await this.runPs(
        `Get-PnpDevice -Class Display | Where-Object { $_.HardwareID -contains ${psQuote(ROOT_HARDWARE_ID)} } | Select-Object -First 1 | Format-List InstanceId, Status, Problem, Present`
      )
      if (r.code === 0 && r.stdout.trim()) {
        const parsed = parsePnpDevice(r.stdout)
        devicePresent = parsed.present
        deviceEnabled = parsed.enabled
        deviceInstanceId = parsed.instanceId
      }
    } catch (err) {
      log.warn(`[vdd-driver] Get-PnpDevice 调用异常：${String(err)}`)
    }

    const isAdmin = await this.checkAdmin()
    const packageBundled = this.zipPath !== null && existsSync(this.zipPath)
    return { installed, installedVersion, oemInf, deviceEnabled, devicePresent, deviceInstanceId, packageBundled, isAdmin }
  }

  /**
   * 安装驱动（用户显式动作）。流程：
   *   1. 已装且版本符合且节点存在 → 直接 ok，不重复装。
   *   2. 管理员检查 → 不是管理员直接拒绝（不弹 UAC、不提权）。
   *   3. 随包 zip 校验：大小 + SHA-256 必须与钉死值一致，否则拒绝。
   *   4. 解到临时目录（PowerShell Expand-Archive）。
   *   5. 信任（驱动库里尚未暂存期望版本时才做）：从解包后的 mttvdd.cat
   *      取签名者证书 → 验 Status=Valid 且主题含 SignPath Foundation →
   *      导出 .cer → certutil 进本机 TrustedPublisher。详见方法内注释。
   *   6. pnputil /add-driver <inf> /install（同上，尚未暂存时才做）。
   *   7. 再查 status() 核对版本，确认装上了才继续；节点已存在即报 ok。
   *   8. 节点缺失（全新机器）：用随包助手 linkspace-rootdev.exe 创建
   *      根设备节点（硬件 ID Root\MttVDD）并装驱动 → 再查 status()，
   *      须 devicePresent=true 才报 ok，否则 node-create-failed。
   *
   * 每一步失败都返回可操作的 reason + detail；临时目录用完即清。
   */
  async ensureInstalled(): Promise<VddInstallResult> {
    const st = await this.status()
    if (st.installed && st.installedVersion === EXPECTED_DRIVER_VERSION && st.devicePresent) {
      log.info(`[vdd-driver] 驱动已安装（版本 ${EXPECTED_DRIVER_VERSION}），无需重复安装`)
      return { ok: true, alreadyInstalled: true }
    }
    if (st.installed) {
      log.warn(
        `[vdd-driver] 驱动库里已有 mttvdd.inf，但版本是 ${st.installedVersion ?? '未知'}，` +
          `将按钉死版本 ${EXPECTED_DRIVER_VERSION} 重新安装`
      )
    }
    if (!st.isAdmin) {
      return {
        ok: false,
        reason: 'not-admin',
        detail: '安装驱动需要管理员权限：请以管理员身份运行 LinkSpace 后重试'
      }
    }
    if (!st.packageBundled || !this.zipPath) {
      return {
        ok: false,
        reason: 'package-missing',
        detail: `随安装包附带的 VDD 驱动包缺失（${VDD_ZIP_NAME}），请重新安装 LinkSpace 或检查安装包完整性`
      }
    }

    // 3. 校验随包 zip：大小 + SHA-256，双项都必须与钉死值一致。
    // 上游 Release 页不公布哈希，本值是 2026-11-03 从官方直链下载后
    // 实测的（见 docs/line3-vdd.md ①）；不符即拒绝，不装来路不明的包。
    let zipBytes: Buffer
    try {
      zipBytes = readFileSync(this.zipPath)
    } catch (err) {
      return { ok: false, reason: 'package-missing', detail: `驱动包无法读取：${String(err)}` }
    }
    if (zipBytes.length !== this.pinnedSize) {
      log.warn(`[vdd-driver] 驱动包大小不符：期望 ${this.pinnedSize}，实际 ${zipBytes.length}`)
      return {
        ok: false,
        reason: 'hash-mismatch',
        detail: `驱动包大小不符（期望 ${this.pinnedSize} 字节，实际 ${zipBytes.length} 字节），可能不是钉死的 ${PINNED_VERSION} 版本，请勿安装`
      }
    }
    const sha256 = createHash('sha256').update(zipBytes).digest('hex')
    if (sha256.toLowerCase() !== this.pinnedSha256.toLowerCase()) {
      log.warn('[vdd-driver] 驱动包 SHA-256 不符，拒绝安装')
      return {
        ok: false,
        reason: 'hash-mismatch',
        detail: `驱动包 SHA-256 与钉死的 ${PINNED_VERSION} 版本不符，请勿安装（可能被篡改或版本漂移）`
      }
    }

    // 4. 解到临时目录。zip 内是 VirtualDisplayDriver/ 子目录，含
    // MttVDD.inf / MttVDD.dll / mttvdd.cat / vdd_settings.xml。
    const tmp = await mkdtemp(join(tmpdir(), 'linkspace-vdd-'))
    try {
      const extract = await this.runPs(
        `Expand-Archive -LiteralPath ${psQuote(this.zipPath)} -DestinationPath ${psQuote(tmp)} -Force`
      )
      if (extract.code !== 0) {
        return {
          ok: false,
          reason: 'extract-failed',
          detail: `驱动包解压失败（code=${extract.code}）：${(extract.stderr || extract.stdout).trim().slice(-200) || '未知错误'}`
        }
      }
      const extractedDir = join(tmp, 'VirtualDisplayDriver')
      const infPath = join(extractedDir, 'MttVDD.inf')
      const catPath = join(extractedDir, CAT_NAME)
      const cerPath = join(tmp, 'signpath.cer')

      // 驱动库里已暂存期望版本时（例如上次安装走到节点创建才失败），
      // 跳过信任 + pnputil 两步——重复暂存没有意义，直接去第 8 步建节点。
      const staged = st.installed && st.installedVersion === EXPECTED_DRIVER_VERSION
      if (!staged) {
        const stagedRes = await this.stageDriver(infPath, catPath, cerPath)
        if (!stagedRes.ok) return stagedRes

        // 7. 复核：驱动库里必须出现期望版本，否则不算装好。
        const after = await this.status()
        if (!(after.installed && after.installedVersion === EXPECTED_DRIVER_VERSION)) {
          return {
            ok: false,
            reason: 'verify-failed',
            detail: `pnputil 返回成功，但复核时驱动库里没有期望版本 ${EXPECTED_DRIVER_VERSION}（实际 ${after.installedVersion ?? '未装'}），安装未生效`
          }
        }
        if (after.devicePresent) {
          log.info(`[vdd-driver] 驱动安装成功（版本 ${EXPECTED_DRIVER_VERSION}，${after.oemInf ?? 'oemInf 未知'}）`)
          return { ok: true, alreadyInstalled: false }
        }
      } else {
        log.info('[vdd-driver] 驱动包已在库且版本符合，跳过重复暂存，直接创建缺失的设备节点')
      }

      // 8. 节点创建（全新机器 / 驱动在库但节点缺失时）：随包助手创建根
      // 设备节点并装驱动；再复核，须 devicePresent=true 才报 ok。
      const node = await this.createDeviceNode(infPath)
      if (!node.ok) return node
      const finalSt = await this.status()
      if (finalSt.installed && finalSt.installedVersion === EXPECTED_DRIVER_VERSION && finalSt.devicePresent) {
        log.info(
          `[vdd-driver] 驱动安装成功（版本 ${EXPECTED_DRIVER_VERSION}，节点 ${finalSt.deviceInstanceId ?? '实例 ID 未知'}）`
        )
        return { ok: true, alreadyInstalled: staged }
      }
      return {
        ok: false,
        reason: 'node-create-failed',
        detail: '节点创建助手已返回成功，但复核时仍未找到设备节点（硬件 ID Root\\MttVDD），请重试安装或检查设备管理器'
      }
    } finally {
      await rm(tmp, { recursive: true, force: true }).catch((err) => {
        log.warn(`[vdd-driver] 临时目录清理失败：${String(err)}`)
      })
    }
  }

  /**
   * 暂存驱动（ensureInstalled 第 5–6 步）：信任 SignPath 发布者证书 +
   * pnputil /add-driver <inf> /install。仅在驱动库里尚未暂存期望版本时调用。
   */
  private async stageDriver(infPath: string, catPath: string, cerPath: string): Promise<VddSimpleResult> {
    // 5. 信任 SignPath 发布者证书。
    //
    // 选定的方法：从 .cat 实时取签名者证书，不随包附带 .cer。
    // 理由：
    //   a. 上游 driver-only 包里只有 .inf/.dll/.cat，没有 .cer——
    //      证书只能从包里现取；现取还把信任锚定在刚验过哈希的同一份
    //      包上，不存在“附带的 .cer 与驱动包漂移”的风险。
    //   b. 只导叶子证书（签名者本人），不导整条链：SignPath →
    //      GlobalSign R45 的链根早已在 Windows 受信根里（TwinDesk
    //      issue #14 的实测佐证：链构建 OK、根在 LocalMachine\Root），
    //      本步只需把“发布者可信”这一环补上。绝不往 Root 里加任何东西。
    //   c. 机制是微软官方文档的做法：非 WHQL 的 Authenticode 签名驱动，
    //      发布者进了 TrustedPublisher 即可静默预装（Microsoft Learn
    //      "Digital Signatures and PnP Device Installation"）；执行用
    //      certutil -addstore TrustedPublisher（本地计算机存储，需管理员）。
    //   d. 双重校验才放行：签名 Status 必须 Valid，且证书主题必须含
    //      SignPath Foundation——换了签名者的包到这步即拦下。
    //   上游同类讨论：Virtual-Display-Driver issue #315。
    //   注意：这一步只影响“驱动安装时是否弹发布者信任框”，不改
    //   Secure Boot、不开 test signing、不装自签证书。
    const trustExport = await this.runPs(
      `$sig = Get-AuthenticodeSignature -LiteralPath ${psQuote(catPath)}; ` +
        `if ($sig.Status -ne 'Valid') { exit 10 }; ` +
        `if ($sig.SignerCertificate.Subject -notmatch ${psQuote(EXPECTED_SIGNER_SUBJECT)}) { exit 11 }; ` +
        `[System.IO.File]::WriteAllBytes(${psQuote(cerPath)}, $sig.SignerCertificate.Export('Cert'))`
    )
    if (trustExport.code !== 0) {
      const detail =
        trustExport.code === 10
          ? '驱动目录文件（mttvdd.cat）的 Authenticode 签名无效，请勿安装'
          : trustExport.code === 11
            ? `签名者不是期望的 ${EXPECTED_SIGNER_SUBJECT}，请勿安装`
            : `从签名中提取发布者证书失败（code=${trustExport.code}）`
      return { ok: false, reason: 'trust-failed', detail }
    }
    const trustImport = await this.runner('certutil.exe', ['-addstore', '-f', 'TrustedPublisher', cerPath])
    if (trustImport.code !== 0) {
      return {
        ok: false,
        reason: 'trust-failed',
        detail: `发布者证书导入 TrustedPublisher 失败（code=${trustImport.code}），静默安装无法继续：${(trustImport.stderr || trustImport.stdout).trim().slice(-200) || '未知错误'}`
      }
    }
    log.info('[vdd-driver] SignPath 发布者证书已导入 TrustedPublisher')

    // 6. 装驱动。
    const add = await this.runner('pnputil.exe', ['/add-driver', infPath, '/install'])
    if (add.code !== 0) {
      const tail = (add.stderr || add.stdout).trim().slice(-300)
      const hint = /0x800B0109/i.test(tail)
        ? '（0x800B0109：签名不被信任——ARM64 Windows 只接受微软签名的驱动包，VDD 暂不支持 ARM64；x64 上出现此码请检查 TrustedPublisher 导入是否成功）'
        : ''
      return {
        ok: false,
        reason: 'install-failed',
        detail: `pnputil /add-driver 失败（code=${add.code}）${hint}：${tail || '未知错误'}`
      }
    }
    return { ok: true }
  }

  /**
   * 创建设备节点（ensureInstalled 第 8 步）：调随包原生助手
   * linkspace-rootdev.exe（native/winhelper/），做 devcon install 同款事——
   * SetupDi 建节点 + DIF_REGISTERDEVICE + UpdateDriverForPlugAndPlayDevices；
   * 节点已存在时助手跳过创建只装驱动（幂等）。
   * 失败返回 node-create-failed + 助手输出尾部；成功只表示助手退出码为 0，
   * 节点是否真出现由调用方再查 status() 复核。
   */
  private async createDeviceNode(infPath: string): Promise<VddSimpleResult> {
    if (!this.helperPath || !existsSync(this.helperPath)) {
      return {
        ok: false,
        reason: 'node-create-failed',
        detail: '设备节点创建助手缺失（linkspace-rootdev.exe 未随包）：驱动包已暂存，但设备节点无法创建，请重新安装 LinkSpace 或检查安装包完整性'
      }
    }
    const r = await this.runner(this.helperPath, ['install', infPath, ROOT_HARDWARE_ID])
    if (r.code === 0) {
      const tail = (r.stdout || '').trim().split(/\r?\n/).pop() ?? ''
      log.info(`[vdd-driver] 节点创建助手成功：${tail}`)
      return { ok: true }
    }
    const tail = (r.stderr || r.stdout).trim().slice(-300)
    return {
      ok: false,
      reason: 'node-create-failed',
      detail: `设备节点创建失败（助手退出码 ${r.code}）：${tail || '未知错误'}。驱动包已暂存进驱动库，可重试安装；仍失败请以管理员身份在设备管理器中检查`
    }
  }

  /**
   * 启用 / 禁用设备节点（管理员 PowerShell）。
   * 不做“该不该启用”的判断——调用方（扩展会话/设置页）决定时机。
   */
  async setDeviceEnabled(enabled: boolean): Promise<VddSimpleResult> {
    const st = await this.status()
    if (!st.isAdmin) {
      return { ok: false, reason: 'not-admin', detail: '启用/禁用驱动设备需要管理员权限：请以管理员身份运行 LinkSpace 后重试' }
    }
    if (!st.devicePresent) {
      return {
        ok: false,
        reason: 'device-not-present',
        detail: `未找到设备节点（硬件 ID ${ROOT_HARDWARE_ID}）：驱动可能尚未安装，请先安装驱动`
      }
    }
    // 用 status() 按硬件 ID 查到的实际实例 ID（全新机器上一般是
    // ROOT\DISPLAY\0000，zero 上是 ROOT\DISPLAY\0001），不要硬编码。
    const target = st.deviceInstanceId ?? DEVICE_INSTANCE_ID
    const verb = enabled ? 'Enable-PnpDevice' : 'Disable-PnpDevice'
    const r = await this.runPs(`${verb} -InstanceId ${psQuote(target)} -Confirm:$false`)
    if (r.code !== 0) {
      return {
        ok: false,
        reason: enabled ? 'enable-failed' : 'disable-failed',
        detail: `${verb} 失败（code=${r.code}）：${(r.stderr || r.stdout).trim().slice(-200) || '未知错误'}`
      }
    }
    log.info(`[vdd-driver] 设备节点已${enabled ? '启用' : '禁用'}`)
    return { ok: true }
  }

  /**
   * 读/写 vdd_settings.xml，保证 count≥1。
   *   - 文件已存在：只改 <count>、只追加缺失的 preferred 档位，
   *     其余内容（用户后加的分辨率、全局刷新率、options）原样保留。
   *   - 文件缺失：按 25.7.23 包内自带模板新建（5 档分辨率，
   *     含 1920×1080@30），count 写调用方的值。
   * 写文件失败（如无管理员权限）返回 settings-write-failed。
   * 注意：改完设置需下次启用设备/重载驱动才生效，本方法不管启用。
   */
  async ensureSettings(
    count: number,
    preferred?: { width: number; height: number; refreshRate?: number }
  ): Promise<VddSettingsResult> {
    const wanted = Math.max(1, Math.floor(count) || 1)
    const refreshRate = preferred?.refreshRate ?? 30
    let existing: string | null = null
    try {
      existing = readFileSync(this.settingsPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        return { ok: false, reason: 'settings-read-failed', detail: `设置文件无法读取：${String(err)}`, count: wanted, created: false, changed: false }
      }
    }

    const resolutionBlock = (w: number, h: number, rr: number): string =>
      `        <resolution>\n            <width>${w}</width>\n            <height>${h}</height>\n            <refresh_rate>${rr}</refresh_rate>\n        </resolution>`
    const hasResolution = (xml: string, w: number, h: number, rr: number): boolean =>
      new RegExp(
        `<resolution>\\s*<width>${w}</width>\\s*<height>${h}</height>\\s*<refresh_rate>${rr}</refresh_rate>`,
        'i'
      ).test(xml)

    let xml: string
    let created = false
    if (existing === null) {
      xml = DEFAULT_SETTINGS_XML.replace(/<count>\d+<\/count>/, `<count>${wanted}</count>`)
      created = true
      if (preferred && !hasResolution(xml, preferred.width, preferred.height, refreshRate)) {
        xml = xml.replace('    </resolutions>', `${resolutionBlock(preferred.width, preferred.height, refreshRate)}\n    </resolutions>`)
      }
    } else {
      xml = existing
      const current = Number(xml.match(/<count>(\d+)<\/count>/)?.[1])
      if (current !== wanted) {
        xml = xml.replace(/<count>\d+<\/count>/, `<count>${wanted}</count>`)
      }
      if (preferred && !hasResolution(xml, preferred.width, preferred.height, refreshRate)) {
        if (!xml.includes('</resolutions>')) {
          return { ok: false, reason: 'settings-write-failed', detail: '设置文件结构异常：找不到 </resolutions>，无法追加分辨率档位', count: wanted, created: false, changed: false }
        }
        xml = xml.replace('</resolutions>', `${resolutionBlock(preferred.width, preferred.height, refreshRate)}\n    </resolutions>`)
      }
    }

    const changed = created || xml !== existing
    if (!changed) {
      return { ok: true, count: wanted, created: false, changed: false }
    }
    try {
      mkdirSync(dirname(this.settingsPath), { recursive: true })
      writeFileSync(this.settingsPath, xml, 'utf8')
    } catch (err) {
      return {
        ok: false,
        reason: 'settings-write-failed',
        detail: `设置文件无法写入（${(err as NodeJS.ErrnoException).code ?? '未知错误'}）：写 ${basename(this.settingsPath)} 需要管理员权限，请以管理员身份运行 LinkSpace 后重试`,
        count: wanted,
        created,
        changed: false
      }
    }
    log.info(`[vdd-driver] 设置已${created ? '新建' : '更新'}：count=${wanted}`)
    return { ok: true, count: wanted, created, changed: true }
  }

  /**
   * 卸载驱动：pnputil /delete-driver <oemInf> /uninstall。
   * 调用方保证：设备已禁用且无活动扩展会话。本方法只做一道防御性
   * 检查——设备仍启用时拒绝，不替调用方关会话。
   * 注意：不清理 TrustedPublisher 里的 SignPath 证书——证书是
   * “发布者可信”这一整机维度的信任，其他 SignPath 签名的驱动也可能
   * 依赖它；卸载只拆驱动包。
   */
  async uninstall(): Promise<{ ok: true; notInstalled?: boolean } | { ok: false; reason: string; detail: string }> {
    const st = await this.status()
    if (!st.installed) {
      log.info('[vdd-driver] 驱动未安装，无需卸载')
      return { ok: true, notInstalled: true }
    }
    if (st.deviceEnabled) {
      return {
        ok: false,
        reason: 'device-still-enabled',
        detail: '设备仍处于启用状态：请先禁用设备并结束扩展会话后再卸载'
      }
    }
    if (!st.isAdmin) {
      return { ok: false, reason: 'not-admin', detail: '卸载驱动需要管理员权限：请以管理员身份运行 LinkSpace 后重试' }
    }
    if (!st.oemInf) {
      return { ok: false, reason: 'uninstall-failed', detail: '驱动库里有 mttvdd.inf，但未找到已发布 INF 名，无法定位要删的包' }
    }
    const r = await this.runner('pnputil.exe', ['/delete-driver', st.oemInf, '/uninstall'])
    if (r.code !== 0) {
      return {
        ok: false,
        reason: 'uninstall-failed',
        detail: `pnputil /delete-driver 失败（code=${r.code}）：${(r.stderr || r.stdout).trim().slice(-200) || '未知错误'}`
      }
    }
    log.info(`[vdd-driver] 驱动已卸载（${st.oemInf}）`)
    return { ok: true }
  }
}
