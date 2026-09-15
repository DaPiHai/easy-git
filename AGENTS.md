# AGENTS.md — EasyGit 工作区指引

## 项目概述

EasyGit：轻量、跨平台、中文优先的 Git 可视化**桌面应用**，目标是让完全不会命令行的用户安全完成 Git 操作。Tauri 2 + Rust 核心 + React 18/TypeScript 前端，MIT 协议开源。

**当前阶段：`0.1.0-rc.2` 完整工程（见 `src-tauri/Cargo.toml` workspace.version）。** 单前端包（无 pnpm-workspace）+ `src-tauri/` Rust workspace；分支 `main`，CI 在 Windows/macOS/Ubuntu 三矩阵出包。不要再按 M1 计划 W1 从零建脚手架。

## 目录结构

```
README.md / CONTRIBUTING.md / LICENSE   # 项目门面；CONTRIBUTING 含分支命名与 PR 门槛
src/                 # React 前端：features/*/ stores/* lib/ipc/ components/ theme/ main.tsx test-setup.ts
src-tauri/           # Rust：src/{main.rs,lib.rs,commands.rs(约60命令),events.rs,bin/generate-bindings.rs} crates/{eg-types,eg-git-core,eg-safety,eg-providers,eg-indexer}/ capabilities/default.json tauri.conf.json
scripts/             # bench-perf.py snapshot-ui.py fixtures/
.github/workflows/ci.yml  # lint / test / 三矩阵 build
docs/
├─ README.md             # 文档索引与阅读顺序（先读这个）
├─ easy-git-prd.md       # 需求文档：功能 P0-P2、里程碑、§1.3 已定决策、§10 开放问题
├─ easy-git-tdd.md       # 技术架构：目录结构、IPC、并发模型、安全引擎、测试/CI
├─ easy-git-ui-design.md # UI 设计：--eg-* 令牌、明暗双主题、组件规格、界面布局图
├─ easy-git-m1-plan.md   # MVP 十周计划：任务编号 F-xx/R-xx/C-xx、每周验收、裁剪顺序
├─ git-commands.md       # Git 2.53 全部 172 命令清单（功能覆盖映射依据）
├─ perf-baseline.md      # 性能基线
├─ testing-10min.md      # 新手 10 分钟测试脚本
└─ design/DESIGN.md      # Linear 设计规范（上游参考，来自 awesome-design-md，MIT）
```

## 动手前必读

- 任何开发：`docs/easy-git-tdd.md`（结构与边界）+ 对应功能的 PRD §5 条目和 M1 计划任务行。
- UI 相关：`docs/easy-git-ui-design.md` 是实现标准；`docs/design/DESIGN.md` 只是上游审美参考，两者冲突时以前者为准。
- 需求取舍：PRD §1.3 决策表已锁定（勿重新讨论），§10 开放问题中未决项不要擅自定案，询问用户。

## 已锁定的架构边界与规范

- 分层：前端 `src/`（React）与 Rust 核心 `src-tauri/crates/`（eg-types、eg-git-core、eg-safety、eg-providers、eg-indexer）；git 逻辑只存在于 eg-git-core/eg-safety，前端命令层不写 git 逻辑。
- Git 交互为 git2-rs + git CLI 混合（复杂操作 CLI 兜底，网络操作走 git CLI `--progress` 流式上报 `sync://progress`；另有 `repo://changed` 事件）；每仓库一个 RepoWorker 线程（Repository 非 Sync）；行为必须与真实 git 一致并有断言测试。
- 组件不直接调用 IPC：组件 → Zustand store → `src/lib/ipc` 封装 → Rust 命令；类型绑定 `src/lib/ipc/bindings.ts` 由 tauri-specta 每次 debug 启动生成，禁止手改（eslint 已忽略该文件）。
- **新增 Tauri 命令必须同时写进 `src/lib.rs` 和 `src/bin/generate-bindings.rs` 两处 `collect_commands![]`**（漏 `lib.rs` 时：Rust 编译过、TS 类型有、绑定能生成、前端还 typecheck 通过，但运行时命令根本不存在，invoke 只会拿到非 `EgError` 的 not-found 并被 UI 降级成通用文案、不打日志——`ssh_init_repo` 就曾这样静默上线）。`src-tauri/tests/command_registry.rs` 会比对两份列表，漏一处即红。
- 错误：Rust 侧统一 `EgError`（TDD §6）扁平序列化 `{code, ...params}`；中文人话文案只放在 `src/lib/ipc/errors.ts`。前端捕获 IPC 错误统一走 `reportError`（`src/lib/ipc/report.ts`，toast 带可展开原因与建议动作，动作由 `hints.ts` 分发），禁止 catch 后吞成固定文案、或把 `EgError` 当 `{title, detail}` 读（没有这两个字段）。不属于 EgError 的集成失败（如 opener 打开文件夹被拒）走同文件的 `reportFailure`：保留该功能自己的文案，但同样带可展开原因 + 日志行。
- capabilities 为 `core:default` + `dialog:default` + `opener:default`（`src-tauri/capabilities/default.json`）。`opener:allow-open-path` 必须自带路径 scope（当前 `{"path":"**"}`）：该权限不带预置 scope，allow 列表为空时插件一律拒绝（`Error::ForbiddenPath`），缺了就是「打开文件夹」静默失败。加权限需同步说明理由。
- 样式只用语义令牌 `--eg-*`（明暗双主题同步维护），禁止硬编码色值；危险操作遵循「红色 + 确认 + 可撤销」三件套。
- 界面文案中文并遵循 PRD §6.7 术语表（如 stash=储藏、fetch=获取、pull=拉取），代码注释与标识符用英文；文档与提交说明用中文。
- 破坏性操作（reset/强推/删除分支/丢弃修改）必须先过 eg-safety 快照点，且必须附带撤销/恢复测试。
- Rust：`cargo fmt` + `cargo clippy -- -D warnings`；TypeScript strict；`_` 前缀标识有意未用（eslint 已放行）。
- 提交与 PR（见 CONTRIBUTING.md）：Conventional Commits（`type(scope): 描述`），分支 `feat|fix|docs/` 前缀；UI 改动附明暗双主题截图并对照 ui-design；Rust 行为变更附测试；破坏性改动附撤销测试；过 CI（fmt、eslint、prettier、绑定无漂移、typecheck、双端测试）。

