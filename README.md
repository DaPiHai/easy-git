# EasyGit

> 不用记一条命令，也能放心用 Git。

EasyGit 是一款**轻量、跨平台、中文优先**的开源 Git 可视化桌面应用：让完全不会命令行的用户能安全地完成 Git 的日常与进阶操作，同时也为熟练开发者提供高效的专业模式。

- **零命令行**：克隆、暂存、提交、分支、合并、推送……全部图形化完成；每个操作还能查看等价的 git 命令（命令透视），边用边学。
- **全操作可撤销**：破坏性操作前自动创建快照点，删除进回收站，基于操作时间线的一键撤销。
- **四大可视化亮点**：提交历史 DAG 图、三区状态视图（工作区/暂存区/远程）、Diff 逐块暂存、冲突解决向导。
- **远程协作**：GitHub / GitLab / Gitee 深度集成（PR/MR、Issue），多仓库工作台，子模块与工作树管理。
- **轻量大仓库友好**：Tauri 2 + Rust，安装包 ≤ 30 MB，10 万+ 提交仓库流畅浏览。

## 技术栈

Tauri 2 · Rust（git2-rs + git CLI 混合） · React 18 · TypeScript · Tailwind CSS v4 · Zustand

## 文档

| 文档 | 说明 |
| --- | --- |
| [需求文档（PRD）](./docs/easy-git-prd.md) | 产品定位、功能需求、里程碑与验收标准 |
| [技术架构（TDD）](./docs/easy-git-tdd.md) | 选型决策、crate 划分、IPC 设计、测试策略 |
| [UI 设计文档](./docs/easy-git-ui-design.md) | 设计令牌、明暗主题、组件规格（基于 Linear 设计语言） |
| [M1 开发计划](./docs/easy-git-m1-plan.md) | MVP 十周任务拆解与排期 |
| [Git 命令清单](./docs/git-commands.md) | 功能覆盖映射的依据（172 个命令及作用） |
| [设计规范](./docs/design/DESIGN.md) | Linear 设计分析（上游规范） |

## 路线图

- **M1 — 本地仓库全流程（进行中）**：多仓库、三区暂存、提交、DAG 历史、分支/标签/储藏、合并与冲突向导、推送拉取、撤销系统
- **M2 — 远程协作与平台集成**：变基/摘取、GitHub/GitLab/Gitee 账号与 PR/MR、命令面板
- **M3 — 进阶与打磨**：交互式变基、二分定位、子模块/工作树、大仓库性能达标、多语言

完整规划见 [PRD §8](./docs/easy-git-prd.md)。

## 开发环境搭建

要求：Rust stable、Node.js 20+、pnpm 9、Git ≥ 2.30（Linux 另需 `webkit2gtk-4.1` 等 Tauri 依赖）。

```bash
pnpm install
pnpm tauri dev    # 开发模式
pnpm tauri build  # 出包
```

详见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## License

[MIT](./LICENSE) © The EasyGit Authors。UI 设计语言基于 [awesome-design-md](https://github.com/voltagent/awesome-design-md) 的 Linear 设计分析（MIT）适配。
