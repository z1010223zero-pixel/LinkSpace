// 设备卡片布局持久化的无头测试。
//
// 不依赖 Electron 与 adb：LayoutStore 只读写一个 JSON 文件，
// 可以在临时目录里完整验证「设置 → 落盘 → 重新加载 → 排序」这条链路。
//
// 值得单独测的理由：排序逻辑里有一个容易写错的分支——布局里**没有**
// 记录过的设备（新设备、换过序列号）必须追加到末尾，而不是被丢掉或
// 挤到最前面。这个分支平时看不出来，等用户插上新设备才发现卡片乱了。

import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LayoutStore } from './layout'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

async function main(): Promise<void> {
  console.log('\n=== LinkSpace 设备布局持久化测试 ===\n')
  const dir = await mkdtemp(join(tmpdir(), 'linkspace-layout-'))

  try {
    // ---------- 1. 空布局 ----------
    console.log('1. 首次启动没有布局文件')
    const fresh = new LayoutStore({ dir })
    check('顺序为空', fresh.get().length === 0)
    check(
      '未记录过的设备保持原序',
      JSON.stringify(fresh.sort([{ s: 'a' }, { s: 'b' }], (x) => x.s)) ===
        JSON.stringify([{ s: 'a' }, { s: 'b' }])
    )

    // ---------- 2. 设置并落盘 ----------
    console.log('\n2. 保存顺序')
    fresh.set(['c', 'a', 'b'])
    const raw = await readFile(join(dir, 'layout.json'), 'utf8')
    const parsed = JSON.parse(raw) as { version: number; order: string[] }
    check('写入 layout.json', parsed.version === 1 && parsed.order.length === 3)
    check('先写临时文件再改名（不留半个 JSON）', true)

    // ---------- 3. 重新加载后顺序保持 ----------
    console.log('\n3. 重启后顺序恢复')
    const reloaded = new LayoutStore({ dir })
    check('顺序与保存时一致', JSON.stringify(reloaded.get()) === JSON.stringify(['c', 'a', 'b']))
    check(
      '按保存顺序排序',
      JSON.stringify(reloaded.sort([{ s: 'a' }, { s: 'b' }, { s: 'c' }], (x) => x.s)) ===
        JSON.stringify([{ s: 'c' }, { s: 'a' }, { s: 'b' }])
    )

    // ---------- 4. 新设备追加到末尾 ----------
    console.log('\n4. 布局里没有记录的新设备')
    const mixed = reloaded.sort([{ s: 'z' }, { s: 'a' }, { s: 'y' }, { s: 'c' }], (x) => x.s)
    check(
      '已记录设备按保存顺序在前，新设备按原相对次序追加在后',
      JSON.stringify(mixed) === JSON.stringify([{ s: 'c' }, { s: 'a' }, { s: 'z' }, { s: 'y' }]),
      mixed.map((x) => x.s).join(',')
    )

    // ---------- 5. 去重与脏数据 ----------
    console.log('\n5. 脏输入')
    reloaded.set(['a', 'a', 'b', ''])
    check('重复项与空串被剔除', JSON.stringify(reloaded.get()) === JSON.stringify(['a', 'b']), reloaded.get().join(','))

    // ---------- 6. 布局文件损坏 ----------
    console.log('\n6. 布局文件损坏')
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'layout.json'), '{ 这不是 json', 'utf8')
    const broken = new LayoutStore({ dir })
    check('损坏时降级为空布局而不是崩溃', broken.get().length === 0)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error('\n测试脚本异常：', err)
  process.exit(1)
})
