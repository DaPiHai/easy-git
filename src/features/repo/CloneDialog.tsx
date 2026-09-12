import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { cloneRepo, pickDirectory } from '../../lib/ipc/commands';
import { reportError } from '../../lib/ipc/report';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import { useUiStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';

/**
 * 克隆仓库 dialog (R-22): url + 目标目录, progress rides the sync task strip.
 * Mounted once at the AppShell level so the sidebar entry works whether or
 * not a repository is already open.
 */
export function CloneDialog() {
  const open = useUiStore((s) => s.cloneDialogOpen);
  const setCloneDialogOpen = useUiStore((s) => s.setCloneDialogOpen);
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const progress = useSyncStore((s) => s.progress);

  const valid = url.trim().length > 0 && target.trim().length > 0 && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErrorText(null);
    try {
      const summary = await cloneRepo(url.trim(), target.trim());
      toast.success(t('wizard.clone.done', { name: summary.name }));
      setCloneDialogOpen(false);
      void useRepoStore.getState().openByPath(summary.path);
    } catch (error) {
      // 失败原因必须就地可见：右下角 toast 容易错过（rc.2 真人反馈），
      // reportError 同时带出可展开的原因与「查看日志」等建议动作。
      const humanized = reportError(error, 'clone');
      const lines = [humanized.detail];
      if (humanized.reason && humanized.reason !== humanized.detail) {
        lines.push(humanized.reason);
      }
      setErrorText(lines.filter(Boolean).join('\n'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={t('wizard.clone')}
      onClose={() => setCloneDialogOpen(false)}
      actions={
        <>
          <Button variant="secondary" onClick={() => setCloneDialogOpen(false)}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            data-testid="clone-confirm"
            onClick={() => void submit()}
          >
            {busy ? t('wizard.clone.running') : t('wizard.clone.confirm')}
          </Button>
        </>
      }
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t('wizard.clone.urlPlaceholder')}
        aria-label={t('wizard.clone.urlPlaceholder')}
        data-testid="clone-url-input"
        className="mb-2 h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <div className="flex gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t('wizard.clone.pathPlaceholder')}
          aria-label={t('wizard.clone.pathPlaceholder')}
          data-testid="clone-path-input"
          className="h-8 flex-1 rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
        />
        <Button
          variant="secondary"
          onClick={async () => {
            const dir = await pickDirectory(t('wizard.clone.pathPlaceholder'));
            if (dir) setTarget(dir);
          }}
        >
          …
        </Button>
      </div>
      {errorText ? (
        <p
          role="alert"
          data-testid="clone-error"
          className="mt-2 rounded-md border border-danger-border bg-danger-bg px-eg-2 py-1.5 text-caption whitespace-pre-wrap break-words text-danger"
        >
          {errorText}
        </p>
      ) : null}
      {busy && progress ? (
        <p className="mt-2 truncate text-caption text-ink-subtle" data-testid="clone-progress">
          {progress.message}
        </p>
      ) : null}
    </Dialog>
  );
}
