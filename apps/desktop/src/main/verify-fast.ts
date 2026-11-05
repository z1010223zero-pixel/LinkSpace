// 高性能投屏的无头测试：帧切分、帧头打包、尺寸/码率计算、候选命令构造，
// 以及（本机有 ffmpeg 与硬编时）用合成源跑真实编码流验证切帧。
// 抓屏（ddagrab）需要交互式桌面会话，这里不测；真机自检看 host 的 [fast-stream] 日志。

import { spawnSync } from 'node:child_process'
import {
  AuSplitter,
  FAST_FLAG_KEY,
  FAST_FRAME_HEADER_BYTES,
  alignDown32,
  alignNearest32,
  buildFastArgs,
  candidatesFor,
  computeFastBitrate,
  computeFastSize,
  hasDdagrab,
  listCompiledEncoders,
  packFastFrame,
  pickFastCandidate
} from './fast-stream'

let failures = 0

function check(label: string, pass: boolean, detail = ''): void {
  if (!pass) failures++
  console.log(`  [${pass ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`)
}

const SC4 = Buffer.from([0, 0, 0, 1])
const SC3 = Buffer.from([0, 0, 1])
const aud = (sc: Buffer): Buffer => Buffer.concat([sc, Buffer.from([0x09, 0xf0])])
const nal = (sc: Buffer, type: number, body: number[]): Buffer =>
  Buffer.concat([sc, Buffer.from([0x60 | type, ...body])])

/** 合成一个 AU：AUD [+ SPS PPS] + 切片（IDR=5 / 非 IDR=1） */
function makeAu(key: boolean, sc: Buffer = SC4, bodyLen = 20): Buffer {
  const parts = [aud(sc)]
  if (key) {
    parts.push(nal(sc, 7, [1, 2, 3]), nal(sc, 8, [4, 5]))
  }
  parts.push(nal(sc, key ? 5 : 1, new Array(bodyLen).fill(0xab)))
  return Buffer.concat(parts)
}

