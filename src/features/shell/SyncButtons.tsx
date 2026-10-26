import { useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, CloudDownload, Layers } from 'lucide-react';
import { Button, Dialog, Select } from '../../components';
import { t } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import { useIsSshActive } from '../../lib/useSshRepo';
import { toast } from '../../stores/toastStore';

/**
 * F-27 同步按钮组 (m1-plan W9): 获取 / 拉取 / 推送 against the first remote.
 * 拉取 refuses divergence with a strategy dialog (合并, rebase later); 推送
 * falls back to the danger 强推 dialog (with 远端备份 rollback) when refused.
 */
export function SyncButtons({ hasActiveRepo }: { hasActiveRepo: boolean }) {
  const fetchRemote = useSyncStore((s) => s.fetch);
  const pull = useSyncStore((s) => s.pull);
  const push = useSyncStore((s) => s.push);
  const refresh = useSyncStore((s) => s.refresh);
  const remotes = useSyncStore((s) => s.remotes);
  const selectedRemote = useSyncStore((s) => s.selectedRemote);
  const setSelectedRemote = useSyncStore((s) => s.setSelectedRemote);
  const pushAll = useSyncStore((s) => s.pushAll);
  const busy = useSyncStore((s) => s.busy);
  const status = useRepoStore((s) => s.status);
  const undoOperation = useRepoStore((s) => s.undoOperation);
  const [divergedOpen, setDivergedOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);
  const [pushAllOpen, setPushAllOpen] = useState(false);
  // Remote-host repos disable force push by policy (no snapshot safety net).
  const isSsh = useIsSshActive();

  const remote = selectedRemote ?? remotes[0]?.name ?? 'origin';
  const branch = status?.branch ?? '';
  const enabled = hasActiveRepo && remotes.length > 0 && busy === null && branch.length > 0;

  const onPull = async () => {
    const result = await pull(remote, branch, 'ff_only');
    if (result === 'diverged') setDivergedOpen(true);
    if (result === 'ok') await refresh();
  };

  const onPush = async () => {
    const result = await push(remote, branch, false);
    // 'rejected' opens the 强推 dialog — except on SSH remotes, where force
    // push is disabled by policy (the backend refuses it outright).
    if (result === 'rejected' && !isSsh) setForceOpen(true);
  };

  const onForcePush = async () => {
    const result = await push(remote, branch, true);
    if (result === 'rejected') return; // still refused; keep the dialog open
    if (result === 'ok') {
      setForceOpen(false);
      // The rollback anchor was recorded server-side; surface it as undo.
      const state = useSyncStore.getState().undoRedo;
      if (state?.undoableOpId) {
        const opId = state.undoableOpId;
        toast.info(t('sync.forceDone'), {
          label: t('toast.undo'),
          onClick: () => void undoOperation(opId),
        });
      }
    }
  };

  return (
    <>
      {remotes.length > 0 ? (
        <Select
          value={remote}
          options={remotes.map((entry) => ({ value: entry.name, label: entry.name }))}
          onChange={setSelectedRemote}
          ariaLabel={t('sync.remote')}
          testId="sync-remote"
          size="sm"
          className="max-w-[120px]"
        />
      ) : null}
      <Button
        variant="tertiary"
        size="sm"
        disabled={!enabled || busy === 'fetch'}
        loading={busy === 'fetch'}
        data-testid="sync-fetch"
        onClick={() => void fetchRemote(remote)}
      >
        <CloudDownload className="size-4" aria-hidden />
        {t('sync.fetch')}
      </Button>
      <Button
        variant="tertiary"
        size="sm"
        disabled={!enabled || busy === 'pull'}
        loading={busy === 'pull'}
        data-testid="sync-pull"
        onClick={() => void onPull()}
      >
        <ArrowDownToLine className="size-4" aria-hidden />
        {t('sync.pull')}
      </Button>
      <Button
        variant="tertiary"
        size="sm"
        disabled={!enabled || busy === 'push'}
        loading={busy === 'push'}
        data-testid="sync-push"
        onClick={() => void onPush()}
      >
        <ArrowUpToLine className="size-4" aria-hidden />
        {t('sync.push')}
      </Button>
      {remotes.length > 1 ? (
        <Button
          variant="tertiary"
          size="sm"
          disabled={!enabled || busy !== null || branch.length === 0}
          title={t('sync.pushAll')}
          aria-label={t('sync.pushAll')}
          data-testid="sync-push-all"
          onClick={() => setPushAllOpen(true)}
        >
          <Layers className="size-4" aria-hidden />
        </Button>
      ) : null}

      {/* 远端全部推送确认：不包含强推，逐个执行并汇总结果。 */}
      <Dialog
        open={pushAllOpen}
        title={t('sync.pushAllTitle')}
        onClose={() => setPushAllOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setPushAllOpen(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy === 'push'}
              data-testid="push-all-confirm"
              onClick={() => {
                setPushAllOpen(false);
                void pushAll(branch);
              }}
            >
              {t('sync.pushAllConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('sync.pushAllDesc')}</p>
        <ul className="mt-2 rounded-md border border-hairline bg-surface-1 px-eg-3 py-2 font-mono text-caption text-ink-muted">
          {remotes.map((entry) => (
            <li key={entry.name}>
              {entry.name} → {branch}
            </li>
          ))}
        </ul>
      </Dialog>

      {/* 分叉情况选择 (F-27): rebase lands in M2, merge reuses the wizard. */}
      <Dialog
        open={divergedOpen}
        title={t('sync.divergedTitle')}
        onClose={() => setDivergedOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDivergedOpen(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={busy === 'pull'}
              data-testid="pull-merge-confirm"
              onClick={() => {
                setDivergedOpen(false);
                void pull(remote, branch, 'merge');
              }}
            >
              {t('sync.divergedMerge')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('sync.divergedDesc')}</p>
        <button
          type="button"
          disabled
          className="mt-2 flex w-full items-start gap-2 rounded-md border border-hairline bg-surface-1 p-2.5 text-left text-caption text-ink-tertiary opacity-60"
        >
          <span>
            <span className="font-medium">{t('sync.divergedRebase')}</span>
            <span className="block">{t('merge.noFfDesc')}</span>
          </span>
        </button>
      </Dialog>

      {/* 强推确认 (R-22): red + confirm + 远端备份可回滚. */}
      <Dialog
        open={forceOpen}
        title={t('sync.forceTitle')}
        danger
        onClose={() => setForceOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setForceOpen(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              loading={busy === 'push'}
              disabled={isSsh}
              title={isSsh ? t('remote.disabledOnSsh') : undefined}
              data-testid="push-force-confirm"
              onClick={() => void onForcePush()}
            >
              {t('sync.forceConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('sync.forceDesc')}</p>
      </Dialog>
    </>
  );
}
