import { CheckCircle2, FileDiff } from 'lucide-react';
import { Badge, EmptyState } from '../../components';
import { t, type MessageKey } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import type { ChangeEntry, StatusReport } from '../../lib/ipc/commands';
import { KIND_META, splitPath } from './kind';

function isClean(status: StatusReport): boolean {
  return (
    status.staged.length === 0 && status.unstaged.length === 0 && status.conflicted.length === 0
  );
}

/** Three-zone changes view (PRD §5.2, UI doc §7.1). W2 delivers the overview;
 * staging interactions and diff land in W3/W6. */
export function ChangesPage() {
  const status = useRepoStore((s) => s.status);
  const statusLoading = useRepoStore((s) => s.statusLoading);

  if (!status) {
    return (
      <div className="relative h-full" data-testid="changes-view">
        <EmptyState
          icon={FileDiff}
          title={t('changes.clean.title')}
          description={t('changes.clean.desc')}
        />
        {statusLoading ? <LoadingBar /> : null}
      </div>
    );
  }

  const zones: { key: MessageKey; entries: ChangeEntry[] }[] = [
    { key: 'changes.zone.conflicted', entries: status.conflicted },
    { key: 'changes.zone.staged', entries: status.staged },
    { key: 'changes.zone.unstaged', entries: status.unstaged },
  ];

  return (
    <div className="relative h-full overflow-y-auto" data-testid="changes-view">
      {statusLoading ? <LoadingBar /> : null}
      {isClean(status) ? (
        <EmptyState
          icon={CheckCircle2}
          title={t('changes.clean.title')}
          description={t('changes.clean.desc')}
        />
      ) : (
        <div className="mx-auto max-w-[1280px] px-eg-4 py-eg-3">
          {zones.map((zone) => (
            <Zone key={zone.key} title={t(zone.key)} entries={zone.entries} />
          ))}
        </div>
      )}
    </div>
  );
}

function LoadingBar() {
  return (
    <div
      className="absolute inset-x-0 top-0 h-0.5 overflow-hidden"
      role="progressbar"
      aria-label={t('changes.title')}
    >
      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
    </div>
  );
}

function Zone({ title, entries }: { title: string; entries: ChangeEntry[] }) {
  const danger = title === t('changes.zone.conflicted') && entries.length > 0;
  return (
    <section className="mb-eg-3" data-zone={title}>
      <div className="mb-1 flex items-center gap-eg-2 px-eg-1">
        <span className={`text-section font-semibold ${danger ? 'text-git-conflict' : 'text-ink'}`}>
          {title}
        </span>
        <Badge variant={danger ? 'conflict' : entries.length > 0 ? 'count' : 'neutral'}>
          {entries.length}
        </Badge>
      </div>
      {entries.length > 0 ? (
        <ul className="overflow-hidden rounded-lg border border-hairline">
          {entries.map((entry) => (
            <ChangeRow key={`${entry.kind}:${entry.path}`} entry={entry} />
          ))}
        </ul>
      ) : (
        <div className="rounded-lg border border-dashed border-hairline px-eg-3 py-eg-2 text-caption text-ink-tertiary">
          — 0
        </div>
      )}
    </section>
  );
}

function ChangeRow({ entry }: { entry: ChangeEntry }) {
  const selectedChange = useRepoStore((s) => s.selectedChange);
  const setSelectedChange = useRepoStore((s) => s.setSelectedChange);
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const selected = selectedChange?.path === entry.path && selectedChange?.kind === entry.kind;
  const { dir, file } = splitPath(entry.path);

  return (
    <li>
      <button
        type="button"
        onClick={() => setSelectedChange(selected ? null : entry)}
        aria-selected={selected}
        data-testid="change-row"
        className={`flex h-9 w-full items-center gap-eg-2 px-eg-3 text-left transition-colors duration-80 ease-eg ${
          selected ? 'bg-surface-2' : 'hover:bg-surface-1'
        }`}
      >
        <span
          className={`w-0.5 self-stretch ${selected ? 'bg-primary' : 'bg-transparent'}`}
          aria-hidden
        />
        <Icon className={`size-4 shrink-0 ${meta.iconClass}`} aria-hidden />
        <span className="truncate font-mono text-mono" title={entry.path}>
          {dir ? <span className="text-ink-subtle">{dir}</span> : null}
          <span className="text-ink">{file}</span>
        </span>
        {entry.oldPath ? (
          <span className="truncate font-mono text-caption text-ink-tertiary" title={entry.oldPath}>
            ← {entry.oldPath}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 pl-eg-2">
          <Badge variant={meta.badgeVariant}>{t(meta.labelKey)}</Badge>
        </span>
      </button>
    </li>
  );
}
