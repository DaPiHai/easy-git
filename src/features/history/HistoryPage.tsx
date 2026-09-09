import * as ContextMenu from '@radix-ui/react-context-menu';
import { GitBranch, GitCommitHorizontal, GitGraph, Search, Tag } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Dialog, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import { authorInitial, formatRelativeTime } from '../../lib/time';
import type { CommitLogEntry } from '../../lib/ipc/commands';
import { useHistoryStore } from '../../stores/historyStore';
import { useMergeStore } from '../../stores/mergeStore';
import { useRepoStore } from '../../stores/repoStore';
import { useRefStore } from '../../stores/refsStore';
import { toast } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { DAG_W, OVERSCAN_ROWS, ROW_H, branchColors, drawGraph } from './graph';

const menuItemContentClass =
  'z-50 min-w-44 rounded-lg border border-hairline bg-surface-3 p-1 shadow-[var(--eg-shadow-dialog)]';
const menuItemClass =
  'flex cursor-default select-none items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink';

/**
 * History view (m1-plan F-15/F-16/F-17/R-11): virtual-scrolled commit list
 * with a canvas DAG layer, filters, context-menu stubs and detail selection.
 */
export function HistoryPage() {
  const activeId = useRepoStore((s) => s.activeId);
  const isEmpty = useRepoStore((s) => (s.activeId ? s.repos[s.activeId]?.isEmpty : false));
  const loading = useHistoryStore((s) => s.loading);
  const error = useHistoryStore((s) => s.error);
  const load = useHistoryStore((s) => s.load);
  const filter = useHistoryStore((s) => s.filter);

  const filterKey = `${filter.branch ?? ''}|${filter.author ?? ''}|${filter.message ?? ''}`;
  useEffect(() => {
    void load();
  }, [activeId, filterKey, load]);

  if (isEmpty) {
    return (
      <EmptyState
        icon={GitCommitHorizontal}
        title={t('history.empty.title')}
        description={t('history.empty.desc')}
      />
    );
  }

  return (
    <div className="flex h-full flex-col" data-testid="history-view">
      <FilterBar />
      {error ? (
        <div className="px-eg-4 py-eg-2 text-caption text-danger" data-testid="history-error">
          {error.title}：{error.detail}
        </div>
      ) : null}
      <CommitList />
      {loading ? (
        <div className="h-0.5 overflow-hidden" role="progressbar" aria-label={t('history.title')}>
          <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
        </div>
      ) : null}
    </div>
  );
}

