# EasyGit 技术架构文档（TDD）

| 项目 | 内容 |
| --- | --- |
| 文档版本 | v1.0 |
| 日期 | 2026-09-08 |
| 上游文档 | [easy-git-prd.md](./easy-git-prd.md)（需求）、[easy-git-ui-design.md](./easy-git-ui-design.md)（UI 令牌与组件） |
| 范围 | M1（MVP）架构为主，M2/M3 扩展点标注 |

---

## 1. 技术选型与决策记录

| 决策 | 结论 | 理由 |
| --- | --- | --- |
| 应用框架 | **Tauri 2**（已定，PRD §1.3） | 包体/内存达标（§PRD 7），Rust 生态提供 git2 等高性能底层 |
| 前端框架 | **React 18 + TypeScript（strict）**（2026-09-08 决策） | 虚拟列表（virtua）、DAG 渲染、diff 组件等生态最全；Radix 提供无障碍行为原语；团队与 AI 协作资源最丰富。PRD §10.1 的 Spike 问题就此关闭 |
| 构建工具 | Vite 5 | Tauri 官方推荐，HMR 快 |
| 样式 | Tailwind CSS v4 + CSS 变量令牌 | 令牌层（UI 文档 §2）独立于框架，Tailwind 仅做原子类引用 |
| 组件基座 | Radix UI primitives + 自建皮肤 | 无障碍行为（焦点管理、菜单/对话框）由 Radix 保证，视觉完全按 UI 文档实现；**不引入**重型组件库 |
| 状态管理 | Zustand | 轻量、可按仓库分片（store per concern），避免 Context 重渲染问题 |
| 虚拟列表 | virtua | 体积小、支持可变行高（变更列表/DAG/时间线都需要） |
| 图标 | lucide-react | 与 Linear 发丝线气质一致（UI 文档 §9） |
| Git 交互 | git2-rs（libgit2）+ git CLI 混合（PRD §4.2） | libgit2 覆盖常规操作；CLI 兜底复杂操作 |
| 异步运行时 | tokio | CLI 子进程、网络、文件监听 |
| IPC 类型 | tauri-specta | Rust → TS 类型与命令绑定自动生成，杜绝前后端类型漂移 |
| 日志/遥测 | tracing + tracing-subscriber（本地文件） | 崩溃诊断；不上传，符合 PRD §7 隐私要求 |
| 协议 | MIT | 2026-09-08 决策 |

## 2. 仓库与代码结构

```
easy-git/
├─ README.md  CONTRIBUTING.md  LICENSE
├─ docs/                          # 文档（PRD/TDD/UI/计划/设计规范）
├─ src/                           # React 前端
│  ├─ main.tsx  App.tsx
│  ├─ theme/                      # tokens.css（UI 文档 §3-§5 令牌）、明暗主题切换
│  ├─ components/                 # 设计系统组件（Button/List/Badge/Dialog…）
│  ├─ features/                   # 按领域分模块
│  │  ├─ repo/          # 仓库工作台、克隆/init 向导
│  │  ├─ changes/       # 三区状态、暂存、提交框
│  │  ├─ history/       # DAG 图、提交详情、diff、blame
│  │  ├─ branches/      # 分支看板、标签、储藏
│  │  ├─ remotes/       # 远程管理、同步
│  │  ├─ conflicts/     # 冲突向导
│  │  ├─ timeline/      # 操作时间线（reflog）、撤销
│  │  ├─ palette/       # 命令面板、命令透视
│  │  └─ settings/
│  ├─ stores/                     # Zustand stores（repo/changes/ui/task…）
│  ├─ lib/ipc/                    # tauri-specta 生成绑定 + 封装（进度、取消、错误映射）
│  └─ lib/i18n/                   # 字符串资源（中文默认，i18next 槽位）
├─ src-tauri/
│  ├─ src/main.rs  lib.rs         # Tauri 入口、命令注册
│  ├─ crates/
│  │  ├─ eg-types/                # 共享类型（serde 序列化 = IPC DTO）
│  │  ├─ eg-git-core/             # Git 交互层（libgit2 + CLI 桥）
│  │  ├─ eg-safety/               # 快照点/回收站/撤销引擎
│  │  ├─ eg-providers/            # GitHub/GitLab/Gitee 适配（M2）
│  │  └─ eg-indexer/              # commit-graph、拓扑 lane 缓存、大仓库加速
│  └─ tauri.conf.json  capabilities/
└─ .github/workflows/             # ci.yml / release.yml
```

## 3. 前端架构要点

- **视图容器**：无 URL 路由（桌面单窗口），顶层 `AppShell` 持有 `view` 状态（PRD §6.1 布局）；冲突向导、命令面板为全局浮层（Zustand `uiStore`）。
- **数据流**：组件 → store action → `lib/ipc` 封装 → Rust 命令；Rust 事件（进度/仓库变更）→ store 订阅 → 视图响应。**组件不直接调用 IPC**。
- **长任务模型**：所有可能超过 300ms 的操作（clone/fetch/push/log 大页/索引）返回 `taskId`；前端 `taskStore` 统一展示进度（底栏），支持取消。
- **错误呈现**：Rust 错误 → `lib/ipc` 按 §6 错误模型映射为 `{code, message, hintAction?}`；`hintAction` 直接渲染为人话提示上的按钮（如「先拉取并整合」），对应 PRD §5.12 错误人话化。
- **DAG 渲染**：Canvas 2D（lane 曲线）+ DOM 覆盖层（行内容，保证文本可选中/无障碍）。布局由 Rust 侧 `eg-indexer` 预计算 lane（§4.5），前端只做绘制与虚拟滚动，10 万提交不卡帧。

## 4. Rust 核心设计

### 4.1 并发模型：每仓库一个 Worker（actor）

git2 `Repository` 非 `Sync`，且多数操作互斥。采用 **RepoWorker**：每个打开的仓库一个专职线程 + `mpsc` 命令队列，命令按序执行，天然避免锁竞争与 `Repository` 跨线程问题。

```
前端 IPC → tauri command（async）→ RepoManager（HashMap<RepoId, WorkerHandle>）
                                        └→ RepoWorker 线程：执行命令、持有 Repository
长任务在 worker 内派生阻塞任务到 rayon 线程池，通过 CancellationToken 支持取消
```

- 只读操作（status/log/diff）可并行派发到只读快照通道；写操作严格串行。
- 仓库关闭：drain 队列后销毁 worker，释放句柄。

### 4.2 eg-git-core：命令实现清单（M1 范围）

| 组 | 实现 | 底层 |
| --- | --- | --- |
| 仓库 | open/init/clone（进度回调）、close、health | git2 + CLI(`clone --progress`) |
| 状态 | status（含未跟踪目录折叠）、fs-watch 增量刷新 | git2 + notify |
| 暂存 | stage/unstage 文件、**hunk/line 级暂存**、discard | hunk 级：生成 patch → `git apply --cached`（CLI） |
| 提交 | commit（amend、部分文件）、模板、消息校验 | git2 |
| 历史 | log 分页（拓扑+lane 预计算）、show、diff（文件/hunk）、blame 基础 | git2 + eg-indexer |
| 分支/标签 | create/rename/delete/switch（脏工作区检测）、tag CRUD | git2 |
| 合并/回退 | merge（ff/no-ff）、abort、revert、reset（soft/mixed/hard） | git2；冲突状态枚举化输出 |
| 储藏 | push/pop/apply/drop（含未跟踪） | CLI（`stash push -u` 语义完整） |
| 远程 | fetch/pull/push（进度、浅获取选项）、remote CRUD、凭据回调 | git2 传输 + keyring 凭据 |
| 引用 | reflog 读取、update-ref（安全引擎内部） | git2 |

