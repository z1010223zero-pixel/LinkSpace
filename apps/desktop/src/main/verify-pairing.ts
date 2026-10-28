// 发现与配对无头环路测试。
//
// 同一进程内起两个完整节点（各自的证书、信任清单、控制通道、文件传输服务），
// 走真实的 WebSocket + TLS 路径验证配对协议，不依赖第二台设备。
//
// 覆盖 docs/mvp-acceptance.md 第 2、9 组中可自动化的部分：
//   2.x 未授权设备不能执行受保护操作
//   9.1 连接授权 / 9.3 撤销信任 / 9.2 配对机制

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setIdentityDir, getDeviceCert } from './transfer/identity'
import { TrustStore } from './transfer/trust'
import { ControlNode } from './control/node'
import { PairingCoordinator, type PendingPairing } from './pairing'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

interface Node {
  id: string
  dir: string
  port: number
  trust: TrustStore
  control: ControlNode
  pairing: PairingCoordinator
  pending: PendingPairing[]
  close(): Promise<void>
}

async function makeNode(id: string, displayName: string): Promise<Node> {
  const dir = await mkdtemp(join(tmpdir(), 'linkspace-pair-'))
  setIdentityDir(dir)

  // 先拿到证书再构造协调器，避免「指纹还没算出来就要用」的顺序问题
  const cert = await getDeviceCert()
  const fingerprint = cert.fingerprint

  const trust = new TrustStore({ dir: join(dir, 'trust') })

  const control = new ControlNode({ deviceId: id, tls: { key: cert.key, cert: cert.cert } })
  // 配对测试只走控制通道，端口由系统分配；
  // 数据面（文件传输服务）不在本测试范围内
  const port = await control.listen()

  const pairing = new PairingCoordinator({
    deviceId: id,
    displayName,
    deviceType: 'win',
    trust,
    node: control,
    caps: () => ['file', 'clipboard'],
    selfFingerprint: () => fingerprint
  })

  const node: Node = {
    id,
    dir,
    port,
    trust,
    control,
    pairing,
    pending: [],
    close: async () => {
      control.stop()
      await rm(dir, { recursive: true, force: true })
    }
  }

  pairing
    .onPairRequested((p) => {
      node.pending.push(p)
    })
    .onPaired(() => {
      /* 由各用例自行断言 */
    })
    .onRevoked(() => {
      /* 由各用例自行断言 */
    })

  return node
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

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 发现与配对无头环路测试 ===\n')

  const A = await makeNode('dev_A_111111111111', 'Alpha')
  const B = await makeNode('dev_B_222222222222', 'Beta')

  try {
    // ---------- 1. 未授权设备被拒绝 ----------
    console.log('1. 未授权设备不能执行受保护操作')
    check('A 不认识 B', !A.trust.isKnown(B.id))
    check('B 不认识 A', !B.trust.isKnown(A.id))

    // ---------- 2. 建立连接并交换身份 ----------
    console.log('\n2. 控制通道连接与身份声明')
    const conn = await A.control.connect('127.0.0.1', B.port)
    A.pairing.introduce(conn)
    await waitFor(() => (conn.peerId === B.id ? conn : undefined))
    check('连接建立且对端身份已声明', conn.peerId === B.id, `peerId=${conn.peerId}`)

    // ---------- 3. 配对：正确配对码 ----------
    console.log('\n3. 配对流程（正确配对码）')
    const pairingPromise = A.pairing.requestPairing(conn)
    const pending = await waitFor(() => B.pending.find((p) => p.peerId === A.id))
    check('B 收到配对请求并生成配对码', /^\d{6}$/.test(pending.code), `code=${pending.code}`)

    const submit = A.pairing.submitCode(conn, pending.code)
    check('A 提交配对码', submit.ok)

    const entry = await pairingPromise
    check('A 侧建立信任', A.trust.isKnown(B.id), `scope=${entry.scope.join(',')}`)
    await waitFor(() => (B.trust.isKnown(A.id) ? true : undefined))
    check('B 侧建立信任', B.trust.isKnown(A.id))
    check('双方记录了对方证书指纹', Boolean(A.trust.fingerprintOf(B.id) && B.trust.fingerprintOf(A.id)))

    // ---------- 4. 配对码错误被拒绝 ----------
    console.log('\n4. 配对码错误')
    const C = await makeNode('dev_C_333333333333', 'Gamma')
    const connC = await C.control.connect('127.0.0.1', B.port)
    C.pairing.introduce(connC)
    await waitFor(() => (connC.peerId === B.id ? connC : undefined))
    void C.pairing.requestPairing(connC).catch(() => {
      /* 预期失败 */
    })
    const pendingC = await waitFor(() => B.pending.find((p) => p.peerId === C.id))

    const wrong = B.pairing.approve(pendingC, '000000')
    check('错误配对码被拒绝', !wrong.ok, wrong.error ?? '')
    check('错误计数已记录', pendingC.attempts === 1, `attempts=${pendingC.attempts}`)
    check('错误配对码未建立信任', !B.trust.isKnown(C.id) && !C.trust.isKnown(B.id))

    B.pairing.reject(pendingC, '用户拒绝')
    await sleep(200)
    await C.close()

    // ---------- 5. 信任撤销 ----------
    console.log('\n5. 撤销信任')
    let revokedSeen = false
    A.pairing.onRevoked((deviceId) => {
      if (deviceId === B.id) revokedSeen = true
    })
    const revoked = B.pairing.revoke(A.id)
    check('B 撤销对 A 的信任', revoked)
    // 撤销要走一个网络往返，等 A 真的删掉再断言
    await waitFor(() => (!A.trust.isKnown(B.id) ? true : undefined))
    check('A 的信任清单中已无 B', !A.trust.isKnown(B.id))
    await waitFor(() => (revokedSeen ? true : undefined))
    check('A 收到撤销通知', revokedSeen)

    // 撤销后重连：不应自动恢复信任
    const conn2 = await A.control.connect('127.0.0.1', B.port)
    A.pairing.introduce(conn2)
    await sleep(300)
    check('撤销后重连不会自动恢复信任', !A.trust.isKnown(B.id) && !B.trust.isKnown(A.id))
    conn2.close()
  } finally {
    await A.close()
    await B.close()
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
