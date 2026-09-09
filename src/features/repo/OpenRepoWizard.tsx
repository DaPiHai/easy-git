import { FolderGit2, FolderOpen, FolderPlus } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { cloneRepo, pickDirectory } from '../../lib/ipc/commands';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import { toast } from '../../stores/toastStore';

/**
 * First-run wizard (m1-plan F-06, PRD §6.1 首页三入口): open / init / clone.
 * Clone runs the real `git clone --progress` with the sync task strip (R-22).
 */
export function OpenRepoWizard() {
  const pickAndOpen = useRepoStore((s) => s.pickAndOpen);
  const pickAndInit = useRepoStore((s) => s.pickAndInit);
  const openByPath = useRepoStore((s) => s.openByPath);
  const recents = useRepoStore((s) => s.recents);
  const error = useRepoStore((s) => s.error);
  const dismissError = useRepoStore((s) => s.dismissError);
  const [cloneOpen, setCloneOpen] = useState(false);

  return (
    <div
      className="flex h-full items-center justify-center overflow-y-auto px-eg-5 py-eg-6"
      data-testid="open-wizard"
    >
      <div className="w-full max-w-xl">
        <div className="mb-eg-5 text-center">
          <div className="text-title font-semibold text-ink">{t('wizard.title')}</div>
          <p className="mt-1 text-secondary text-ink-subtle">{t('wizard.desc')}</p>
        </div>

        <div className="grid grid-cols-1 gap-eg-3 sm:grid-cols-3">
          <WizardCard
            icon={FolderOpen}
            title={t('wizard.open')}
            description={t('wizard.open.desc')}
            onClick={() => void pickAndOpen()}
            testId="wizard-open"
          />
          <WizardCard
            icon={FolderPlus}
            title={t('wizard.init')}
            description={t('wizard.init.desc')}
            onClick={() => void pickAndInit()}
            testId="wizard-init"
          />
          <WizardCard
            icon={FolderGit2}
            title={t('wizard.clone')}
            description={t('wizard.clone.desc')}
            onClick={() => setCloneOpen(true)}
            testId="wizard-clone"
          />
        </div>

        <CloneDialog
          open={cloneOpen}
          onClose={() => setCloneOpen(false)}
          onDone={(summary) => {
            setCloneOpen(false);
            void openByPath(summary.path);
          }}
        />

        {error ? (
          <div
            role="alert"
            className="mt-eg-4 flex items-center justify-between gap-eg-3 rounded-lg border border-danger-border bg-danger-bg px-eg-3 py-eg-2 text-secondary text-danger"
            data-testid="wizard-error"
          >
            <span>
              {error.title} · {error.detail}
            </span>
            <Button variant="tertiary" size="sm" onClick={dismissError} className="text-danger">
              {t('wizard.error.dismiss')}
            </Button>
          </div>
        ) : null}

        {recents.length > 0 ? (
          <section className="mt-eg-6">
            <div className="mb-eg-2 text-caption font-medium text-ink-subtle">
              {t('wizard.recent')}
            </div>
            <ul className="overflow-hidden rounded-lg border border-hairline">
              {recents.map((repo) => (
                <li key={repo.path}>
                  <button
                    type="button"
                    onClick={() => void openByPath(repo.path)}
                    className="flex w-full items-center gap-eg-2 border-b border-hairline px-eg-3 py-eg-2 text-left text-secondary text-ink-muted hover:bg-surface-1 last:border-b-0"
                  >
                    <FolderGit2 className="size-3.5 text-ink-tertiary" aria-hidden />
                    <span className="text-ink">{repo.name}</span>
                    <span className="truncate font-mono text-ink-tertiary">{repo.path}</span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    </div>
  );
}

function WizardCard({
  icon: Icon,
  title,
  description,
  onClick,
  disabled = false,
  badge,
  testId,
}: {
  icon: typeof FolderOpen;
  title: string;
  description: string;
  onClick?: () => void;
  disabled?: boolean;
  badge?: string;
  testId: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      data-testid={testId}
      className="flex h-full w-full flex-col items-start gap-eg-2 rounded-lg border border-hairline bg-surface-1 p-eg-4 text-left transition-colors duration-80 ease-eg hover:border-hairline-strong hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-45"
    >
      <div className="flex w-full items-center justify-between">
        <Icon className="size-5 text-ink-subtle" aria-hidden />
        {badge ? (
          <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-caption leading-none text-ink-tertiary">
            {badge}
          </span>
        ) : null}
      </div>
      <span className="text-section font-semibold text-ink">{title}</span>
      <span className="text-caption text-ink-subtle">{description}</span>
    </button>
  );
}

/** 克隆对话框 (W2 顺延 + m1-plan R-22): url + 目标目录, 进度走 sync 任务条. */
function CloneDialog({
  open,
  onClose,
  onDone,
}: {
  open: boolean;
  onClose: () => void;
  onDone: (summary: { path: string }) => void;
}) {
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const progress = useSyncStore((s) => s.progress);

  const valid = url.trim().length > 0 && target.trim().length > 0 && !busy;

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    try {
      const summary = await cloneRepo(url.trim(), target.trim());
      toast.success(t('wizard.clone.done', { name: summary.name }));
      onDone(summary);
    } catch (error) {
      const raw = error as { title?: string; detail?: string };
      toast.error(raw.title ?? t('wizard.clone.failed'), raw.detail);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      title={t('wizard.clone')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
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
      {busy && progress ? (
        <p className="mt-2 truncate text-caption text-ink-subtle" data-testid="clone-progress">
          {progress.message}
        </p>
      ) : null}
    </Dialog>
  );
}
