import { CloudUpload, GitBranch, GitCommitHorizontal, ListChecks, X } from 'lucide-react';
import { useState } from 'react';
import { t } from '../../lib/i18n';

const CARDS = [
  { icon: ListChecks, titleKey: 'concepts.staging.title', descKey: 'concepts.staging.desc' },
  { icon: GitCommitHorizontal, titleKey: 'concepts.commit.title', descKey: 'concepts.commit.desc' },
  { icon: GitBranch, titleKey: 'concepts.branch.title', descKey: 'concepts.branch.desc' },
  { icon: CloudUpload, titleKey: 'concepts.remote.title', descKey: 'concepts.remote.desc' },
] as const;

const FLAG = 'eg.onboard.concepts';

/**
 * First-run concept cards (m1-plan F-11 / X-04): a one-time primer for
 * Git beginners on the changes view; dismissal persists in localStorage.
 */
export function ConceptCards() {
  const [open, setOpen] = useState(() => localStorage.getItem(FLAG) !== 'done');
  if (!open) return null;
  return (
    <div className="mx-auto max-w-[1280px] px-eg-4 pt-eg-3" data-testid="concept-cards">
      <div className="grid grid-cols-1 gap-eg-2 rounded-xl border border-hairline bg-surface-1 p-eg-3 sm:grid-cols-2 xl:grid-cols-4">
        {CARDS.map((card) => (
          <div key={card.titleKey} className="flex items-start gap-2.5 rounded-lg p-2">
            <card.icon className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
            <div className="min-w-0">
              <p className="text-secondary font-medium text-ink">{t(card.titleKey)}</p>
              <p className="mt-0.5 text-caption text-ink-tertiary">{t(card.descKey)}</p>
            </div>
          </div>
        ))}
      </div>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          data-testid="concept-cards-dismiss"
          onClick={() => {
            try {
              localStorage.setItem(FLAG, 'done');
            } catch {
              // Best-effort persistence; the cards still close for this session.
            }
            setOpen(false);
          }}
          className="flex items-center gap-1 rounded-md px-2 py-1 text-caption text-ink-tertiary hover:bg-surface-2 hover:text-ink-muted"
        >
          <X className="size-3" aria-hidden />
          {t('concepts.dismiss')}
        </button>
      </div>
    </div>
  );
}