async function main(): Promise<void> {
  console.log('\n=== 高性能投屏 · 无头测试 ===\n')

  console.log('1. AU 切分（整块喂入）')
  {
    const s = new AuSplitter()
    const stream = Buffer.concat([makeAu(true), makeAu(false), makeAu(false), makeAu(true)])
    const out = s.push(stream)
    // 最后一个 AU 要等下一个 AUD 才完整，所以此刻只出前 3 个
    check('已完整的 AU 数 = 3', out.length === 3, String(out.length))
    check('首个是关键帧', out[0]?.key === true)
    check('第二三个是非关键帧', out[1]?.key === false && out[2]?.key === false)
    check('AU 以 AUD 开头', out.every((o) => o.au[4] === 0x09))
    const more = s.push(makeAu(false))
    check('下一个 AUD 到来后最后一个 AU 落地', more.length === 1 && more[0]!.key === true)
  }

  console.log('\n2. AU 切分（任意位置碎片喂入）')
  {
    const frames = [true, false, false, false, true, false, false].map((k, i) =>
      makeAu(k, i % 2 === 0 ? SC4 : SC3, 5 + i * 37)
    )
    const stream = Buffer.concat([...frames, makeAu(false)])
    for (const step of [1, 2, 3, 7, 13, 64]) {
      const s = new AuSplitter()
      const got: Array<{ au: Buffer; key: boolean }> = []
      for (let i = 0; i < stream.length; i += step) got.push(...s.push(stream.subarray(i, i + step)))
      const same =
        got.length === frames.length &&
        got.every((g, i) => g.au.equals(frames[i]!)) &&
        got.every((g, i) => g.key === (i === 0 || i === 4))
      check(`步长 ${step} 字节：${frames.length} 个 AU 逐字节一致`, same, `got=${got.length}`)
    }
  }

  console.log('\n3. AU 切分（首个 AUD 之前的杂字节被丢弃）')
  {
    const s = new AuSplitter()
    const junk = Buffer.from([9, 8, 7, 6, 5])
    const out = s.push(Buffer.concat([junk, makeAu(true), makeAu(false)]))
    check('杂字节不进 AU', out.length === 1 && out[0]!.au.equals(makeAu(true)))
  }

  console.log('\n4. 帧头打包')
  {
    const au = makeAu(true)
    const key = packFastFrame(au, true, 1_700_000_000_123)
    const non = packFastFrame(au, false, 5)
    check('帧头 9 字节', key.length === FAST_FRAME_HEADER_BYTES + au.length)
    check('关键帧标志位', (key[0]! & FAST_FLAG_KEY) === FAST_FLAG_KEY && non[0] === 0)
    check('时间戳 u64 小端', key.readBigUInt64LE(1) === 1_700_000_000_123n)
    check('负载原样', key.subarray(FAST_FRAME_HEADER_BYTES).equals(au))
  }

  console.log('\n5. 分辨率与码率')
  {
    check('alignDown32(1999)=1984', alignDown32(1999) === 1984)
    check('alignNearest32(1116)=1120', alignNearest32(1116) === 1120)
    const a = computeFastSize(3840, 2160, 2000, 1250)
    check('4K 屏 → 平板盒子 2000x1250：宽 1984', a.width === 1984, JSON.stringify(a))
    check('高度为 32 倍数', a.height % 32 === 0 && a.height === 1120, JSON.stringify(a))
    const b = computeFastSize(1366, 768, 2560, 1600)
    check('小屏不放大', b.width <= 1366 && b.width === 1344, JSON.stringify(b))
    const c = computeFastSize(1920, 1080, 1920, 1080)
    check('1080p 保持 1920x1088(最近32倍数)', c.width === 1920 && c.height === 1088, JSON.stringify(c))
    const r1080 = computeFastBitrate(1920, 1088, 60)
    check('1080p60 码率约 12Mbps', r1080 > 11e6 && r1080 < 14e6, String(r1080))
    check('码率下限 6M', computeFastBitrate(640, 480, 24) === 6_000_000)
    check('码率上限 40M', computeFastBitrate(3840, 2160, 60) === 40_000_000)
  }

  console.log('\n6. 候选与命令构造')
  {
    const cands = candidatesFor(['h264_nvenc', 'h264_qsv'])
    check('每个编码器两条通路（GPU 缩放优先）', cands.length === 4 && cands[0]!.zeroCopy && !cands[1]!.zeroCopy)
    const p = { outputIdx: 1, width: 1984, height: 1120, fps: 60, bitrate: 13_000_000 }
    const qsv = buildFastArgs(candidatesFor(['h264_qsv'])[0]!, p).join(' ')
    check('QSV 零拷贝：hwmap + scale_qsv', qsv.includes('hwmap=derive_device=qsv') && qsv.includes('scale_qsv=w=1984:h=1120'))
    check('带 output_idx 与帧率', qsv.includes('output_idx=1') && qsv.includes('framerate=60'))
    check('无 B 帧、无前瞻', qsv.includes('-bf 0') && qsv.includes('-look_ahead 0'))
    check('补 SPS/PPS 且插 AUD', qsv.includes('dump_extra=freq=keyframe') && qsv.includes('aud=insert'))
    const nv = buildFastArgs(candidatesFor(['h264_nvenc'])[0]!, p).join(' ')
    check('NVENC 零拷贝：scale_d3d11', nv.includes('scale_d3d11=w=1984:h=1120') && nv.includes('-tune ll'))
    const cpu = buildFastArgs(candidatesFor(['h264_amf'])[1]!, p).join(' ')
    check('CPU 缩放通路：hwdownload', cpu.includes('hwdownload') && cpu.includes('-usage ultralowlatency'))
    const probe = buildFastArgs(candidatesFor(['h264_qsv'])[0]!, p, 12).join(' ')
    check('探测模式限帧数', probe.includes('-frames:v 12'))
  }

  console.log('\n7. 真实编码流切帧（合成源 + 本机硬编，不含抓屏）')
  {
    const encs: string[] = await listCompiledEncoders('ffmpeg').catch(() => [])
    const ddagrab = await hasDdagrab('ffmpeg').catch(() => false)
    const picked = await pickFastCandidate('ffmpeg').catch(() => null)
    console.log(`  ffmpeg 编译含：${encs.join(',') || '(无)'} ddagrab=${ddagrab} picked=${picked?.id ?? 'null'}`)
    const test = (encoder: string, extra: string[]): void => {
      const r = spawnSync(
        'ffmpeg',
        [
          '-hide_banner', '-loglevel', 'error',
          '-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=60',
          '-t', '2', '-vf', 'format=nv12',
          '-c:v', encoder, ...extra,
          '-bf', '0', '-g', '30',
          '-bsf:v', 'dump_extra=freq=keyframe,h264_metadata=aud=insert',
          '-f', 'h264', 'pipe:1'
        ],
        { maxBuffer: 64 * 1024 * 1024 }
      )
      if (r.status !== 0 || r.stdout.length < 1000) {
        console.log(`  [SKIP] ${encoder} 本机不可用（${r.stderr?.toString().trim().split('\n').slice(-1)[0] ?? ''}）`)
        return
      }
      const s = new AuSplitter()
      const aus = s.push(r.stdout)
      // 120 帧 → 末帧待下一个 AUD，期望 119 个
      check(`${encoder}：AU 数 ≈ 帧数`, aus.length >= 115 && aus.length <= 120, String(aus.length))
      const keys = aus.filter((a) => a.key).length
      check(`${encoder}：GOP 30 → 关键帧约 4 个`, keys >= 3 && keys <= 6, String(keys))
      check(`${encoder}：首帧是关键帧`, aus[0]?.key === true)
      const hasSps = (b: Buffer): boolean => {
        for (let i = 0; i + 3 < b.length; i++) {
          if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3]! & 0x1f) === 7) return true
        }
        return false
      }
      check(`${encoder}：每个关键帧自带 SPS`, aus.filter((a) => a.key).every((a) => hasSps(a.au)))
      check(`${encoder}：非关键帧无 SPS`, aus.filter((a) => !a.key).every((a) => !hasSps(a.au)))
      // 逐字节重组：所有 AU 拼起来应是原流的前缀
      const joined = Buffer.concat(aus.map((a) => a.au))
      check(`${encoder}：AU 拼接 = 原流前缀（无丢字节）`, r.stdout.subarray(0, joined.length).equals(joined))
    }
    test('libx264', ['-preset', 'ultrafast', '-tune', 'zerolatency'])
    if (encs.includes('h264_qsv')) {
      test('h264_qsv', ['-preset', 'veryfast', '-look_ahead', '0', '-async_depth', '1', '-b:v', '6M'])
    }
  }

  console.log(`\n=== 结果：${failures === 0 ? '全部通过' : `${failures} 项失败`} ===\n`)
  process.exit(failures === 0 ? 0 : 1)
}

void main()
