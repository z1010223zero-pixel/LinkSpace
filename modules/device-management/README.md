# modules/device-management — 设备与会话管理

架构 L2 层。

## 职责

- 设备注册表：身份、能力、显示名、信任状态
- 信任关系管理：配对、授权范围、撤销
- 连接状态机与心跳对账
- 会话生命周期（投屏 / 传输 / 控制）
- 设备布局的持久化（与在线状态解耦）

## 对外接口（草案）

```ts
interface DeviceRegistry {
  list(): Device[];
  get(id: DeviceId): Device | undefined;
  updateTrust(id: DeviceId, state: TrustState, scope?: Capability[]): void;
  saveLayout(layout: Layout): void;
}

interface SessionManager {
  start(type: SessionType, target: DeviceId, params: unknown): Promise<SessionId>;
  stop(id: SessionId): Promise<void>;
  onStateChange(handler: (s: Session) => void): void;
}
```

## 关键约束

- **布局不随离线清理**（方案 2.2）。`layout` 独立存储。
- 心跳连续 3 次超时才判定离线，避免抖动误判。
- 应用退出时必须停止所有会话并清理子进程。

## 状态

未开始。状态机定义见 `docs/architecture.md` 第 5 节。
