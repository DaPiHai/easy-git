import { Archive } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../lib/i18n';

/** Stash / tags / submodules / worktrees hub ships in W7 (F-22). */
export function StoragePage() {
  return (
    <div className="h-full">
      <EmptyState
        icon={Archive}
        title={t('storage.empty.title')}
        description={t('storage.empty.desc')}
      />
    </div>
  );
}
