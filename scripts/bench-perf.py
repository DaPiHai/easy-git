"""X-01 performance benchmark on the mid-size fixture (5001 commits / 51 refs).

Measures on the real deb binary (AT-SPI driven):
  cold start (spawn -> window mapped), repo open (recents click -> main UI),
  history first screen (tab click -> commit rows), scroll burst latency,
  idle RSS, plus git CLI baselines for context.

Usage: python3 /tmp/bench-w10.py
"""
import os
import sqlite3
import subprocess
import sys
import time

os.environ['DISPLAY'] = ':0'
os.environ['GDK_BACKEND'] = 'x11'
os.environ['GTK_MODULES'] = 'atk-bridge'
if 'EG_BENCH_NOCOMP' in os.environ:
    os.environ['WEBKIT_DISABLE_COMPOSITING_MODE'] = '1'

import gi  # noqa: E402

gi.require_version('Atspi', '2.0')
from gi.repository import Atspi  # noqa: E402

FIXTURE = '/home/hhdlj/easy-git/.fixtures/mid-size'
RESULTS = {}


def sh(cmd, **kw):
    return subprocess.run(cmd, shell=True, capture_output=True, text=True, **kw)


def app():
    d = Atspi.get_desktop(0)
    for i in range(d.get_child_count()):
        a = d.get_child_at_index(i)
        if a.get_name() == 'easy-git':
            return a
    return None


def walk(obj):
    try:
        role = obj.get_role_name()
        name = obj.get_name() or ''
    except Exception:
        return
    yield obj, role, name
    try:
        n = obj.get_child_count()
    except Exception:
        n = 0
    for i in range(n):
        yield from walk(obj.get_child_at_index(i))


def find(text, role=None):
    a = app()
    return [] if a is None else [o for o, r, n in walk(a) if text in n and (role is None or r == role)]


def wait_for(text, role=None, timeout=30, poll=0.03):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if find(text, role):
            return True
        time.sleep(poll)
    return False


def click(text, role=None):
    hits = find(text, role)
    if not hits:
        print(f'FAIL not found: {text!r}')
        sys.exit(2)
    return hits[0].do_action(0)


def bench_cold_start():
    sh('pkill -x easy-git')
    time.sleep(1)
    t0 = time.monotonic()
    sh('nohup /usr/bin/easy-git >/tmp/eg-bench.log 2>&1 &')
    end = time.monotonic() + 60
    registered = None
    while time.monotonic() < end:
        if app() is not None and registered is None:
            registered = round(time.monotonic() - t0, 2)
        if find('新建仓库', 'button'):
            RESULTS['cold_start_registered_s'] = registered
            RESULTS['cold_start_usable_s'] = round(time.monotonic() - t0, 2)
            return
        time.sleep(0.03)
    print('FAIL cold start timeout')
    sys.exit(3)


def bench_open_repo():
    time.sleep(2)
    t0 = time.monotonic()
    if not click('mid-size'):
        sys.exit(2)
    ok = wait_for('获取', 'button', 60)
    RESULTS['repo_open_s'] = round(time.monotonic() - t0, 2) if ok else None
    if not ok:
        print('FAIL repo open timeout')
        sys.exit(3)


def bench_history():
    import re

    oid_re = re.compile(r'[0-9a-f]{7}\b')
    time.sleep(1)
    t0 = time.monotonic()
    click('历史')
    end = time.monotonic() + 30
    ok = False
    while time.monotonic() < end:
        rows = [n for _, r, n in walk(app()) if r == 'button' and oid_re.search(n)]
        if rows:
            ok = True
            break
        time.sleep(0.03)
    RESULTS['history_first_screen_s'] = round(time.monotonic() - t0, 2) if ok else None
    if not ok:
        print('FAIL history rows timeout')
        sys.exit(3)


def bench_scroll_burst():
    import re

    wid = sh("xdotool search --name 'EasyGit' | head -1").stdout.strip()
    if not wid:
        print('no window for scroll')
        return
    sh('xdotool windowactivate ' + wid)
    time.sleep(0.5)
    oid_re = re.compile(r'[0-9a-f]{7}\b')
    rows = [o for o, r, n in walk(app()) if r == 'button' and oid_re.search(n)]
    if not rows:
        print('no rows to hover')
        return
    ext = rows[0].get_extents(Atspi.CoordType.SCREEN)
    sh(f'xdotool mousemove {ext.x + ext.width // 2} {ext.y + ext.height // 2}')
    time.sleep(0.3)
    before = {n for _, r, n in walk(app()) if r == 'button' and oid_re.search(n)}
    t0 = time.monotonic()
    sh('xdotool click --repeat 25 --delay 30 5')  # 25 wheel-down ticks
    changed = False
    while time.monotonic() - t0 < 15:
        now = {n for _, r, n in walk(app()) if r == 'button' and oid_re.search(n)}
        if now and now != before:
            changed = True
            break
        time.sleep(0.05)
    RESULTS['scroll_burst_catchup_s'] = round(time.monotonic() - t0, 2) if changed else None


def bench_rss():
    time.sleep(5)
    out = sh("ps -o rss= -C easy-git,WebKitWebProcess,WebKitNetworkProcess").stdout.split()
    RESULTS['idle_rss_mb'] = round(sum(int(x) for x in out) / 1024, 1)


def git_baselines():
    for label, cmd in [
        ('git_status_porcelain_s', 'git -C ' + FIXTURE + ' status --porcelain'),
        ('git_log_500_s', 'git -C ' + FIXTURE + ' log --oneline -500'),
    ]:
        t0 = time.monotonic()
        sh(cmd)
        RESULTS[label] = round(time.monotonic() - t0, 3)


if __name__ == '__main__':
    git_baselines()
    bench_cold_start()
    bench_open_repo()
    bench_history()
    bench_scroll_burst()
    bench_rss()
    sh('pkill -x easy-git')
    deb = sh('ls -la /home/hhdlj/easy-git/src-tauri/target/release/bundle/deb/*.deb').stdout
    RESULTS['deb_mb'] = round(int(deb.split()[4]) / 1024 / 1024, 1)
    for k, v in RESULTS.items():
        print(f'{k}: {v}')
