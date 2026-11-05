// 剪贴板回环抑制的无头测试。
//
// 这里测的不是「能不能收发」，而是**不会自己转起来**。剪贴板同步一旦
// 出现回环，两台机器会持续互推同一段文本，占满控制通道，且现象随
// 时序抖动时有时无——真机上极难稳定复现，只能靠确定性测试钉死。

import { ClipboardSync, type ClipboardIo } from './clipboard'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

/** 内存剪贴板，行为与系统剪贴板一致：写入后立即读到新值 */
function makeIo(initial = ''): ClipboardIo & { value: string } {
  const io = {
    value: initial,
    readText() {
      return io.value
    },
    writeText(t: string) {
      io.value = t
    }
  }
  return io
}

/** 可推进的假时钟，让抑制窗口的边界可确定验证 */
function makeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000
  return {
    now: () => t,
    advance: (ms: number) => {
      t += ms
    }
  }
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 剪贴板同步测试 ===\n')

  // ---------- 1. 启动基线 ----------
  console.log('1. 启动时不广播已有内容')
  {
    const io = makeIo('启动前就在剪贴板里的东西')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    sync.poll()
    check('启动基线未被发送', sent.length === 0, sent.join('|'))
  }

  // ---------- 2. 本机变更 ----------
  console.log('\n2. 本机复制后广播')
  {
    const io = makeIo('')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    io.value = '你好，LinkSpace'
    sync.poll()
    check('变更被发送一次', sent.length === 1 && sent[0] === '你好，LinkSpace')
    sync.poll()
    check('重复轮询不重复发送', sent.length === 1)
  }

  // ---------- 3. 收到远端 ----------
  console.log('\n3. 收到远端内容')
  {
    const io = makeIo('')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    sync.receive('来自对端的文本')
    check('已写入本机剪贴板', io.value === '来自对端的文本')
    check('未回推给对端', sent.length === 0)
  }

  // ---------- 4. 回环：收到后轮询不再发回 ----------
  console.log('\n4. 收到后立即轮询不产生回环（关键）')
  {
    const io = makeIo('')
    const sent: string[] = []
    const clock = makeClock()
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t), now: clock.now })
    sync.start()
    sync.receive('A')
    for (let i = 0; i < 5; i++) {
      clock.advance(200)
      sync.poll()
    }
    check('五次轮询一次都没发送', sent.length === 0, sent.join('|'))
  }

  // ---------- 5. 抑制窗口结束后仍能同步真实变更 ----------
  console.log('\n5. 抑制窗口结束后用户的新复制仍会同步')
  {
    const io = makeIo('')
    const sent: string[] = []
    const clock = makeClock()
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t), now: clock.now })
    sync.start()
    sync.receive('A')
    clock.advance(600) // 越过 500ms 抑制窗口
    io.value = 'B'
    sync.poll()
    check('窗口后的真实变更被发送', sent.length === 1 && sent[0] === 'B', sent.join('|'))
  }

  // ---------- 6. 抑制窗口内不把旧值记成基线 ----------
  console.log('\n6. 抑制窗口内读到旧值不会记成基线')
  {
    const io = makeIo('X')
    const sent: string[] = []
    const clock = makeClock()
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t), now: clock.now })
    sync.start() // 基线 X
    sync.receive('A') // 写入 A，基线变 A
    io.value = 'X' // 模拟写入尚未生效，读到旧值
    sync.poll() // 落在抑制窗口内
    io.value = 'A' // 写入生效
    clock.advance(600)
    sync.poll()
    check('窗口结束后不会把生效值当成新变更', sent.length === 0, sent.join('|'))
  }

  // ---------- 7. 体积上限 ----------
  console.log('\n7. 体积上限')
  {
    const io = makeIo('')
    const sent: string[] = []
    const skipped: string[] = []
    const sync = new ClipboardSync({
      io,
      send: (t) => sent.push(t),
      maxBytes: 100,
      onSkip: (r) => skipped.push(r)
    })
    sync.start()
    io.value = 'x'.repeat(101)
    sync.poll()
    check('超限的本机内容未发送', sent.length === 0)
    check('超限原因已上报', skipped.length === 1 && skipped[0].includes('超过上限'))
    sync.receive('y'.repeat(101))
    check('超限的远端内容未写入', io.value === 'x'.repeat(101))
  }

  // ---------- 8. 空内容 ----------
  console.log('\n8. 空内容不参与同步')
  {
    const io = makeIo('')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    io.value = ''
    sync.poll()
    check('清空剪贴板不发送', sent.length === 0)
    sync.receive('')
    check('收到的空内容不写入', io.value === '')
  }

  // ---------- 9. acceptRemote 门禁 ----------
  console.log('\n9. acceptRemote 未通过时不写入')
  {
    const io = makeIo('')
    const sync = new ClipboardSync({
      io,
      send: () => undefined,
      acceptRemote: () => false
    })
    sync.start()
    sync.receive('不该被接受的内容')
    check('未写入本机剪贴板', io.value === '')
  }

  // ---------- 10. 停止后不再响应 ----------
  console.log('\n10. stop 之后不再读写')
  {
    const io = makeIo('')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    sync.stop()
    io.value = 'Z'
    sync.poll()
    sync.receive('W')
    check('停止后既不发送也不写入', sent.length === 0 && io.value === 'Z')
  }

  // ---------- 11. 快速连续复制（验收 6.4） ----------
  console.log('\n11. 1s 内连续复制 5 次')
  {
    // 逐次轮询：每次都是用户真实复制，各发一次且顺序正确，
    // 绝不能出现旧值回推（那是回环，不是刷屏）
    const io = makeIo('')
    const sent: string[] = []
    const clock = makeClock()
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t), now: clock.now })
    sync.start()
    const inputs = ['一', '二', '三', '四', '五']
    for (const v of inputs) {
      io.value = v
      clock.advance(200) // 共 800ms < 1s
      sync.poll()
    }
    check('逐次轮询按序发送且无回推', JSON.stringify(sent) === JSON.stringify(inputs), sent.join('|'))
  }
  {
    // 轮询间隔大于复制间隔（800ms 轮询 vs 200ms 复制）：
    // 状态同步天然合并中间态，只发最终值——这就是「不刷屏」的保证
    const io = makeIo('')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    for (const v of ['1', '2', '3', '4', 'final']) io.value = v
    sync.poll() // 只轮询一次
    check('中间态被合并，只发最终值', sent.length === 1 && sent[0] === 'final', sent.join('|'))
  }

  // ---------- 12. 敏感内容不留痕（验收 6.7） ----------
  console.log('\n12. 日志与丢弃原因不含剪贴板明文')
  {
    const secret = 'P@ssw0rd-密码内容-0f2c9e'
    const io = makeIo('')
    const sent: string[] = []
    const skipped: string[] = []
    // 触发所有会留痕的路径：超限丢弃、空内容、回环抑制
    const sync = new ClipboardSync({
      io,
      send: (t) => sent.push(t),
      maxBytes: 10,
      onSkip: (r) => skipped.push(r)
    })
    sync.start()
    io.value = secret
    sync.poll() // 超限 → onSkip
    sync.receive(secret) // 远端同内容超限 → onSkip
    io.value = '短'
    sync.poll()
    sync.receive('长内容超限'.repeat(10))
    const all = skipped.join('\n')
    check('丢弃原因中无明文', !skipped.some((s) => s.includes(secret)), all.slice(0, 200))
    check('发送路径未发出敏感内容', !sent.includes(secret))
    check('丢弃原因只含尺寸与原因', skipped.every((s) => s.includes('字节') || s.includes('未接受') || s.includes('超过')), all.slice(0, 200))
  }

  // ---------- 13. 重新开启后基线重读（Host 开关语义） ----------
  console.log('\n13. stop 后再 start 不广播存量内容')
  {
    const io = makeIo('')
    const sent: string[] = []
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t) })
    sync.start()
    io.value = '开关期间复制的旧内容'
    sync.stop()
    sync.start() // 模拟用户重新打开开关：重读基线
    sync.poll()
    check('重新开启不广播存量内容', sent.length === 0, sent.join('|'))
    io.value = '开启后的新复制'
    sync.poll()
    check('开启后的新复制正常同步', sent.length === 1 && sent[0] === '开启后的新复制')
  }

  // ---------- 14. markRemoteWrite 抑制回推（如 screen.paste） ----------
  console.log('\n14. markRemoteWrite 防止远端写入文本被 poll 回推')
  {
    const io = makeIo('初始内容')
    const sent: string[] = []
    const clock = makeClock()
    const sync = new ClipboardSync({ io, send: (t) => sent.push(t), now: clock.now })
    sync.start()
    const pasteText = '远端粘贴过来的中文内容'
    io.value = pasteText
    sync.markRemoteWrite(pasteText)
    sync.poll()
    check('markRemoteWrite 后立即 poll 不产生回推', sent.length === 0, sent.join('|'))
    clock.advance(600)
    sync.poll()
    check('抑制窗口过后由于内容未变仍然不回推', sent.length === 0, sent.join('|'))
    io.value = '用户后续新的复制'
    sync.poll()
    check('后续新复制正常同步', sent.length === 1 && sent[0] === '用户后续新的复制')
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