CLI 桥统一约束：`tokio::process`、环境变量固定（`GIT_TERMINAL_PROMPT=0`）、超时与取消、`--porcelain`/`--json` 输出解析、进度 stderr 解析（`GIT_TRACE` 不开启）、**所有控制台子进程一律经 `eg_git_core::process::hidden_command` 创建**（Windows 传 `CREATE_NO_WINDOW`；release 下应用是 GUI 子系统、自身无控制台，裸 spawn 会让 Windows 给 git 子进程新建可见控制台，表现为每次 git 操作与空闲 `gc` 都闪一个空白 cmd 窗口；隐藏控制台会被 askpass 等后代继承，故不用 `DETACHED_PROCESS`）；spawn 报 `NotFound` 一律经 `classify_spawn_error` 映射为 `git_missing` 错误码（不落 `internal`）；启动时经 `env_check` 命令探测系统 git 版本（`eg_git_core::env`，PRD §7：≥ 2.30，缺失/过旧由前端引导页接管）。

### 4.3 eg-safety：安全引擎（PRD §4.4 落地）

- **操作日志**：`<app-data>/safety/<repo-id>/operations.jsonl`，每行一条 `{op_id, time, kind, args, before_refs, snapshot_refs}`（append-only）。
- **快照点**：写操作（reset/rebase/merge/强制推送/删除分支/丢弃修改）执行前：
  1. 将受影响引用备份到 `refs/easy-git/backup/<op_id>/*`（`update-ref`，原子）；
  2. 脏工作区时自动 `stash push -u`（记录 stash ref）；
  3. 写操作日志；然后才执行原操作。
- **撤销/重做**：解析操作日志栈 → 反向应用（恢复引用指向 + 恢复 stash）；UI 的「恢复到任意时间点」= 找到对应 op_id 重放恢复。
- **回收站**：删除的分支/标签移入 `refs/easy-git/trash/<ts>/<name>`，启动时清理 >30 天；UI 可恢复。
- **崩溃恢复**：启动扫描 `MERGE_HEAD`/`rebase-merge` 等残留状态 + 未完成的 op 记录 → 引导恢复（对应 PRD 风险表）。

### 4.4 eg-providers（M2 预留，M1 只定接口）

```rust
trait Provider { // github | gitlab | gitee 各一实现
    async fn account(&self) -> Account;                    // OAuth Device Flow + keyring
    async fn list_prs(&self, repo: &RepoSlug) -> Vec<Pr>;
    async fn create_pr(&self, req: CreatePrReq) -> Pr;
    async fn pr_detail(&self, id: PrId) -> PrDetail;       // 评论/CI 状态
    async fn merge_pr(&self, id: PrId, mode: MergeMode) -> Result<()>;
    async fn notifications(&self) -> Vec<Notification>;    // M3
}
```

平台差异收敛在此 trait；OAuth 回调走 Tauri deep-link（`easygit://oauth`）。

### 4.5 eg-indexer：大仓库加速

- 打开仓库后台确保 `commit-graph`（CLI `git commit-graph write --reachable --changed-paths`，静默失败可容忍）。
- 拓扑 lane 计算：按 `--topo-order` 遍历 + first-parent 着色，活跃 lane 上限 12，超出折叠为灰色细线；结果按 `(head_oid, page)` 缓存于 `<app-data>/cache/`，HEAD 或引用变更即失效。
- blame、贡献统计同样走此缓存层。

### 4.6 IPC 命令面（v1，约 40 个）

命名规范：`<域>_<动作>`，DTO 全部定义在 `eg-types`，经 tauri-specta 生成 TS。事件：`task://progress`、`repo://changed`（fs-watch 防抖 300ms）、`safety://snapshot`。

示例签名（节选）：

```rust
repo_open(path) -> RepoSummary          repo_clone(req) -> TaskHandle
status_get(repo) -> StatusReport        stage(repo, paths, Mode) -> ()
stage_hunks(repo, patch_id, hunks) -> ()   commit(repo, req) -> CommitId
log_page(repo, q: LogQuery) -> LogPage  // 含 lane、分支着色，分页 500
stage_diff_lines(repo, req) -> ()       branch_switch(repo, name, opts) -> Outcome
merge(repo, req) -> MergeOutcome        // Conflict(detailed) | Done | FastForward
reset(repo, mode, target) -> OpHandle   stash(repo, req) -> ()
fetch/pull/push(repo, opts) -> TaskHandle
reflog_page(repo, q) -> ReflogPage      undo(repo, op_id) -> ()
```

## 5. 关键数据流（时序）

**提交流**：fs-watch 触发 → `repo://changed` → 前端 `changesStore.refresh()` → `status_get`；用户勾选文件（本地状态）→ 输入消息 → `commit` → worker 校验模板 → 写提交 → 自动返回新 `CommitId` + 触发 `safety://snapshot`（若启用了危险前快照规则）→ DAG 增量刷新。

**撤销流**：用户点击撤销 → `undo(repo, op_id)` → eg-safety 读操作日志 → 恢复引用/弹回 stash → 返回 `Restored{detail}` → 前端全量刷新状态与 DAG。

## 6. 错误模型与人话化

```rust
enum EgError { RepoNotFound, DirtyWorktree{..}, Network{kind, url}, Auth{provider},
  ConflictState{state}, UnsafeOperation{confirm_required}, NotSupported{feature},
  Cancelled, Internal{context} }
```

IPC 序列化为 `{code, params, message_zh, hint?}`；前端 `lib/ipc/errors.ts` 持有映射表，`hint` 携带建议动作（code + 参数），如 `PushRejectedNonFastForward` →「远程有新提交」+ 按钮「先拉取并整合」。未映射错误降级为「出了点问题（已记录日志）+ 查看日志」。

## 7. 安全与隐私

- 凭据：`keyring` crate → 系统钥匙串（Windows Credential Manager / Keychain / Secret Service）；SSH 走系统 agent，优先 `GIT_SSH_COMMAND` 兜底。
- 所有 IPC 命令在 capability 清单中显式声明（Tauri 2 ACL），前端无法触达未声明能力。
- 破坏性操作三层防护：UI 确认（UI 文档 §11）→ eg-safety 快照 → 执行；`UnsafeOperation` 错误要求前端回传确认标志才会真正执行。
- 日志只写本地，脱敏 URL 中的凭据；无任何遥测上报。

## 8. 测试策略

| 层 | 工具 | 要求 |
| --- | --- | --- |
| eg-git-core 单元 | 临时仓库 fixture builder（脚本化构造提交/分支/冲突样本，对应 PRD 附录 B） | 覆盖率 ≥ 70%，行为与真实 git 断言一致 |
| eg-safety | 操作注入测试：执行→撤销→断言仓库状态等价（tree oid 对比） | 全部破坏性操作必须有撤销测试 |
| 前端 | Vitest + Testing Library（stores、错误映射、diff 行计算） | 核心逻辑覆盖，组件烟测 |
| E2E | tauri-driver（WebDriver）冒烟：打开仓库→暂存→提交→建分支→切换 | CI 每夜跑 |
| 性能 | 基准脚本：mid-size（5000 提交）打开 ≤1.5s、DAG 滚动 60fps；huge-repo（10 万+）M3 达标 | 每次发布前跑 |

## 9. CI/CD 与工程规范

- `ci.yml`：lint（`cargo fmt --check`、`clippy -D warnings`、eslint/prettier/typecheck）→ test → build 矩阵（windows-latest / macos-latest / ubuntu-22.04，Linux 装 webkit2gtk-4.1）→ 产物上传（每夜构建）。
- `release.yml`（M3）：tag 触发 `tauri build` + 更新签名 + GitHub Releases / Gitee 镜像；自动更新走 Tauri updater。
- 版本：`0.x` 阶段按里程碑递增（0.1=M1 RC）；Conventional Commits；PR 模板含截图/录屏要求（UI 变更必附）。
- Linux 打包 deb/rpm/AppImage 全开，Windows 签名与 mac 公证为 M3 事项（PRD §10.5）。

