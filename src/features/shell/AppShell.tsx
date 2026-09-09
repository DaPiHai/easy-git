import { useEffect } from 'react';
import { useUiStore } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';
import { ToastHost } from '../../components';
import { BottomBar } from './BottomBar';
import { DetailPanel } from './DetailPanel';
import { RepoSidebar } from './RepoSidebar';
import { QuickSwitcher } from '../palette/QuickSwitcher';
import { TopBar } from './TopBar';
import { OpenRepoWizard } from '../repo/OpenRepoWizard';
import { ConflictWizard } from '../conflicts/ConflictWizard';
import { useMergeStore } from '../../stores/mergeStore';
import { ChangesPage } from '../changes/ChangesPage';
import { HistoryPage } from '../history/HistoryPage';
import { BranchesPage } from '../branches/BranchesPage';
import { StoragePage } from '../storage/StoragePage';
import { SettingsPage } from '../settings/SettingsPage';

/** PRD §6.1 frame: top bar / repo sidebar / main view / detail panel / bottom bar. */
export function AppShell() {
  const view = useUiStore((s) => s.view);
  const setSwitcherOpen = useUiStore((s) => s.setSwitcherOpen);
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);
  // F-24: a parked merge takes over the main view until resolved/aborted.
  const midMerge = useMergeStore((s) => s.mergeState !== null);
  const status = useRepoStore((s) => s.status);

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

  // Track the parked-merge state alongside every status refresh (fs-watch).
  useEffect(() => {
    void useMergeStore.getState().poll();
  }, [hasActiveRepo, status]);

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
          {view === 'settings' ? (
            <SettingsPage />
          ) : !hasActiveRepo ? (
            <OpenRepoWizard />
          ) : midMerge ? (
            <ConflictWizard />
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
      <ToastHost />
    </div>
  );
}
