// VDD 驱动生命周期无头测试（线 3，⑤ + 设备节点创建）。
//
// 全部用注入的 fake 命令执行器覆盖，不动真实设备状态：
//   1. status 解析——已装（英文/中文 pnputil 标签各一）与未装
//   2. 哈希不符拒绝安装（且一发 pnputil 都没打出去）
//   3. 安装 happy path（fake）：校验 → 解压 → 取证信任 → certutil →
//      pnputil /add-driver → 复核，断言每一步的命令都发对了
//   4. enable/disable 发出的 PowerShell 命令
//   5. settings 读/写（临时目录）：缺失新建、已有保留档位只改 count、
//      preferred 档位追加、count<1 钳到 1
//   6. uninstall：设备启用时拒绝、已禁用时发 /delete-driver
//   7. 节点创建（全新机器）：add-driver 后节点仍缺失 → 调随包助手
//      linkspace-rootdev.exe install <inf> Root\MttVDD → 复核节点出现
//   8. 节点创建失败 → node-create-failed；助手缺失 → node-create-failed
//      且不调助手；驱动已暂存但节点缺失时重跑安装跳过信任 + add-driver，
//      直奔助手
//
// 不碰真实 pnputil、不碰 Enable/Disable-PnpDevice、不改显示状态。
// 运行：npm run verify:vdd-driver（esbuild 打包后 node 执行）。

import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEVICE_INSTANCE_ID,
  EXPECTED_DRIVER_VERSION,
  ROOT_HARDWARE_ID,
  VddDriverManager,
  parsePnputilDrivers,
  parsePnpDevice,
  type CommandResult
} from './extend/vdd-driver'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function ok(stdout = '', code = 0): CommandResult {
  return { code, stdout, stderr: '' }
}

/** 记录每一次调用、按行为函数回包的 fake 执行器 */
class FakeRunner {
  calls: Array<{ cmd: string; args: string[] }> = []
  constructor(private behavior: (cmd: string, args: string[]) => CommandResult) {}
  run = async (cmd: string, args: string[]): Promise<CommandResult> => {
    this.calls.push({ cmd, args })
    return this.behavior(cmd, args)
  }
  /** 是否发过包含该片段的命令 */
  has(fragment: string): boolean {
    return this.calls.some(({ cmd, args }) => `${cmd} ${args.join(' ')}`.includes(fragment))
  }
  count(fragment: string): number {
    return this.calls.filter(({ cmd, args }) => `${cmd} ${args.join(' ')}`.includes(fragment)).length
  }
}

/** 英文 pnputil 输出（含 VDD 包） */
const PNPUTIL_EN = `Published Name:     oem116.inf
Original Name:      mttvdd.inf
Provider Name:      MikeTheTech
Class Name:         Display
Class GUID:         {4d36e968-e325-11ce-bfc1-08002be10318}
Driver Version:     12/24/2024 11.30.4.434
Signer Name:        SignPath Foundation

Published Name:     oem42.inf
Original Name:      someother.inf
Provider Name:      Other
Class Name:         Display
Driver Version:     01/01/2024 1.2.3.4
`

/** 中文 pnputil 输出（zero 实测的标签，值是 ASCII） */
const PNPUTIL_ZH = `已发布名称:      oem116.inf
原始名称:        mttvdd.inf
提供程序名称:    MikeTheTech
类:              Display
类 GUID:         {4d36e968-e325-11ce-bfc1-08002be10318}
驱动程序版本:    12/24/2024 11.30.4.434
签名者姓名:      SignPath Foundation
`

const PNPUTIL_NONE = `Published Name:     oem42.inf
Original Name:      someother.inf
Provider Name:      Other
Class Name:         Display
Driver Version:     01/01/2024 1.2.3.4
`

/** Get-PnpDevice：已禁用（zero 当前的真实状态） */
const PNPDEV_DISABLED = `InstanceId   : ROOT\\DISPLAY\\0001
FriendlyName : Virtual Display Driver
Status       : Error
Problem      : CM_PROB_DISABLED
Class        : Display
Present      : True
`

