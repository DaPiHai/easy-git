import { FileMinus, FilePlus } from 'lucide-react';
import { useMemo, useState } from 'react';
import { t } from '../../lib/i18n';
import type { DiffLine } from '../../lib/ipc/commands';
import { KIND_META } from '../changes/kind';
import { useDiffStore } from '../../stores/diffStore';

const FOLD_THRESHOLD = 600;
const FOLD_VISIBLE = 300;

/**
 * Unified diff view (m1-plan F-18): line numbers, add/delete tints, word-level
 * highlight, per-hunk action bar and whole-line folding for huge files.
 * Interactive mode (changes view) offers line-selection partial staging (F-19);
 * commit diffs are read-only.
 */
export function DiffView({ interactive = false }: { interactive?: boolean }) {
  const data = useDiffStore((s) => s.data);
  const request = useDiffStore((s) => s.request);
  const loading = useDiffStore((s) => s.loading);
  const error = useDiffStore((s) => s.error);
  const applySelection = useDiffStore((s) => s.applySelection);
  const [selection, setSelection] = useState<Map<number, Set<number>>>(new Map());
  const [expanded, setExpanded] = useState(false);

  const totalLines = useMemo(
    () => data?.hunks.reduce((sum, h) => sum + h.lines.length, 0) ?? 0,
    [data],
  );
  const selectedCount = useMemo(
    () => [...selection.values()].reduce((sum, set) => sum + set.size, 0),
    [selection],
  );
  const source = request?.source ?? 'worktree';

  if (loading && !data) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center" data-testid="diff-loading">
        <span className="text-caption text-ink-tertiary">{t('diff.loading')}</span>
      </div>
    );
  }
  if (error) {
    return (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1 px-eg-5 text-center"
        data-testid="diff-error"
      >
        <p className="text-secondary text-ink-muted">{error.title}</p>
        <p className="text-caption text-ink-tertiary">{error.detail}</p>
      </div>
    );
  }
  if (!data) return null;

  const meta = KIND_META[data.kind];
  const Icon = data.kind === 'added' ? FilePlus : data.kind === 'deleted' ? FileMinus : meta.icon;

  const toggleRow = (hunkIndex: number, lineIndex: number) => {
    setSelection((prev) => {
      const next = new Map(prev);
      const rows = new Set(next.get(hunkIndex) ?? []);
      if (rows.has(lineIndex)) {
        rows.delete(lineIndex);
      } else {
        rows.add(lineIndex);
      }
      if (rows.size === 0) {
        next.delete(hunkIndex);
      } else {
        next.set(hunkIndex, rows);
      }
      return next;
    });
  };

  const stageHunk = (hunkIndex: number) => {
    const rows = data.hunks[hunkIndex].lines
      .map((l, i) => (l.kind !== 'context' ? i : -1))
      .filter((i) => i >= 0);
    void applySelection([{ hunkIndex, lineIndexes: rows }]).then((ok) => {
      if (ok) setSelection(new Map());
    });
  };

  const applySelected = () => {
    const hunks = [...selection.entries()].map(([hunkIndex, rows]) => ({
      hunkIndex,
      lineIndexes: [...rows],
    }));
    void applySelection(hunks).then((ok) => {
      if (ok) setSelection(new Map());
    });
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-eg-3 py-eg-2"
      data-testid="diff-view"
    >
      <div className="flex items-center gap-eg-2">
        <Icon className={`size-4 shrink-0 ${meta.iconClass}`} aria-hidden />
        <span className="truncate font-mono text-mono text-ink" title={data.path}>
          {data.oldPath ? <span className="text-ink-subtle">{data.oldPath} → </span> : null}
          {data.path}
        </span>
        <span className="ml-auto shrink-0 font-mono text-caption text-ink-tertiary">
          <span className="text-git-added">+{data.added}</span>{' '}
          <span className="text-git-deleted">−{data.deleted}</span>
        </span>
      </div>

      {data.isBinary ? (
        <p className="mt-eg-4 text-caption text-ink-tertiary" data-testid="diff-binary">
          {t('diff.binary')}
        </p>
      ) : data.hunks.length === 0 ? (
        <p className="mt-eg-4 text-caption text-ink-tertiary" data-testid="diff-empty">
          {t('diff.empty')}
        </p>
      ) : (
        <>
          {data.truncated ? (
            <p className="mt-eg-2 text-caption text-ink-tertiary" data-testid="diff-truncated">
              {t('diff.truncated')}
            </p>
          ) : null}
          <div className="mt-eg-2 overflow-x-auto overflow-y-hidden rounded-lg border border-hairline">
            {data.hunks.map((hunk, hunkIndex) => {
              const folded = !expanded && totalLines > FOLD_THRESHOLD;
              const visible =
                folded && hunkIndex > 0
                  ? []
                  : folded
                    ? hunk.lines.slice(0, FOLD_VISIBLE)
                    : hunk.lines;
              return (
                <div key={hunkIndex} data-testid="diff-hunk">
                  <div className="flex h-7 items-center gap-eg-2 border-y border-hairline bg-surface-2 px-eg-2">
                    <span className="truncate font-mono text-micro text-ink-tertiary">
                      {hunk.header}
                    </span>
                    {interactive ? (
                      <button
                        type="button"
                        data-testid={`diff-hunk-action-${hunkIndex}`}
                        className="ml-auto shrink-0 rounded-md px-2 py-0.5 text-caption text-primary hover:bg-surface-3"
                        onClick={() => stageHunk(hunkIndex)}
                      >
                        {t(source === 'worktree' ? 'diff.stageHunk' : 'diff.unstageHunk')}
                      </button>
                    ) : null}
                  </div>
                  {visible.map((line, lineIndex) => (
                    <DiffRow
                      key={lineIndex}
                      line={line}
                      hunkIndex={hunkIndex}
                      lineIndex={lineIndex}
                      interactive={interactive}
                      selected={selection.get(hunkIndex)?.has(lineIndex) ?? false}
                      onToggle={() => toggleRow(hunkIndex, lineIndex)}
                    />
                  ))}
                </div>
              );
            })}
          </div>
          {!expanded && totalLines > FOLD_THRESHOLD ? (
            <button
              type="button"
              data-testid="diff-expand"
              className="mx-auto mt-eg-2 block rounded-md border border-hairline bg-surface-1 px-3 py-1 text-caption text-ink-muted hover:bg-surface-2"
              onClick={() => setExpanded(true)}
            >
              {t('diff.expand')}
            </button>
          ) : null}
          {interactive && selectedCount > 0 ? (
            <button
              type="button"
              data-testid="diff-apply-selection"
              className="sticky bottom-2 mt-eg-3 flex h-8 items-center justify-center self-end rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary shadow-[var(--eg-shadow-dialog)] transition-opacity duration-80 ease-eg hover:opacity-90"
              onClick={applySelected}
            >
              {t(source === 'worktree' ? 'diff.stageSelected' : 'diff.unstageSelected', {
                n: selectedCount,
              })}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function DiffRow({
  line,
  hunkIndex,
  lineIndex,
  interactive,
  selected,
  onToggle,
}: {
  line: DiffLine;
  hunkIndex: number;
  lineIndex: number;
  interactive: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const selectable = interactive && line.kind !== 'context';
  const bg =
    line.kind === 'added'
      ? 'bg-diff-added-bg'
      : line.kind === 'deleted'
        ? 'bg-diff-deleted-bg'
        : '';
  const wordBg = line.kind === 'added' ? 'bg-diff-word-added-bg' : 'bg-diff-word-deleted-bg';
  const sign = line.kind === 'added' ? '+' : line.kind === 'deleted' ? '-' : ' ';

  return (
    <div
      className={`flex min-w-0 items-stretch font-mono text-mono ${bg} ${
        selected ? 'ring-1 ring-inset ring-primary' : ''
      }`}
      data-testid={`diff-row-${hunkIndex}-${lineIndex}`}
      data-kind={line.kind}
    >
      {selectable ? (
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`${t('diff.selectLine')} ${line.content}`}
          data-testid={`diff-line-check-${hunkIndex}-${lineIndex}`}
          className="mx-1.5 size-3 shrink-0 self-center accent-[var(--eg-primary)]"
        />
      ) : (
        <span className="w-6 shrink-0" aria-hidden />
      )}
      <span className="w-10 shrink-0 select-none border-r border-hairline px-1 text-right text-ink-tertiary">
        {line.oldLineno ?? ''}
      </span>
      <span className="w-10 shrink-0 select-none border-r border-hairline px-1 text-right text-ink-tertiary">
        {line.newLineno ?? ''}
      </span>
      <span className="select-none px-1 text-ink-tertiary">{sign}</span>
      <code className="min-w-0 flex-1 whitespace-pre pr-2 text-ink">
        {line.word ? (
          <>
            {line.content.slice(0, line.word.start)}
            <mark className={`${wordBg} text-inherit`}>
              {line.content.slice(line.word.start, line.word.end)}
            </mark>
            {line.content.slice(line.word.end)}
          </>
        ) : (
          line.content
        )}
      </code>
    </div>
  );
}
