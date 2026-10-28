// 设备身份证书。
//
// 每个设备一对自签密钥，证书与私钥持久化在 userData 下。
// **必须持久化**：若每次启动重新生成，指纹会变，已配对的对端会判定
// 身份变更并告警，用户就得重新配对（见 docs/threat-model.md T1）。
//
// 信任模型是 TOFU（首次配对时人工核对指纹），不是证书链验证——
// 局域网无 CA，这是现实选择，代价是需要用户参与一次确认。

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { generate } from 'selfsigned'
import { app } from 'electron'
import { log } from '../log'

export interface DeviceCert {
  /** PEM 私钥 */
  key: string
  /** PEM 证书 */
  cert: string
  /** 证书 DER 的 SHA-256，冒号分隔小写十六进制，用于人工核对 */
  fingerprint: string
}

/** 与 `openssl x509 -fingerprint -sha256` 一致的计算方式 */
export function fingerprintOfCert(certPem: string): string {
  const body = certPem.replace(/-----(BEGIN|END)[^-]+-----/g, '').replace(/\s+/g, '')
  const der = Buffer.from(body, 'base64')
  return createHash('sha256').update(der).digest('hex').replace(/(.{2})(?=.)/g, '$1:')
}

let cached: DeviceCert | null = null
let overrideDir: string | null = null

/**
 * 无头测试（node 直接运行，无 Electron）时注入 userData 目录。
 * 正常运行时留空，走 app.getPath('userData')。
 */
export function setIdentityDir(dir: string): void {
  overrideDir = dir
  cached = null
}

function resolveUserData(): string {
  if (overrideDir) return overrideDir
  // electron 在非 Electron 进程里（如无头测试）不可用，app 会退化成
  // 一个字符串，必须显式判错而不是让它带着 undefined 往下跑
  const maybeApp = app as unknown as { getPath?: (name: string) => string } | undefined
  if (maybeApp && typeof maybeApp.getPath === 'function') {
    return maybeApp.getPath('userData')
  }
  throw new Error('无法确定 userData 目录：无头测试请先调用 setIdentityDir()')
}

export async function getDeviceCert(): Promise<DeviceCert> {
  if (cached) return cached

  const dir = join(resolveUserData(), 'identity')
  const keyPath = join(dir, 'device-key.pem')
  const certPath = join(dir, 'device-cert.pem')

  if (existsSync(keyPath) && existsSync(certPath)) {
    const key = readFileSync(keyPath, 'utf8')
    const cert = readFileSync(certPath, 'utf8')
    cached = { key, cert, fingerprint: fingerprintOfCert(cert) }
    log.info(`已加载设备身份证书，指纹 ${cached.fingerprint.slice(0, 23)}…`)
    return cached
  }

// 首次生成。有效期 10 年，避免频繁重签导致指纹漂移。
  // selfsigned v5 用 notAfterDate 而非 days
  const notAfter = new Date()
  notAfter.setFullYear(notAfter.getFullYear() + 10)

  const pems = await generate(
    [{ name: 'commonName', value: 'LinkSpace Device' }],
    {
      notAfterDate: notAfter,
      keySize: 2048,
      algorithm: 'sha256',
      extensions: [
        { name: 'basicConstraints', cA: false, critical: true },
        { name: 'keyUsage', digitalSignature: true, keyEncipherment: true, critical: true },
        { name: 'extKeyUsage', serverAuth: true, clientAuth: true }
      ]
    }
  )

  mkdirSync(dir, { recursive: true })
  writeFileSync(keyPath, pems.private, { mode: 0o600 })
  writeFileSync(certPath, pems.cert)

  cached = {
    key: pems.private,
    cert: pems.cert,
    fingerprint: fingerprintOfCert(pems.cert)
  }
  log.info(`已生成设备身份证书，指纹 ${cached.fingerprint.slice(0, 23)}…`)
  return cached
}

/** 仅测试用：清掉缓存，下次读取时重新从磁盘加载 */
export function resetCertCache(): void {
  cached = null
}
