# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本仓库的权威工程约定是 **`AGENTS.md`**（架构边界、已锁定规范、已知注意事项、交付要求）；本文件不重复它，
> 只补「命令速查」与「需要读多个文件才能建立的整体认知」。两者冲突时以 `AGENTS.md` 为准。

EasyGit：Tauri 2 + Rust 核心 + React 18/TS 的**中文优先 Git 可视化桌面应用**（`0.1.0-rc.3`，MIT）。
git 逻辑只存在于 Rust 侧；前端是纯展示与编排。文档索引见 `docs/README.md`。

## 常用命令

```bash
pnpm install                 # CI 用 --frozen-lockfile；pnpm 版本以 package.json packageManager 为准
pnpm dev                     # 纯前端 vite（:5173，无 Tauri，走 IPC 降级分支）
pnpm tauri dev               # 桌面联调
pnpm build / pnpm typecheck  # tsc --noEmit (+ tsconfig.node.json) && vite build
pnpm lint                    # eslint src（bindings.ts 已在 eslint 配置里忽略）
pnpm format / format:check   # prettier，仅 src/
pnpm test / test:watch       # vitest run / watch（jsdom，setup=src/test-setup.ts，include=src/**/*.test.{ts,tsx}）

# 单个前端测试
pnpm vitest run src/stores/refsStore.test.ts
pnpm vitest run -t "切换分支"          # 按用例名过滤

# Rust（在 src-tauri/ 下）
cargo fmt --all --check
cargo test --workspace
cargo clippy -- -D warnings            # CONTRIBUTING 门槛，CI lint 未跑，提交前本地跑
cargo test -p eg-git-core --test w8_merge_conflicts            # 单个测试文件
cargo test -p eg-git-core --test w8_merge_conflicts merge_ff   # 单个用例
cargo run --features gen-bindings --bin generate-bindings      # 生成绑定；跑完 git diff src/lib/ipc/bindings.ts 须为空
```

Rust 测试需要 `git` 在 PATH 上（eg-git-core 的行为断言要跟真实 git 对齐）。

```bash
# 验收夹具（生成到 .fixtures/，已 gitignore；确定性作者/日期）
scripts/fixtures/build-fixtures.sh [--out DIR] [--huge] [--conflicted] [name...]
#   tiny-demo / feature-flow / mid-size(~5000 提交) / huge-repo(10 万，--huge)

# UI 视觉验收：需先 pnpm dev 起 :5173；用 WebKitGTK（生产同款引擎）截各状态图，依赖 PyGObject
python3 scripts/snapshot-ui.py <out-dir> [base-url]
# 性能基线（AT-SPI 驱动真机 deb；脚本内硬编码 DISPLAY/fixture 路径，属开发机专用）
python3 scripts/bench-perf.py
```

出包见 `AGENTS.md`（Windows MSI 必须用 `--config` 覆盖纯数字版本且每次递增 N）。

## 一次操作的完整链路

```
组件 → Zustand store → src/lib/ipc/commands.ts（唯一 IPC 封装层）
     → commands.rs（薄编排，async）
     → eg_git_core::RepoManager → WorkerHandle
     → RepoWorker 线程（本地，持有 git2::Repository） / ssh_backend（远端）
     → eg-git-core 领域模块 → git2 或 git CLI
事件回流：repo://changed（fs-watch 防抖 300ms）、sync://progress（网络进度）→ store 订阅 → 视图
```

- 命令层不写 git 逻辑；`commands.rs` 只做参数搬运 + `spawn_blocking` 转发（同步 worker 命令带 15s 往返超时）。
- 长任务/网络操作走 git CLI `--progress`，stderr 逐行解析成 `sync://progress`（`percent: Option<u32>`、`done` 收尾）。
- 事件 DTO 放在 app crate（`src/events.rs`，因 tauri-specta 的 Event 宏依赖 tauri）；其余 IPC DTO 一律在 `eg-types`。

## 两种后端：本地 worker 与 SSH 远端

`WorkerHandle` 内部按 `eg_types::RepoLocation`（`Local(path)` | `Ssh(target)`）分派，**IPC 层不需要按后端分支**：