## 10. PRD 可追溯映射

| PRD 模块 | 前端 | Rust |
| --- | --- | --- |
| §5.1 仓库管理 | features/repo | eg-git-core(repo) |
| §5.2 三区暂存 | features/changes | eg-git-core(status/stage) |
| §5.3 历史/DAG/diff | features/history | eg-git-core(log/diff) + eg-indexer |
| §5.4 分支与集成 | features/branches | eg-git-core(branch/merge/revert/reset) |
| §5.5 远程协作 | features/remotes | eg-git-core(remote/transport) + keyring |
| §5.6 平台集成（M2） | features/remotes + features/platform | eg-providers |
| §5.7 储藏/时间线 | features/branches, features/timeline | eg-git-core(stash/reflog) + eg-safety |
| §5.8 冲突向导 | features/conflicts | eg-git-core(merge) |
| §5.9 撤销与安全 | features/timeline | eg-safety |
| §5.10 设置/§5.11 维护 | features/settings | eg-git-core(config/maintenance) |

## 11. 变更记录

### 2026-09-08 · W1 脚手架落地偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | 错误线格式（§6） | IPC 实际序列化为扁平 tagged 枚举 `{code, ...params}`（如 `{"code":"repo_not_found","path":"…"}`），人话文案与建议动作统一收敛在 `src/lib/ipc/errors.ts` 映射表（`{title, detail, hint?}`）。§6 原文 `{code, params, message_zh, hint?}` 中 `message_zh`/`hint` 不再由 Rust 产出，避免双语双源。EgError 变体与 §6 列表一致。 |
| 2 | tauri-specta 版本 | 上游 v2 仍为 RC：锁定 `tauri-specta =2.0.0-rc.25`、`specta =2.0.0-rc.25`、`specta-typescript 0.0.12`（等于号锁版本，遵循上游 beta 期要求）。错误处理用 `ErrorHandlingMode::Result`（rc 默认值），前端拿到 `{status:'ok'\|'error'}` 包装。 |
| 3 | 绑定生成方式 | `src/lib/ipc/bindings.ts` 在每次 debug 启动自动再生成，另提供 `cargo run --bin generate-bindings`（无 GUI 场景/CI）；CI 以「重新生成后 git diff 为空」防漂移。新增该 bin 属结构补充。 |
| 4 | 构建工具版本 | Vite 按 §1 固定 v5.4（Node 20.11 兼容）；配套 Vitest 2.1、TypeScript 5.9、ESLint 9（flat config）、Tailwind CSS v4.3、Prettier 3。React 固定 18.3。 |
| 5 | 字体打包 | Inter 与 JetBrains Mono 以 `@fontsource-variable/inter`、`@fontsource-variable/jetbrains-mono`（可变字重 woff2）随应用打包；中文字体走系统栈（§4.1）。 |
| 6 | 应用图标 | 正式品牌图已由用户提供（2026-09-08）：横版 logo 与方形图标源图归档于 `src-tauri/icons/brand/`，方形图标重制成 1024×1024 透明底源图后经 `tauri icon` 生成全套平台图标；占位图生成器 `scripts/gen-icon.py` 已移除。 |
| 7 | Rust 版本与 edition | workspace edition = 2021、`rust-version = 1.85`（Tauri 2 最低线）；本机工具链 rustc 1.96。 |
| 8 | 日志 | tracing + tracing-subscriber 已接入，W1 仅 stderr（`RUST_LOG` env-filter）；本地文件 sink 随 W2 落地（§1 表格中"本地文件"目标不变）。 |
| 9 | eg-git-core 依赖 | git2 0.21 以 `default-features = false` 引入（M1 本地操作够用；HTTPS/SSH 传输到 W9 再开 feature，届时由 CLI 兜底）；libgit2 语义以单测锚定（init/unborn HEAD）。 |
| 10 | eg-providers | M1 只落 §4.4 接口：trait 用原生 `async fn`（工作区内部消费，`#[allow(async_fn_in_trait)]`，M2 需要 spawn 时再降糖 `impl Future + Send`）。 |

### 2026-09-08 · W2 仓库打开与状态底座偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | fs-watch 实现 | notify 8 稳定版 + worker 自实现 300ms 防抖（未用 notify-debouncer-full：最新为 RC 版本；worker 命令循环内以 quiet-period 合并事件，语义与 TDD §4.6「防抖 300ms」一致），`.git` 内部变更被过滤。 |
| 2 | 事件定义位置 | `RepoChanged` 事件结构放在 app crate（`src/events.rs`）而非 eg-types：tauri-specta 的 Event 宏依赖 tauri。事件名按 TDD 钉为 `repo://changed`（`#[tauri_specta(event_name=...)]`）；当前负载仅 `{repoId}`，未来更复杂的负载 DTO 仍进 eg-types。 |
| 3 | RepoCommand 通道 | Worker 用 std mpsc + oneshot 回执（命令枚举 Status/Summary/Close），IPC 侧 `status_get` 为 async 命令 + `spawn_blocking` 转发，15s 超时；符合 §4.1 每仓库一线程模型。 |
| 4 | 仓库去重 | RepoManager 按规范路径（canonicalize）去重：重复 open 同一路径返回既有 worker 的摘要，不新建线程。 |
| 5 | repo_init 语义 | `repo_init` 对已是仓库的目录幂等（等价 open），新建用 libgit2 init；clone（R-04 P1）与底栏任务进度（F-07 P1）顺延到下次会话。 |
| 6 | 生成器同步约束 | `generate-bindings` bin 的命令/事件注册表必须与 `run()` 保持一致（W2 首跑踩坑：漏注册导致绑定缺失），后续考虑提取共享注册函数。 |
| 7 | 真实 status 语义 | status 分组：staged=index-vs-HEAD，unstaged=worktree-vs-index（含未跟踪），conflicted=合并冲突；未跟踪整目录折叠为 `dir/`（与 git status 一致）；重命名检测 `renames_head_to_index`，条目 path 取 delta.new_file。全部有断言测试（9 例）+ mid-size 打开+status < 1.5s 实测（#[ignore] 性能测试）。 |

### 2026-09-08 · W3 变更与暂存闭环偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | eg-safety v0 | 快照点实现为「备份树」：受影响路径的当前内容（worktree，staged 删除回退 index 内容）写入无父提交，挂在 `refs/easy-git/backup/<op_id>`；操作日志 `<root>/safety/<repo-id>/operations.jsonl` append-only，同 op_id 以最后一条为准（撤销=追加 undone 记录）。快照失败会中止整个 discard（红线）。撤销=按备份树 checkout 还原；路径不在备份树中时跳过（checkout pathspec 落空会误删文件，实测踩坑）。 |
| 2 | unstage 实现 | `git reset HEAD -- paths` 用 `repo.reset_default(Some(&head_obj), paths)`；注意 git2 0.21 的 `reset_default(None)` 并非「默认 HEAD」而是清空匹配条目（实测踩坑，必须显式传 HEAD 对象）；unborn HEAD 退化为逐路径 `index.remove_path`。 |
| 3 | discard 语义 | 统一流程=快照 → unstage(索引回到 HEAD) → 未跟踪删除 / 已跟踪从索引强检出到工作区；staged 删除被丢弃=取消删除（文件恢复 HEAD 内容，无数据丢失，快照自然为空）。 |
| 4 | 勾选即暂存 | 行复选框=立即暂存/取消暂存（GitHub Desktop 心智），区头复选框=整区批量；提交勾选集（W4 提交框消费）W4 再引入，避免双状态混用。 |
| 5 | clean | 仅允许未跟踪条目（其它路径拒绝并返回 UnsafeOperation），确认对话框列出将删除项，走同一快照+撤销通道。 |
| 6 | 测试 | W3 新增 8 项集成测试，含「执行→撤销→内容等价」往返（修改/staged删除/未跟踪目录 三形态）与 double-undo 拒绝。 |

