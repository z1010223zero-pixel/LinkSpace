# 文档索引

| 文档 | 用途 | 状态 |
|---|---|---|
| `architecture.md` | 分层、进程模型、端口规划、状态机、适配层接口、ADR | 草案 v0.1 |
| `protocol.md` | 消息定义、文件传输子协议、错误码、版本兼容 | 草案 v0 |
| `mvp-acceptance.md` | 可执行验收清单、发布门限 | 可用 |
| `threat-model.md` | 资产、信任边界、威胁与缓解 | 初版 |
| `license-inventory.md` | 依赖许可证核实与合规检查 | 已核实主要项 |
| `roadmap.md` | 阶段划分、门限、转向判据 | 可用 |
| `technical-validation.md` | 第 1 周验证清单与记录模板 | 待执行 |

## 阅读顺序

新接手本项目建议按以下顺序：

1. 根目录 `README.md` —— 项目是什么、现在到哪一步
2. `architecture.md` —— 系统怎么切分
3. `protocol.md` —— 设备之间说什么
4. `threat-model.md` —— 什么不能做
5. `license-inventory.md` —— 什么代码不能碰
6. `roadmap.md` + `mvp-acceptance.md` —— 下一步做什么、做到什么算完

## 约定

- 设计结论写进文档，不留在对话里。
- 文档之间用相对链接互相引用，避免内容重复后不同步。
- 状态字段如实填写：草案 / 可用 / 待执行 / 已过时。过时的文档不要删，标注日期与替代文档。