/** Get-PnpDevice：已启用 */
const PNPDEV_ENABLED = `InstanceId   : ROOT\\DISPLAY\\0001
FriendlyName : Virtual Display Driver
Status       : OK
Problem      : CM_PROB_NONE
Class        : Display
Present      : True
`

/** 管理员检查固定回 True 的行为；其余命令由各用例自己接管 */
function adminTrue(_cmd: string, _args: string[]): CommandResult {
  return ok('True\r\n')
}

async function main(): Promise<void> {
  console.log('\n=== VDD 驱动生命周期无头验证 ===\n')
  const dir = await mkdtemp(join(tmpdir(), 'linkspace-vdd-verify-'))
  try {
    // ---- 1. 解析器单测（不跑命令） ----
    console.log('1. pnputil / Get-PnpDevice 输出解析')
    const en = parsePnputilDrivers(PNPUTIL_EN)
    check('英文 pnputil 解析出已装', en.installed && en.oemInf === 'oem116.inf' && en.installedVersion === '11.30.4.434', `${en.oemInf} / ${en.installedVersion}`)
    const zh = parsePnputilDrivers(PNPUTIL_ZH)
    check('中文 pnputil 解析出已装', zh.installed && zh.oemInf === 'oem116.inf' && zh.installedVersion === '11.30.4.434', `${zh.oemInf} / ${zh.installedVersion}`)
    const none = parsePnputilDrivers(PNPUTIL_NONE)
    check('无 mttvdd 时解析出未装', !none.installed && none.oemInf === null && none.installedVersion === null)
    const dis = parsePnpDevice(PNPDEV_DISABLED)
    check('已禁用节点解析', dis.present && !dis.enabled && dis.instanceId === DEVICE_INSTANCE_ID, `present=${dis.present} enabled=${dis.enabled} instanceId=${dis.instanceId}`)
    const ena = parsePnpDevice(PNPDEV_ENABLED)
    check('已启用节点解析', ena.present && ena.enabled && ena.instanceId === DEVICE_INSTANCE_ID)
    check('空输出解析为不存在', !parsePnpDevice('').present && !parsePnpDevice('').enabled && parsePnpDevice('').instanceId === null)

    // ---- 2. status()：已装 + 已禁用 ----
    console.log('\n2. status() 已装/已禁用')
    const zipPath = join(dir, 'vdd.zip')
    await writeFile(zipPath, Buffer.from('fake-zip-bytes'))
    const fakeStatus = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_EN)
      if (joined.includes('Get-PnpDevice')) return ok(PNPDEV_DISABLED)
      return adminTrue(cmd, args)
    })
    const mgrStatus = new VddDriverManager({ zipPath, runner: fakeStatus.run })
    const st = await mgrStatus.status()
    check('status 已装', st.installed && st.installedVersion === EXPECTED_DRIVER_VERSION && st.oemInf === 'oem116.inf')
    check('status 设备存在但已禁用', st.devicePresent && !st.deviceEnabled)
    check('status 返回节点实例 ID', st.deviceInstanceId === DEVICE_INSTANCE_ID, st.deviceInstanceId ?? 'null')
    check('status 随包 zip 在', st.packageBundled)
    check('status 是管理员', st.isAdmin)

    // ---- 3. status()：未装 + 设备不存在 ----
    console.log('\n3. status() 未装/设备不存在')
    const fakeEmpty = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_NONE)
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'Get-PnpDevice : No such device' }
      return adminTrue(cmd, args)
    })
    const mgrEmpty = new VddDriverManager({ zipPath, runner: fakeEmpty.run })
    const st2 = await mgrEmpty.status()
    check('status 未装', !st2.installed && st2.installedVersion === null && st2.oemInf === null)
    check('status 设备不存在', !st2.devicePresent && !st2.deviceEnabled)

    // ---- 4. 哈希不符拒绝安装 ----
    console.log('\n4. 哈希不符拒绝安装')
    const fakeHash = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_NONE)
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'No such device' }
      return adminTrue(cmd, args)
    })
    const mgrHash = new VddDriverManager({ zipPath, runner: fakeHash.run })
    const hashRes = await mgrHash.ensureInstalled()
    check('哈希不符返回 hash-mismatch', !hashRes.ok && hashRes.reason === 'hash-mismatch', hashRes.ok ? '意外成功' : hashRes.reason)
    check('哈希不符时没打 pnputil /add-driver', !fakeHash.has('/add-driver'))
    check('哈希不符时没碰 certutil', !fakeHash.has('certutil'))
    check('哈希不符时没碰信任导出', !fakeHash.has('Get-AuthenticodeSignature'))

    // ---- 4b. 大小符合但 SHA 不符 → 同样拒绝（覆盖 SHA 分支本身） ----
    console.log('\n4b. 大小符合、SHA 不符拒绝安装')
    const fakeShaOnly = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_NONE)
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'No such device' }
      return adminTrue(cmd, args)
    })
    const shaOnlyZip = join(dir, 'sha-only.zip')
    const shaOnlyBytes = Buffer.from('size-matches-but-hash-wrong')
    await writeFile(shaOnlyZip, shaOnlyBytes)
    const mgrShaOnly = new VddDriverManager({
      zipPath: shaOnlyZip,
      runner: fakeShaOnly.run,
      pinnedSha256: '00'.repeat(32),
      pinnedSize: shaOnlyBytes.length
    })
    const shaOnlyRes = await mgrShaOnly.ensureInstalled()
    check('SHA 不符返回 hash-mismatch', !shaOnlyRes.ok && shaOnlyRes.reason === 'hash-mismatch', shaOnlyRes.ok ? '意外成功' : shaOnlyRes.reason)
    check('SHA 不符时没打 pnputil /add-driver', !fakeShaOnly.has('/add-driver'))

    // ---- 5. 非管理员拒绝安装 ----
    console.log('\n5. 非管理员拒绝安装')
    const fakeNoAdmin = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_NONE)
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'No such device' }
      if (joined.includes('IsInRole')) return ok('False\r\n')
      return ok('')
    })
    const mgrNoAdmin = new VddDriverManager({ zipPath, runner: fakeNoAdmin.run })
    const noAdminRes = await mgrNoAdmin.ensureInstalled()
    check('非管理员返回 not-admin', !noAdminRes.ok && noAdminRes.reason === 'not-admin', noAdminRes.ok ? '意外成功' : noAdminRes.reason)
    check('非管理员时没打 pnputil /add-driver', !fakeNoAdmin.has('/add-driver'))

    // ---- 6. 安装 happy path（fake） ----
    console.log('\n6. 安装 happy path（fake）')
    const fixture = Buffer.from('fake-zip-bytes-for-happy-path')
    const fixtureZip = join(dir, 'happy.zip')
    await writeFile(fixtureZip, fixture)
    const fixtureSha = createHash('sha256').update(fixture).digest('hex')
    let addDriverCalls = 0
    const fakeHappy = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe' && joined.includes('/enum-drivers')) {
        // 安装前未装，安装后已装
        return ok(addDriverCalls === 0 ? PNPUTIL_NONE : PNPUTIL_EN)
      }
      if (cmd === 'pnputil.exe' && joined.includes('/add-driver')) {
        addDriverCalls++
        return ok('Driver package added successfully.\r\nPublished Name: oem116.inf\r\n')
      }
      if (cmd === 'certutil.exe') return ok('CertUtil: -addstore command completed successfully.\r\n')
      if (joined.includes('Get-PnpDevice')) return ok(PNPDEV_DISABLED)
      if (joined.includes('Expand-Archive')) return ok('')
      if (joined.includes('Get-AuthenticodeSignature')) return ok('')
      return adminTrue(cmd, args)
    })
    const mgrHappy = new VddDriverManager({
      zipPath: fixtureZip,
      runner: fakeHappy.run,
      pinnedSha256: fixtureSha,
      pinnedSize: fixture.length
    })
    const happyRes = await mgrHappy.ensureInstalled()
    check('happy path 安装成功', happyRes.ok && !happyRes.alreadyInstalled, happyRes.ok ? 'ok' : `${happyRes.reason}：${happyRes.detail}`)
    check('发了 Expand-Archive 解压', fakeHappy.has('Expand-Archive'))
    check('信任导出用了 .cat 签名', fakeHappy.has('Get-AuthenticodeSignature') && fakeHappy.has('mttvdd.cat'))
    check('信任导出校验 SignPath 主题', fakeHappy.has('SignPath Foundation'))
    check('certutil 进 TrustedPublisher', fakeHappy.has('TrustedPublisher') && fakeHappy.has('certutil'))
    check('pnputil /add-driver 带 /install', fakeHappy.has('/add-driver') && fakeHappy.has('/install'))
    check('安装只打了一次 /add-driver', fakeHappy.count('/add-driver') === 1)
    check('节点已存在时不调助手', !fakeHappy.has('linkspace-rootdev.exe'))

    // ---- 7. 已装且版本符合直接 ok，不重复装 ----
    console.log('\n7. 已装直接 ok')
    const fakeAlready = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_EN)
      if (joined.includes('Get-PnpDevice')) return ok(PNPDEV_DISABLED)
      return adminTrue(cmd, args)
    })
    const mgrAlready = new VddDriverManager({ zipPath, runner: fakeAlready.run })
    const alreadyRes = await mgrAlready.ensureInstalled()
    check('已装返回 alreadyInstalled', alreadyRes.ok && alreadyRes.alreadyInstalled)
    check('已装时没打 /add-driver', !fakeAlready.has('/add-driver'))

    // ---- 8. enable / disable 发出的命令 ----
    console.log('\n8. enable / disable 命令')
    const fakeToggle = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_EN)
      if (joined.includes('Get-PnpDevice')) return ok(PNPDEV_DISABLED)
      return adminTrue(cmd, args)
    })
    const mgrToggle = new VddDriverManager({ zipPath, runner: fakeToggle.run })
    const enRes = await mgrToggle.setDeviceEnabled(true)
    check('enable 成功', enRes.ok, enRes.ok ? '' : enRes.detail)
    check('enable 发 Enable-PnpDevice', fakeToggle.has('Enable-PnpDevice') && fakeToggle.has(DEVICE_INSTANCE_ID))
    const disRes = await mgrToggle.setDeviceEnabled(false)
    check('disable 成功', disRes.ok, disRes.ok ? '' : disRes.detail)
    check('disable 发 Disable-PnpDevice', fakeToggle.has('Disable-PnpDevice'))

    // ---- 9. enable 时设备不存在 → 拒绝，不发命令 ----
    console.log('\n9. 设备不存在时 enable 拒绝')
    const fakeNoDev = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_NONE)
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'No such device' }
      return adminTrue(cmd, args)
    })
    const mgrNoDev = new VddDriverManager({ zipPath, runner: fakeNoDev.run })
    const noDevRes = await mgrNoDev.setDeviceEnabled(true)
    check('设备不存在返回 device-not-present', !noDevRes.ok && noDevRes.reason === 'device-not-present', noDevRes.ok ? '意外成功' : noDevRes.reason)
    check('拒绝时没发 Enable-PnpDevice', !fakeNoDev.has('Enable-PnpDevice'))

    // ---- 10. settings：缺失新建 ----
    console.log('\n10. settings 缺失新建')
    const settingsPath = join(dir, 'vdd_settings.xml')
    const mgrSettings = new VddDriverManager({ zipPath, runner: fakeStatus.run, settingsPath })
    const created = await mgrSettings.ensureSettings(1)
    check('缺失时新建成功', created.ok && created.created && created.changed && created.count === 1, JSON.stringify(created))
    const createdText = await readFile(settingsPath, 'utf8')
    check('新建含 1920x1080@30', createdText.includes('<width>1920</width>') && createdText.includes('<height>1080</height>'))
    check('新建 count=1', /<count>1<\/count>/.test(createdText))

    // ---- 11. settings：已有保留档位，只改 count ----
    console.log('\n11. settings 已有保留档位')
    const existingXml = `<?xml version='1.0' encoding='utf-8'?>\n<vdd_settings>\n    <monitors>\n        <count>1</count>\n    </monitors>\n    <resolutions>\n        <resolution>\n            <width>1600</width>\n            <height>720</height>\n            <refresh_rate>60</refresh_rate>\n        </resolution>\n        <resolution>\n            <width>1920</width>\n            <height>1080</height>\n            <refresh_rate>30</refresh_rate>\n        </resolution>\n    </resolutions>\n</vdd_settings>\n`
    await writeFile(settingsPath, existingXml, 'utf8')
    const updated = await mgrSettings.ensureSettings(2)
    check('已有文件改 count 成功', updated.ok && !updated.created && updated.changed && updated.count === 2)
    const updatedText = await readFile(settingsPath, 'utf8')
    check('用户档位 1600x720@60 被保留', updatedText.includes('<width>1600</width>') && updatedText.includes('<height>720</height>'))
    check('count 已改成 2', /<count>2<\/count>/.test(updatedText))
    const noChange = await mgrSettings.ensureSettings(2)
    check('count 已是目标值时不写文件', noChange.ok && !noChange.changed)

    // ---- 12. settings：preferred 追加 + count 钳制 ----
    console.log('\n12. settings preferred 追加与 count 钳制')
    const appended = await mgrSettings.ensureSettings(2, { width: 2560, height: 1440, refreshRate: 30 })
    check('缺失档位被追加', appended.ok && appended.changed)
    const appendedText = await readFile(settingsPath, 'utf8')
    check('追加了 2560x1440@30', appendedText.includes('<width>2560</width>') && appendedText.includes('<height>1440</height>'))
    const clamped = await mgrSettings.ensureSettings(0)
    check('count 0 被钳到 1', clamped.ok && clamped.count === 1, `count=${clamped.count}`)
    const clampedText = await readFile(settingsPath, 'utf8')
    check('钳制后文件 count=1', /<count>1<\/count>/.test(clampedText))

    // ---- 13. uninstall：启用时拒绝、禁用时执行 ----
    console.log('\n13. uninstall 门禁与执行')
    const fakeUninstEnabled = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe') return ok(PNPUTIL_EN)
      if (joined.includes('Get-PnpDevice')) return ok(PNPDEV_ENABLED)
      return adminTrue(cmd, args)
    })
    const mgrUninstEnabled = new VddDriverManager({ zipPath, runner: fakeUninstEnabled.run })
    const uninstRefused = await mgrUninstEnabled.uninstall()
    check('设备启用时拒绝卸载', !uninstRefused.ok && uninstRefused.reason === 'device-still-enabled', uninstRefused.ok ? '意外成功' : uninstRefused.reason)
    check('拒绝时没打 /delete-driver', !fakeUninstEnabled.has('/delete-driver'))

    const fakeUninst = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe' && joined.includes('/enum-drivers')) return ok(PNPUTIL_EN)
      if (cmd === 'pnputil.exe' && joined.includes('/delete-driver')) return ok('Driver package deleted successfully.\r\n')
      if (joined.includes('Get-PnpDevice')) return ok(PNPDEV_DISABLED)
      return adminTrue(cmd, args)
    })
    const mgrUninst = new VddDriverManager({ zipPath, runner: fakeUninst.run })
    const uninstRes = await mgrUninst.uninstall()
    check('已禁用时卸载成功', uninstRes.ok, uninstRes.ok ? '' : uninstRes.detail)
    check('卸载发 /delete-driver oem116.inf /uninstall', fakeUninst.has('/delete-driver') && fakeUninst.has('oem116.inf') && fakeUninst.has('/uninstall'))

    // ---- 14. 包缺失拒绝安装 ----
    console.log('\n14. 包缺失拒绝安装')
    const mgrNoPkg = new VddDriverManager({ zipPath: null, runner: fakeEmpty.run })
    const noPkgRes = await mgrNoPkg.ensureInstalled()
    check('包缺失返回 package-missing', !noPkgRes.ok && noPkgRes.reason === 'package-missing', noPkgRes.ok ? '意外成功' : noPkgRes.reason)

    // ---- 15. 全新机器 happy path：add-driver 后节点仍缺失 → 调助手建节点 ----
    console.log('\n15. 全新机器安装 happy path（节点创建）')
    const freshFixture = Buffer.from('fake-zip-bytes-for-fresh-machine')
    const freshZip = join(dir, 'fresh.zip')
    await writeFile(freshZip, freshFixture)
    const freshSha = createHash('sha256').update(freshFixture).digest('hex')
    const helperPath = join(dir, 'linkspace-rootdev.exe')
    await writeFile(helperPath, Buffer.from('fake-helper-bytes'))
    let freshAddDriverCalls = 0
    let freshHelperCalls = 0
    const fakeFresh = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe' && joined.includes('/enum-drivers')) {
        return ok(freshAddDriverCalls === 0 ? PNPUTIL_NONE : PNPUTIL_EN)
      }
      if (cmd === 'pnputil.exe' && joined.includes('/add-driver')) {
        freshAddDriverCalls++
        return ok('Driver package added successfully.\r\nPublished Name: oem116.inf\r\n')
      }
      if (cmd === 'certutil.exe') return ok('CertUtil: -addstore command completed successfully.\r\n')
      if (joined.includes('Get-PnpDevice')) {
        // 助手调用前节点不存在，调用后出现（已禁用态）
        return freshHelperCalls === 0
          ? { code: 1, stdout: '', stderr: 'Get-PnpDevice : No such device' }
          : ok(PNPDEV_DISABLED)
      }
      if (joined.includes('Expand-Archive')) return ok('')
      if (joined.includes('Get-AuthenticodeSignature')) return ok('')
      if (cmd.endsWith('linkspace-rootdev.exe')) {
        freshHelperCalls++
        return ok('instanceId=ROOT\\DISPLAY\\0000\r\nok\r\n')
      }
      return adminTrue(cmd, args)
    })
    const mgrFresh = new VddDriverManager({
      zipPath: freshZip,
      helperPath,
      runner: fakeFresh.run,
      pinnedSha256: freshSha,
      pinnedSize: freshFixture.length
    })
    const freshRes = await mgrFresh.ensureInstalled()
    check('全新机器安装成功', freshRes.ok && !freshRes.alreadyInstalled, freshRes.ok ? 'ok' : `${freshRes.reason}：${freshRes.detail}`)
    check('全新机器只打一次 /add-driver', fakeFresh.count('/add-driver') === 1)
    check('全新机器调了一次助手', freshHelperCalls === 1)
    const freshHelperCall = fakeFresh.calls.find((c) => c.cmd.endsWith('linkspace-rootdev.exe'))
    check(
      '助手收到 install <inf> Root\\MttVDD',
      freshHelperCall !== undefined &&
        freshHelperCall.args[0] === 'install' &&
        freshHelperCall.args[1]!.endsWith('MttVDD.inf') &&
        freshHelperCall.args[2] === ROOT_HARDWARE_ID,
      freshHelperCall ? freshHelperCall.args.join(' ') : '没找到助手调用'
    )
    check('助手调用在 /add-driver 之后', fakeFresh.calls.findIndex((c) => c.cmd.endsWith('linkspace-rootdev.exe')) > fakeFresh.calls.findIndex((c) => c.args.join(' ').includes('/add-driver')))

    // ---- 16. 助手失败 → node-create-failed，不报成功 ----
    console.log('\n16. 节点创建助手失败')
    let helperFailCalls = 0
    let helperFailAddCalls = 0
    const fakeHelperFail = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe' && joined.includes('/enum-drivers')) {
        return ok(helperFailAddCalls === 0 ? PNPUTIL_NONE : PNPUTIL_EN)
      }
      if (cmd === 'pnputil.exe' && joined.includes('/add-driver')) {
        helperFailAddCalls++
        return ok('Driver package added successfully.\r\n')
      }
      if (cmd === 'certutil.exe') return ok('')
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'No such device' }
      if (joined.includes('Expand-Archive')) return ok('')
      if (joined.includes('Get-AuthenticodeSignature')) return ok('')
      if (cmd.endsWith('linkspace-rootdev.exe')) {
        helperFailCalls++
        return { code: 14, stdout: '', stderr: 'error 0x80070005 at UpdateDriverForPlugAndPlayDevices' }
      }
      return adminTrue(cmd, args)
    })
    const mgrHelperFail = new VddDriverManager({
      zipPath: freshZip,
      helperPath,
      runner: fakeHelperFail.run,
      pinnedSha256: freshSha,
      pinnedSize: freshFixture.length
    })
    const helperFailRes = await mgrHelperFail.ensureInstalled()
    check('助手失败返回 node-create-failed', !helperFailRes.ok && helperFailRes.reason === 'node-create-failed', helperFailRes.ok ? '意外成功' : helperFailRes.reason)
    check('助手失败时 detail 带退出码', !helperFailRes.ok && helperFailRes.detail.includes('14'), helperFailRes.ok ? '' : helperFailRes.detail)
    check('助手失败时只调了一次助手', helperFailCalls === 1)

    // ---- 17. 助手缺失 → node-create-failed，且不调助手 ----
    console.log('\n17. 助手缺失拒绝建节点')
    let noHelperAddCalls = 0
    const fakeNoHelper = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe' && joined.includes('/enum-drivers')) {
        return ok(noHelperAddCalls === 0 ? PNPUTIL_NONE : PNPUTIL_EN)
      }
      if (cmd === 'pnputil.exe' && joined.includes('/add-driver')) {
        noHelperAddCalls++
        return ok('Driver package added successfully.\r\n')
      }
      if (cmd === 'certutil.exe') return ok('')
      if (joined.includes('Get-PnpDevice')) return { code: 1, stdout: '', stderr: 'No such device' }
      if (joined.includes('Expand-Archive')) return ok('')
      if (joined.includes('Get-AuthenticodeSignature')) return ok('')
      return adminTrue(cmd, args)
    })
    const mgrNoHelper = new VddDriverManager({
      zipPath: freshZip,
      helperPath: join(dir, 'does-not-exist.exe'),
      runner: fakeNoHelper.run,
      pinnedSha256: freshSha,
      pinnedSize: freshFixture.length
    })
    const noHelperRes = await mgrNoHelper.ensureInstalled()
    check('助手缺失返回 node-create-failed', !noHelperRes.ok && noHelperRes.reason === 'node-create-failed', noHelperRes.ok ? '意外成功' : noHelperRes.reason)
    check('助手缺失时没调助手', !fakeNoHelper.has('linkspace-rootdev.exe'))

    // ---- 18. 驱动已暂存但节点缺失：重跑安装跳过信任 + add-driver，直奔助手 ----
    console.log('\n18. 已暂存缺节点时重跑安装')
    let retryHelperCalls = 0
    const fakeRetry = new FakeRunner((cmd, args) => {
      const joined = args.join(' ')
      if (cmd === 'pnputil.exe' && joined.includes('/enum-drivers')) return ok(PNPUTIL_EN)
      if (joined.includes('Get-PnpDevice')) {
        return retryHelperCalls === 0
          ? { code: 1, stdout: '', stderr: 'No such device' }
          : ok(PNPDEV_DISABLED)
      }
      if (joined.includes('Expand-Archive')) return ok('')
      if (cmd.endsWith('linkspace-rootdev.exe')) {
        retryHelperCalls++
        return ok('instanceId=ROOT\\DISPLAY\\0000\r\nok\r\n')
      }
      return adminTrue(cmd, args)
    })
    const mgrRetry = new VddDriverManager({
      zipPath: freshZip,
      helperPath,
      runner: fakeRetry.run,
      pinnedSha256: freshSha,
      pinnedSize: freshFixture.length
    })
    const retryRes = await mgrRetry.ensureInstalled()
    check('重跑安装成功且 alreadyInstalled', retryRes.ok && retryRes.alreadyInstalled, retryRes.ok ? 'ok' : `${retryRes.reason}：${retryRes.detail}`)
    check('重跑时跳过 certutil 信任', !fakeRetry.has('certutil'))
    check('重跑时跳过 /add-driver', !fakeRetry.has('/add-driver'))
    check('重跑时调了助手', retryHelperCalls === 1)

    report()
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function report(): void {
  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n验证脚本异常：', err)
  process.exit(1)
})