### 2026-09-08 · W4 提交与命令透视偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | amend 的 git2 语义 | `git commit --amend` 的新提交 parent 是原提交的 parents，首个 parent 永远 ≠ 当前 tip，因此 git2 的 `commit(Some("HEAD"), …)` 校验（"current tip is not the first parent"）对所有 amend 一律拒绝（根提交 amend 同理）。实现改为：`commit(None, …)` 先建对象，再 `repo.reference(分支名, oid, force=true)` 移动分支引用（`repo.head()` 解析后即分支 ref 名）；有断言测试覆盖根/非根两种 amend 且 HEAD 不脱钩。 |
| 2 | 部分暂存约束 | `partially_staged` = INDEX_* 与 WT_* 标志的交集文件；未确认时返回 `UnsafeOperation { confirm_required: "部分暂存：<paths>" }`，前端 CommitBox 弹确认对话框并带 `allowPartial: true` 重发；amend 天然允许（其内容以索引为准）。 |
| 3 | 身份检查 | `signature_for` 只读 `repo.config()`（git2 已合并 repo-local + global 生效值），缺失返回明确错误；提交框挂载时经 `config_get(scope=repo)` 探测生效身份并显示「去设置」横幅，设置页 F-14 读写 global scope。 |
| 4 | config 命令 | `config_get/config_set` 走 RepoWorker（R-09 v1：任意 key 的 get/set；Repo 用 repo.config()，Global 用 `git2::Config::open_default()`）；未做 key 白名单/代理等结构化设置项，随网络里程碑（W9）扩展。 |
| 5 | 命令透视 | lensStore 仅内存（不持久化），由 repoStore 各动作在成功路径记录等价命令（上限 100 条、相邻去重），面板在底栏向上弹出，复制用 clipboard API + execCommand 兜底；configSet 也记录 `git config …`。 |
| 6 | 错误人话化 R-08 | repoStore 增加 `failLoudly`：stage/discard/clean/ignore/undo 失败在保留 `error` 状态的同时走 `toast.error(标题, 细节)`；commit 的错误由 CommitBox 区分 `unsafe_operation`（确认对话框）与其它（toast）。 |
| 7 | 设置页入口 | 顶栏齿轮开关 settings 视图（MainView 增加 `'settings'`，无激活仓库也可进入）；底栏简洁/专家按钮接 uiStore.expertMode（localStorage 持久化，v1 仅存偏好）。 |
| 8 | 测试 | Rust +8（commit 根/非根 amend、partial 约束、空 subject、缺身份、config 往返）；前端 +17（CommitBox 5、lensStore 4、Settings 4、BottomBar lens 4）。快照 judge 发现的两处渲染问题（无仓库时详情面板不应出现提交框；合成右键事件缺坐标导致菜单锚到 (0,0)）已修复，17 张快照全部 pass。 |
| 9 | deb 打包排除辅助 bin | `generate-bindings` bin 曾被打进 deb（/usr/bin 下出现两个可执行）。改为 `required-features = ["gen-bindings"]`：`tauri build` 不启用该 feature 时 cargo 直接跳过该 bin；CI 与手动生成改用 `cargo run --features gen-bindings --bin generate-bindings`。 |

### 2026-09-08 · W5 历史 DAG 图偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | lane 预计算 | 几何在 Rust 侧逐行算好（Lanes：lane 槽位持有「期望的父 oid」）：子先父后的 topo 序；分支 tip 落新右槽、首父直落本槽、其余父入已有槽（merge 斜线）或新槽；oid 重复的槽合并（join 线）；根提交槽终止，下方槽左移产生全高斜线。`node.lane`/`from` 用本行（压缩前）坐标系，`to` 用压缩后坐标系，join 线 `to` 保持指向本行节点。渲染契约：`from==to` 直线；`to==node.lane` 自上入节点；`from==node.lane` 自节点出；其余全高斜线。有 diamond/线性/终止断言测试。 |
| 2 | 分页语义 | `offset` 按「扫描过的提交数」计而非返回行数——author/message 过滤跳过的行也要计入，翻页才稳定；过滤扫描上限 MAX_SCAN=100k 强制终止。默认 500 行/页（PRD §5.3），滚动近底 30 行内续读。 |
| 3 | lane 着色偏差 | UI 文档 §3.4 要求「按分支名哈希稳定分配」，v1 实现为按 lane 序号循环 8 色板（lane 0 恒为 branch-1，主干 2.5px），分支名稳定着色与分支看板同色随 W7 一起做（需要 ref→lane 的溯名算法）。已在测试断言 lane0=color0。 |
| 4 | commit-graph 缺位 | R-10 提到的「commit-graph 后台生成」不落地：libgit2 的 revwalk 不读 commit-graph 文件，写了也加速不了。mid-size（5001 提交）实测 500 行页 <100ms（深 offset 同样），预算 1s（#[ignore] 性能测试）；十万级仓库再评估。 |
| 5 | specta 数字类型 | `author_time: i64` 被 specta 拒绝导出（BigInt 防精度丢失），改 `f64`（git 时间戳远小于 2^53，无精度损失）。后续 DTO 一律避免 i64/u64。 |
| 6 | 渲染分层 | 左列 96px 用 sticky `<canvas>`（视口高，dpr 缩放，滚动时只画可见行），DOM 行绝对定位只挂可见窗口 ±15 行；jsdom 无 canvas 后端，draw 前判空（测试屏 getContext 噪音已屏蔽）。 |
| 7 | 原生控件主题 | 暗色下 `<select>` 白底黑字（原生控件不吃 CSS 变量）——tokens.css 补 `color-scheme: dark/light` 按 data-theme 声明，judge 验收通过。 |
| 8 | 右键桩 R-11 | 提交行右键菜单：查看变更详情（可用）+ 在此建分支/摘取/回滚（disabled，W7/W8 开放）；不接后端。 |
| 9 | 测试 | Rust +8（lane 几何 diamond、refs 装饰、分页连续性、三过滤、详情文件计数、空仓库、list_branches + perf）；前端 +18（graph 几何 3、historyStore 6、HistoryPage 6、time 3）。快照 26-28 judge 通过（修复：暗色原生 select、菱形节点、color-scheme）。 |

