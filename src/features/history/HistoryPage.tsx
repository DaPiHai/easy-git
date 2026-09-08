import { GitGraph } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../lib/i18n';

/** History DAG view ships in W5 (F-15). */
export function HistoryPage() {
  return (
    <div className="h-full">
      <EmptyState
        icon={GitGraph}
        title={t('history.empty.title')}
        description={t('history.empty.desc')}
      />
    </div>
  );
}
