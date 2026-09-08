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
        }});
      }})()
    """, "10-dark-changes-zones.png"),
    ("""
      (() => {
        const repoStore = window.__eg.repoStore;
        const s = repoStore.getState();
        repoStore.setState({
          selectedChange: s.status.unstaged[0],
          favorites: ['/home/hhdlj/easy-git'],
        });
      })()
    """, "11-dark-changes-selected.png"),
    ("""
      (() => {
        document.querySelector('[data-testid="detail-toggle"]').click();
        window.__eg.uiStore.getState().setView('history');
      })()
    """, "12-dark-history.png"),
    ("""
      (() => {
        window.__eg.uiStore.getState().setView('changes');
        window.__eg.uiStore.getState().setSwitcherOpen(true);
      })()
    """, "13-dark-quick-switcher.png"),
    ("""
      (() => {
        window.__eg.uiStore.getState().setSwitcherOpen(false);
        document.querySelector('[data-testid="theme-light"]').click();
      })()
    """, "14-light-changes-zones.png"),
    ("""
      (() => {
        const repoStore = window.__eg.repoStore;
        repoStore.setState({ status: null, selectedChange: null });
        document.querySelector('[data-testid="theme-dark"]').click();
      })()
    """, "15-dark-changes-clean.png"),
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
