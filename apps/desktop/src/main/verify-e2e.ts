// 端到端集成测试：两个 Host 跑完整的「发现 → 配对 → 传输 → 取消」。
//
// 与 verify-pairing / verify-transfer 的区别：那两者各自验证一层，
// 这里把真实路径串起来——mDNS 发现、WebSocket 控制通道、TLS 数据面、
// 信任清单门禁、transfer.cancel 的跨端传播，全部走真代码。
//
// 这是 docs/mvp-acceptance.md 第 4 组「真实跨设备」能自动化的最接近形式：
// 仍然是同一台机器，但两个进程级节点各自持有独立证书、独立信任清单。

import { mkdtemp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { Host } from './host'
import { fingerprintOfCert, type DeviceCert } from './transfer/identity'
import type { DiscoveredService } from './discovery'
import type { PendingPairing } from './pairing'
import type { TransferTask } from './transfer/manager'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 20_000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await sleep(50)
  }
}

async function makeCert(): Promise<DeviceCert> {
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 10)
  const pems = await generate([{ name: 'commonName', value: 'LinkSpace Device' }], {
    notAfterDate: notAfter,
    keySize: 2048,
    algorithm: 'sha256',
    extensions: [
      { name: 'basicConstraints', cA: false, critical: true },
      { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
      { name: 'extKeyUsage', serverAuth: true, clientAuth: true }
    ]
  })
  return {
    key: pems.private,
    cert: pems.cert,
    fingerprint: fingerprintOfCert(pems.cert)
  }
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 端到端集成测试（发现 → 配对 → 传输 → 取消）===\n')

  const workDir = await mkdtemp(join(tmpdir(), 'linkspace-e2e-'))
  const dirA = join(workDir, 'A')
  const dirB = join(workDir, 'B')
  await mkdir(dirA, { recursive: true })
  await mkdir(dirB, { recursive: true })

  const certA = await makeCert()
  const certB = await makeCert()

  const A = new Host({
    displayName: 'E2E-Alpha',
    deviceType: 'win',
    dataDir: dirA,
    cert: certA,
    // 必须监听全部地址：本测试真走 mDNS，对端拿到的是本机局域网地址
    // （如 192.168.x.x），绑死回环会让对端连不上。来源地址门禁仍然生效——
    // 192.168.x.x 属于局域网，不会被拦。
    bind: '0.0.0.0'
  })
  const B = new Host({
    displayName: 'E2E-Beta',
    deviceType: 'android-phone',
    dataDir: dirB,
    cert: certB,
    bind: '0.0.0.0'
  })

  // 收集事件
  const discovered: DiscoveredService[] = []
  const offered: TransferTask[] = []
  const changed: TransferTask[] = []
  const pairRequests: PendingPairing[] = []

  A.on('discovered', (s) => discovered.push(s))
  // offer 是接收方收到的事件，注册在 B 上
  B.on('transferOffered', (t) => offered.push(t))
  A.on('transferChanged', (t) => changed.push(t))
  B.on('pairRequested', (p) => pairRequests.push(p))

  await A.start()
  await B.start()

  try {
    // ---------- 1. mDNS 发现 ----------
    console.log('1. mDNS 发现')
    const found = await waitFor(() => discovered.find((s) => s.displayName === 'E2E-Beta'))
    check('A 通过 mDNS 发现了 B', Boolean(found), `${found.host}:${found.port}`)
    check('通告里带上了能力位', found.caps.includes('file'), found.caps.join(','))

    // ---------- 2. 配对 ----------
    console.log('\n2. 配对')
    const conn = await A.connect(found)
    await waitFor(() => (conn.peerId === B.id ? conn : undefined))
    check('连接后完成身份声明', conn.peerId === B.id)

    const pairingPromise = A.requestPairing(conn)
    const pending = await waitFor(() => pairRequests.find((p) => p.peerId === A.id))
    check('B 收到配对请求', Boolean(pending))
    const submit = A.submitCode(conn, pending.code)
    check('提交配对码', submit.ok)
    await pairingPromise
    check('双方建立信任', A.trustStore.isKnown(B.id) && B.trustStore.isKnown(A.id))
    check(
      // 配对默认授予 file + clipboard，但**绝不包括** control：
      // 键鼠与投屏能让对端操作本机，必须另行授权
      '配对默认不授予 control',
      !A.trustStore.scopeOf(B.id).includes('control') &&
        A.trustStore.scopeOf(B.id).includes('file') &&
        A.trustStore.scopeOf(B.id).includes('clipboard'),
      A.trustStore.scopeOf(B.id).join(',')
    )

    // ---------- 3. 未授权时不能传输 ----------
    console.log('\n3. 授权门禁')
    const C = new Host({
      displayName: 'E2E-Gamma',
      deviceType: 'win',
      dataDir: join(workDir, 'C'),
      cert: await makeCert(),
      bind: '0.0.0.0'
    })
    await mkdir(join(workDir, 'C'), { recursive: true })
    await C.start()
    // C 与 B 建立了连接但从未配对，应被授权门禁挡下
    const svcC: DiscoveredService = {
      serviceName: 'E2E-Gamma',
      idPrefix: C.id.slice(0, 12),
      displayName: 'E2E-Gamma',
      deviceType: 'win',
      caps: ['file'],
      host: '127.0.0.1',
      port: B.port,
      lastSeen: Date.now(),
      paired: false
    }
    const connC = await C.connect(svcC)
    await waitFor(() => (connC.peerId === B.id ? connC : undefined))

    let blocked = ''
    try {
      await C.offerFiles(B.id, [{ name: 'x.txt', size: 1 }])
    } catch (err) {
      blocked = err instanceof Error ? err.message : String(err)
    }
    check('已连接但未配对的设备无法发起传输', blocked.includes('授权'), blocked)
    await C.stop()

    // ---------- 4. 真实文件传输 ----------
    console.log('\n4. 跨节点文件传输')
    const srcDir = join(workDir, 'src')
    const saveDir = join(workDir, 'save')
    await mkdir(srcDir, { recursive: true })
    await mkdir(saveDir, { recursive: true })

    const payload = Buffer.from('LinkSpace 端到端传输内容 '.repeat(500))
    const srcPath = join(srcDir, 'e2e.txt')
    await writeFile(srcPath, payload)
    const { createHash } = await import('node:crypto')
    const digest = createHash('sha256').update(payload).digest('hex')

    const task = await A.offerFiles(B.id, [{ name: 'e2e.txt', path: srcPath, size: payload.length }])
    check('A 发起传输任务', task.state === 'offered', task.state)

    const incoming = await waitFor(() => offered.find((t) => t.id === task.id))
    check('B 收到 offer', Boolean(incoming))

    await B.acceptTransfer(task.id, saveDir)

    const done = await waitFor(() => changed.find((t) => t.id === task.id && t.state === 'completed'))
    check('A 侧任务完成', done.state === 'completed', done.state)

    const bTask = await waitFor(() =>
      B.transferTasks().find((t) => t.id === task.id && t.state === 'completed')
    )
    check('B 侧任务完成', bTask.state === 'completed', bTask.state)

    const savedPath = join(saveDir, 'e2e.txt')
    const saved = await stat(savedPath)
    check('落盘大小一致', saved.size === payload.length, `${saved.size} vs ${payload.length}`)
    const { readFile } = await import('node:fs/promises')
    const actual = createHash('sha256').update(await readFile(savedPath)).digest('hex')
    check('内容 SHA-256 一致', actual === digest)

    // ---------- 5. 取消真实传播到对端 ----------
    console.log('\n5. 取消跨端传播')
    // 文件要足够大，否则 4MiB 块几下就传完，取消消息还在路上文件已落盘，
    // 测的就不是「传输中取消」了。128MB 在本机环路约 2s，留出足够窗口。
    const cancelSize = 128 * 1024 * 1024
    const bigPath = join(srcDir, 'cancel.bin')
    await writeFile(bigPath, Buffer.alloc(cancelSize, 7))
    const cancelTask = await A.offerFiles(B.id, [
      { name: 'cancel.bin', path: bigPath, size: cancelSize }
    ])
    await waitFor(() => offered.find((t) => t.id === cancelTask.id))
    await B.acceptTransfer(cancelTask.id, saveDir)

    // 等它真的开始传，再取消
    await waitFor(() =>
      changed.find((t) => t.id === cancelTask.id && t.transferred > 1024 * 1024)
    )
    await A.cancelTransfer(cancelTask.id)

    const bCancelled = await waitFor(() =>
      B.transferTasks().find((t) => t.id === cancelTask.id && t.state === 'cancelled')
    )
    check('B 侧收到取消并进入 cancelled', bCancelled.state === 'cancelled', bCancelled.state)

    const { existsSync } = await import('node:fs')
    const partFile = join(saveDir, '.cancel.bin.linkspace.part')
    check('B 侧的 .part 已被清理', !existsSync(partFile))
    check('B 侧未产出最终文件', !existsSync(join(saveDir, 'cancel.bin')))
    const aCancelled = A.transferTasks().find((t) => t.id === cancelTask.id)
    check('A 侧状态一致', aCancelled?.state === 'cancelled', aCancelled?.state)

    // ---------- 6. 剪贴板同步 ----------
    console.log('\n6. 剪贴板同步（跨节点）')
    // 注入内存剪贴板：不碰真实系统剪贴板，测试才不会互相干扰
    const clipA = { value: '' as string }
    const clipB = { value: '' as string }
    A.enableClipboardSync({
      readText: () => clipA.value,
      writeText: (t) => {
        clipA.value = t
      }
    })
    B.enableClipboardSync({
      readText: () => clipB.value,
      writeText: (t) => {
        clipB.value = t
      }
    })

    clipA.value = '在 A 上复制的文本'
    A.pollClipboard()
    await waitFor(() => (clipB.value === '在 A 上复制的文本' ? true : undefined))
    check('A 的复制内容到达 B', clipB.value === '在 A 上复制的文本', clipB.value)

    // 回环：B 收到后不管轮询多少次，都不该把同一段推回 A
    for (let i = 0; i < 5; i++) {
      B.pollClipboard()
      A.pollClipboard()
    }
    check('B 未把收到的内容推回 A', clipA.value === '在 A 上复制的文本', clipA.value)

    // 反向。必须等过抑制窗口：B 刚写入收到的内容，窗口内的变更一律忽略，
    // 否则窗口内读到的旧值会被当成新复制，形成一次往返回环。
    await sleep(600)
    clipB.value = '在 B 上复制的文本'
    B.pollClipboard()
    await waitFor(() => (clipA.value === '在 B 上复制的文本' ? true : undefined))
    check('反向同步同样生效', clipA.value === '在 B 上复制的文本', clipA.value)

    // ---------- 7. 设备重命名（5.4）：两端同步 + 持久化 ----------
    console.log('\n7. 设备重命名（device.rename）')
    // A 改名 → B 的信任条目更新
    const renameA = A.setDisplayName('E2E-Alpha-改')
    check('A 改名成功', renameA.ok === true, String(renameA.name))
    await waitFor(() =>
      B.trustStore.list().find((e) => e.deviceId === A.id && e.displayName === 'E2E-Alpha-改')
        ? true
        : undefined
    )
    check('B 的信任条目已同步 A 的新名字', B.trustStore.fingerprintOf(A.id) !== null)
    const bEntry = B.trustStore.list().find((e) => e.deviceId === A.id)
    check('B 记录的名字为 A 的新名字', bEntry?.displayName === 'E2E-Alpha-改', bEntry?.displayName)

    // B 改名 → A 的信任条目更新（双向对称）
    const renameB = B.setDisplayName('E2E-Beta-改')
    check('B 改名成功', renameB.ok === true, String(renameB.name))
    await waitFor(() =>
      A.trustStore.list().find((e) => e.deviceId === B.id && e.displayName === 'E2E-Beta-改')
        ? true
        : undefined
    )
    const aEntry = A.trustStore.list().find((e) => e.deviceId === B.id)
    check('A 记录的名字为 B 的新名字', aEntry?.displayName === 'E2E-Beta-改', aEntry?.displayName)

    // 空名字拒绝：清洗后为空必须报错而不是静默回退
    const emptyName = A.setDisplayName('   ')
    check('空名字被拒绝', emptyName.ok === false)

    // 接收侧持久化：B 的信任清单已落盘，用全新 TrustStore 重读同一目录，
    // 名字必须还在——这验证「重启后保持」的一半（对端记录侧）；
    // 另一半（改名方 profile.json）由 setDisplayName 内的 persist 覆盖
    const { TrustStore: FreshTrust } = await import('./transfer/trust')
    const reborn = new FreshTrust({ dir: dirB })
    check(
      'B 重启后仍记录 A 的新名字',
      reborn.list().find((e) => e.deviceId === A.id)?.displayName === 'E2E-Alpha-改'
    )

    // ---------- 8. 撤销信任后门禁重新生效 ----------
    console.log('\n8. 撤销信任后门禁重新生效')
    B.revokeTrust(A.id)
    await waitFor(() => (!A.trustStore.isKnown(B.id) ? true : undefined))
    check('A 的信任已撤销', !A.trustStore.isKnown(B.id))

    let blockedAfterRevoke = ''
    try {
      await A.offerFiles(B.id, [{ name: 'y.txt', size: 1 }])
    } catch (err) {
      blockedAfterRevoke = err instanceof Error ? err.message : String(err)
    }
    // 撤销会同时断开连接，所以可能是「未连接」或「没有授权」，
    // 两者都说明传输被挡住了
    check(
      '撤销后无法再发起传输',
      blockedAfterRevoke.length > 0,
      blockedAfterRevoke || '(竟然没有报错)'
    )
  } finally {
    await A.stop()
    await B.stop()
    await rm(workDir, { recursive: true, force: true })
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