function FilterBar() {
  const branches = useHistoryStore((s) => s.branches);
  const branch = useHistoryStore((s) => s.filter.branch);
  const setFilter = useHistoryStore((s) => s.setFilter);
  const [author, setAuthor] = useState('');
  const [message, setMessage] = useState('');
  const timers = useRef<{ author?: number; message?: number }>({});

  // Debounced text filters (F-17); branch applies immediately.
  const debounce = (key: 'author' | 'message', value: string) => {
    window.clearTimeout(timers.current[key]);
    timers.current[key] = window.setTimeout(() => {
      const trimmed = value.trim();
      void setFilter(key === 'author' ? { author: trimmed || null } : { message: trimmed || null });
    }, 300);
  };

  return (
    <div
      className="flex shrink-0 items-center gap-eg-2 border-b border-hairline px-eg-4 py-eg-2"
      data-testid="history-filter-bar"
    >
      <label className="flex items-center gap-1.5 text-caption text-ink-subtle">
        <GitBranch className="size-3.5" aria-hidden />
        <select
          value={branch ?? ''}
          onChange={(e) => void setFilter({ branch: e.target.value || null })}
          aria-label={t('history.filter.branch')}
          data-testid="history-filter-branch"
          className="h-7 rounded-md border border-hairline-strong bg-surface-1 px-eg-2 text-caption text-ink outline-none"
        >
          <option value="">{t('history.filter.allBranches')}</option>
          {branches.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
      </label>
      <input
        onChange={(e) => {
          setAuthor(e.target.value);
          debounce('author', e.target.value);
        }}
        value={author}
        placeholder={t('history.filter.author')}
        aria-label={t('history.filter.author')}
        data-testid="history-filter-author"
        className="h-7 w-36 rounded-md border border-hairline-strong bg-surface-1 px-eg-2 text-caption text-ink outline-none placeholder:text-ink-tertiary"
      />
      <div className="relative">
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary"
          aria-hidden
        />
        <input
          onChange={(e) => {
            setMessage(e.target.value);
            debounce('message', e.target.value);
          }}
          value={message}
          placeholder={t('history.filter.search')}
          aria-label={t('history.filter.search')}
          data-testid="history-filter-search"
          className="h-7 w-52 rounded-md border border-hairline-strong bg-surface-1 pl-7 pr-eg-2 text-caption text-ink outline-none placeholder:text-ink-tertiary"
        />
      </div>
    </div>
  );
}

function CommitList() {
  const entries = useHistoryStore((s) => s.entries);
  const selectedOid = useHistoryStore((s) => s.selectedOid);
  const selectCommit = useHistoryStore((s) => s.selectCommit);
  const loadMore = useHistoryStore((s) => s.loadMore);
  const nextOffset = useHistoryStore((s) => s.nextOffset);
  const resolvedTheme = useUiStore((s) => s.resolvedTheme);

  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [viewportHeight, setViewportHeight] = useState(600);
  const [scrollTop, setScrollTop] = useState(0);
  const colors = useMemo(
    () => branchColors(),
    // resolvedTheme re-triggers palette resolution when the theme flips.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [resolvedTheme],
  );

  // 在此建分支 from the DAG context menu (R-11, live since W7).
  const [branchAt, setBranchAt] = useState<string | null>(null);
  const createBranch = useRefStore((s) => s.createBranch);
  const [branchName, setBranchName] = useState('');

  // F-25: 回滚 / 重置 from the DAG context menu (R-20).
  const revert = useMergeStore((s) => s.revert);
  const reset = useMergeStore((s) => s.reset);
  const undoOperation = useRepoStore((s) => s.undoOperation);
  const [hardResetAt, setHardResetAt] = useState<CommitLogEntry | null>(null);

  const onRevert = (oid: string) => {
    void revert([oid]);
  };
  const onResetMixed = (entry: CommitLogEntry) => {
    void reset('mixed', entry.oid).then((outcome) => {
      if (outcome) toast.success(t('history.reset.done', { short: entry.shortOid }));
    });
  };
  const onResetHard = (entry: CommitLogEntry) => {
    void reset('hard', entry.oid).then((outcome) => {
      if (!outcome) return;
      const { opId } = outcome;
      if (opId) {
        toast.info(t('history.reset.undoable', { short: entry.shortOid }), {
          label: t('toast.undo'),
          onClick: () => void undoOperation(opId),
        });
      } else {
        toast.success(t('history.reset.done', { short: entry.shortOid }));
      }
    });
  };

  // Virtual window: only rows near the viewport mount in the DOM.
  const first = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN_ROWS);
  const visibleCount = Math.ceil(viewportHeight / ROW_H) + OVERSCAN_ROWS * 2;
  const last = Math.min(entries.length, first + visibleCount);
  const visible = entries.slice(first, last);

  const redraw = useCallback(() => {
    const canvas = canvasRef.current;
    const container = containerRef.current;
    if (!canvas || !container) return;
    const dpr = window.devicePixelRatio || 1;
    const height = container.clientHeight;
    canvas.width = DAG_W * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawGraph(ctx, visible, first, scrollTop, height, colors);
  }, [visible, first, scrollTop, colors]);

  useEffect(() => {
    redraw();
  }, [redraw]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => setViewportHeight(container.clientHeight));
    observer.observe(container);
    setViewportHeight(container.clientHeight);
    return () => observer.disconnect();
  }, []);

  const onScroll = () => {
    const container = containerRef.current;
    if (!container) return;
    setScrollTop(container.scrollTop);
    // Scroll续读 (PRD §5.3): fetch the next page near the bottom.
    if (
      nextOffset !== null &&
      container.scrollTop + container.clientHeight >= container.scrollHeight - ROW_H * 30
    ) {
      void loadMore();
    }
  };

  if (entries.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <p className="text-caption text-ink-tertiary">{t('history.empty.title')}</p>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="relative min-h-0 flex-1 overflow-y-auto"
      data-testid="history-list"
    >
      <Dialog
        open={branchAt !== null}
        title={t('history.menu.branch')}
        onClose={() => setBranchAt(null)}
      >
        <input
          value={branchName}
          onChange={(e) => setBranchName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && branchName.trim()) {
              void createBranch(branchName.trim(), branchAt).then((ok) => {
                if (ok) {
                  setBranchAt(null);
                  setBranchName('');
                }
              });
            }
          }}
          placeholder={t('branch.namePlaceholder')}
          aria-label={t('branch.namePlaceholder')}
          data-testid="branch-at-input"
          autoFocus
          className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
        />
        <div className="mt-eg-4 flex justify-end gap-eg-2">
          <button
            type="button"
            onClick={() => setBranchAt(null)}
            className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            data-testid="branch-at-confirm"
            disabled={!branchName.trim()}
            onClick={() => {
              void createBranch(branchName.trim(), branchAt).then((ok) => {
                if (ok) {
                  setBranchAt(null);
                  setBranchName('');
                }
              });
            }}
            className="h-8 rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
          >
            {t('branch.create')}
          </button>
        </div>
      </Dialog>

      {/* 硬重置 confirmation (R-20, red + confirm + undoable snapshot). */}
      <Dialog
        open={hardResetAt !== null}
        title={t('history.reset.hardTitle', { short: hardResetAt?.shortOid ?? '' })}
        danger
        onClose={() => setHardResetAt(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setHardResetAt(null)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="reset-hard-confirm"
              onClick={() => {
                const entry = hardResetAt;
                setHardResetAt(null);
                if (entry) onResetHard(entry);
              }}
            >
              {t('history.reset.hardConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('history.reset.hardDesc')}</p>
      </Dialog>
      {/* Scroll-length spacer; sticky canvas + visible DOM rows render inside. */}
      <div style={{ height: entries.length * ROW_H }}>
        <canvas
          ref={canvasRef}
          aria-hidden
          style={{
            position: 'sticky',
            top: 0,
            width: DAG_W,
            height: viewportHeight,
            display: 'block',
            pointerEvents: 'none',
          }}
          data-testid="history-canvas"
        />
        {visible.map((entry, i) => (
          <CommitRow
            key={entry.oid}
            entry={entry}
            index={first + i}
            selected={entry.oid === selectedOid}
            onSelect={() => void selectCommit(entry.oid)}
            onBranchAt={() => setBranchAt(entry.oid)}
            onRevert={() => onRevert(entry.oid)}
            onResetMixed={() => onResetMixed(entry)}
            onResetHard={() => setHardResetAt(entry)}
          />
        ))}
      </div>
    </div>
  );
}

function RefPills({ entry }: { entry: CommitLogEntry }) {
  const pills: { label: string; kind: 'branch' | 'remote' | 'tag' }[] = [
    ...entry.refs.branches.map((b) => ({ label: b, kind: 'branch' as const })),
    ...entry.refs.remotes.map((r) => ({ label: r, kind: 'remote' as const })),
    ...entry.refs.tags.map((tag) => ({ label: tag, kind: 'tag' as const })),
  ];
  return (
    <span className="flex shrink-0 items-center gap-1">
      {pills.slice(0, 3).map(({ label, kind }) => (
        <span
          key={`${kind}:${label}`}
          className={`flex items-center gap-0.5 rounded-pill px-1.5 py-0.5 text-micro leading-none ${
            kind === 'branch' ? 'bg-primary text-on-primary' : 'bg-surface-3 text-ink-muted'
          }`}
          data-testid="ref-pill"
        >
          {kind === 'tag' ? <Tag className="size-2.5" aria-hidden /> : null}
          {label}
        </span>
      ))}
      {pills.length > 3 ? (
        <span className="text-micro text-ink-tertiary">+{pills.length - 3}</span>
      ) : null}
    </span>
  );
}

function CommitRow({
  entry,
  index,
  selected,
  onSelect,
  onBranchAt,
  onRevert,
  onResetMixed,
  onResetHard,
}: {
  entry: CommitLogEntry;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onBranchAt: () => void;
  onRevert: () => void;
  onResetMixed: () => void;
  onResetHard: () => void;
}) {
  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>
        <div
          role="button"
          tabIndex={0}
          data-testid="history-row"
          data-oid={entry.oid}
          onClick={onSelect}
          onKeyDown={(e) => {
            if (e.key === 'Enter') onSelect();
          }}
          aria-selected={selected}
          style={{ top: index * ROW_H, height: ROW_H }}
          className={`absolute inset-x-0 flex cursor-default items-center gap-eg-2 px-eg-3 transition-colors duration-80 ease-eg ${
            selected
              ? 'bg-surface-1 shadow-[inset_3px_0_0_var(--eg-primary)]'
              : 'hover:bg-surface-1'
          }`}
        >
          <span style={{ width: DAG_W }} className="shrink-0" aria-hidden />
          <span className="truncate text-body text-ink">{entry.subject}</span>
          <RefPills entry={entry} />
          <span className="ml-auto flex shrink-0 items-center gap-eg-2 text-caption text-ink-subtle">
            <span
              className="flex size-4 items-center justify-center rounded-full bg-surface-3 text-micro text-ink-muted"
              aria-hidden
            >
              {authorInitial(entry.authorName)}
            </span>
            <span className="w-16 text-right">{formatRelativeTime(entry.authorTime ?? 0)}</span>
            <span className="w-14 font-mono text-mono text-ink-tertiary">{entry.shortOid}</span>
          </span>
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuItemContentClass}>
          <ContextMenu.Item className={menuItemClass} onSelect={onSelect}>
            {t('history.menu.detail')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItemClass} onSelect={onBranchAt}>
            {t('history.menu.branch')}
          </ContextMenu.Item>
          <ContextMenu.Item className={menuItemClass} onSelect={onRevert}>
            {t('history.menu.revert')}
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-hairline" />
          <ContextMenu.Sub>
            <ContextMenu.SubTrigger className={menuItemClass}>
              {t('history.menu.resetTo')}
              <span className="ml-auto text-caption text-ink-tertiary">›</span>
            </ContextMenu.SubTrigger>
            <ContextMenu.Portal>
              <ContextMenu.SubContent className={menuItemContentClass}>
                <ContextMenu.Item className={menuItemClass} onSelect={onResetMixed}>
                  {t('history.reset.mixed')}
                </ContextMenu.Item>
                <ContextMenu.Item className={`${menuItemClass} text-danger`} onSelect={onResetHard}>
                  {t('history.reset.hard')}
                </ContextMenu.Item>
              </ContextMenu.SubContent>
            </ContextMenu.Portal>
          </ContextMenu.Sub>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Kept for the empty-repo case before any commit exists (W5 regression). */
export function HistoryEmptyState() {
  return (
    <EmptyState
      icon={GitGraph}
      title={t('history.empty.title')}
      description={t('history.empty.desc')}
    />
  );
}
