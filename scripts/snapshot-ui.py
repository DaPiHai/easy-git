#!/usr/bin/env python3
"""Captures EasyGit UI screenshots with WebKitGTK — the same engine that
renders the production Tauri app — for visual acceptance of the W1 scaffold.

Drives the running vite dev server (http://localhost:5173) through a list of
states (theme / tabs / panel collapse) via injected JS, snapshotting each to
PNG. Tauri IPC is absent in this harness, so the bottom bar shows the
「IPC 未连接」 fallback by design.

Usage: python3 scripts/snapshot-ui.py <out-dir> [base-url]
"""
import sys

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

WIDTH, HEIGHT = 1280, 800

# (action_js_or_None, output_name) — actions are wrapped in an IIFE because
# WebKit evaluates every script in the same global scope. Mock IPC payloads
# are injected as JSON through the dev-only window.__eg store handle.

import json

SUMMARY_R1 = {
    "repoId": "r1",
    "path": "/home/hhdlj/easy-git",
    "name": "easy-git",
    "branch": "main",
    "headOid": "e1b2c3d4f5a6",
    "ahead": 2,
    "behind": 0,
    "isEmpty": False,
}

STATUS_R1 = {
    "repoId": "r1",
    "branch": "main",
    "headOid": "e1b2c3d4f5a6",
    "conflicted": [{"path": "src/merge-me.txt", "oldPath": None, "kind": "conflicted"}],
    "staged": [{"path": "src/app.ts", "oldPath": None, "kind": "added"}],
    "unstaged": [
        {"path": "src/dag.ts", "oldPath": None, "kind": "modified"},
        {"path": "assets/icons/", "oldPath": None, "kind": "untracked"},
    ],
}

RECENTS = [
    {"path": "/home/hhdlj/easy-git", "name": "easy-git"},
    {"path": "/opt/projects/website", "name": "website"},
]

