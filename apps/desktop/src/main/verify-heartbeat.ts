// 在线状态（验收 5.1）无头测试：离线判定的两条路径。
//
//   1. TCP 断连立即感知：对端 stop → onClosed 触发
//   2. 心跳静默超时：对端活着但不发消息（真实断网的典型表现是
//      静默丢包，TCP 没有断开信号）→ 15s 无消息判定离线并踢出
//
// 心跳间隔/超时可注入，测试用 100ms/300ms 短周期，1 秒内跑完。

import { setIdentityDir, getDeviceCert } from './transfer/identity'
import { ControlNode, type Connection } from './control/node'
import { WebSocket } from 'ws'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function waitFor<T>(fn: () => T | undefined, timeoutMs = 5000): Promise<T> {
  const start = Date.now()
  for (;;) {
    const v = fn()
    if (v !== undefined) return v
    if (Date.now() - start > timeoutMs) throw new Error('等待超时')
    await sleep(25)
  }
}

interface Node {
  id: string
  port: number
  control: ControlNode
  close(): Promise<void>
}

async function makeNode(id: string): Promise<Node> {
  const dir = await mkdtemp(join(tmpdir(), 'linkspace-hb-'))
  setIdentityDir(dir)
  const cert = await getDeviceCert()
  const control = new ControlNode({ deviceId: id, tls: { key: cert.key, cert: cert.cert } })
  const port = await control.listen()
  return {
    id,
    port,
    control,
    close: async () => {
      control.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 在线状态（心跳/断连）无头测试 ===\n')

  const A = await makeNode('dev_A_111111111111')
  const B = await makeNode('dev_B_222222222222')

  try {
    // ---------- 1. TCP 断连立即感知 ----------
    console.log('1. 对端断连立即感知')
    let closedSeen = false
    A.control.onClosed(() => {
      closedSeen = true
    })
    await A.control.connect('127.0.0.1', B.port)
    // 裸 ControlNode 没有 PairingCoordinator，peerId 无人填充，
    // 在线判定只依赖连接表与 onClosed 事件
    await waitFor(() => (A.control.connections().length === 1 ? true : undefined))
    check('连接已登记', A.control.connections().length === 1)

    await B.close()
    await waitFor(() => (closedSeen ? true : undefined))
    check('对端 stop 后 onClosed 触发', closedSeen)
    await waitFor(() => (A.control.connections().length === 0 ? true : undefined))
    check('断连后连接表已清理', A.control.connections().length === 0)

    // ---------- 2. 心跳静默超时（对端存活但不发消息） ----------
    console.log('\n2. 心跳超时判定离线（静默丢包路径）')
    const B2 = await makeNode('dev_B2_333333333333')
    await A.control.connect('127.0.0.1', B2.port)
    await waitFor(() => (A.control.connections().length === 1 ? true : undefined))
    check('第二条连接建立', A.control.connections().length === 1)

    // 双方都跑短周期心跳：正常消息往来时谁也不会被误杀
    let timedOut: Connection | null = null
    A.control.startHeartbeat((c) => {
      timedOut = c
    }, { intervalMs: 100, timeoutMs: 300 })
    B2.control.startHeartbeat(() => {}, { intervalMs: 100, timeoutMs: 300 })
    await sleep(500)
    check('正常心跳往来不误判超时', timedOut === null)

    // 模拟静默丢包：TCP 活着，但 B2 的消息再也到不了 A
    // （lastSeen 是收包时间戳，冻结它等同于「对端沉默」）
    for (const c of A.control.connections()) c.lastSeen = Date.now() - 10_000
    await waitFor(() => (timedOut !== null ? true : undefined))
    check('静默超时后心跳判定触发', timedOut !== null)
    // close 握手是异步的，连接表条目在 ws 'close' 事件里才删除
    await waitFor(() => (A.control.connections().length === 0 ? true : undefined))
    check('超时连接已被踢出连接表', A.control.connections().length === 0)

    await B2.close()
    A.control.stop()

    // ---------- 3. 消息洪泛防护（P2-5） ----------
    console.log('\n3. 消息洪泛防护（限频与单消息上限）')
    const B3 = await makeNode('dev_B3_444444444444')
    // 裸 ws 客户端直接灌消息：不经过 ControlNode 的发送侧，测的就是
    // 服务端对「合法格式 + 非法频率/尺寸」的防御
    const envelopeOf = (type: string, payload: Record<string, unknown> = {}) =>
      JSON.stringify({
        v: 1,
        type,
        id: 't-' + Math.random().toString(36).slice(2),
        from: 'dev_attacker',
        to: B3.id,
        ts: Date.now(),
        payload
      })

    // input.event 限频 200 条/s：阈值内保持，第 201 条断开
    {
      const ws = new WebSocket('wss://127.0.0.1:' + B3.port + '/linkspace/v1/control', {
        rejectUnauthorized: false
      })
      await new Promise<void>((r) => ws.once('open', r))
      let closedCode = 0
      ws.on('close', (code) => {
        closedCode = code
      })
      for (let i = 0; i < 200; i++) ws.send(envelopeOf('input.event'))
      await sleep(300)
      check('限频阈值内（200 条/s）连接保持', ws.readyState === WebSocket.OPEN)
      ws.send(envelopeOf('input.event'))
      await waitFor(() => (closedCode !== 0 ? true : undefined))
      check('超频的 input.event 被按 4008 断开', closedCode === 4008, String(closedCode))
    }

    // 单消息上限 1MiB：超过按 ws 标准 1009 断开，不进 JSON.parse
    {
      const ws = new WebSocket('wss://127.0.0.1:' + B3.port + '/linkspace/v1/control', {
        rejectUnauthorized: false
      })
      await new Promise<void>((r) => ws.once('open', r))
      let closedCode = 0
      ws.on('close', (code) => {
        closedCode = code
      })
      ws.send(envelopeOf('clipboard.share', { kind: 'text', text: 'x'.repeat(2 * 1024 * 1024) }))
      await waitFor(() => (closedCode !== 0 ? true : undefined))
      check('超过 1MiB 的消息被按 1009 断开', closedCode === 1009, String(closedCode))
    }

    await B3.close()
  } finally {
    await A.close().catch(() => {})
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
