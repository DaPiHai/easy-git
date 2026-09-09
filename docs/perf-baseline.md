# 性能基准（X-01，m1-plan W10）

> 记录日期：2026-09-09 · 机器：WSL2 (WSLg) x64，6 核，GNOME/X11 · 被测：deb 安装的 release 二进制
> 方法：AT-SPI 驱动真机操作，`time.monotonic` 计时（30–50ms 轮询量化）；内存为 `ps` RSS 求和（主进程 + WebKitWebProcess + WebKitNetworkProcess）。
> AT-SPI 节点出现的时刻略早于首帧绘制，下列 UI 数字按「下界」理解。

## 基准仓库

`mid-size`（PRD 附录 B #3）：5001 提交 / 51 引用（`scripts/fixtures/build-fixtures.sh mid-size`）。

## 实测结果（PRD §7 M1 相关指标）

| 指标 | 目标（PRD §7） | 实测 | 结论 |
| --- | --- | --- | --- |
| 冷启动（进程→UI 可交互） | ≤ 2 s | **0.49 s** | ✅ |
| 打开仓库（最近列表点击→主界面可用） | — | 0.24 s | ✅ |
| 状态刷新（git CLI 基线 `status --porcelain`） | ≤ 1 s | 3 ms（CLI 基线） | ✅ |
| 历史首屏 500 提交（DAG+行渲染） | ≤ 3 s（10万提交为 M3 目标） | **0.43 s** | ✅ |
| 滚动（25 格滚轮连发，内容跟进） | ≥ 50 fps | 1.12 s 内容跟进（含连发本身 ~0.8 s；单格无可见迟滞） | ⚠️ 方法论受限，见下 |
| 空闲内存（三进程 RSS 合计，WSLg 关合成后） | ≤ 300 MB | **≈ 469 MB**（主进程 179 + 渲染 198 + 网络 53） | ❌ 见说明 |
| 安装包（deb） | ≤ 30 MB | **5.9 MB** | ✅ |
| git CLI 基线 `log --oneline -500` | — | 27 ms | 参考 |

## 内存说明与已做优化

- WebKitGTK 渲染进程在本机基线即 ~350 MB（空向导页），EasyGit 自身内容仅 +60 MB（500 提交历史 + DAG canvas）。
- **WSLg 缓解（已实现进 main.rs）**：检测 WSL 环境（`WSL_DISTRO_NAME`/内核串含 microsoft）时设置 `WEBKIT_DISABLE_COMPOSITING_MODE=1`，渲染进程 353→198 MB（-155 MB），且冷启动更快、滚动无回退。真实 Linux 桌面不受影响。
- 300 MB 目标按「全进程 RSS」在本技术栈上不可达（WebKitGTK 自身底线 ~250-450 MB 视平台）。建议后续将目标改写为「主进程 ≤ 200 MB + 渲染进程 ≤ 250 MB」或在 PRD 中注明口径——**待用户决策，未擅自改 PRD**。

## 滚动方法论限制

50 fps 无法在 WSLg 下用外部工具直接测量（scrot 抓屏全黑、无 GPU 计数器）。采用「滚轮连发后内容跟进耗时」作为替代指标；follow-up 可在原生 Linux 桌面用 DevTools/性能面板补测。

## 复现

```bash
scripts/fixtures/build-fixtures.sh mid-size
python3 scripts/bench-perf.py          # EG_BENCH_NOCOMP=1 为关合成 A/B
```
