# apps/desktop — Windows 桌面端

Electron + Vue 3 + TypeScript。

## 职责

- 设备工作空间界面：设备卡片、拖拽布局、在线状态
- 发起配对、管理信任与授权范围
- 启动/停止投屏与文件传输任务
- 管理子进程生命周期（scrcpy、adb、windows-helper）

## 边界

- **渲染进程不创建子进程、不调用系统 API**（架构约束 C3）。一切系统能力经主进程 IPC。
- 不包含传输协议的实现细节，只消费 `modules/*` 暴露的能力。
- 不解析 scrcpy 视频流。

## 进程结构

```
main process  设备注册表 / HTTPS 服务 / mDNS / IPC 网关 / 子进程池
renderer      Vue 应用（可多窗口）
```

详见 `docs/architecture.md` 第 3 节。

## 状态

未开始。启动前需完成阶段 0 的 Electron 选型确认（ADR-001）。

## 待定

- 构建工具：electron-vite / electron-builder 待定
- 是否使用 TypeScript 严格模式：建议是