- `Local` → `HandleKind::Local { tx }`，mpsc 队列串行执行，`RepoWorker` 独占 `git2::Repository`
  （Repository 非 Sync），同时承载 fs-watch、300ms 防抖、空闲 5 分钟静默 `git gc`。
- `Ssh`（`ssh_backend.rs`，约 2500 行）→ 远端路径就是 `ssh://…` / `user@host:/path` 坐标，**每条命令都用
  `ssh::git_cmd`（allowlist）拼命令、`ssh_run` 执行、把 porcelain 输出重新解析成本地同款 DTO**。
  破坏性操作在这里硬拒：`ssh_backend::refuse(...)` 返回 `NotSupported`（reset / 强推 / discard / clean /
  分支 -D / stash drop / undo / restore 在远端仓库一律禁用）。

**因此新增一个 RepoCommand 时要同时想清楚本地与 SSH 两条路径**：要么在 `ssh_backend` 里实现同契约的
只读+安全写，要么显式 `refuse`。远端仓库同样是"打开的工作台"，只在细节上比本地只读。

## 绑定管道与两处注册表（最容易静默出事的地方）

- `src/lib/ipc/bindings.ts` 由 tauri-specta 生成，debug 启动自动重生成，禁止手改；CI 以"重生成后 `git diff` 为空"防漂移。
- 新增命令必须同时写进 `src/lib.rs` 的 `collect_commands![]`（**运行时真正生效的那份**）与
  `src/bin/generate-bindings.rs` 的同名列表。漏 `lib.rs` 时 Rust 编译过、TS 类型有、前端 typecheck 过，
  但运行时 invoke 拿到非 `EgError` 的 not-found，UI 降级成通用文案且不打日志。当前 67 条命令。
  `src-tauri/tests/command_registry.rs` 比对两份清单，漏一处即红。
- `ErrorHandlingMode::Result`：前端拿到的是 `{status:'ok'|'error'}` 包装（`commands.ts` 逐条 unwrap）。
- specta 禁 i64/u64（会被导成 BigInt 防精度丢失）——DTO 用 `f64`（时间戳）或 `u32`。
- capabilities 变更会被 `src-tauri/tests/capabilities.rs` 守住（`opener:allow-open-path` 必须自带 path scope）。

## 错误链路（前后端各一半）

- Rust：扁平 tagged 枚举 `{code, ...params}`（`eg-types/src/error.rs`），`code()` 必须与 serde tag 一致；
  可选 `detail` 携带脱敏后的真实原因（`sensitive::redact_*`，秘密不进日志）。
- 前端：`src/lib/ipc/errors.ts` 是唯一中文文案 + `hint` 动作表，`hints.ts` 把动作分发成导航；
  **捕获 IPC 错误统一走 `reportError`**（toast 带可展开原因 + 建议动作 + 日志行），
  非 EgError 的集成失败（如 opener 被拒）走同文件 `reportFailure`。禁止 catch 后吞成固定文案，
  也禁止把 EgError 当 `{title, detail}` 读。
- Rust 侧按 `EgError::is_expected()` 分级：UI 守卫类（dirty/conflict/unsafe/not_supported/cancelled）记 debug，
  其余记 error，保证文件日志里只剩真故障。

## eg-safety：破坏性操作的快照与撤销

- 快照点 = 操作前把受影响内容写成无父提交挂在 `refs/easy-git/backup/<op_id>`；删除的分支/标签进
  `refs/easy-git/trash/*`；强推记录远端旧 tip 以支持推回。
- 操作日志 `<app-data>/safety/<repo-id>/operations.jsonl` append-only，同一 op_id 以最后一条为准；
  撤销 = 追加 `undone: true`，重做 = 重放原语 + 复用同一 op_id 重新激活（避免无限重做）。
- 破坏性操作必须「先快照后执行」（`reset_plan` → `reset_with_record` 的顺序是血泪教训），且必须附撤销/恢复测试。

## 前端结构要点

- 无路由：`uiStore` 持 `MainView`（changes/history/branches/storage/timeline/remotes/settings），
  顶层 `AppShell` 决定布局；merge 停车时 `ConflictWizard` 全屏接管主视图；克隆/切换器等是全局浮层。
