import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { writeGitignoreTemplate } from '../../lib/ipc/commands';
import { reportError } from '../../lib/ipc/report';
import { useGitignorePrompt } from '../../stores/gitignoreStore';
import { toast } from '../../stores/toastStore';

/**
 * 通用 .gitignore 提醒 (F-06 新建/打开仓库): a freshly opened repository
 * without a .gitignore prompts once to create the generic template. Creating
 * writes the embedded template via the worker — an existing .gitignore is
 * never touched.
 */
export function InitGitignoreDialog() {
  const target = useGitignorePrompt((s) => s.target);
  const close = useGitignorePrompt((s) => s.close);
  const [busy, setBusy] = useState(false);

  if (!target) return null;

  const create = () => {
    setBusy(true);
    void writeGitignoreTemplate(target.repoId)
      .then((created) => {
        if (created) toast.success(t('toast.gitignoreCreated'));
      })
      .catch((error) => reportError(error, 'gitignore.template'))
      .finally(() => {
        setBusy(false);
        close();
      });
  };

  return (
    <Dialog
      open
      title={t('dialog.gitignore.title')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close} data-testid="gitignore-skip">
            {t('dialog.gitignore.skip')}
          </Button>
          <Button variant="primary" loading={busy} data-testid="gitignore-confirm" onClick={create}>
            {t('dialog.gitignore.confirm')}
          </Button>
        </>
      }
    >
      <p data-testid="gitignore-desc">{t('dialog.gitignore.desc', { name: target.name })}</p>
    </Dialog>
  );
}