STATES = [
    (None, "08-wizard.png"),
    (f"""
      (() => {{
        window.__eg.repoStore.getState().seed({{
          recents: {json.dumps(RECENTS)},
        }});
      }})()
    """, "09-wizard-recents.png"),
    (f"""
      (() => {{
        window.__eg.repoStore.setState({{
          repos: {{ r1: {json.dumps(SUMMARY_R1)} }},
          activeId: 'r1',
          status: {json.dumps(STATUS_R1)},
          favorites: ['/home/hhdlj/easy-git'],
        }});
      }})()
    """, "10-dark-changes-zones.png"),
    ("""
      (() => {
        const repoStore = window.__eg.repoStore;
        const s = repoStore.getState();
        repoStore.setState({ selectedChange: s.status.unstaged[0] });
      })()
    """, "11-dark-changes-selected.png"),
    ("""
      (() => {
        const row = [...document.querySelectorAll('[data-testid="change-row"]')]
          .find(r => r.textContent.includes('dag.ts'));
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
        }));
      })()
    """, "16-dark-context-menu.png"),
    ("""
      (() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find(i => i.textContent.includes('丢弃修改'));
        item.click();
      })()
    """, "18-dark-discard-dialog.png"),
    ("""
      (() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        const row = [...document.querySelectorAll('[data-testid="change-row"]')]
          .find(r => r.textContent.includes('assets/'));
        const rect = row.getBoundingClientRect();
        row.dispatchEvent(new MouseEvent('contextmenu', {
          bubbles: true, cancelable: true, button: 2,
          clientX: Math.round(rect.left + rect.width / 2),
          clientY: Math.round(rect.top + rect.height / 2),
        }));
      })()
    """, "19-dark-clean-menu.png"),
    ("""
      (() => {
        const item = [...document.querySelectorAll('[role="menuitem"]')]
          .find(i => i.textContent.includes('清理未跟踪'));
        item.click();
      })()
    """, "20-dark-clean-dialog.png"),
    ("""
      (() => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        window.__eg.toastStore.getState().push({
          kind: 'info',
          message: '已丢弃 1 个路径的修改',
          action: { label: '撤销', onClick: () => {} },
          duration: 60000,
        });
      })()
    """, "17-dark-discard-toast.png"),
    ("""
      (() => {
        const toastStore = window.__eg.toastStore;
        toastStore.getState().dismiss(toastStore.getState().toasts[0].id);
        window.__eg.uiStore.getState().setSwitcherOpen(true);
      })()
    """, "13-dark-quick-switcher.png"),
    ("""
      (() => {
        window.__eg.uiStore.getState().setSwitcherOpen(false);
        document.querySelector('[data-testid="theme-light"]').click();
      })()
    """, "14-light-changes-zones.png"),
    (f"""
      (() => {{
        document.querySelector('[data-testid="theme-dark"]').click();
        window.__eg.repoStore.setState({{
          status: {{
            repoId: 'r1', branch: 'main', headOid: 'e1b2c3d4f5a6',
            conflicted: [], staged: [], unstaged: [],
          }},
          selectedChange: null,
        }});
      }})()
    """, "15-dark-changes-clean.png"),
    # ---- W4: commit box / command lens / settings ----
    (f"""
      (() => {{
        window.__eg.repoStore.setState({{
          status: {json.dumps(STATUS_R1)},
          selectedChange: null,
        }});
        const input = document.querySelector('[data-testid="commit-subject"]');
        const setter = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '接入暂存区与提交流程');
        input.dispatchEvent(new Event('input', {{ bubbles: true }}));
      }})()
    """, "21-dark-commit-box.png"),
    (f"""
      (() => {{
        const lens = window.__eg.lensStore.getState();
        lens.clear();
        lens.record('git add -- "src/app.ts"');
        lens.record('git restore --staged -- "src/dag.ts"');
        lens.record('git commit -m "接入暂存区与提交流程"');
        document.querySelector('[data-testid="command-lens"]').click();
      }})()
    """, "22-dark-lens-panel.png"),
    (f"""
      (() => {{
        window.__eg.lensStore.getState().clear();
        document.querySelector('[data-testid="command-lens"]').click();
        window.__eg.uiStore.getState().setView('settings');
      }})()
    """, "23-dark-settings.png"),
    (f"""
      (() => {{
        document.querySelector('[data-testid="theme-light"]').click();
      }})()
    """, "24-light-settings.png"),
    (f"""
      (() => {{
        document.querySelector('[data-testid="theme-dark"]').click();
        window.__eg.uiStore.getState().setView('changes');
      }})()
    """, "25-dark-back-to-changes.png"),
    # ---- W5: history DAG / commit detail ----
    (f"""
      (() => {{
        const now = Math.floor(Date.now() / 1000);
        const e = (i, subject, author, node, lines, laneCount, extra = {{}}) => ({{
          oid: 'c' + i.toString().padStart(3, '0') + 'abcdef',
          shortOid: 'c' + i.toString().padStart(3, '0') + 'ab',
          subject,
          body: '',
          authorName: author,
          authorEmail: 'dev@ex.com',
          authorTime: now - i * 900,
          parentCount: node.merge ? 2 : 1,
          isHead: false,
          refs: {{ branches: [], remotes: [], tags: [] }},
          node,
          lines,
          laneCount,
          ...extra,
        }});
        const trunk = (i, s, a, extra) => e(i, s, a, {{ lane: 0, color: 0, merge: false }},
          [{{ from: 0, to: 0, color: 0 }}], 1, extra);
        const side = (i, s, a, extra) => e(i, s, a, {{ lane: 1, color: 1, merge: false }},
          [{{ from: 1, to: 1, color: 1 }}, {{ from: 0, to: 0, color: 0 }}], 2, extra);
        const rows = [
          e(0, 'merge: 合并 feature/dag-render', '张三',
            {{ lane: 0, color: 0, merge: true }},
            [{{ from: 0, to: 0, color: 0 }}, {{ from: 0, to: 1, color: 1 }}], 2,
            {{ isHead: true, refs: {{ branches: ['main'], remotes: ['origin/main'], tags: [] }} }}),
          side(1, 'feat: DAG 分支着色与合并菱形', '李四',
            {{ refs: {{ branches: [], remotes: [], tags: [] }} }}),
          trunk(2, 'fix: 提交框 Ctrl+Enter 提交', '张三'),
          side(3, 'feat: 命令透视面板', '李四',
            {{ refs: {{ branches: [], remotes: [], tags: ['v0.9'] }} }}),
          e(4, 'chore: 初始化仓库基础', '张三',
            {{ lane: 0, color: 0, merge: false }}, [{{ from: 1, to: 0, color: 1 }}], 2),
        ];
        for (let i = 5; i < 35; i++) {{
          rows.push(trunk(i, ['docs: 补充快速开始指南', 'refactor: 抽出 lane 预计算',
            'test: 补充分页往返用例', 'style: 主题令牌微调'][i % 4], i % 2 ? '李四' : '张三'));
        }}
        window.__eg.historyStore.getState().seed({{
          entries: rows,
          branches: ['main', 'feature/dag-render'],
          branch: 'main',
          filter: {{ branch: null, author: null, message: null }},
        }});
        window.__eg.uiStore.getState().setView('history');
      }})()
    """, "26-dark-history.png"),
    (f"""
      (() => {{
        const hs = window.__eg.historyStore.getState();
        hs.seed({{
          selectedOid: hs.entries[0].oid,
          detailLoading: false,
          detail: {{
            oid: hs.entries[0].oid,
            shortOid: 'c000ab',
            subject: 'merge: 合并 feature/dag-render',
            body: 'DAG 渲染的 lane 预计算与合并菱形。',
            authorName: '张三',
            authorEmail: 'dev@ex.com',
            authorTime: Math.floor(Date.now() / 1000),
            refs: {{ branches: ['main'], remotes: ['origin/main'], tags: [] }},
            files: [
              {{ path: 'src/features/history/graph.ts', oldPath: null, kind: 'added', added: 96, deleted: 0 }},
              {{ path: 'src/features/history/HistoryPage.tsx', oldPath: null, kind: 'modified', added: 48, deleted: 12 }},
              {{ path: 'src/stores/historyStore.ts', oldPath: null, kind: 'modified', added: 31, deleted: 4 }},
            ],
          }},
        }});
      }})()
    """, "27-dark-history-detail.png"),
    (f"""
      (() => {{
        document.querySelector('[data-testid="theme-light"]').click();
      }})()
    """, "28-light-history.png"),
    # ---- W6: file diff / partial staging ----
    (f"""
      (() => {{
        const diffData = {{
          repoId: 'r1', path: 'src/features/history/graph.ts', oldPath: null,
          kind: 'modified', added: 4, deleted: 2, isBinary: false, truncated: false,
          hunks: [
            {{
              header: '@@ -12,7 +12,9 @@ export function laneX',
              oldStart: 12, newStart: 12,
              lines: [
                {{ kind: 'context', oldLineno: 12, newLineno: 12, content: 'export function laneX(lane: number): number {{', word: null }},
                {{ kind: 'deleted', oldLineno: 13, newLineno: null, content: '  return 12 + lane * LANE_W;', word: {{ start: 9, end: 11 }} }},
                {{ kind: 'added', oldLineno: null, newLineno: 13, content: '  const base = 9 + LANE_W / 2;', word: null }},
                {{ kind: 'added', oldLineno: null, newLineno: 14, content: '  return base + lane * LANE_W;', word: null }},
                {{ kind: 'context', oldLineno: 14, newLineno: 15, content: '}}', word: null }},
              ],
            }},
            {{
              header: '@@ -31,6 +33,8 @@ export function drawGraph',
              oldStart: 31, newStart: 33,
              lines: [
                {{ kind: 'context', oldLineno: 31, newLineno: 33, content: '  ctx.lineCap = round', word: null }},
                {{ kind: 'added', oldLineno: null, newLineno: 34, content: '  ctx.strokeStyle = colors[line.color % 8];', word: null }},
                {{ kind: 'deleted', oldLineno: 32, newLineno: null, content: '  ctx.lineWidth = 1.5;', word: null }},
                {{ kind: 'added', oldLineno: null, newLineno: 35, content: '  ctx.lineWidth = line.color === 0 ? 2.5 : 1.5;', word: null }},
              ],
            }},
          ],
        }};
        window.__eg.diffStore.getState().seed({{
          request: {{ path: 'src/features/history/graph.ts', oldPath: null, source: 'worktree', commitOid: null }},
          data: diffData, loading: false, error: null,
        }});
        const repo = window.__eg.repoStore.getState();
        repo.setSelectedChange(
          {{ path: 'src/features/history/graph.ts', oldPath: null, kind: 'modified' }}, 'worktree');
        window.__eg.uiStore.getState().setView('changes');
        document.querySelector('[data-testid="theme-dark"]').click();
      }})()
    """, "29-dark-diff-worktree.png"),
    (f"""
      (() => {{
        const ds = window.__eg.diffStore.getState();
        ds.seed({{
          request: {{ path: 'src/features/history/graph.ts', oldPath: null, source: 'index', commitOid: null }},
        }});
      }})()
    """, "30-dark-diff-staged.png"),
    (f"""
      (() => {{
        window.__eg.historyStore.getState().seed({{ detailFile: 'src/features/history/graph.ts' }});
        window.__eg.diffStore.getState().seed({{
          request: {{ path: 'src/features/history/graph.ts', oldPath: null, source: 'commit', commitOid: 'c000abcdef' }},
        }});
        window.__eg.uiStore.getState().setView('history');
      }})()
    """, "31-dark-commit-diff.png"),
]

