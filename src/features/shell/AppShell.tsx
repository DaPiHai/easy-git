import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { BottomBar } from './BottomBar';
import { DetailPanel } from './DetailPanel';
import { RepoSidebar } from './RepoSidebar';
import { TopBar } from './TopBar';
import { ChangesPage } from '../changes/ChangesPage';
import { HistoryPage } from '../history/HistoryPage';
import { BranchesPage } from '../branches/BranchesPage';
import { StoragePage } from '../storage/StoragePage';

/** PRD §6.1 frame: top bar / repo sidebar / main view / detail panel / bottom bar. */
export function AppShell() {
  const view = useUiStore((s) => s.view);

  useEffect(() => {
    const { initTheme, fetchAppVersion } = useUiStore.getState();
    initTheme();
    void fetchAppVersion();
    return () => useUiStore.getState().stopWatchingSystemTheme();
  }, []);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas font-ui text-ink">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <RepoSidebar />
        <main className="min-w-0 flex-1">
          {view === 'changes' && <ChangesPage />}
          {view === 'history' && <HistoryPage />}
          {view === 'branches' && <BranchesPage />}
          {view === 'storage' && <StoragePage />}
        </main>
        <DetailPanel />
      </div>
      <BottomBar />
    </div>
  );
}