### 2026-09-08 · W6 Diff 与逐块暂存偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | libgit2 workdir diff 缺陷 | 本环境的 libgit2 `diff_tree_to_workdir_with_index(None)` 并不按文档「用 index 做旧侧」，实测整个文件回成 Added（旧侧等同空树）。修法：Worktree 源显式 `index.write_tree()` 生成 index 树对象再 `diff_tree_to_workdir(Some(&tree))`，语义与 `git diff` 一致。后续升级 libgit2 需回归 w6 测试。 |
| 2 | print 回调契约 | `diff.print` 回调返回 `false` 在 git2 里是「用户中止」→ 报错 -7（User），不能当优雅退出用。截断改「跳过不入列」；file_header 捕获首块后继续走完。二进制文件靠 origin `'B'` 行检测（delta.flags 的 BINARY 标志对 workdir diff 不总置位）。 |
| 3 | 未跟踪文件 diff | 需 `DiffOptions::show_untracked_content(true)`，否则未跟踪条目只有文件头没有 hunk 内容。 |
| 4 | R-13 行级暂存 | 过滤补丁在 Rust 重建：整 hunk 选择→原文直出；部分选择→保留上下文+选中 ± 行、按首行行号重算 `@@ -a,b +c,d @@`。应用走 git CLI `git apply --cached --unidiff-zero --recount -`（stdin），等价 `git add -p`。unstage=把 HEAD→index 的 diff **反转**（+↔- 互换、header 起止互换）后同样应用——index 是补丁旧侧。未跟踪文件仅支持整块选择（部分选择无法构造 preimage）。 |
| 5 | 快照点边界 | 行级暂存只改 index（可随时反操作），不属破坏性操作，不走 eg-safety 快照（与整文件 stage/unstage 同口径）。 |
| 6 | 词级高亮 | 仅配对「单行删除+单行新增」计算公共前/后缀（字节级，UTF-8 安全），span 存于两侧行；多行块不配对。前端按增/删行分别用 diff-word-added/deleted-bg 高亮中间段。 |
| 7 | 前端结构 | diffStore 单槽（request+data），open 对 `isTauriAvailable()==false` 早退且不清空（快照 harness 可 seed，本次 judge 首轮 fail 根因即此）；选中行携带来源（staged→index / unstaged→worktree）进入详情面板；提交详情文件点击→只读 commit 源 diff + 返回按钮，detailFile 提升到 historyStore 供 harness 驱动。 |
| 8 | 性能 | 后端每文件行数上限 5000（truncated 标记）；前端 >600 行折叠显示前 300 行（展开全部），折叠期间未挂载的行不进 DOM；diff 行代码不折行（横向滚动），退出标准「5000 行不卡」由折叠+截断双保险达成。 |
| 9 | 测试 | Rust +6（三源 diff、词级 span、二进制/截断、整 hunk 暂存往返、部分行暂存 index 内容断言、双 hunk 选择性暂存、unstage 还原）；前端 +10（diffStore 4、DiffView 6）。快照 29-31 judge 通过。 |

