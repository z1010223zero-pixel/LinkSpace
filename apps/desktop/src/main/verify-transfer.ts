// 文件传输无头环路测试。
//
// 同一进程内同时扮演发送方与接收方，走真实的 TLS + HTTPS 分块路径，
// 验证协议实现本身是否正确，不依赖第二台设备。
//
// 覆盖 docs/mvp-acceptance.md 第 4 组中可自动化的部分：
//   4.1 内容一致 / 4.4 取消 / 4.5 断点续传 / 4.6 重传
//   4.7 特殊文件名与 0 字节 / 4.10 并发 / 9.2 未授权拒绝
//
// 1 GB 大文件用 --large 单独触发，避免每次回归都跑很久。

import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setIdentityDir } from './transfer/identity'
import { startTransferServer } from './transfer/server'
import { TransferManager } from './transfer/manager'
import { hashFile } from './transfer/chunker'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/**
 * 块大小可用 --chunk=N 覆盖。
 * 默认 64KB 是为了让多块/续传/取消等场景在毫秒级跑完；
 * 生产默认 4MiB，用 --chunk=4194304 可测真实吞吐。
 */
function configuredChunkSize(): number {
  const m = /--chunk=(\d+)/.exec(process.argv.join(' '))
  return m ? Number(m[1]) : 64 * 1024
}
async function makeFile(path: string, size: number, seed = 1): Promise<string> {
  const hash = createHash('sha256')
  const chunk = Buffer.alloc(64 * 1024)
  for (let i = 0; i < chunk.length; i++) chunk[i] = (i * 31 + seed * 7) & 0xff

  const handle = await open(path, 'w')
  try {
    let written = 0
    while (written < size) {
      const n = Math.min(chunk.length, size - written)
      const piece = chunk.subarray(0, n)
      hash.update(piece)
      await handle.write(piece)
      written += n
    }
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

interface Harness {
  workDir: string
  sender: TransferManager
  receiver: TransferManager
  port: number
  close(): Promise<void>
}

async function setup(): Promise<Harness> {
  const workDir = await mkdtemp(join(tmpdir(), 'linkspace-ft-'))
  setIdentityDir(workDir)

  const chunkSize = configuredChunkSize()
  const receiver = new TransferManager({ chunkSize })
  const sender = new TransferManager({ chunkSize })

  // 接收方只认这一个已授权设备；token 交由接收方管理器按任务校验
  // （正是真实链路上 host.verifyTransfer 的接线方式）
  const knownDevices = new Set(['dev-sender-001'])
  const { server, port } = await startTransferServer(
    {
      resolveIncoming: (id: string) => receiver.resolveIncoming(id),
      resolveOutgoing: (id: string) => receiver.resolveOutgoing(id),
      appendIncoming: (key: string, offset: number, body: Buffer) =>
        receiver.appendIncoming(key, offset, body),
      verifyTransfer: (key: string, id: string, token: string) =>
        knownDevices.has(id) && receiver.verifyToken(key, token)
    },
    undefined,
    // 环路测试固定走回环地址，不参与自动绑定局域网网卡
    { bind: '127.0.0.1' }
  )

  return {
    workDir,
    sender,
    receiver,
    port,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }
}

/** offer → accept → push → finalize 完整跑一遍 */
async function runTransfer(
  h: Harness,
  files: { name: string; path: string; size: number }[],
  saveDir: string,
  token = 'tok-default'
): Promise<{ sendTaskId: string; recvTaskId: string }> {
  const offered = await h.sender.offer(
    'dev-receiver-001',
    files,
    // 发送方生成 transferId，接收方沿用同一个 id（protocol.md 4.5）
    `tr-test-${Math.random().toString(36).slice(2, 10)}`
  )
  // 接收方收到同一个 transferId
  await h.receiver.offer(
    'dev-sender-001',
    files.map((f) => ({ name: f.name, size: f.size })),
    offered.id,
    'receive'
  )
  await h.receiver.accept(offered.id, saveDir, { token })
  // token 由接收方生成，需经控制通道交还发送方，否则数据面鉴权失败
  h.sender.attachToken(offered.id, token)
  const pushed = await h.sender.push(offered.id, {
    host: '127.0.0.1',
    port: h.port,
    deviceId: 'dev-sender-001'
  })
  // 发送方算出的整体摘要交给接收方，落盘前比对（真实链路上的 transfer.complete）
  const digests: Record<string, string> = {}
  for (const f of pushed.files) if (f.digest) digests[f.name] = f.digest
  await h.receiver.finalize(offered.id, digests)
  return { sendTaskId: offered.id, recvTaskId: offered.id }
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 文件传输无头环路测试 ===\n')
  const h = await setup()

  try {
    const srcDir = join(h.workDir, 'src')
    const outDir = join(h.workDir, 'out')
    await mkdir(srcDir, { recursive: true })
    await mkdir(outDir, { recursive: true })

    // ---------- 1. 基础传输与内容一致性 ----------
    console.log('1. 基础传输与内容一致性')
    const smallPath = join(srcDir, 'hello.txt')
    const smallDigest = await makeFile(smallPath, 3000, 1)
    const emptyPath = join(srcDir, 'empty.bin')
    await writeFile(emptyPath, Buffer.alloc(0))

    await runTransfer(
      h,
      [
        { name: 'hello.txt', path: smallPath, size: 3000 },
        { name: 'empty.bin', path: emptyPath, size: 0 }
      ],
      outDir
    )

    const got = await (await import('node:fs/promises')).readFile(join(outDir, 'hello.txt'))
    check('文本文件内容一致', createHash('sha256').update(got).digest('hex') === smallDigest)
    check('0 字节文件传输', (await stat(join(outDir, 'empty.bin'))).size === 0)

    // ---------- 2. 特殊文件名 ----------
    console.log('\n2. 特殊文件名')
    const weirdName = '报告 最终版 (v2) #1.txt'
    const weirdPath = join(srcDir, weirdName)
    await makeFile(weirdPath, 5000, 2)
    await runTransfer(h, [{ name: weirdName, path: weirdPath, size: 5000 }], outDir)
    check('含空格/中文/# 的文件名', (await stat(join(outDir, weirdName))).size === 5000)

    // ---------- 3. 同名文件不覆盖 ----------
    console.log('\n3. 同名文件默认重命名（不静默覆盖）')
    const dupPath = join(srcDir, 'dup.txt')
    await makeFile(dupPath, 100, 3)
    await runTransfer(h, [{ name: 'dup.txt', path: dupPath, size: 100 }], outDir, 'tok-dup-1')
    await runTransfer(h, [{ name: 'dup.txt', path: dupPath, size: 100 }], outDir, 'tok-dup-2')
    check('首次传输落盘', (await stat(join(outDir, 'dup.txt'))).size === 100)
    check('第二次生成重命名副本', (await stat(join(outDir, 'dup (1).txt'))).size === 100)

    // ---------- 4. 多块传输 ----------
    console.log('\n4. 多块传输（超过 64KB 块大小）')
    const bigPath = join(srcDir, 'multi.bin')
    const bigSize = 200 * 1024
    const bigDigest = await makeFile(bigPath, bigSize, 4)
    const { sendTaskId: multiId } = await runTransfer(
      h,
      [{ name: 'multi.bin', path: bigPath, size: bigSize }],
      outDir
    )
    check('多块文件内容一致', (await hashFile(join(outDir, 'multi.bin'))) === bigDigest)
    check(
      'transferred 统计等于总大小',
      h.sender.get(multiId)?.transferred === bigSize,
      `transferred=${h.sender.get(multiId)?.transferred}`
    )

    // ---------- 5. 断点续传 ----------
    console.log('\n5. 断点续传（不从头重传）')
    const resumeSrc = join(srcDir, 'resume.bin')
    const resumeSize = 150 * 1024
    const resumeDigest = await makeFile(resumeSrc, resumeSize, 5)

    const resumeId = `tr-resume-${Math.random().toString(36).slice(2, 8)}`
    await h.sender.offer(
      'dev-receiver-001',
      [{ name: 'resume.bin', path: resumeSrc, size: resumeSize }],
      resumeId
    )
    await h.receiver.offer(
      'dev-sender-001',
      [{ name: 'resume.bin', size: resumeSize }],
      resumeId,
      'receive'
    )
    await h.receiver.accept(resumeId, outDir, { token: 'tok-resume' })
    h.sender.attachToken(resumeId, 'tok-resume')

    // 模拟中断：手工推第一块（60KB），相当于「传了一半断线」
    const { readChunk } = await import('./transfer/chunker')
    const { sendChunk } = await import('./transfer/server')
    const firstChunk = await readChunk(resumeSrc, 0, 60 * 1024)
    await sendChunk('127.0.0.1', h.port, `${resumeId}:resume.bin`, 0, firstChunk, {
      deviceId: 'dev-sender-001',
      token: 'tok-resume'
    })
    const half = await h.receiver.partSize(resumeId, 'resume.bin')
    check('第一块已写入', half === 60 * 1024, `size=${half}`)

    // 续传：push 必须从 60KB 继续，若从 0 重传最终会变成 210KB
    const resumed = await h.sender.push(resumeId, {
      host: '127.0.0.1',
      port: h.port,
      deviceId: 'dev-sender-001'
    })
    const afterResume = await h.receiver.partSize(resumeId, 'resume.bin')
    check(
      '续传后总大小等于源文件（未重复追加）',
      afterResume === resumeSize,
      `size=${afterResume}，期望 ${resumeSize}`
    )
    check(
      'committedOffset 最终等于文件大小',
      resumed.transferred === resumeSize,
      `transferred=${resumed.transferred}`
    )
    await h.receiver.finalize(resumeId, { 'resume.bin': resumeDigest })
    check(
      '续传后内容摘要一致',
      (await hashFile(join(outDir, 'resume.bin'))) === resumeDigest
    )

    // ---------- 6. 取消 ----------
    console.log('\n6. 取消传输并清理临时文件')
    // 取消测试要真的「传到一半」，样本必须远大于块大小：
    // 若只有一个块，传输会在取消生效前就 completed，测试就变成假通过。
    const cancelSize = Math.max(32 * 1024 * 1024, configuredChunkSize() * 16)
    const cancelSrc = join(srcDir, 'cancel-me.bin')
    await makeFile(cancelSrc, cancelSize, 6)
    const cancelId = `tr-cancel-${Math.random().toString(36).slice(2, 8)}`
    await h.sender.offer(
      'dev-receiver-001',
      [{ name: 'cancel-me.bin', path: cancelSrc, size: cancelSize }],
      cancelId
    )
    await h.receiver.offer(
      'dev-sender-001',
      [{ name: 'cancel-me.bin', size: cancelSize }],
      cancelId,
      'receive'
    )
    await h.receiver.accept(cancelId, outDir, { token: 'tok-cancel' })
    h.sender.attachToken(cancelId, 'tok-cancel')

    const partFile = h.receiver.partPath(cancelId, 'cancel-me.bin')!
    let cancelRequested = false
    let cancelDone: Promise<void> | null = null

    // 接线：发送方取消 → transfer.cancel 送达接收方 → 接收方清理 .part。
    // 真实链路上这一步走控制通道，这里直接接事件。
    let peerCancel: Promise<void> | null = null
    h.sender.on('cancelRequested', (e: { id: string }) => {
      peerCancel = h.receiver.cancel(e.id)
    })

    // 用进度回调触发取消，保证取消确实发生在传输过程中
    // （靠 sleep 猜时间是不可靠的：本地环路 500KB 只要二十几毫秒就传完了）
    const pushing = h.sender.push(
      cancelId,
      { host: '127.0.0.1', port: h.port, deviceId: 'dev-sender-001' },
      () => {
        if (!cancelRequested) {
          cancelRequested = true
          cancelDone = h.sender.cancel(cancelId)
        }
      }
    )
    const cancelled = await pushing
    if (cancelDone) await cancelDone
    if (peerCancel) await peerCancel

    check('取消发生在传输过程中', cancelRequested)
    check('取消后状态为 cancelled', cancelled.state === 'cancelled', cancelled.state)
    check('取消后 .part 已被清理', !(await exists(partFile)), partFile)
    check('取消后未产出最终文件', !(await exists(join(outDir, 'cancel-me.bin'))))

    // ---------- 7. 鉴权 ----------
    console.log('\n7. 数据面鉴权')
    const authSrc = join(srcDir, 'auth.bin')
    await makeFile(authSrc, 1000, 7)
    const authId = `tr-auth-${Math.random().toString(36).slice(2, 8)}`
    await h.sender.offer(
      'dev-receiver-001',
      [{ name: 'auth.bin', path: authSrc, size: 1000 }],
      authId
    )
    await h.receiver.offer('dev-sender-001', [{ name: 'auth.bin', size: 1000 }], authId, 'receive')
    await h.receiver.accept(authId, outDir, { token: 'tok-right' })
    h.sender.attachToken(authId, 'tok-right')

    const rejected = await h.sender
      .push(authId, { host: '127.0.0.1', port: h.port, deviceId: 'dev-UNKNOWN' })
    check('未授权设备被拒绝', rejected.state === 'failed', rejected.state)
    check('失败原因可读', Boolean(rejected.error), rejected.error ?? '(空)')

    // ---------- 8. 并发 ----------
    console.log('\n8. 并发互不干扰')
    const c1 = join(srcDir, 'con1.bin')
    const c2 = join(srcDir, 'con2.bin')
    const d1 = await makeFile(c1, 80 * 1024, 11)
    const d2 = await makeFile(c2, 120 * 1024, 12)
    const [r1, r2] = await Promise.all([
      runTransfer(h, [{ name: 'con1.bin', path: c1, size: 80 * 1024 }], outDir, 'tok-c1'),
      runTransfer(h, [{ name: 'con2.bin', path: c2, size: 120 * 1024 }], outDir, 'tok-c2')
    ])
    check('并发任务 1 内容一致', (await hashFile(join(outDir, 'con1.bin'))) === d1)
    check('并发任务 2 内容一致', (await hashFile(join(outDir, 'con2.bin'))) === d2)
    check('两个任务 id 不同', r1.sendTaskId !== r2.sendTaskId)

    // ---------- 9. 块级摘要校验（4.6） ----------
    console.log('\n9. 块级摘要校验（坏摘要拒收，好摘要落盘）')
    const dgSrc = join(srcDir, 'digest.bin')
    const dgSize = 100 * 1024
    await makeFile(dgSrc, dgSize, 9)
    const dgId = `tr-digest-${Math.random().toString(36).slice(2, 8)}`
    await h.sender.offer(
      'dev-receiver-001',
      [{ name: 'digest.bin', path: dgSrc, size: dgSize }],
      dgId
    )
    await h.receiver.offer('dev-sender-001', [{ name: 'digest.bin', size: dgSize }], dgId, 'receive')
    await h.receiver.accept(dgId, outDir, { token: 'tok-digest' })
    h.sender.attachToken(dgId, 'tok-digest')

    const dgChunk = await readChunk(dgSrc, 0, 64 * 1024)
    // 声明一个错误摘要（模拟发送方声明损坏）：接收方必须拒收且不把坏字节写进 .part
    let badChunkRejected = false
    try {
      await sendChunk(
        '127.0.0.1',
        h.port,
        `${dgId}:digest.bin`,
        0,
        dgChunk,
        { deviceId: 'dev-sender-001', token: 'tok-digest' },
        { declaredDigest: '0'.repeat(64) }
      )
    } catch {
      badChunkRejected = true
    }
    check('坏摘要块被拒收', badChunkRejected)
    check('坏摘要块未落盘', (await h.receiver.partSize(dgId, 'digest.bin')) === 0)
    // 同一块带正确摘要重传，应正常落盘
    await sendChunk('127.0.0.1', h.port, `${dgId}:digest.bin`, 0, dgChunk, {
      deviceId: 'dev-sender-001',
      token: 'tok-digest'
    })
    check(
      '正确摘要重传落盘',
      (await h.receiver.partSize(dgId, 'digest.bin')) === 64 * 1024
    )
    // 该任务到此目的已完成，取消掉避免悬挂 .part
    await h.receiver.cancel(dgId)

    // ---------- 10. 大文件 ----------
    if (process.argv.includes('--large')) {
      console.log('\n10. 1 GB 大文件')
      const largeSrc = join(srcDir, 'large.bin')
      const largeSize = 1024 * 1024 * 1024
      const t0 = Date.now()
      await makeFile(largeSrc, largeSize, 8)
      console.log(`     生成 1 GB 样本耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`)
      const t1 = Date.now()
      await runTransfer(h, [{ name: 'large.bin', path: largeSrc, size: largeSize }], outDir, 'tok-large')
      const secs = (Date.now() - t1) / 1000
      console.log(
        `     传输耗时 ${secs.toFixed(1)}s（块 ${(configuredChunkSize() / 1024).toFixed(0)}KB）` +
          ` ≈ ${(largeSize / 1024 / 1024 / secs).toFixed(1)} MB/s`
      )
      check('1 GB 文件大小正确', (await stat(join(outDir, 'large.bin'))).size === largeSize)
    }
  } finally {
    await h.close()
    await rm(h.workDir, { recursive: true, force: true })
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
