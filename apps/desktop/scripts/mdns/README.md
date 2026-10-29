# mDNS 排查脚本

`npm run verify:mdns` 失败时，按下面顺序跑。每一步隔离一层，
**不要跳步**——mDNS 出问题时每层的现象都可能是「底层通、上层不通」，
跳步很容易误判。

```bash
cd apps/desktop

# 1. 组播层通不通？（收不到任何包 → 网卡/系统问题，不是代码问题）
node scripts/mdns/mdns-diag.cjs

# 2. 包里的名字对不对？（看 PTR 记录名是否为 _linkspace._tcp.local）
node scripts/mdns/mdns-records.cjs        # 需要 Android 刚启动，通告是突发式的

# 3. 查询有没有应答？（有应答说明对端活着）
node scripts/mdns/mdns-query.cjs

# 4. 带 interface 通不通？（通 → 问题在网卡选择；不通 → interface 本身有问题）
node scripts/mdns/mdns-iface-test.cjs 192.168.x.x

# 5. 端口能不能绑
node scripts/mdns/mdns-port.cjs

# 6. 最后才看解析层
npm run verify:mdns
```

## 2026-10-29 修复记录

三层问题叠加，每层单独的表现都一样，所以必须逐层隔离：

| 层 | 问题 | 现象 |
|---|---|---|
| Android 发送侧 | `advertise()` 在 MulticastLock 获取之前调用 | 本机日志显示注册成功，对端零收到 |
| Windows 网卡选择 | `multicast-dns` 选中了 CGNAT 段（100.64/10） | 能收到突发通告，主动查询无应答 |
| Windows 解析层 | Android 的 TXT 缺 `ver` 字段，`parseTxt` 拒收 | bonjour 底层有应答，Discovery 不 emit up |

## 脚本说明

| 脚本 | 依赖 | 说明 |
|---|---|---|
| `mdns-diag.cjs` | 无 | 全流量嗅探，不带过滤。用于确认组播 RX 是否工作 |
| `mdns-records.cjs` | Android 刚重启 | 解析 PTR/SRV/TXT 记录名与内容 |
| `mdns-query.cjs` | Android 在线 | 手动构造 PTR 查询，测试对端是否应答 |
| `mdns-iface-test.cjs` | Android 在线 | 直接用 `multicast-dns` 带 interface 选项 |
| `mdns-port.cjs` | 无 | 检查 5353 能否绑定 |
| `mdns-resolve.cjs` | Android 在线 | 直接用 bonjour-service（不带 interface），复现原 bug |

这几个脚本刻意用 CommonJS 且不依赖 electron，可以在任何 Node 环境直接跑。
