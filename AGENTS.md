# AGENTS.md — EasyGit 工作区指引

## 项目概述

EasyGit：轻量、跨平台、中文优先的 Git 可视化**桌面应用**，目标是让完全不会命令行的用户安全完成 Git 操作。Tauri 2 + Rust 核心 + React 18/TypeScript 前端，MIT 协议开源。

**当前阶段：纯文档期（M1 开发尚未启动）。** 仓库中没有任何源代码、`package.json` 或 Cargo 工程；也不是 git 仓库（未 `git init`）。第一个编码任务是按 `docs/easy-git-m1-plan.md` W1 建立脚手架——不要凭空发明结构，脚手架必须符合 TDD。

## 目录结构

```
README.md / CONTRIBUTING.md / LICENSE   # 项目门面（已定稿）
docs/
├─ README.md             # 文档索引与阅读顺序（先读这个）
├─ easy-git-prd.md       # 需求文档：功能 P0-P2、里程碑、§1.3 已定决策、§10 开放问题
├─ easy-git-tdd.md       # 技术架构：目录结构、IPC、并发模型、安全引擎、测试/CI
├─ easy-git-ui-design.md # UI 设计：--eg-* 令牌、明暗双主题、组件规格、界面布局图
├─ easy-git-m1-plan.md   # MVP 十周计划：任务编号 F-xx/R-xx/C-xx、每周验收、裁剪顺序
├─ git-commands.md       # Git 2.53 全部 172 命令清单（功能覆盖映射依据）
└─ design/DESIGN.md      # Linear 设计规范（上游参考，来自 awesome-design-md，MIT）
```

## 动手前必读

- 任何开发：`docs/easy-git-tdd.md`（结构与边界）+ 对应功能的 PRD §5 条目和 M1 计划任务行。
- UI 相关：`docs/easy-git-ui-design.md` 是实现标准；`docs/design/DESIGN.md` 只是上游审美参考，两者冲突时以前者为准。
- 需求取舍：PRD §1.3 决策表已锁定（勿重新讨论），§10 开放问题中未决项不要擅自定案，询问用户。

## 已锁定的架构边界与规范

- 分层：前端 `src/`（React）与 Rust 核心 `src-tauri/crates/`（eg-types、eg-git-core、eg-safety、eg-providers、eg-indexer）；git 逻辑只存在于 eg-git-core/eg-safety，前端命令层不写 git 逻辑。
- Git 交互为 git2-rs + git CLI 混合（复杂操作 CLI 兜底）；每仓库一个 RepoWorker 线程（Repository 非 Sync）；行为必须与真实 git 一致并有断言测试。
- 组件不直接调用 IPC：组件 → Zustand store → `lib/ipc` 封装 → Rust 命令；类型绑定由 tauri-specta 生成，禁止手写漂移。
- 样式只用语义令牌 `--eg-*`（明暗双主题同步维护），禁止硬编码色值；危险操作遵循「红色 + 确认 + 可撤销」三件套。
- 界面文案中文并遵循 PRD §6.7 术语表（如 stash=储藏、fetch=获取、pull=拉取），代码注释与标识符用英文；文档与提交说明用中文。
- 破坏性操作（reset/强推/删除分支/丢弃修改）必须先过 eg-safety 快照点，且必须附带撤销/恢复测试。
- Rust：`cargo fmt` + `cargo clippy -- -D warnings`；错误统一 `EgError`（TDD §6）并映射人话化提示。

## 构建 / 运行命令（脚手架建立后生效）

```bash
pnpm install && pnpm tauri dev     # 开发
pnpm tauri build                   # 出包
cargo fmt && cargo clippy -- -D warnings   # Rust lint（src-tauri/ 下）
```

要求：Node 20+、pnpm 9、Rust stable、Git ≥ 2.30；Linux 需 webkit2gtk-4.1（见 CONTRIBUTING.md）。脚手架就绪前这些命令不存在。

## 已知注意事项

- 本项目是 Git GUI 但**自身尚未 git init**；在用户明确要求前不要擅自初始化或提交。
- M1 范围红线（不可裁剪）：三区暂存、提交、DAG 历史、分支、merge/冲突向导、fetch/push、撤销/回收站（m1-plan §4）。
- 非目标（PRD §1.5）：不做内置终端、不做代码编辑器、不做 SVN/P4 互操作、不暴露 plumbing 命令界面。
- `docs/design/LICENSE.awesome-design-md` 是上游规范许可文件，保留勿删。
