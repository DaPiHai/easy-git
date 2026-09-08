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

CLI 桥统一约束：`tokio::process`、环境变量固定（`GIT_TERMINAL_PROMPT=0`）、超时与取消、`--porcelain`/`--json` 输出解析、进度 stderr 解析（`GIT_TRACE` 不开启）。

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