class Snapper:
    def __init__(self, out_dir, base_url):
        self.out_dir = out_dir
        self.base_url = base_url
        self.state_index = -1
        self.win = Gtk.Window(title="EasyGit")
        self.win.set_default_size(WIDTH, HEIGHT)
        self.view = WebKit2.WebView()
        settings = self.view.get_settings()
        settings.set_enable_developer_extras(False)
        self.view.connect("load-changed", self.on_load_changed)
        self.win.add(self.view)
        self.win.show_all()
        self.win.present()
        self.view.load_uri(base_url)

    def on_load_changed(self, view, event):
        if event == WebKit2.LoadEvent.FINISHED:
            # Let fonts/first paint settle, then walk the state list.
            GLib.timeout_add(900, self.next_state)

    def run_js(self, js, on_done):
        if js is None:
            on_done()
            return

        def callback(view, result):
            view.run_javascript_finish(result)
            on_done()

        self.view.run_javascript(js, None, callback)

    def next_state(self):
        self.state_index += 1
        if self.state_index >= len(STATES):
            Gtk.main_quit()
            return GLib.SOURCE_REMOVE
        js, out_name = STATES[self.state_index]
        self.run_js(
            js,
            lambda name=out_name: GLib.timeout_add(
                450, lambda: (self.snapshot(name), GLib.SOURCE_REMOVE)[1]
            ),
        )
        return GLib.SOURCE_REMOVE

    def snapshot(self, out_name):
        if out_name is None:
            GLib.idle_add(self.next_state)
            return

        def on_snapshot(view, result):
            surface = view.get_snapshot_finish(result)
            path = f"{self.out_dir}/{out_name}"
            surface.write_to_png(path)
            print(f"saved {path}")
            GLib.idle_add(self.next_state)

        self.view.get_snapshot(
            WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, on_snapshot
        )


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "/tmp/eg-shots"
    base_url = sys.argv[2] if len(sys.argv) > 2 else "http://localhost:5173/"
    Snapper(out_dir, base_url)
    GLib.timeout_add(30000, Gtk.main_quit)  # hard cap, never hang CI
    Gtk.main()


if __name__ == "__main__":
    main()
