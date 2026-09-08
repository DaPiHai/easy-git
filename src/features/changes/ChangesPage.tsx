import { FileDiff } from 'lucide-react';
import { EmptyState } from '../../components/EmptyState';
import { t } from '../../lib/i18n';

/** Default landing view (PRD §6.1); the three-zone status view ships in W2–W3. */
export function ChangesPage() {
  return (
    <div className="h-full">
      <EmptyState
        icon={FileDiff}
        title={t('changes.empty.title')}
        description={t('changes.empty.desc')}
      />
    </div>
  );
}
