import * as ContextMenu from '@radix-ui/react-context-menu';
import { CheckCircle2, ChevronRight, FileDiff, Search } from 'lucide-react';
import { create } from 'zustand';
import { useState } from 'react';
import { Badge, Checkbox, Dialog, EmptyState } from '../../components';
import { t, type MessageKey } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { toast } from '../../stores/toastStore';
import type { ChangeEntry, StageMode, StatusReport } from '../../lib/ipc/commands';
import { KIND_META, splitPath } from './kind';

function isClean(status: StatusReport): boolean {
  return (
    status.staged.length === 0 && status.unstaged.length === 0 && status.conflicted.length === 0
  );
}

/** Confirm-dialog targets, module-level so rows/zones can open them. */
interface ChangesDialogState {
  discardTargets: ChangeEntry[] | null;
  cleanTargets: string[] | null;
  openDiscard: (entries: ChangeEntry[]) => void;
  openClean: (paths: string[]) => void;
  closeAll: () => void;
}

export const useChangesDialogs = create<ChangesDialogState>()((set) => ({
  discardTargets: null,
  cleanTargets: null,
  openDiscard: (entries) => set({ discardTargets: entries }),
  openClean: (paths) => set({ cleanTargets: paths }),
  closeAll: () => set({ discardTargets: null, cleanTargets: null }),
}));

/**
 * Full three-zone changes view (m1-plan F-08/F-09): progress-metaphor header,
 * checkbox staging (勾选即暂存), batch zone actions, context menu with
 * snapshot-guarded discard / clean and .gitignore ignore, file filter.
 */
