import { useState } from 'react';
import { ArrowDownToLine, ArrowUpToLine, CloudDownload } from 'lucide-react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
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
  const busy = useSyncStore((s) => s.busy);
  const status = useRepoStore((s) => s.status);
  const undoOperation = useRepoStore((s) => s.undoOperation);
  const [divergedOpen, setDivergedOpen] = useState(false);
  const [forceOpen, setForceOpen] = useState(false);

  const remote = remotes[0]?.name ?? 'origin';
  const branch = status?.branch ?? '';
  const enabled = hasActiveRepo && remotes.length > 0 && busy === null && branch.length > 0;

  const onPull = async () => {
    const result = await pull(remote, branch, 'ff_only');
    if (result === 'diverged') setDivergedOpen(true);
    if (result === 'ok') await refresh();
  };

  const onPush = async () => {
    const result = await push(remote, branch, false);
    // 'rejected' opens the 强推 dialog; 'auth' means the credential retry
    // also failed (toast already shown); 'cancelled' is a quiet dismiss.
    if (result === 'rejected') setForceOpen(true);
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
