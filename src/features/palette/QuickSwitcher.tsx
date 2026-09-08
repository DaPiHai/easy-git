import { FolderGit2, Search } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';

/**
 * Ctrl/Cmd+K quick repo switcher (m1-plan F-05 雏形, UI doc §6.9 geometry):
 * 640px panel, surface-3, borderless 44px search, grouped results.
 * The panel remounts on every open, so its state resets naturally.
 */
export function QuickSwitcher() {
  const open = useUiStore((s) => s.switcherOpen);
  if (!open) return null;
  return <SwitcherPanel />;
}

function SwitcherPanel() {
  const setOpen = useUiStore((s) => s.setSwitcherOpen);
  const repos = useRepoStore((s) => s.repos);
  const recents = useRepoStore((s) => s.recents);
  const openByPath = useRepoStore((s) => s.openByPath);
  const activate = useRepoStore((s) => s.activate);
  const pickAndOpen = useRepoStore((s) => s.pickAndOpen);

  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const items = useMemo(() => {
    const q = query.trim().toLowerCase();
    const seen = new Set<string>();
    const merged: { key: string; label: string; path: string; repoId?: string }[] = [];
    for (const repo of Object.values(repos)) {
      seen.add(repo.path);
      merged.push({ key: repo.repoId, label: repo.name, path: repo.path, repoId: repo.repoId });
    }
    for (const recent of recents) {
      if (!seen.has(recent.path))
        merged.push({ key: recent.path, label: recent.name, path: recent.path });
    }
    const filtered = q
      ? merged.filter((m) => `${m.label} ${m.path}`.toLowerCase().includes(q))
      : merged;
    return filtered.slice(0, 8);
  }, [repos, recents, query]);

  const choose = (index: number) => {
    const item = items[index];
    if (!item) return;
    setOpen(false);
    if (item.repoId) void activate(item.repoId);
    else void openByPath(item.path);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center pt-24"
      style={{ background: 'var(--eg-overlay)' }}
      onMouseDown={() => setOpen(false)}
      data-testid="quick-switcher"
    >
      <div
        className="w-full max-w-[640px] overflow-hidden rounded-xl border border-hairline-strong bg-surface-3 shadow-[var(--eg-shadow-dialog)]"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t('switcher.title')}
      >
        <div className="flex h-11 items-center gap-eg-3 border-b border-hairline px-eg-4">
          <Search className="size-4 text-ink-tertiary" aria-hidden />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setCursor(0);
            }}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setCursor((c) => Math.min(c + 1, items.length - 1));
              } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                setCursor((c) => Math.max(c - 1, 0));
              } else if (e.key === 'Enter') {
                e.preventDefault();
                choose(cursor);
              } else if (e.key === 'Escape') {
                setOpen(false);
              }
            }}
            placeholder={t('switcher.placeholder')}
            className="h-full flex-1 bg-transparent text-body text-ink outline-none placeholder:text-ink-tertiary"
            aria-label={t('switcher.title')}
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-1">
          {items.map((item, index) => (
            <li key={item.key}>
              <button
                type="button"
                onMouseEnter={() => setCursor(index)}
                onClick={() => choose(index)}
                className={`flex w-full items-center gap-eg-2 rounded-md px-eg-3 py-eg-2 text-left text-secondary ${
                  index === cursor ? 'bg-surface-2 text-ink' : 'text-ink-muted'
                }`}
              >
                <FolderGit2 className="size-4 text-ink-tertiary" aria-hidden />
                <span className="text-ink">{item.label}</span>
                <span className="truncate font-mono text-caption text-ink-tertiary">
                  {item.path}
                </span>
              </button>
            </li>
          ))}
          {items.length === 0 ? (
            <li className="px-eg-3 py-eg-2 text-secondary text-ink-tertiary">
              {t('switcher.empty')}
            </li>
          ) : null}
        </ul>
        <div className="flex items-center gap-eg-4 border-t border-hairline px-eg-3 py-1.5 text-micro text-ink-tertiary">
          <span>↵ 打开</span>
          <span>↑↓ 选择</span>
          <span>esc 关闭</span>
          <button
            type="button"
            className="ml-auto text-ink-subtle hover:text-ink"
            onClick={() => {
              setOpen(false);
              void pickAndOpen();
            }}
          >
            {t('switcher.open')}
          </button>
        </div>
      </div>
    </div>
  );
}
