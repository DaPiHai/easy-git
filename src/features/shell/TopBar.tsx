import {
  ArrowDownToLine,
  ArrowUpToLine,
  ChevronDown,
  CloudDownload,
  PanelRight,
  Search,
} from 'lucide-react';
import { t } from '../../lib/i18n';
import { useUiStore, type MainView } from '../../stores/uiStore';
import { Button } from '../../components/Button';
import { ThemeToggle } from './ThemeToggle';

const mainViews: { id: MainView; labelKey: Parameters<typeof t>[0] }[] = [
  { id: 'changes', labelKey: 'tab.changes' },
  { id: 'history', labelKey: 'tab.history' },
  { id: 'branches', labelKey: 'tab.branches' },
  { id: 'storage', labelKey: 'tab.storage' },
];

/**
 * 44px top bar (UI doc §5.1): repo switcher · main view tabs · sync group + search.
 * Repo-bound controls stay disabled until a repository is opened (W2).
 */
export function TopBar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const detailOpen = useUiStore((s) => s.detailOpen);
  const toggleDetail = useUiStore((s) => s.toggleDetail);

  return (
    <header
      className="flex shrink-0 items-center gap-eg-3 border-b border-hairline bg-canvas px-eg-3"
      style={{ height: 'var(--eg-topbar-h)' }}
    >
      {/* Repo switcher placeholder — functional in W2 (F-05). */}
      <Button variant="tertiary" size="sm" disabled data-testid="repo-switcher">
        <span className="font-medium">{t('app.title')}</span>
        <span className="text-ink-subtle">·</span>
        <span>{t('topbar.openRepo')}</span>
        <ChevronDown className="size-3.5 text-ink-tertiary" aria-hidden />
      </Button>

      {/* Main view tabs (UI doc §6.3). */}
      <nav className="mx-auto flex items-center gap-1" aria-label="主导航">
        {mainViews.map(({ id, labelKey }) => {
          const selected = view === id;
          return (
            <button
              key={id}
              type="button"
              aria-current={selected ? 'page' : undefined}
              onClick={() => setView(id)}
              className={`h-7 rounded-pill px-3.5 text-secondary font-medium transition-colors duration-80 ease-eg ${
                selected ? 'bg-surface-2 text-ink' : 'text-ink-subtle hover:text-ink-muted'
              }`}
            >
              {t(labelKey)}
            </button>
          );
        })}
      </nav>

      {/* Sync group + search — wired up in W9 / W7. */}
      <div className="flex items-center gap-1">
        <Button variant="tertiary" size="sm" disabled data-testid="sync-fetch">
          <CloudDownload className="size-4" aria-hidden />
          {t('sync.fetch')}
        </Button>
        <Button variant="tertiary" size="sm" disabled>
          <ArrowDownToLine className="size-4" aria-hidden />
          {t('sync.pull')}
        </Button>
        <Button variant="tertiary" size="sm" disabled>
          <ArrowUpToLine className="size-4" aria-hidden />
          {t('sync.push')}
        </Button>
        <ThemeToggle />
        <Button variant="tertiary" size="sm" disabled aria-label={t('topbar.search')}>
          <Search className="size-4" aria-hidden />
        </Button>
        <Button
          variant="tertiary"
          size="sm"
          onClick={toggleDetail}
          aria-label={t('topbar.detailPanel')}
          aria-pressed={detailOpen}
          data-testid="detail-toggle"
        >
          <PanelRight className="size-4" aria-hidden />
        </Button>
      </div>
    </header>
  );
}