export function ChangesPage() {
  const status = useRepoStore((s) => s.status);
  const statusLoading = useRepoStore((s) => s.statusLoading);
  const summary = useRepoStore((s) => (s.activeId ? s.repos[s.activeId] : null));
  const discardTargets = useChangesDialogs((s) => s.discardTargets);
  const cleanTargets = useChangesDialogs((s) => s.cleanTargets);
  const closeDialogs = useChangesDialogs((s) => s.closeAll);
  const [filter, setFilter] = useState('');

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
  const query = filter.trim().toLowerCase();
  const matches = (entry: ChangeEntry) => query === '' || entry.path.toLowerCase().includes(query);

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
          {/* §7.1 进度条隐喻: 工作区 → 暂存区 → 本地 → 远程 */}
          <FlowStrip status={status} ahead={summary?.ahead ?? 0} behind={summary?.behind ?? 0} />

          <div className="relative mb-eg-2">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-ink-tertiary"
              aria-hidden
            />
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder={t('changes.filter.placeholder')}
              aria-label={t('changes.filter.placeholder')}
              data-testid="changes-filter"
              className="h-7 w-full rounded-md border border-hairline-strong bg-surface-1 pl-8 pr-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary"
            />
          </div>

          {zones.map((zone) => (
            <Zone
              key={zone.key}
              title={t(zone.key)}
              entries={zone.entries}
              visible={zone.entries.filter(matches)}
            />
          ))}
        </div>
      )}

      <Dialog
        open={discardTargets !== null}
        title={t('dialog.discard.title')}
        danger
        onClose={closeDialogs}
        actions={
          <>
            <DialogCancel onClose={closeDialogs} />
            <DiscardConfirm
              paths={(discardTargets ?? []).map((e) => e.path)}
              onDone={closeDialogs}
            />
          </>
        }
      >
        <p className="break-all">
          {t('dialog.discard.desc', {
            paths: (discardTargets ?? []).map((e) => e.path).join('、'),
          })}
        </p>
      </Dialog>

      <Dialog
        open={cleanTargets !== null}
        title={t('dialog.clean.title')}
        danger
        onClose={closeDialogs}
        actions={
          <>
            <DialogCancel onClose={closeDialogs} />
            <CleanConfirm paths={cleanTargets ?? []} onDone={closeDialogs} />
          </>
        }
      >
        <p>{t('dialog.clean.desc')}</p>
        <ul
          className="mt-eg-2 max-h-48 overflow-y-auto font-mono text-caption"
          data-testid="clean-list"
        >
          {(cleanTargets ?? []).map((path) => (
            <li key={path}>{path}</li>
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function FlowStrip({
  status,
  ahead,
  behind,
}: {
  status: StatusReport;
  ahead: number;
  behind: number;
}) {
  const steps = [
    {
      label: t('changes.flow.workspace'),
      badge: `${status.unstaged.length + status.conflicted.length}`,
      accent: false,
    },
    { label: t('changes.flow.staging'), badge: `${status.staged.length}`, accent: false },
    { label: t('changes.flow.local'), badge: `↑${ahead}`, accent: true },
    { label: t('changes.flow.remote'), badge: `↓${behind}`, accent: false },
  ];
  return (
    <div className="mb-eg-3 flex items-center gap-1.5 px-eg-1" data-testid="flow-strip">
      {steps.map((step, index) => (
        <span key={step.label} className="flex items-center gap-1.5">
          {index > 0 ? <ChevronRight className="size-3 text-ink-tertiary" aria-hidden /> : null}
          <span className="text-caption text-ink-subtle">{step.label}</span>
          <span
            className={`rounded-pill px-2 py-0.5 text-caption leading-none ${
              step.accent ? 'bg-primary text-on-primary' : 'bg-surface-2 text-ink-muted'
            }`}
          >
            {step.badge}
          </span>
        </span>
      ))}
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

function DialogCancel({ onClose }: { onClose: () => void }) {
  return (
    <button
      type="button"
      onClick={onClose}
      className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
    >
      {t('dialog.cancel')}
    </button>
  );
}

function DiscardConfirm({ paths, onDone }: { paths: string[]; onDone: () => void }) {
  const discardPaths = useRepoStore((s) => s.discardPaths);
  const undoOperation = useRepoStore((s) => s.undoOperation);
  return (
    <button
      type="button"
      data-testid="discard-confirm"
      className="h-8 rounded-md bg-danger px-3.5 text-secondary font-medium text-on-primary hover:opacity-90"
      onClick={() => {
        onDone();
        void discardPaths(paths).then((opId) => {
          if (opId) {
            toast.info(t('toast.discarded', { n: paths.length }), {
              label: t('toast.undo'),
              onClick: () => void undoOperation(opId),
            });
          }
        });
      }}
    >
      {t('dialog.discard.confirm')}
    </button>
  );
}

function CleanConfirm({ paths, onDone }: { paths: string[]; onDone: () => void }) {
  const cleanUntracked = useRepoStore((s) => s.cleanUntracked);
  const undoOperation = useRepoStore((s) => s.undoOperation);
  return (
    <button
      type="button"
      data-testid="clean-confirm"
      className="h-8 rounded-md bg-danger px-3.5 text-secondary font-medium text-on-primary hover:opacity-90"
      onClick={() => {
        onDone();
        void cleanUntracked(paths).then((opId) => {
          if (opId) {
            toast.info(t('toast.cleaned', { n: paths.length }), {
              label: t('toast.undo'),
              onClick: () => void undoOperation(opId),
            });
          }
        });
      }}
    >
      {t('dialog.clean.confirm')}
    </button>
  );
}

function Zone({
  title,
  entries,
  visible,
}: {
  title: string;
  entries: ChangeEntry[];
  visible: ChangeEntry[];
}) {
  const stagePaths = useRepoStore((s) => s.stagePaths);
  const previewClean = useRepoStore((s) => s.previewClean);
  const openClean = useChangesDialogs((s) => s.openClean);

  if (entries.length === 0) {
    return (
      <section className="mb-eg-3" data-zone={title}>
        <div className="mb-1 flex items-center gap-eg-2 px-eg-1">
          <span className="text-section font-semibold text-ink">{title}</span>
          <Badge variant="neutral">0</Badge>
        </div>
        <div className="rounded-lg border border-dashed border-hairline px-eg-3 py-eg-2 text-caption text-ink-tertiary">
          — 0
        </div>
      </section>
    );
  }

  const conflictedZone = title === t('changes.zone.conflicted');
  const stagedZone = title === t('changes.zone.staged');
  const hasUntracked = entries.some((e) => e.kind === 'untracked');

  const toggleAll = () => {
    const paths = entries.map((e) => e.path);
    const mode: StageMode = stagedZone ? 'unstage' : 'stage';
    void stagePaths(paths, mode).then(() => {
      toast.success(t(stagedZone ? 'toast.unstaged' : 'toast.staged', { n: paths.length }));
    });
  };

  return (
    <section className="mb-eg-3" data-zone={title}>
      <div className="mb-1 flex items-center gap-eg-2 px-eg-1">
        <Checkbox
          checked={stagedZone}
          onChange={toggleAll}
          ariaLabel={`${title} 全选`}
          testId={`zone-check-${stagedZone ? 'staged' : 'unstaged'}`}
        />
        <span
          className={`text-section font-semibold ${conflictedZone ? 'text-git-conflict' : 'text-ink'}`}
        >
          {title}
        </span>
        <Badge variant={conflictedZone ? 'conflict' : 'count'}>{entries.length}</Badge>
        {hasUntracked ? (
          <button
            type="button"
            data-testid="zone-clean"
            className="ml-auto rounded-md px-2 py-0.5 text-caption text-ink-subtle hover:bg-surface-2 hover:text-ink"
            onClick={() => {
              void previewClean().then((paths) => {
                openClean(paths);
              });
            }}
          >
            {t('menu.clean')}
          </button>
        ) : null}
      </div>
      {visible.length > 0 ? (
        <ul className="overflow-hidden rounded-lg border border-hairline">
          {visible.map((entry) => (
            <ChangeRow
              key={`${entry.kind}:${entry.path}`}
              entry={entry}
              checked={stagedZone}
              conflictedZone={conflictedZone}
            />
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

const menuItemContentClass =
  'z-50 min-w-44 rounded-lg border border-hairline bg-surface-3 p-1 shadow-[var(--eg-shadow-dialog)]';
const menuItemClass =
  'flex cursor-default select-none items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink';

function ChangeRow({
  entry,
  checked,
  conflictedZone,
}: {
  entry: ChangeEntry;
  checked: boolean;
  conflictedZone: boolean;
}) {
  const selectedChange = useRepoStore((s) => s.selectedChange);
  const setSelectedChange = useRepoStore((s) => s.setSelectedChange);
  const stagePaths = useRepoStore((s) => s.stagePaths);
  const ignorePaths = useRepoStore((s) => s.ignorePaths);
  const openDiscard = useChangesDialogs((s) => s.openDiscard);
  const openClean = useChangesDialogs((s) => s.openClean);
  const meta = KIND_META[entry.kind];
  const Icon = meta.icon;
  const selected = selectedChange?.path === entry.path && selectedChange?.kind === entry.kind;
  const { dir, file } = splitPath(entry.path);

  const toggleStage = () => {
    const mode: StageMode = checked ? 'unstage' : 'stage';
    void stagePaths([entry.path], mode).then(() =>
      toast.success(t(checked ? 'toast.unstaged' : 'toast.staged', { n: 1 })),
    );
  };

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>
        <li>
          <div
            role="button"
            tabIndex={0}
            onClick={() => setSelectedChange(selected ? null : entry)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setSelectedChange(selected ? null : entry);
            }}
            aria-selected={selected}
            data-testid="change-row"
            className={`flex h-9 w-full cursor-default items-center gap-eg-2 px-eg-3 text-left transition-colors duration-80 ease-eg ${
              selected ? 'bg-surface-2' : 'hover:bg-surface-1'
            }`}
          >
            {!conflictedZone ? (
              <Checkbox
                checked={checked}
                onChange={toggleStage}
                ariaLabel={`${checked ? t('menu.unstage') : t('menu.stage')} ${entry.path}`}
                testId="row-check"
              />
            ) : (
              <span className="size-4 shrink-0" aria-hidden />
            )}
            <Icon className={`size-4 shrink-0 ${meta.iconClass}`} aria-hidden />
            <span className="truncate font-mono text-mono" title={entry.path}>
              {dir ? <span className="text-ink-subtle">{dir}</span> : null}
              <span className="text-ink">{file}</span>
            </span>
            {entry.oldPath ? (
              <span
                className="truncate font-mono text-caption text-ink-tertiary"
                title={entry.oldPath}
              >
                ← {entry.oldPath}
              </span>
            ) : null}
            <span className="ml-auto shrink-0 pl-eg-2">
              <Badge variant={meta.badgeVariant}>{t(meta.labelKey)}</Badge>
            </span>
          </div>
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuItemContentClass}>
          {!conflictedZone ? (
            <ContextMenu.Item className={menuItemClass} onSelect={toggleStage}>
              {checked ? t('menu.unstage') : t('menu.stage')}
            </ContextMenu.Item>
          ) : null}
          {!conflictedZone ? (
            <ContextMenu.Item
              className={`${menuItemClass} text-danger data-[highlighted]:bg-danger-bg`}
              onSelect={() => openDiscard([entry])}
            >
              {t('menu.discard')}
            </ContextMenu.Item>
          ) : null}
          {entry.kind === 'untracked' ? (
            <>
              <ContextMenu.Item
                className={`${menuItemClass} text-danger data-[highlighted]:bg-danger-bg`}
                onSelect={() => openClean([entry.path])}
              >
                {t('menu.clean')}
              </ContextMenu.Item>
              <ContextMenu.Sub>
                <ContextMenu.SubTrigger className={menuItemClass}>
                  {t('menu.ignore')}
                  <ChevronRight className="ml-auto size-3.5 text-ink-tertiary" aria-hidden />
                </ContextMenu.SubTrigger>
                <ContextMenu.Portal>
                  <ContextMenu.SubContent className={menuItemContentClass}>
                    <ContextMenu.Item
                      className={menuItemClass}
                      onSelect={() => {
                        void ignorePaths([entry.path], 'by_path').then(() =>
                          toast.success(t('toast.ignored')),
                        );
                      }}
                    >
                      {t('menu.ignore.byPath')}
                    </ContextMenu.Item>
                    <ContextMenu.Item
                      className={menuItemClass}
                      onSelect={() => {
                        void ignorePaths([entry.path], 'by_extension').then(() =>
                          toast.success(t('toast.ignored')),
                        );
                      }}
                    >
                      {t('menu.ignore.byExtension')}
                    </ContextMenu.Item>
                  </ContextMenu.SubContent>
                </ContextMenu.Portal>
              </ContextMenu.Sub>
            </>
          ) : null}
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
