// LinkSpace 应用内日志 —— 脱敏是硬要求，见 docs/threat-model.md T5
//
// 允许记录：设备序列号（截断）、消息类型、错误码、字节数、时长
// 禁止记录：文件路径全称、剪贴板内容、凭据、配对码、密钥

type Level = 'info' | 'warn' | 'error'

function stamp(): string {
  return new Date().toISOString()
}

function emit(level: Level, msg: string): void {
  const line = `${stamp()} [${level.toUpperCase()}] ${msg}`
  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)
}

/** 序列号可能很长（无线设备形如 adb-xxxx._adb-tls-connect._tcp），只留前缀 */
export function shortSerial(serial: string): string {
  return serial.length > 24 ? `${serial.slice(0, 24)}…` : serial
}

export const log = {
  info: (m: string) => emit('info', m),
  warn: (m: string) => emit('warn', m),
  error: (m: string) => emit('error', m)
}
