// 生成第三方许可证清单（SBOM），输出到 sbom/third-party-licenses.json。
//
// license-inventory.md §4 的要求：每次构建发布产物时生成，随发布归档；
// npm 依赖树用 license-checker 扫描，scrcpy/adb 等原生二进制不在 npm
// 依赖树内，必须手工维护（§1.3 有逐文件核实表）——本脚本把两部分
// 合并成一份 JSON，对应 mvp-acceptance.md 9.6「依赖清单」检查项。

import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const licenseChecker = require('license-checker')

const root = process.cwd()

function scanNpm() {
  return new Promise((resolve, reject) => {
    licenseChecker.init(
      { start: root, production: true, development: false, direct: false },
      (err, json) => (err ? reject(err) : resolve(json))
    )
  })
}

// 原生二进制手工条目。与 docs/license-inventory.md §1.3 的核实表保持同步，
// 版本升级时两处都要改。许可证 UNKNOWN 表示「取决于构建配置，尚未核实」，
// 不允许留空——留空会被当成已核实。
const NATIVE_COMPONENTS = [
  {
    name: 'scrcpy',
    version: '5.0.1',
    licenses: 'Apache-2.0',
    source: 'https://github.com/Genymobile/scrcpy',
    files: ['scrcpy.exe'],
    notes: '官方发行包自带 LICENSE.txt（Apache-2.0）'
  },
  {
    name: 'scrcpy-server',
    version: '5.0.1',
    licenses: 'Apache-2.0',
    source: 'https://github.com/Genymobile/scrcpy',
    files: ['scrcpy-server'],
    notes: '运行时推送到 Android 设备'
  },
  {
    name: 'Android Debug Bridge (adb)',
    version: '1.0.41',
    licenses: 'Apache-2.0',
    source: 'https://developer.android.com/studio/releases/platform-tools',
    files: ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll'],
    notes: ''
  },
  {
    name: 'SDL',
    version: '3.4.18',
    licenses: 'zlib',
    source: 'https://github.com/libsdl-org/SDL',
    files: ['SDL3.dll'],
    notes: 'scrcpy 5.x 已从 SDL2 升级为 SDL3'
  },
  {
    name: 'libusb',
    version: '1.0',
    licenses: 'LGPL-2.1',
    source: 'https://github.com/libusb/libusb',
    files: ['libusb-1.0.dll'],
    notes: '动态链接，需随附许可证全文（由 renderLicenseBundle 承担）'
  },
  {
    name: 'FFmpeg libavcodec',
    version: '63.1.102',
    licenses: 'UNKNOWN',
    source: 'https://ffmpeg.org',
    files: ['avcodec-63.dll'],
    notes: '取决于构建选项（LGPL 或 GPL），核实前按 UNKNOWN 记录，见 license-inventory.md §1.3'
  },
  {
    name: 'FFmpeg libavformat',
    version: '63',
    licenses: 'UNKNOWN',
    source: 'https://ffmpeg.org',
    files: ['avformat-63.dll'],
    notes: '同 libavcodec'
  },
  {
    name: 'FFmpeg libavutil',
    version: '61',
    licenses: 'UNKNOWN',
    source: 'https://ffmpeg.org',
    files: ['avutil-61.dll'],
    notes: '同 libavcodec'
  },
  {
    name: 'FFmpeg libswresample',
    version: '7',
    licenses: 'UNKNOWN',
    source: 'https://ffmpeg.org',
    files: ['swresample-7.dll'],
    notes: '同 libavcodec'
  }
]

const npmJson = await scanNpm()

// license-checker 的 key 形如 'name@version' 或 '@scope/name@version'。
// 它对 scoped 包经常不填 name/version 字段，必须从 key 兜底解析，
// 否则 SBOM 里会出现成片的空名条目（实测 @vue/*、@peculiar/* 全中招）。
function parseKey(key) {
  const at = key.lastIndexOf('@')
  return at > 0 ? [key.slice(0, at), key.slice(at + 1)] : [key, null]
}

const npmPackages = Object.entries(npmJson)
  .map(([key, info]) => {
    const [kName, kVersion] = parseKey(key)
    return {
      name: info.name || kName,
      version: info.version || kVersion,
      licenses: info.licenses,
      repository: info.repository ?? null,
      licenseFile: info.licenseFile ?? null,
      path: info.path
    }
  })
  // 根包是本项目自身（private → UNLICENSED），不属于第三方依赖
  .filter((p) => p.name !== 'linkspace-desktop')
  .sort((a, b) => a.name.localeCompare(b.name))

const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const sbom = {
  product: { name: pkg.name, version: pkg.version, description: pkg.description },
  generatedAt: new Date().toISOString(),
  generator: {
    tool: 'license-checker',
    version: require('license-checker/package.json').version,
    scope: 'production npm dependencies of apps/desktop'
  },
  nativeDistribution: {
    name: 'scrcpy 官方 Windows 发行包',
    version: '5.0.1',
    bundled: '随安装包分发于 <resourcesPath>/scrcpy/（electron-builder extraResources）',
    note: '官方发行包仅含一份 Apache-2.0 LICENSE.txt，SDL3/libusb/FFmpeg 的许可证文本需在发布时随附（license-inventory.md §5 合规检查表）',
    components: NATIVE_COMPONENTS
  },
  npmPackages
}

const outDir = join(root, 'sbom')
mkdirSync(outDir, { recursive: true })
const outFile = join(outDir, 'third-party-licenses.json')
writeFileSync(outFile, JSON.stringify(sbom, null, 2) + '\n')

const unknown = [
  ...npmPackages.filter((p) => String(p.licenses).toUpperCase().includes('UNKNOWN')),
  ...NATIVE_COMPONENTS.filter((p) => p.licenses === 'UNKNOWN')
]
console.log(`[sbom] npm 依赖 ${npmPackages.length} 个，原生组件 ${NATIVE_COMPONENTS.length} 个`)
console.log(`[sbom] 已写入 ${outFile}`)
if (unknown.length) {
  console.warn(`[sbom] ⚠ ${unknown.length} 个条目许可证为 UNKNOWN，发布前必须核实：`)
  for (const u of unknown) console.warn(`  - ${u.name}@${u.version}`)
}
