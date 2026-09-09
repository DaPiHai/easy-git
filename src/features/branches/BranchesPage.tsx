import * as ContextMenu from '@radix-ui/react-context-menu';
import {
  ArrowDownRight,
  ArrowUpRight,
  Check,
  GitBranch,
  GitMerge,
  Pencil,
  Plus,
  Trash2,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Button, Dialog, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import { authorInitial, formatRelativeTime } from '../../lib/time';
import type { BranchInfo } from '../../lib/ipc/commands';
import { useMergeStore } from '../../stores/mergeStore';
import { useRepoStore } from '../../stores/repoStore';
import { useRefStore } from '../../stores/refsStore';
import { useSyncStore } from '../../stores/syncStore';

const menuItemContentClass =
  'z-50 min-w-44 rounded-lg border border-hairline bg-surface-3 p-1 shadow-[var(--eg-shadow-dialog)]';
const menuItemClass =
  'flex cursor-default select-none items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink';

type BranchDialog =
  | { kind: 'create' }
  | { kind: 'rename'; name: string }
  | { kind: 'delete'; name: string }
  | { kind: 'dirty'; name: string }
  | { kind: 'merge'; name: string; current: string }
  | { kind: 'upstream'; name: string }
  | null;

/**
 * Branch board (m1-plan F-21): current-branch hero, branch list with
 * ahead/behind, quick switch and create/rename/delete with the recycle bin.
 */
export function BranchesPage() {
  const isEmpty = useRepoStore((s) => (s.activeId ? s.repos[s.activeId]?.isEmpty : false));
  const branches = useRefStore((s) => s.branches);
  const refresh = useRefStore((s) => s.refresh);
  const activeId = useRepoStore((s) => s.activeId);
  const [dialog, setDialog] = useState<BranchDialog>(null);

  useEffect(() => {
    void refresh();
  }, [activeId, refresh]);

  if (isEmpty) {
    return (
      <EmptyState
        icon={GitBranch}
        title={t('branches.empty.title')}
        description={t('branches.empty.desc')}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="branches-view">
      <div className="mx-auto max-w-[860px] px-eg-5 py-eg-4">
        <div className="flex items-center gap-eg-2">
          <h2 className="text-section font-semibold text-ink">{t('branches.list')}</h2>
          <Badge variant="count">{branches.length}</Badge>
          <button
            type="button"
            data-testid="branch-new"
            onClick={() => setDialog({ kind: 'create' })}
            className="ml-auto flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-caption font-medium text-on-primary hover:opacity-90"
          >
            <Plus className="size-3.5" aria-hidden />
            {t('branch.new')}
          </button>
        </div>
        <ul
          className="mt-eg-2 overflow-hidden rounded-lg border border-hairline"
          data-testid="branch-list"
        >
          {branches.map((branch) => (
            <BranchRow key={branch.name} branch={branch} onDialog={setDialog} />
          ))}
          {branches.length === 0 ? (
            <li className="px-eg-3 py-eg-3 text-caption text-ink-tertiary">
              {t('branches.onlyCurrent')}
            </li>
          ) : null}
        </ul>
      </div>

      <CreateBranchDialog open={dialog?.kind === 'create'} onClose={() => setDialog(null)} />
      {dialog?.kind === 'rename' ? (
        <RenameBranchDialog open name={dialog.name} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'delete' ? (
        <DeleteBranchDialog open name={dialog.name} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'dirty' ? (
        <StashSuggestionDialog open name={dialog.name} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'merge' ? (
        <MergeBranchDialog
          open
          name={dialog.name}
          current={dialog.current}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog?.kind === 'upstream' ? (
        <UpstreamDialog open name={dialog.name} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

function BranchRow({
  branch,
  onDialog,
}: {
  branch: BranchInfo;
  onDialog: (dialog: Exclude<BranchDialog, null | { kind: 'create' }>) => void;
}) {
  const switchBranch = useRefStore((s) => s.switchBranch);

  const trySwitch = () => {
    if (branch.isCurrent) return;
    void switchBranch(branch.name).then((result) => {
      if (result === 'dirty') onDialog({ kind: 'dirty', name: branch.name });
    });
  };

  return (
    <ContextMenu.Root modal={false}>
      <ContextMenu.Trigger asChild>
        <li>
          <div
            role="button"
            tabIndex={0}
            data-testid="branch-row"
            onClick={trySwitch}
            onKeyDown={(e) => {
              if (e.key === 'Enter') trySwitch();
            }}
            className="flex h-11 cursor-default items-center gap-eg-3 px-eg-3 transition-colors duration-80 ease-eg hover:bg-surface-1"
          >
            {branch.isCurrent ? (
              <Check className="size-4 shrink-0 text-primary" aria-hidden />
            ) : (
              <span
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-surface-2 text-micro text-ink-muted"
                aria-hidden
              >
                {authorInitial(branch.name)}
              </span>
            )}
            <span
              className={`min-w-0 truncate font-mono text-secondary ${
                branch.isCurrent ? 'font-semibold text-primary' : 'text-ink'
              }`}
            >
              {branch.name}
            </span>
            {branch.isCurrent ? <Badge variant="count">{t('branches.current')}</Badge> : null}
            {branch.upstream ? <Badge variant="neutral">{branch.upstream}</Badge> : null}
            {branch.ahead > 0 || branch.behind > 0 ? (
              <span className="flex items-center gap-1 font-mono text-caption text-ink-tertiary">
                {branch.ahead > 0 ? <ArrowUpRight className="size-3" aria-hidden /> : null}
                {branch.behind > 0 ? <ArrowDownRight className="size-3" aria-hidden /> : null}
              </span>
            ) : null}
            <span
              className="ml-auto truncate pl-eg-2 text-caption text-ink-tertiary"
              title={branch.tipSubject}
            >
              {branch.tipSubject}
            </span>
            <span className="shrink-0 text-caption text-ink-tertiary">
              {formatRelativeTime(branch.tipTime ?? 0)}
            </span>
          </div>
        </li>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className={menuItemContentClass}>
          {!branch.isCurrent ? (
            <ContextMenu.Item className={menuItemClass} onSelect={trySwitch}>
              <Check className="size-3.5" aria-hidden />
              {t('branch.switchTo')}
            </ContextMenu.Item>
          ) : null}
          {!branch.isCurrent ? (
            <ContextMenu.Item
              className={menuItemClass}
              onSelect={() =>
                onDialog({
                  kind: 'merge',
                  name: branch.name,
                  current:
                    useRepoStore.getState().repos[useRepoStore.getState().activeId ?? '']?.branch ??
                    '',
                })
              }
            >
              <GitMerge className="size-3.5" aria-hidden />
              {t('merge.menu')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onDialog({ kind: 'rename', name: branch.name })}
          >
            <Pencil className="size-3.5" aria-hidden />
            {t('branch.rename')}
          </ContextMenu.Item>
          {!branch.isCurrent ? (
            <ContextMenu.Item
              className={`${menuItemClass} text-danger data-[highlighted]:bg-danger-bg`}
              onSelect={() => onDialog({ kind: 'delete', name: branch.name })}
            >
              <Trash2 className="size-3.5" aria-hidden />
              {t('branch.delete')}
            </ContextMenu.Item>
          ) : null}
          <ContextMenu.Item
            className={menuItemClass}
            onSelect={() => onDialog({ kind: 'upstream', name: branch.name })}
          >
            <ArrowUpRight className="size-3.5" aria-hidden />
            {t('remotes.setUpstream')}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/**
 * 上游设置 (W7 顺延, m1-plan W9): pick a remote branch (origin/main style)
 * or clear the tracking relationship entirely.
 */
function UpstreamDialog({
  open,
  name,
  onClose,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
}) {
  const remoteBranches = useSyncStore((s) => s.remoteBranches);
  const setUpstream = useSyncStore((s) => s.setUpstream);
  const branches = useRefStore((s) => s.branches);
  const current = branches.find((b) => b.name === name);
  const [selection, setSelection] = useState('');

  const submit = async () => {
    const ok = await setUpstream(name, selection === '' ? null : selection || null);
    if (ok) onClose();
  };

  return (
    <Dialog
      open={open}
      title={t('remotes.setUpstream')}
      onClose={onClose}
      actions={
        <>
          {current?.upstream ? (
            <Button
              variant="secondary"
              data-testid="upstream-unset"
              onClick={() => void setUpstream(name, null).then((ok) => ok && onClose())}
            >
              {t('remotes.unsetUpstream')}
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button variant="primary" data-testid="upstream-confirm" onClick={() => void submit()}>
            {t('dialog.confirm')}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-caption text-ink-muted">
        {name} · {t('remotes.upstream')}：
        <span className="font-mono">{current?.upstream ?? t('remotes.none')}</span>
      </p>
      <select
        value={selection}
        onChange={(e) => setSelection(e.target.value)}
        data-testid="upstream-select"
        aria-label={t('remotes.upstreamPlaceholder')}
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none focus:border-primary"
      >
        <option value="">{t('remotes.upstreamPlaceholder')}</option>
        {remoteBranches.map((rb) => (
          <option key={rb} value={rb}>
            {rb}
          </option>
        ))}
      </select>
    </Dialog>
  );
}

/**
 * Merge dialog (F-26 简洁模式安全默认): fast-forward first; the no-ff merge
 * commit stays opt-in for users who want branch history preserved.
 */
function MergeBranchDialog({
  open,
  name,
  current,
  onClose,
}: {
  open: boolean;
  name: string;
  current: string;
  onClose: () => void;
}) {
  const startMerge = useMergeStore((s) => s.startMerge);
  const [noFf, setNoFf] = useState(false);

  const submit = () => {
    void startMerge(name, noFf).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <FormDialog
      open={open}
      title={t('merge.title')}
      confirmLabel={t('merge.menu')}
      confirmTestId="merge-confirm"
      onConfirm={submit}
      onClose={onClose}
    >
      <p className="text-caption text-ink-muted">{t('merge.desc', { name, current })}</p>
      <div className="mt-eg-3 flex flex-col gap-eg-2">
        <label className="flex items-start gap-eg-2 text-caption text-ink-muted">
          <input
            type="checkbox"
            data-testid="merge-no-ff"
            checked={noFf}
            onChange={(e) => setNoFf(e.target.checked)}
            className="mt-0.5 size-3.5 accent-[var(--eg-primary)]"
          />
          <span>
            <span className="font-medium text-ink">{t('merge.noFf')}</span>
            <span className="block">{t('merge.noFfDesc')}</span>
            <span className="mt-0.5 block text-ink-tertiary">{t('merge.autoFfDesc')}</span>
          </span>
        </label>
      </div>
    </FormDialog>
  );
}

function FormDialog({
  open,
  title,
  children,
  confirmLabel,
  onConfirm,
  onClose,
  danger = false,
  confirmTestId,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  danger?: boolean;
  confirmTestId: string;
}) {
  return (
    <Dialog open={open} title={title} onClose={onClose} danger={danger}>
      {children}
      <div className="mt-eg-4 flex justify-end gap-eg-2">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
        >
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          data-testid={confirmTestId}
          onClick={onConfirm}
          className={`h-8 rounded-md px-3.5 text-secondary font-medium text-on-primary hover:opacity-90 ${
            danger ? 'bg-danger' : 'bg-primary'
          }`}
        >
          {confirmLabel}
        </button>
      </div>
    </Dialog>
  );
}

function CreateBranchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const createBranch = useRefStore((s) => s.createBranch);
  const [name, setName] = useState('');
  const [switchTo, setSwitchTo] = useState(false);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void createBranch(trimmed, null).then((ok) => {
      if (!ok) return;
      onClose();
      setName('');
      if (switchTo) {
        void useRefStore.getState().switchBranch(trimmed);
      }
    });
  };

  return (
    <FormDialog
      open={open}
      title={t('branch.new')}
      confirmLabel={t('branch.create')}
      confirmTestId="branch-create-confirm"
      onConfirm={submit}
      onClose={onClose}
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') submit();
        }}
        placeholder={t('branch.namePlaceholder')}
        aria-label={t('branch.namePlaceholder')}
        data-testid="branch-name-input"
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <label className="mt-eg-2 flex items-center gap-eg-2 text-caption text-ink-muted">
        <input
          type="checkbox"
          checked={switchTo}
          onChange={(e) => setSwitchTo(e.target.checked)}
          data-testid="branch-create-switch"
          className="size-3.5 accent-[var(--eg-primary)]"
        />
        {t('branch.createAndSwitch')}
      </label>
    </FormDialog>
  );
}

function RenameBranchDialog({
  open,
  name,
  onClose,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
}) {
  const renameBranch = useRefStore((s) => s.renameBranch);
  const [newName, setNewName] = useState(name);

  const submit = () => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === name) return;
    void renameBranch(name, trimmed).then((ok) => {
      if (ok) onClose();
    });
  };

  return (
    <FormDialog
      open={open}
      title={t('branch.rename')}
      confirmLabel={t('branch.renameConfirm')}
      confirmTestId="branch-rename-confirm"
      onConfirm={submit}
      onClose={onClose}
    >
      <input
        value={newName}
        onChange={(e) => setNewName(e.target.value)}
        data-testid="branch-rename-input"
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 font-mono text-secondary text-ink outline-none focus:border-primary"
      />
    </FormDialog>
  );
}

function DeleteBranchDialog({
  open,
  name,
  onClose,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
}) {
  const deleteBranch = useRefStore((s) => s.deleteBranch);
  return (
    <FormDialog
      open={open}
      title={t('branch.deleteTitle', { name })}
      confirmLabel={t('branch.deleteConfirm')}
      confirmTestId="branch-delete-confirm"
      danger
      onConfirm={() => {
        void deleteBranch(name).then((ok) => {
          if (ok) onClose();
        });
      }}
      onClose={onClose}
    >
      <p className="text-secondary text-ink-muted">{t('branch.deleteDesc')}</p>
    </FormDialog>
  );
}

/** 切分支时主动建议储藏 (m1-plan F-22): a dirty worktree blocks the switch. */
function StashSuggestionDialog({
  open,
  name,
  onClose,
}: {
  open: boolean;
  name: string;
  onClose: () => void;
}) {
  const stashPush = useRefStore((s) => s.stashPush);
  const switchBranch = useRefStore((s) => s.switchBranch);

  const stashAndSwitch = () => {
    void stashPush(null, true).then((ok) => {
      if (!ok) return;
      void switchBranch(name).then(() => onClose());
    });
  };

  return (
    <FormDialog
      open={open}
      title={t('branch.dirtyTitle')}
      confirmLabel={t('branch.dirtyStashAndSwitch', { name })}
      confirmTestId="branch-stash-switch"
      onConfirm={stashAndSwitch}
      onClose={onClose}
    >
      <p className="text-secondary text-ink-muted">{t('branch.dirtyDesc')}</p>
    </FormDialog>
  );
}