### 2026-09-08 · W7 分支 / 标签 / 储藏偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | 回收站模型 | eg-safety 增加 `OpKind::RefDelete`（保持 Copy，分支/标签名放 `paths[0]`），原引用目标存 `refs/easy-git/trash/branch-<op_id>` 或 `tag-<op_id>`（名字前缀区分类型）。撤销=从 trash ref 重建 refs/heads|tags/<name> 并删除 trash 引用；附注标签的 trash ref 指向 tag 对象，恢复后仍是附注标签。当前分支不可删（与 git 一致）。 |
| 2 | switch 脏区检测 | 切换前自查 status：已暂存/未暂存的**已跟踪**变更一律拒绝（DirtyWorktree 带路径）；未跟踪文件仅在目标分支包含同路径时拒绝（否则放行）。checkout 用安全模式（非 force），冲突兜底也报 DirtyWorktree。前端收到 dirty 弹「储藏并切换」对话框（F-22 主动建议储藏）。 |
| 3 | stash 细节 | `stash_save2` 需要 `&mut Repository`（worker 的 repo 改为 mut 绑定）；干净工作区提前拒绝（libgit2 报 NotFound 太晦涩）；身份缺省回退 `EasyGit <easygit@invalid>`（stash 不涉作者归属）。apply 用 `reinstantiate_index` 保证「存→取」索引状态无损（退出标准）。drop 无撤销（libgit2 无 stash store API），以红色确认对话框兜底，记入已知偏差。 |
| 4 | 上游设置顺延 | R-15 的「上游设置」推迟到 W9（远程里程碑）：无 remote 时上游无意义，BranchInfo 已预留 upstream/ahead/behind 字段与 UI 展示。 |
| 5 | F-23 命令面板完整版顺延 | Ctrl+K 保持仓库切换；操作/分支/文件四类搜索随 M2。 |
| 6 | fork API 坑 | 本 fork：`find_branch(name, BranchType)` 无 Option 包装；`tag.tagger()`/`tag.message()` 返回 Option（非 Result）；`stash_apply` 的方法名是 `reinstantiate_index`（上游是 reinstate_index）；`references_glob` 可用。 |
| 7 | q() 反引号 bug | 模板字符串里的正则字符类含反引号（/([$"\\`])/）会提前闭合模板字面量，导致 shell 引用函数 q() 丢结尾引号——W4 起所有 lens 命令的引号都不闭合（本次 W7 测试断言暴露）。改为纯字符串拼接 + 正则 `[\\$"']`。 |
| 8 | 分支看板形态 | judge 建议后去掉了独立 hero 卡：当前分支作为列表首行（✓ 图标 + primary 高亮 + 当前分支徽标），计数徽标与列表一致；当前分支右键仅重命名（不提供切换/删除）。 |
| 9 | 测试 | Rust +5（branch CRUD/重命名移动 HEAD/回收站找回/当前分支拒删、switch 脏区与未跟踪冲突、tag 轻量+附注+回收站、stash 无损往返含 index reinstated、untracked stash）；前端 +6（refsStore：refresh/创建+lens/切换同步/dirty 无 toast/删除撤销链路/stash push）。快照 32-33 judge 通过（含「列表含 main」整改复验）。 |

### 2026-09-09 · W8 合并 / 回退 / 冲突向导偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | 冲突停车模型 | merge_start 遇冲突时把 merge_commits 产出的**内存索引**逐条拷入磁盘索引（libgit2 的 merged index 不能直接 write），同时写 `.git/MERGE_HEAD`/`MERGE_MSG`（git 原生停车），并把冲突标记文件写入工作区（`<<<<<<< HEAD` / `>>>>>>> <branch>`；二进制文件保留 ours 内容）。真实 git CLI 造出的 mid-merge 仓库同样被识别（冒烟验证）。 |
| 2 | 冲突解析载荷 | conflicts_get 返回三阶段内容（base/ours/theirs blob）+ 工作区标记解析出的 blocks/segments（segments.len == blocks.len+1，重组用）。conflict_resolve 写回文件 + conflict_remove + add_path + write，即完成暂存。 |
| 3 | 合并收尾走提交路径 | commit() 读 MERGE_HEAD 附加第二父提交；mid-merge 时跳过「空暂存」与「部分暂存」守卫（git 同样允许空差异合并提交），并在成功后清除 MERGE_*。amend 与合并收尾互斥。 |
| 4 | FF 与 no-ff | 默认快进优先（merge_analysis），checkout 用 safe + recreate_missing（本 fork 默认 SAFE 不含 recreate_missing，新增文件不会落盘——switch_branch 一并修正）；no_ff 勾选后即使可快进也创建双亲合并提交，干净合并自动提交并同步工作区。 |
| 5 | revert 实现 | libgit2 `repo.revert` 的 ours 恒取 HEAD，多步 revert 无法堆叠暂存结果（报 uncommitted change overwritten）；改用 `merge_trees` 三方树合并：base=被回滚提交、theirs=其父、ours=当前索引树（等价 `git revert --no-commit` 的堆叠语义），结果写入磁盘索引并 force 检出工作区（起始树已由 ensure_clean 验证干净，序列中脏文件都是 revert 自身产物）。中途冲突整体回滚到原 HEAD 并报 ConflictState。 |
| 6 | reset 三模式 | soft/mixed 不做快照（不破坏任何内容）；hard 先对「HEAD↔目标树差异路径」做 eg-safety 快照点，OpRecord kind=Reset，paths[0]=原 HEAD oid + 文件路径。撤销 = 从快照恢复文件 + mixed reset 回原 tip（分支移回、文件以未暂存形式出现）。undo_operation 签名改为 `&mut Repository`（W3/W7 测试调用点同步更新）。 |
| 7 | 冲突向导形态 | 全屏接管主视图（mergeState 非空时 AppShell 渲染 ConflictWizard）；顶部进度 + 常驻「中止合并」（danger + 确认对话框）；文件 chips（已解决划线 ✓）；三栏 基础/我方/对方（色点标注）；逐块决策 用我的/用对方的/两者保留/手动编辑，已解决块降饱和+打勾；全部解决后出现「完成合并」→ 预填 git 合并消息的提交对话框（双亲提交）。进度模型用 knownPaths（累计见过）− 当前冲突集，兼容 resolve 后文件从冲突列表消失的时序。 |
| 8 | DAG 右键接真 | 回滚此提交 = revert 单提交（结果进暂存区，toast 引导去变更页提交）；重置到此提交子菜单 = 混合重置（保留修改，直接执行）/ 硬重置（丢弃修改，红色确认 + 快照点 + 撤销 toast）。摘取（cherry-pick）仍未实现（本 fork 无 cherry_pick API，顺延 M2 记录）。 |
| 9 | merge 安全默认 | 分支板右键「合并…」对话框默认快进优先，「总是创建合并提交（no-ff）」为可选勾选（F-26 简洁模式默认）；合并中 CommitBox 预填合并消息且输入框禁用（渲染期状态调整模式，规避 setState-in-effect lint）。 |
| 10 | 冒烟与验收 | deb 安装后以 AT-SPI 无障碍树驱动真机（scrot 在 WSLg 抓屏全黑，弃用坐标盲操）：feature-flow-conflicted（真实 git CLI 停车）→ 向导接管 → 用我的 → 解决此文件 → 完成合并 → 双亲合并提交落盘、MERGE_HEAD 清除；重建 fixture 后 中止合并 → 工作区/HEAD 完全复原。14 张 W8 快照 judge 12 页全过。 |
| 11 | 测试与已知问题 | Rust +12（ff/no-ff/干净分叉/停车/中止/块解析+双亲收尾/revert 单·多·回滚/reset 三模式/hard 撤销/已合并 noop+脏区拒绝），前端 +13（mergeStore 9、ConflictWizard 8、composeContent；Radix 右键菜单在 jsdom 挂死不可测，菜单接线由真机冒烟覆盖）。快照 harness 换 ephemeral WebKit context（旧缓存曾致 `__eg.mergeStore` 缺失）+ JS 错误可见化；f-string 注入 JS 的 `{{}}`/`\n` 转义为易错点。 |

### 2026-09-09 · W9 远程与安全网偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | 网络操作走 CLI | GitCli 封装 `git -C <workdir>`（TDD §4 混合模型）：run() 返回 (输出, 是否成功)——早期只探 git 存在性的 quick_status 无法区分命令失败，fetch/push 静默假成功风险由此堵住。fetch 支持 `--prune`/`--depth`（R-24/R-22 浅获取入口在核心层）。 |
| 2 | 进度管道 | CLI `--progress` stderr 逐行解析（Receiving/Resolving xx% (a/b)）→ mpsc → `sync://progress` 事件 → 底部任务条（task/message/percent）。进度发射在 tauri async_runtime::spawn 中转发，命令结束发 done 收尾。 |
| 3 | 强推回滚 | push_with_rollback：force 时**先 fetch**（刷新 lease 基线，否则 --force-with-lease 报 stale info）+ ls-remote 取远端旧 tip → 先写 eg-safety 记录（OpKind::ForcePush，paths=[分支, 远端旧tip, 远端名]）→ 再推。撤销 = `push_restore` 把旧 tip 强推回去（远端备份可回滚，R-22 退出标准）。 |
| 4 | pull 集成 | CLI fetch（带进度）+ worker `pull_integrate`（libgit2）：ff_only 遇分叉报 ConflictState（文案含「分叉」，ahead/behind 计数）；前端映射为分叉对话框（F-27）——「合并远端提交」复用 W8 合并管线（冲突进向导），「变基」置灰（即将推出）。merge_start 的目标解析扩展为 refs/heads/{name} → {name} → refs/remotes/{name} 全名匹配。 |
| 5 | 撤销/重做引擎 | R-25「引用快照树」定案（PRD §10.2 已决策）：OpRecord 增加 target 与 undone 字段。撤销打 undone 标记；**重做 = 重放原语 + 重新激活原记录（同 op_id、undone=false）**，避免每次 redo 生成新记录导致无限重做；Reset 重做委托 reset_with_record（先照原样记录再重放）。各原语拆出 *_apply（discard/clean/delete_branch/delete_tag）供重做复用。 |
| 6 | reset 快照时序 | W8 版在 repo.reset 之后才建快照——快到的是重置后内容，撤销等于没撤销。重构为 reset_plan（变更路径 + 原 tip + 目标，均在变更前取）→ reset_with_record（先快照后 reset）。教训写进 W8 表 #6 的修正。 |
| 7 | 远程管理 | R-24：libgit2 remote CRUD + 重命名/改址 + ls-remote 连通性测试；分支板上游设置（W7 顺延）= set_branch_upstream。fork 坑：`StringArray::iter()` 产出 `Result<Option<&str>>`；`remote_rename` 在 Repository 上；`remote.url()` 返回 Result。 |
| 8 | 时间线 | F-28：HEAD reflog 分类（classify_reflog）+ eg-safety 操作日志合并去重排序（time 用 f64——specta 禁 i64/u64）。危险类（reset/discard/clean/ref_delete/force_push/rebase）红环 + danger 色；行 hover 出「恢复到此状态」= 快照保护的硬重置（红色确认）。重置条目 subject 只写「重置」，目标 oid 由右侧 chip 显示（避免 oid 重复）。 |
| 9 | R-23 凭据偏差 | keyring 集成 / HTTPS token 托管不做：凭据完全交给系统 git 凭据基础设施（credential helper / SSH agent / store），EasyGit 不接触、不存储任何密钥（CLI 子进程天然继承）。身份配置已在 W4 设置页落地（global user.name/email）。keyring 内建托管顺延 M2 并已同步 PRD 待议。 |
| 10 | 分层纠偏 | sync 命令初版把 git2/uuid 拉进了 app crate（违反 TDD §3 边界）——重构为 eg_git_core::remote 高层入口（fetch_at/push_with_rollback/clone_repo 等），app crate 回归纯 IPC 编排。绑定新增 17 命令 + SyncProgressEvent，两处注册清单同步。 |
| 11 | 冒烟与验收 | 本地 bare origin 三仓 fixture（server.git/peer/work），deb 真机 AT-SPI：获取（origin/main 前移）→ 拉取遇分叉 → 分叉对话框「合并远端提交」→ 双亲合并提交 → 推送（server 前移）→ peer 分叉后推送被拒 → 强推对话框 → 远端重写 → 底栏撤销 → **远端恢复旧 tip（强推可回滚）** → 时间线 hover「恢复到此状态」→ 硬重置 + 快照 ref 落盘 → 再撤销 → main 回到合并提交。W9 退出标准全过。 |
| 12 | 冒烟坑 | 本环境 AT-SPI 按钮角色名是 `button` 而非 `push button`（按后者的 find/dump 全部落空）；toast 在 AT-SPI 树不可见（不可靠信号，改验 git 落盘状态）；对话框在树中可按标题定位（radix dialog role）。xdotool 看不见 Wayland 客户端——需 `GDK_BACKEND=x11` 重启应用才能 hover（时间线恢复按钮是 hover-only）。`pkill -f easy-git` 会自杀（bash -c 命令行含模式串），用 `pkill -x`。快照脚本：W8 末态残留 light 主题传染 W9 状态（51/57 两张 md5 相同暴露）——每个主题态显式点击 theme-dark/light + 清 mergeStore 接管。 |

### 2026-09-09 · W10 打磨与 RC 偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | X-01 性能基准 | 新增 docs/perf-baseline.md（方法论+数据）与 scripts/bench-perf.py（AT-SPI 真机驱动计时）。mid-size（5001 提交/51 引用）：冷启动到可交互 0.49s（目标 ≤2s）、开仓 0.24s、历史首屏 500 提交 0.43s（目标 ≤3s）、deb 5.9MB（≤30MB）、git CLI 基线 status 3ms / log500 27ms。滚动 ≥50fps 在 WSLg 无法直接测（scrot 全黑、无 GPU 计数器），以「25 格滚轮连发内容跟进 ~1.1s」替代记录。 |
| 2 | 内存与 WSLg 缓解 | 全进程 RSS ≈469MB 超 PRD 300MB 目标：分解=主进程 179 + WebKit 渲染 198 + 网络 53。渲染进程基线在 WSLg 高达 ~350MB；main.rs 检测 WSL（WSL_DISTRO_NAME/内核串）时设 `WEBKIT_DISABLE_COMPOSITING_MODE=1`，渲染 353→198MB 且无性能回退；真实 Linux 桌面不受影响。300MB 按「全进程」口径在 WebKitGTK 上不可达——建议 PRD 改口径（主进程 ≤200MB），**待用户定，未擅改**。 |
| 3 | X-02 自动维护 | worker 空闲（无命令且无待处理 fs 变更）5 分钟后静默跑 `git -c gc.autoDetach=false gc --quiet`（含 repack/prune/pack-refs）：`gc --auto` 的采样阈值在 git 2.53 实测不可靠，改用完整 gc（已打包仓库近乎无操作）。内联不 detach，防 worker 自我竞争。w10_maintenance 2 测试：松散对象被打包、eg-safety 快照 refs 在 gc 后完好。 |
| 4 | X-03 快捷键 v1 | lib/shortcuts.ts 单一 keydown 入口 + 输入框守卫（editable 元素保留原生编辑键）；设置页新增速查卡（快照 58 judge 过）；绑定：Ctrl+K 切换器 / Ctrl+, 设置 / Ctrl+R·F5 刷新（实测不会触发 webview 重载）/ Ctrl+Z·Y 撤销重做 / Alt+1..6 切视图。**平台事实：WebKitGTK 原生层吞掉 Ctrl+数字与 Alt+数字**（xev 证实 X 层送达、合成事件与 7 个单测正常、Ctrl+K/,/R 真机正常）——视图切换在 Linux 上待真实桌面复验，记入已知问题。全键盘 Tab 走查焦点链正常（注意 AT-SPI FOCUSED 要取最内层节点）。 |
| 5 | X-04 概念卡片与新手测试 | ConceptCards（暂存区/提交/分支/远端与同步 4 卡）首次开仓一次性显示，localStorage 记忆，测试 3 例；空状态 W1-W9 已全覆盖无需补。docs/testing-10min.md 交付任务卡+观察表+自动化对照脚本。真机自跑 4/6 步：克隆（真实键入地址/路径→自动打开）→ 改+暂存+提交（身份缺失警告 → 全局配置后消失 → 提交 4fe6f5f 落盘）通过；分支创建步被测试环境卡死：**fcitx 死守护进程吞掉全部进 webview 的文本输入**（`GTK_IM_MODULE=` 空后恢复）+ WSLg XTEST 注入管线中途整体失效（xev 证实连 xev 自身都收不到事件）。属环境工具问题非应用缺陷；5 人真人测试仍需线下组织（PRD 验收硬性项，阻塞 RC tag）。 |
| 6 | X-05 RC 收尾 | 版本升 0.1.0-rc.1（tauri.conf + workspace Cargo.toml）；Linux 双包 deb 5.9MB + AppImage 84.8MB（AppImage 含运行时体积超 30MB 口径，deb 达标）。README 更新 M1 RC 状态 + 未签名说明（SmartScreen/Gatekeeper 绕过指引）。exe/msi/dmg 需 Windows/macOS 机器（待办）；git tag 留待 5 人测试通过后补。w4 缺身份测试改用 libgit2 `set_search_path` 密封（GIT_CONFIG_GLOBAL 对 libgit2 无效；冒烟期间设置的全局身份不再影响测试）。 |
| 7 | 已知问题清单（同步 M2 范围） | ① 视图快捷键 WebKitGTK 不触发（Alt+1..6 待真桌面复验）② 空闲内存 PRD 口径待修订（建议主进程 ≤200MB）③ AppImage 体积口径 ④ R-23 keyring/HTTPS token 托管顺延 M2 ⑤ pull 变基选项置灰（M2）⑥ CLI 网络操作无超时/取消（PRD §4.2 要求，M2）⑦ 测试环境输入管线不稳（仅 WSLg 测试环境）。PRD §10 未决项（签名/应急终端/历史重写/LFS）保持开放，未经用户决策不改。 |
| 8 | rc.2 用户反馈修复 | 首批真人试用四项反馈：① 侧栏「克隆仓库」仍是 W2 的 disabled 占位——CloneDialog 提升为 AppShell 级全局挂载（uiStore.cloneDialogOpen），向导卡片与侧栏入口共用；② 窄窗口下分支行「当前分支」徽标竖排换行——Badge 基类加 shrink-0/whitespace-nowrap，分支名 span 补 min-w-0；③ 变更页蓝线不停闪——LoadingBar 只在首载（无 status）与手动刷新（Ctrl+R）出现，fs-watch 后台刷新静默；④ 远程页「测试连接无反应/获取后按钮灰卡」——根因是 CLI 网络命令无超时（用户网络下 ls-remote/fetch 挂起，busy 永不清除，PRD §4.2 欠账）：run() 加 try_wait 轮询超时（ls-remote 45s / fetch·push·push_restore 300s / clone 600s / 本地 gc 900s），超时 kill 并人话化报错；toast 真机渲染已证实正常（「已获取 origin」截图）。真机复验：侧栏克隆弹窗 ✓、51 分支单行 ✓、后台刷新无蓝线且状态实时 ✓、获取后 toast+按钮恢复 ✓。 |
| 9 | R-22 推送 HTTPS 用户名/密码回退 | 部分老服务器 HTTPS 推送需要用户名+密码（系统凭据助手无缓存时旧行为是卡到 300s 超时或无出路的 Auth toast）。方案：首次仍走 ambient；`auth` 拒绝后弹凭据框（用户名+密码，`sync.auth*` 文案），提交后带凭据重试一次，成功则记入**进程会话内存**（Map<repo,remote>，关闭应用即清，不落盘——R-23「不存储密钥」deferral 依然成立，keyring 托管仍顺延 M2）。后端经临时 askpass 脚本注入（Windows .bat / Unix sh，prompt 含 User→用户名否则→密码，Unix 0600，单次调用唯一目录防并发撞车，Drop 守卫保证用后删除），子进程统一 `GIT_TERMINAL_PROMPT=0` + stdin null（TDD §4.2 桥约定补上：缺凭据快速失败不再垂死超时）。秘密不进 argv/日志/lens/op-log/timeline。范围仅 push（含强推预检 fetch/ls_remote 同次复用）；`push_restore`（undo 强推）与 fetch/pull/clone 仍 ambient，是已知局限。IPC：`sync_push` 新增 `credentials: PushCredentials|null`（bindings 重生成，CI 漂移门）。前端 `push()` 新增 `'auth'|'cancelled'` 返回（取消静默收场；二次 auth 失败 toast `sync.authFailed`）。测试：askpass 单测 3 例 + syncStore 对话框/缓存/取消 3 例 + file:// 回归（带 creds 推不断言破坏）。 |
| 10 | 合并工作区同步修复 | 用户真机用 EasyGit 合并后出现「被暂存的反向 diff」：干净合并路径先 commit 移动 HEAD 再 `checkout_head`，libgit2 以当前 HEAD 树为基线（基线=目标），SAFE 策略跳过所有被合并修改/删除的路径，工作区与磁盘索引停在合并前——旧 w8 用例只新增文件（RECREATE_MISSING 兜住）故全部漏检。修复：checkout_tree(合并树) 先于 commit（与 FF 路径同序），提交失败 `reset --hard` 兜底；冲突停车路径同步补齐——非冲突的合并结果经内存临时索引 `checkout_index(force)` 落工作区（走 libgit2 过滤器），冲突文件仍由 `write_conflict_workdir` 写标记，否则完成合并后同样留反向 diff。回归测试 2 例（改+删文件合并后 status 三区全空；冲突合并中非冲突文件已同步），在旧代码上均失败、修复后通过；内容断言统一忽略行尾（autocrlf 基线）。 |
| 11 | 切换分支工作区同步修复 | 合并修复后用户复测发现同族问题：`switch_branch` 先 `set_head` 移动 HEAD 再 `checkout_head`，基线=目标，SAFE checkout 空转——HEAD 在新分支、工作区/索引留在旧分支（未暂存反向 diff）。这是全工程最后一个「先动 ref 后 checkout」的生产路径（合并/重置均已正确）。修复：checkout_tree(目标提交树) 先于 set_head，沿用切换前脏工作区守卫（tracked 改动与目标树冲突的未跟踪文件先拒绝），checkout 失败时 HEAD 未动、无半成品状态。回归测试 1 例（两分支各有改/增/删，来回切换断言工作区内容与 status 三区全空），旧代码失败、修后通过。 |

### 2026-09-12 · 日志系统与失败原因透出偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | §1 文件 sink 落地（兑现 W1 #8 承诺） | tracing-subscriber registry 双层：stderr（dev 控制台）+ tracing-appender 每日滚动文件 `<app-data>/logs/easygit.log.YYYY-MM-DD`（non_blocking，WorkerGuard 由 Tauri state 保活到进程退出）；初始化自 run() 移入 setup()（app_data_dir 在 setup 才可得）；`RUST_LOG` 仍覆盖默认 info；启动清理 14 天前旧文件；panic hook 先落 `error!` 再走默认 hook（PRD §7 崩溃日志本地存储）。 |
| 2 | 埋点收口（不逐个改 55 命令） | worker.rs 泛型 `request()` 对 Err 分级：DirtyWorktree/UnsafeOperation/ConflictState/NotSupported/Cancelled 属 UI 守卫记 `debug`，其余 `error`（EgError 新增 `is_expected()`）；worker 主循环每命令 `debug`（label + 耗时，RepoCommand 补 `label()`）；GitCli::run 启动/完成/超时日志（参数过脱敏）；humanize_network / classify_spawn_error；commands.rs 生命周期（open/init/clone/close）。 |
| 3 | §6 错误模型扩展 | RepoNotFound/Network/Auth/ConflictState 增可选 `detail`（serde `skip_serializing_if` 缺省不出现，旧前端向后兼容）：humanize_network 把脱敏 stderr 尾部（4 行）放进 detail，Network.url 填真实远端（此前恒空串），RepoNotFound.path 恢复纯路径（git2 错误文本移入 detail）。 |
| 4 | §6 hint 接线 + toast 增强 | errors.ts 的 hint 动作首次接到导航（`lib/ipc/hints.ts`：open-logs→设置页日志区、go-changes、open-conflict-wizard→切离 settings 并 poll、open-repo-picker→快速切换器、open-git-download→opener；open-settings-network/open-credentials 暂落设置页顶部，分区未实现；未知动作记日志不抛错）。Toast 落地 UI §6.11「错误可展开详情」（reason 块，等宽字体）；**错误 toast 停留 4s→8s**（展开场景 4s 不可读）。 |
| 5 | 前端日志漏斗 | `lib/ipc/report.ts reportError()`：humanize + toast(reason+hint) + appLog 一行；repoStore.failLoudly / diffStore / syncStore(11 处) / CommitBox 改走该入口；main.tsx 安装 window error + unhandledrejection 全局钩子 → 新命令 `log_write` → tracing target `web`（与 Rust 同一文件同一格式）。 |
| 6 | 日志查看器 | 设置页新增「日志」区（LogsPanel）：文件下拉（每日倒序）、级别过滤（条目行按订阅者格式匹配，延续行随条目——过滤错误级保留堆栈）、复制、打开文件夹（opener）；只读，不做终端（PRD §1.5）。IPC 新增 `logs_dir/logs_list/logs_read/log_write`（两处注册表同步，bindings 重生成；数值字段 u32 规避 specta BigInt 禁令）。 |
| 7 | 凭据脱敏 | eg-types 新增 `sensitive::redact_url/redact_text`（scheme://user:pass@ 保留用户名掩码密码；http(s) 裸 userinfo 视为 token 掩码；ssh/scp 不动），应用于日志行与错误 detail；「秘密不进日志」红线（W10 #9）由代码路径保证。 |

### 2026-10-26 · SSH 首次连接引导与多远端推送偏差记录

| # | 条目 | 说明 |
| --- | --- | --- |
| 1 | 根因 | `humanize_network`（本地仓库的 git CLI 网络命令）没有主机指纹分支，`Host key verification failed.` 落到 `EgError::Internal`，前端显示「内部错误」；`Permission denied (publickey)` 又被归为 `Auth{provider:"git"}`，前端弹 HTTPS 用户名/密码框，与 SSH 密钥问题不符。`ssh_credentials_overview` 只读，没有指纹确认/密钥生成通路。 |
| 2 | 错误模型 | `EgError` 新增 `SshHostKey { host, port, changed, fingerprint?, key_type?, detail? }`（code `ssh_host_key`）；`Auth` 增加可选 `host`。`humanize_network`/`humanize_ssh` 都先判主机指纹与 SSH 公钥失败，再走网络/HTTPS 认证分支；`SshHostKey` 进入 `is_expected()`（用户确认属于控制流，分类器单独 warn）。 |
| 3 | 主机信任 | 新增 `probe_host_key`（用临时 `UserKnownHostsFile` 让 ssh 自行握手并 pin 主机键，再用 `ssh-keygen -lf` 算指纹）与 `trust_host_key`（重探比对、`ssh-keygen -R` 清旧条目、原子写 known_hosts）；**只有用户点击确认才写入**。changed key 需二次勾选风险确认；探测失败显示原因并提供「重新获取指纹」，不静默信任。`ssh_run` 对 SSH 远端仓库保留 `StrictHostKeyChecking=accept-new`（不破坏 ProxyJump/ssh config；changed key 仍会弹窗），本地仓库 git CLI 走显式确认。注：Windows OpenSSH 9.5 的 `ssh-keyscan` 对 GitHub 报 unsupported KEX，而 `ssh` 正常，故探测改用 ssh 本身（真机 2026-10-26）。 |
| 4 | 密钥向导 | `ssh_generate_key` 生成 `~/.ssh/id_ed25519`（ed25519、无口令、权限 600、拒绝覆盖）；`ssh_public_key` 只允许读 `~/.ssh/*.pub`；`ssh_test_github` 解析 `Hi <user>! You've successfully authenticated`（GitHub 成功也退出 1）。前端全局 `SshHostKeyDialog` + `SshSetupDialog`，`withHostKeyTrust` 在信任后自动重试原操作一次；`open-ssh-setup` hint 直达向导。 |
| 5 | 多远端 | `syncStore.selectedRemote` 按仓库持久化到 `localStorage`（默认：已保存 → 上游远端 → origin → 首个）；同步按钮旁的 `<select>` 决定 fetch/pull/push 目标。`pushAll` 非强推、选中远端优先、单个失败继续、取消即停止，最后一条汇总 toast；单次 push 仅在分支没有上游时自动 `branch_set_upstream`，`pushAll` 不改上游。 |
| 6 | 测试与边界 | Rust 新增主机指纹/URL 解析/认证错误分类单测；前端新增 sshStore 信任重试、syncStore 选择/全部推送单测。真实 GitHub 检测仍需用户账号做一次手工验收；keychain/口令记忆、HTTPS token 托管仍不在本轮范围。 |
