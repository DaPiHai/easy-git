import { GitBranch } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../lib/i18n';

/** Branch board ships in W7 (F-21). */
export function BranchesPage() {
  return (
    <div className="h-full">
      <EmptyState
        icon={GitBranch}
        title={t('branches.empty.title')}
        description={t('branches.empty.desc')}
      />
    </div>
  );
}
