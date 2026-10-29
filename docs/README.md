# EasyGit 文档索引

| 文档 | 说明 | 状态 |
| --- | --- | --- |
| [easy-git-prd.md](./easy-git-prd.md) | 产品需求文档：定位、用户与场景、功能需求（P0–P2）、非功能需求、里程碑与验收 | v1.0 |
| [easy-git-tdd.md](./easy-git-tdd.md) | 技术架构：选型决策、代码结构、IPC 与并发模型、安全引擎、测试与 CI | v1.0 |
| [easy-git-ui-design.md](./easy-git-ui-design.md) | UI 设计：设计令牌、明暗双主题、中文排版、组件规格、关键界面布局 | v1.0 |
| [easy-git-m1-plan.md](./easy-git-m1-plan.md) | M1（MVP）十周开发计划：任务拆解、每周验收、裁剪顺序、发布清单 | v1.0 |
| [git-commands.md](./git-commands.md) | Git 2.53 全部 172 个命令/文档条目及作用（功能覆盖映射依据） | v1.0 |
| [perf-baseline.md](./perf-baseline.md) | 性能基线：冷启动、首屏、内存与包体积实测，含复现方法 | X-01 实测 |
| [testing-10min.md](./testing-10min.md) | 10 分钟新手测试脚本：真人验收任务卡、观察记录表、自动化对照 | X-04 |
| [design/DESIGN.md](./design/DESIGN.md) | Linear 设计分析（上游设计规范，取自 awesome-design-md） | 上游 alpha |
| [design/LICENSE.awesome-design-md](./design/LICENSE.awesome-design-md) | 上游规范许可（MIT © 2026 VoltAgent） | — |

## 阅读顺序建议

- 了解产品 → PRD → UI 设计文档
- 动手开发 → PRD §5/§8 → TDD → M1 计划 → UI 设计文档（实现时对照）
- 评审决策 → PRD §1.3（已确认决策）、§10（开放问题）

> 根目录 [README](../README.md) 里的界面截图存放在 [`screenshots/`](./screenshots/)（1440×900，演示仓库数据）。UI 改动后建议同步重拍：状态清单（主题 / 视图 / 浮层）可参考 `scripts/snapshot-ui.py`。
