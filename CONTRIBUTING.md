# 贡献指南

感谢关注 EasyGit！本项目尚在早期（MVP 阶段），欢迎 Issue 讨论、文档纠错与代码贡献。

## 开发环境

1. 安装依赖：Rust stable（rustup）、Node.js 20+、pnpm 9、Git ≥ 2.30。
2. Linux 额外依赖（Ubuntu 示例）：
   ```bash
   sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file \
     libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev
   ```
3. 克隆并运行：
   ```bash
   git clone <仓库地址> && cd easy-git
   pnpm install
   pnpm tauri dev
   ```

## 如何贡献

1. 先查 [Issue 列表](../../issues)；大改动请先开 Issue 讨论方案（对照 [PRD](./docs/easy-git-prd.md) 与 [TDD](./docs/easy-git-tdd.md)）再动手。
2. 从 `main` 切出功能分支：`feat/dag-virtual-scroll`、`fix/stash-untracked`、`docs/prd-update`。
3. 提交信息遵循 Conventional Commits：`type(scope): 描述`，如 `feat(history): DAG 图支持按作者过滤`。
4. PR 要求：
   - UI 变更必须附**明暗双主题**截图或录屏，并对照 [UI 设计文档](./docs/easy-git-ui-design.md)；
   - Rust 核心行为变更需附带测试（git-core 行为必须与真实 git 一致）；
   - 破坏性操作相关改动必须包含「撤销/恢复」测试；
   - 通过 CI（fmt、clippy、eslint、prettier、测试）。
5. 文档改动直接 PR；需求/设计类讨论请开 Issue 打上对应标签。

## 代码风格

- Rust：`cargo fmt` + `cargo clippy -- -D warnings`；错误统一用 `EgError`（见 TDD §6）；不直接在前端命令层写 git 逻辑。
- TypeScript：strict 模式；组件只经 store 调用 IPC，不直接 import 绑定；样式只用语义令牌（`--eg-*`），禁止硬编码色值。
- 文案：界面中文遵循 PRD §6.7 术语表；代码注释与标识符用英文。

## 项目结构

见 [TDD §2](./docs/easy-git-tdd.md)。前端在 `src/`，Rust 核心在 `src-tauri/crates/`，文档在 `docs/`。

## 行为准则

保持友善与专业，尊重不同经验的贡献者——本项目本身就以「帮助 Git 新手」为使命。争执对事不对人；维护者保留处理不当言行的权利。

## License

提交即表示你同意代码以 [MIT](./LICENSE) 协议发布。