- 样式：只用 `src/theme/tokens.css` 的 `--eg-*` 语义令牌；暗色是 `:root` 基线，亮色镜像在 `[data-theme='light']`，
  两套必须同步改。硬编码色值一律禁止。
- 文案：`src/lib/i18n`（`t(key)` + `MessageKey`，目前仅 zh-CN），术语遵循 PRD §6.7（stash=储藏、fetch=获取、pull=拉取）。
- 命令透视（lens）在 store 里记等价 git 命令，只读展示，不是终端（非目标）。
- `isTauriAvailable()`：浏览器预览/快照 harness 下所有 IPC 走降级分支，新增 store 动作要保留这条早退路径。
- 等待指示器是**白名单**（`commands.ts` 的 `BUSY_LABELS`）：只包用户发起的写/网络命令，
  只读刷新（status/log/diff/轮询）刻意不列，否则后台刷新会重新引入蓝线闪烁。

## 测试布局

- Rust 行为测试按里程碑周分文件：`eg-git-core/tests/w2_repo_foundation.rs` … `w10_maintenance.rs`，
  每个文件自带 fixture helper（注意 `init_repo()` 显式钉 `core.autocrlf=false`，内容断言统一忽略行尾）。
  新行为优先扩展对应 w 文件；断言必须与真实 git 一致，破坏性操作附撤销往返。
- 前端：stores 与纯逻辑用 vitest（覆盖率较实），组件烟测用 Testing Library；Radix 右键菜单在 jsdom 会挂死，
  菜单接线靠真机冒烟而非单测。
- 冒烟/性能/截图脚本依赖 WebKitGTK + PyGObject + AT-SPI，只在 Linux 开发机可跑（`scripts/*.py`）。

## 写代码前必读的坑（多文件交叉，踩过一次）

- **先 checkout 再动 ref**：合并、切换分支都必须 `checkout_tree(目标树)` 先于 commit / `set_head`。
  libgit2 的 SAFE checkout 以当前 HEAD 为基线，先移 ref 会让工作区与索引停在旧状态，产生"被暂存的反向 diff"。
  （历史上合并、切分支两条路径先后踩中，见 TDD §11 的 W10 #10/#11。）
- `reset_default(None)` 不是"默认 HEAD"，是**清空匹配条目**；unstage 必须显式传 HEAD 对象。
- workdir diff 旧侧要显式传 `index.write_tree()` 的树：`diff_tree_to_workdir_with_index(None)` 在本版本回成整文件 Added；
  未跟踪内容还要 `show_untracked_content(true)`；`diff.print` 回调返回 `false` 会被当成"用户中止"报错，不能当优雅退出。
- amend 不能用 `commit(Some("HEAD"), …)`（libgit2 一律拒绝），要 `commit(None, …)` 建对象再 force 移动分支引用。
- 行级暂存走 CLI `git apply --cached --unidiff-zero --recount -`（stdin），unstage 是反转补丁后同样应用。
- 外部命令一律经 `eg_git_core::process::hidden_command` 创建（release 是 GUI 子系统，裸 `Command::new` 会让
  Windows 每次给 git 弹空白 cmd 窗口；该问题只在 release 包复现）；spawn 失败经 `classify_spawn_error` 映射。
- CLI 网络命令都有超时（ls-remote 45s / fetch·push 300s / clone 600s），超时 kill 并人话化报错——无超时的
  网络命令会让 busy 永不清除。
- 行尾：`.gitattributes` 已钉 `* text=auto eol=lf`（全仓库 HEAD 都是 LF）。注意它**不能**阻止编辑器把工作区
  改写成 CRLF——`git status` 照样显示上百个"改动"，只是这种改写再也进不了提交（`git add` 会归一化回 LF；
  没有这个文件时 CRLF 会被原样入库）。判定是否只是行尾：`git diff --ignore-cr-at-eol --stat` 输出为空即是，
  然后 `git restore .` 收工。两个例外：`docs/design/DESIGN.md` 与 `docs/design/LICENSE.awesome-design-md`
  上游本身就是 CRLF，已用 `-text` 豁免（改了它们会显示为永久的 modified）。
- 提交前确认分支与 diff；不要擅自提交或推送（本项目自己就是 Git GUI，脏树风险高）。
