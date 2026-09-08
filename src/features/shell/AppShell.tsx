import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';
import { BottomBar } from './BottomBar';
import { DetailPanel } from './DetailPanel';
import { RepoSidebar } from './RepoSidebar';
import { QuickSwitcher } from '../palette/QuickSwitcher';
import { TopBar } from './TopBar';
import { OpenRepoWizard } from '../repo/OpenRepoWizard';
import { ChangesPage } from '../changes/ChangesPage';
import { HistoryPage } from '../history/HistoryPage';
import { BranchesPage } from '../branches/BranchesPage';
import { StoragePage } from '../storage/StoragePage';

/** PRD §6.1 frame: top bar / repo sidebar / main view / detail panel / bottom bar. */
export function AppShell() {
  const view = useUiStore((s) => s.view);
  const setSwitcherOpen = useUiStore((s) => s.setSwitcherOpen);
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);

  useEffect(() => {
    const { initTheme, fetchAppVersion } = useUiStore.getState();
    initTheme();
    void fetchAppVersion();
    useRepoStore.getState().init();
    return () => {
      useUiStore.getState().stopWatchingSystemTheme();
      useRepoStore.getState().dispose();
    };
  }, []);

  // Ctrl/Cmd+K quick switcher (F-05 prototype).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        const { switcherOpen, setSwitcherOpen: set } = useUiStore.getState();
        set(!switcherOpen);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [setSwitcherOpen]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas font-ui text-ink">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <RepoSidebar />
        <main className="min-w-0 flex-1">
          {!hasActiveRepo ? (
            <OpenRepoWizard />
          ) : (
            <>
              {view === 'changes' && <ChangesPage />}
              {view === 'history' && <HistoryPage />}
              {view === 'branches' && <BranchesPage />}
              {view === 'storage' && <StoragePage />}
            </>
          )}
        </main>
        <DetailPanel />
      </div>
      <BottomBar />
      <QuickSwitcher />
    </div>
  );
}
