// 跨平台接收验证：Android → Windows。
// 与 xplat-probe.ts 方向相反：平板是发送方，本机只当接收方——
// 复用同一份探测身份（LINKSPACE_PROBE_HOME，此前配对轮次已互信），
// 收到 offer 自动接受，落盘后逐文件打印 SHA-256 供发送端比对。
//
// 退出码：0 = 至少一个任务完成并已校验，1 = 失败/取消/超时。
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { createReadStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { join } from 'node:path'
import { Host } from '../src/main/host'
import type { TransferTask } from '../src/main/transfer/manager'

function sha256File(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256')
    createReadStream(path)
      .on('data', (d) => hash.update(d))
      .on('end', () => resolve(hash.digest('hex')))
      .on('error', reject)
  })
}

async function main(): Promise<void> {
  // 与 xplat-probe.ts 同目录：证书与信任清单跨轮次复用，免去重新配对
  const workDir = process.env.LINKSPACE_PROBE_HOME ?? '/tmp/linkspace-probe-home'
  const saveDir = process.env.LINKSPACE_RECV_DIR ?? join(workDir, 'received')
  await mkdir(saveDir, { recursive: true })
  // 清掉上一轮的落盘文件，校验只认本轮接收
  for (const f of await readdir(saveDir)) {
    await rm(join(saveDir, f), { recursive: true, force: true })
  }

  // bind 0.0.0.0：平板拿到的是局域网地址，绑回环会连不上（verify-e2e 同款坑）
  const host = new Host({
    displayName: 'XPlat-Recv',
    deviceType: 'win',
    dataDir: workDir,
    bind: '0.0.0.0'
  })
  await host.start()
  console.log(`[host] 接收端就绪 id=${host.id} 端口=${host.port} 保存目录=${saveDir}`)

  const timeoutMs = Number(process.env.LINKSPACE_RECV_TIMEOUT ?? 240_000)
  const timer = setTimeout(() => {
    console.log('[recv] 超时未等到完成的传输')
    process.exit(1)
  }, timeoutMs)

  host.on('transferOffered', (t: TransferTask) => {
    const files = t.files.map((f) => `${f.name}(${f.size}B)`).join(', ')
    console.log(`[recv] 收到 offer ${t.id} 来自 ${t.peerId}: ${files}`)
    host.acceptTransfer(t.id, saveDir).catch((err) => {
      console.log(`[recv] 接受失败: ${err instanceof Error ? err.message : String(err)}`)
      process.exit(1)
    })
  })

  host.on('transferChanged', (t: TransferTask) => {
    console.log(`[recv] 任务 ${t.id} → ${t.state} ${t.transferred}/${t.totalSize}`)
    if (t.state === 'completed') {
      clearTimeout(timer)
      void (async () => {
        for (const f of t.files) {
          // savePath 在 accept 时写入，completed 时必然存在
          const p = f.savePath ?? join(saveDir, f.name)
          const s = await stat(p)
          const digest = await sha256File(p)
          console.log(`[verify] ${f.name} size=${s.size} sha256=${digest} path=${p}`)
        }
        await host.stop()
        process.exit(0)
      })()
    }
    if (t.state === 'failed' || t.state === 'cancelled') {
      clearTimeout(timer)
      console.log(`[recv] 任务 ${t.state}: ${t.error ?? '(无错误信息)'}`)
      void host.stop().then(() => process.exit(1))
    }
  })
}

void main()
