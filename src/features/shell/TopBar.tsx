import { PanelRight, Search, Settings } from 'lucide-react';
import { t } from '../../lib/i18n';
import { useUiStore, type MainView } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';
import { Button } from '../../components/Button';
import { ThemeToggle } from './ThemeToggle';
import { RepoSwitcher } from '../repo/RepoSwitcher';
import { SyncButtons } from './SyncButtons';

const mainViews: { id: MainView; labelKey: Parameters<typeof t>[0] }[] = [
  { id: 'changes', labelKey: 'tab.changes' },
  { id: 'history', labelKey: 'tab.history' },
  { id: 'branches', labelKey: 'tab.branches' },
  { id: 'storage', labelKey: 'tab.storage' },
  { id: 'timeline', labelKey: 'tab.timeline' },
  { id: 'remotes', labelKey: 'tab.remotes' },
];

/**
 * 44px top bar (UI doc §5.1): repo switcher · main view tabs · sync group + search.
 * Sync actions stay disabled until remotes land (W9).
 */
export function TopBar() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const detailOpen = useUiStore((s) => s.detailOpen);
  const toggleDetail = useUiStore((s) => s.toggleDetail);
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);

  return (
    <header
      className="flex shrink-0 items-center gap-eg-3 border-b border-hairline bg-canvas px-eg-3"
      style={{ height: 'var(--eg-topbar-h)' }}
    >
      <RepoSwitcher />

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

      {/* Sync group (F-27, live since W9) + search. */}
      <div className="flex items-center gap-1">
        <SyncButtons hasActiveRepo={hasActiveRepo} />
        <ThemeToggle />
        <Button variant="tertiary" size="sm" disabled aria-label={t('topbar.search')}>
          <Search className="size-4" aria-hidden />
        </Button>
        <Button
          variant="tertiary"
          size="sm"
          onClick={() => setView(view === 'settings' ? 'changes' : 'settings')}
          aria-label={t('settings.title')}
          aria-pressed={view === 'settings'}
          data-testid="settings-toggle"
        >
          <Settings className="size-4" aria-hidden />
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
