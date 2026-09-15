import { useEffect, useState } from 'react';
import { GitCommitHorizontal, History } from 'lucide-react';
import { Button, Dialog, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import { formatRelativeTime } from '../../lib/time';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import { useIsSshActive } from '../../lib/useSshRepo';

const kindColors: Record<string, string> = {
  commit: 'bg-branch-1',
  merge: 'bg-branch-2',
  reset: 'bg-danger',
  discard: 'bg-danger',
  clean: 'bg-danger',
  ref_delete: 'bg-danger',
  force_push: 'bg-danger',
  fetch: 'bg-git-untracked',
  rebase: 'bg-danger',
  other: 'bg-ink-subtle',
};

/**
 * 操作时间线 (m1-plan F-28, UI §6.10): HEAD reflog + eg-safety operations in
 * one feed; dangerous entries carry the danger outline, hover offers 恢复到
 * 此状态 (snapshot-protected hard reset, R-25 引用快照树).
 */
export function TimelinePage() {
  const timeline = useSyncStore((s) => s.timeline);
  const refreshTimeline = useSyncStore((s) => s.refreshTimeline);
  const restoreTo = useSyncStore((s) => s.restoreTo);
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);
  const [restoreAt, setRestoreAt] = useState<{ oid: string; short: string } | null>(null);
  // Remote-host repos disable restore-to (hard reset without a snapshot net).
  const isSsh = useIsSshActive();

  useEffect(() => {
    if (hasActiveRepo) void refreshTimeline();
  }, [hasActiveRepo, refreshTimeline]);

  if (!hasActiveRepo || timeline.length === 0) {
    return (
      <div className="h-full">
        <EmptyState icon={History} title={t('timeline.empty')} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="timeline-view">
      <div className="mx-auto max-w-[860px] px-eg-5 py-eg-4">
        <h2 className="text-section font-semibold text-ink">{t('timeline.title')}</h2>
        <ol className="relative mt-eg-3">
          {timeline.map((entry, index) => (
            <li
              key={`${entry.time}-${entry.subject}-${index}`}
              className="group relative flex items-center gap-eg-3 py-eg-2 pl-1"
              data-testid="timeline-row"
            >
              {/* Left: relative time (UI §6.10). */}
              <span className="w-20 shrink-0 text-caption text-ink-subtle">
                {entry.time !== null ? formatRelativeTime(Math.round(entry.time)) : ''}
              </span>
              {/* Middle rail + node. */}
              <span className="relative flex w-4 shrink-0 items-center justify-center">
                {index < timeline.length - 1 ? (
                  <span className="absolute inset-y-0 w-px bg-hairline-strong" aria-hidden />
                ) : null}
                <span
                  className={`relative z-10 size-2 rounded-full ${
                    kindColors[entry.kind] ?? 'bg-ink-subtle'
                  } ${entry.danger ? 'ring-1 ring-danger ring-offset-1 ring-offset-canvas' : ''}`}
                  aria-hidden
                />
              </span>
              {/* Right: subject + hover action. */}
              <span className="flex min-w-0 flex-1 items-center gap-eg-2">
                <span className="truncate text-secondary text-ink" title={entry.subject}>
                  {entry.kind === 'commit' ? (
                    <GitCommitHorizontal
                      className="mr-1 inline size-3.5 text-ink-tertiary"
                      aria-hidden
                    />
                  ) : null}
                  {entry.subject}
                </span>
                {entry.oid && !isSsh ? (
                  <>
                    <span className="shrink-0 font-mono text-mono text-ink-tertiary">
                      {entry.oid.slice(0, 7)}
                    </span>
                    <button
                      type="button"
                      data-testid={`timeline-restore-${index}`}
                      onClick={() => {
                        const oid = entry.oid;
                        if (!oid) return;
                        setRestoreAt({ oid, short: oid.slice(0, 7) });
                      }}
                      className="hidden shrink-0 rounded-md border border-danger-border bg-danger-bg px-2.5 py-0.5 text-caption font-medium text-danger group-hover:block hover:bg-git-danger"
                    >
                      {t('timeline.restore')}
                    </button>
                  </>
                ) : null}
              </span>
            </li>
          ))}
        </ol>
      </div>

      <Dialog
        open={restoreAt !== null}
        title={t('timeline.restoreTitle', { short: restoreAt?.short ?? '' })}
        danger
        onClose={() => setRestoreAt(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setRestoreAt(null)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="timeline-restore-confirm"
              onClick={() => {
                const target = restoreAt;
                setRestoreAt(null);
                if (target) void restoreTo(target.oid);
              }}
            >
              {t('timeline.restoreConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('timeline.restoreDesc')}</p>
      </Dialog>
    </div>
  );
}
