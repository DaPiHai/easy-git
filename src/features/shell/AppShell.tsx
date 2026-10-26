import { useEffect } from 'react';
import { handleShortcut } from '../../lib/shortcuts';
import { gitBlockingReason, useUiStore } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';
import { useBusyStore } from '../../stores/busyStore';
import { LoadingBar, ToastHost } from '../../components';
import { BottomBar } from './BottomBar';
import { DetailPanel } from './DetailPanel';
import { RepoSidebar } from './RepoSidebar';
import { QuickSwitcher } from '../palette/QuickSwitcher';
import { TopBar } from './TopBar';
import { OpenRepoWizard } from '../repo/OpenRepoWizard';
import { CloneDialog } from '../repo/CloneDialog';
import { SshDialog } from '../repo/SshDialog';
import { InitGitignoreDialog } from '../repo/InitGitignoreDialog';
import { GitMissingNotice } from '../repo/GitMissingNotice';
import { CredentialsDialog } from './CredentialsDialog';
import { SshHostKeyDialog } from './SshHostKeyDialog';
import { SshSetupDialog } from './SshSetupDialog';
import { ConflictWizard } from '../conflicts/ConflictWizard';
import { useMergeStore } from '../../stores/mergeStore';
import { useSyncStore } from '../../stores/syncStore';
import { TimelinePage } from '../timeline/TimelinePage';
import { RemotesPage } from '../remotes/RemotesPage';
import { ChangesPage } from '../changes/ChangesPage';
import { HistoryPage } from '../history/HistoryPage';
import { BranchesPage } from '../branches/BranchesPage';
import { StoragePage } from '../storage/StoragePage';
import { SettingsPage } from '../settings/SettingsPage';

/** PRD §6.1 frame: top bar / repo sidebar / main view / detail panel / bottom bar. */
export function AppShell() {
  const view = useUiStore((s) => s.view);
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);
  // F-24: a parked merge takes over the main view until resolved/aborted.
  const midMerge = useMergeStore((s) => s.mergeState !== null);
  const status = useRepoStore((s) => s.status);
  // Global wait bar for user-initiated git operations (busyStore is time-gated,
  // so instant operations never flash; read-only refreshes never raise it).
  const busy = useBusyStore((s) => s.visible);
  // PRD §7: gate the main view when system git is missing or below 2.30.
  const envStatus = useUiStore((s) => s.envStatus);
  const gitReason = gitBlockingReason(envStatus?.gitVersion);

  useEffect(() => {
    const { initTheme, fetchAppVersion, fetchEnvStatus } = useUiStore.getState();
    initTheme();
    void fetchAppVersion();
    // PRD §7: probe system git once at startup; GitMissingNotice gates on it.
    void fetchEnvStatus();
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

  // W9: sync progress subscription + remotes/undo-redo state tracking.
  useEffect(() => useSyncStore.getState().init(), []);
  useEffect(() => {
    void useSyncStore.getState().refresh();
  }, [hasActiveRepo, status]);

  // Global shortcuts v1 (m1-plan X-03): one entry point for all bindings.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (handleShortcut(event)) event.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-canvas font-ui text-ink">
      {busy ? <LoadingBar className="z-50" /> : null}
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <RepoSidebar />
        <main className="min-w-0 flex-1">
          {gitReason ? (
            <GitMissingNotice />
          ) : view === 'settings' ? (
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
              {view === 'timeline' && <TimelinePage />}
              {view === 'remotes' && <RemotesPage />}
            </>
          )}
        </main>
        <DetailPanel />
      </div>
      <BottomBar />
      <QuickSwitcher />
      <CloneDialog />
      <SshDialog />
      <InitGitignoreDialog />
      <CredentialsDialog />
      <SshHostKeyDialog />
      <SshSetupDialog />
      <ToastHost />
    </div>
  );
}