## 构建 / 运行 / 检查命令（以 package.json 与 CI 实测为准）

```bash
pnpm install                 # 安装（CI 用 pnpm install --frozen-lockfile）
pnpm dev                     # 纯前端 vite（:5173）
pnpm tauri dev               # 桌面联调
pnpm build                   # tsc --noEmit && vite build
pnpm typecheck               # tsc --noEmit + tsconfig.node.json
pnpm lint                    # eslint src
pnpm format / pnpm format:check  # prettier（仅 src/）
pnpm test / pnpm test:watch  # vitest run / watch
pnpm tauri build             # 全平台出包（产物 src-tauri/target/release/bundle/）
```

```bash
# src-tauri/ 下
cargo fmt --all --check      # CI lint 门槛
cargo test --workspace
cargo clippy -- -D warnings  # CONTRIBUTING 门槛（CI lint 未跑，提交前本地跑）
cargo run --features gen-bindings --bin generate-bindings  # 生成绑定；跑完须 git diff --exit-code -- ../src/lib/ipc/bindings.ts 无漂移
```

要求：Node 20+、pnpm 以 package.json `packageManager` 销定的 10.20.0 为准（CONTRIBUTING 写的 pnpm 9 已过期）、Rust stable（workspace rust-version 1.85）、Git ≥ 2.30；Linux 需 webkit2gtk-4.1 等系统依赖（见 CONTRIBUTING.md 与 ci.yml 的 LINUX_APT）。specta 销定 `=2.0.0-rc.25`，勿随意升级。

## 已知注意事项

- 提交前确认分支与 diff，不要擅自提交或推送（本项目自身就是 Git GUI，脏树风险高）。
- 代码任务完成后必须出 Windows 安装包（MSI+NSIS）供测试机真机验证，只跑测试不算交付：`pnpm tauri build`。MSI（WiX）只收纯数字版本，须用 `--config '{"bundle":{"windows":{"wix":{"version":"0.1.0.N"}}}}'` 覆盖预发布串且每次递增 N（同号会被已装旧版拒绝覆盖安装）；NSIS 无此限制。
- 合并/切分支后出现「反向 diff / 凭空多出的未暂存文件」，多半是外部编辑器（如 VS Code 旧缓冲）把文件写回旧内容，restore 到 HEAD 即可，不是 EasyGit 的 bug。
- 改绑定/命令后必跑绑定漂移检查；`src/lib/ipc/bindings.ts` 漂移是 CI lint 直接失败项。
- 外部命令（`git`）必须经 `eg_git_core::process::hidden_command` 创建：release 是 GUI 子系统无控制台，裸 `Command::new` 会让 Windows 每次给子进程弹一个空白 cmd 窗口；该问题只在 release 包复现，`tauri dev` 看不到。
- M1 范围红线（不可裁剪）：三区暂存、提交、DAG 历史、分支、merge/冲突向导、fetch/push、撤销/回收站（m1-plan §4）。
- 非目标（PRD §1.5）：不做内置终端、不做代码编辑器、不做 SVN/P4 互操作、不暴露 plumbing 命令界面。
- `docs/design/LICENSE.awesome-design-md` 是上游规范许可文件，保留勿删。
