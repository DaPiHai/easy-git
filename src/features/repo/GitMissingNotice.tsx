import { useState } from 'react';
import { openUrl } from '@tauri-apps/plugin-opener';
import { FolderGit2, RefreshCw } from 'lucide-react';
import { Button, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import { gitBlockingReason, useUiStore } from '../../stores/uiStore';

/** The official download page linked from the environment gate (PRD §7). */
const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

/**
 * Main-view environment gate (PRD §7: 检测系统 git ≥ 2.30，缺失时引导安装).
 * Takes over the main view like OpenRepoWizard while local shell chrome stays
 * visible. Two variants: git missing, or present but below the PRD minimum.
 */
export function GitMissingNotice() {
  const envStatus = useUiStore((s) => s.envStatus);
  const fetchEnvStatus = useUiStore((s) => s.fetchEnvStatus);
  const [rechecking, setRechecking] = useState(false);

  const reason = gitBlockingReason(envStatus?.gitVersion);
  const version = envStatus?.gitVersion ?? null;
  const title = reason === 'tooOld' ? t('env.gitTooOld.title') : t('env.gitMissing.title');
  const description =
    reason === 'tooOld' && version !== null
      ? t('env.gitTooOld.desc', { version })
      : t('env.gitMissing.desc');

  const recheck = async () => {
    setRechecking(true);
    try {
      await fetchEnvStatus();
    } finally {
      setRechecking(false);
    }
  };

  return (
    <div className="flex h-full items-center justify-center" data-testid="git-missing-notice">
      <div className="w-full max-w-xl">
        <EmptyState icon={FolderGit2} title={title} description={description} />
        <div className="mt-eg-4 flex items-center justify-center gap-eg-3">
          <Button
            variant="primary"
            data-testid="git-download"
            onClick={() => void openUrl(GIT_DOWNLOAD_URL)}
          >
            {t('env.download')}
          </Button>
          <Button
            variant="secondary"
            loading={rechecking}
            data-testid="git-recheck"
            onClick={() => void recheck()}
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {rechecking ? t('env.rechecking') : t('env.recheck')}
          </Button>
        </div>
      </div>
    </div>
  );
}
