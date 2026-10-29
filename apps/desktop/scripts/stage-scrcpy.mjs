// 从本机已安装的 scrcpy 官方发行包复制到 vendor/scrcpy，供 electron-builder
// extraResources 打进安装包。安装后主进程按 <resourcesPath>/scrcpy 定位
// （platform.ts 查找顺序第 2 优先级），随包分发是 license-inventory.md §1.3
// 认定的合规基线：再分发需自行补齐 FFmpeg/SDL3/libusb 的许可证文本，
// 因此这里不裁剪发行包内容，保持与官方发行物逐文件一致、可追溯。
//
// 来源只认 LINKSPACE_SCRCPY_DIR 环境变量或 winget 已知安装路径，
// 与 platform.ts 的开发期兜底保持同一套约定。版本号目录会变，
// 版本升级时需同步修改 platform.ts 的 knownWingetDirs。

import { cpSync, existsSync, readdirSync, statSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const dest = join(process.cwd(), 'vendor', 'scrcpy')

function findSource() {
  const candidates = []
  if (process.env.LINKSPACE_SCRCPY_DIR) candidates.push(process.env.LINKSPACE_SCRCPY_DIR)
  const local = process.env.LOCALAPPDATA
  if (local) {
    candidates.push(
      join(
        local,
        'Microsoft',
        'WinGet',
        'Packages',
        'Genymobile.scrcpy_Microsoft.Winget.Source_8wekyb3d8bbwe',
        'scrcpy-win64-v5.0.1'
      )
    )
  }
  for (const dir of candidates) {
    if (existsSync(join(dir, 'scrcpy.exe'))) return dir
  }
  return null
}

const src = findSource()
if (!src) {
  console.error(
    '[stage:scrcpy] 未找到 scrcpy 发行包。请设置 LINKSPACE_SCRCPY_DIR 指向 scrcpy-win64 解压目录。'
  )
  process.exit(1)
}
if (!existsSync(join(src, 'adb.exe'))) {
  console.error('[stage:scrcpy] 源目录缺少 adb.exe，不是完整的官方发行包：' + src)
  process.exit(1)
}

mkdirSync(dest, { recursive: true })
cpSync(src, dest, { recursive: true })

const files = readdirSync(dest)
let total = 0
for (const f of files) total += statSync(join(dest, f)).size
console.log(`[stage:scrcpy] ${src} -> ${dest}`)
console.log(`[stage:scrcpy] ${files.length} 个文件，共 ${(total / 1024 / 1024).toFixed(1)} MB`)
for (const f of files) console.log('  - ' + f)
