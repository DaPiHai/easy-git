import { Redo2, Undo2, ChevronDown } from 'lucide-react';
import { t } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import { useUiStore } from '../../stores/uiStore';
import { LensPanel } from './LensPanel';

/**
 * 28px bottom bar (UI doc §5.1): mode switch · undo/redo · command lens · task progress.
 * Undo/redo drive the eg-safety 引用快照树 engine (R-25); the strip shows
 * network task progress (R-22/F-27).
 */
export function BottomBar() {
  const expertMode = useUiStore((s) => s.expertMode);
  const toggleExpertMode = useUiStore((s) => s.toggleExpertMode);
  const undoRedo = useSyncStore((s) => s.undoRedo);
  const redo = useSyncStore((s) => s.redo);
  const undoOperation = useRepoStore((s) => s.undoOperation);
  const progress = useSyncStore((s) => s.progress);
  const activeId = useRepoStore((s) => s.activeId);

  const onUndo = () => {
    const opId = undoRedo?.undoableOpId;
    if (!opId) return;
    void undoOperation(opId).then(() => useSyncStore.getState().refresh());
  };

  return (
    <footer
      className="flex shrink-0 items-center gap-eg-4 border-t border-hairline bg-canvas px-eg-3 text-micro text-ink-subtle"
      style={{ height: 'var(--eg-bottombar-h)' }}
    >
      <button
        type="button"
        onClick={toggleExpertMode}
        className="flex items-center gap-1 font-medium rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:text-ink"
        data-testid="mode-switch"
        title={t('settings.mode.desc')}
      >
        {expertMode ? t('bottom.mode.expert') : t('bottom.mode.simple')}
        <ChevronDown className="size-3" aria-hidden />
      </button>

      <div className="flex items-center gap-eg-2">
        <button
          type="button"
          disabled={!activeId || !undoRedo?.undoableOpId}
          aria-label={t('bottom.undo')}
          title={undoRedo?.undoableLabel || t('bottom.undo')}
          data-testid="undo-button"
          onClick={onUndo}
          className="flex size-5 items-center justify-center rounded-sm hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
        >
          <Undo2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          disabled={!activeId || !undoRedo?.redoable}
          aria-label={t('bottom.redo')}
          title={t('bottom.redo')}
          data-testid="redo-button"
          onClick={() => void redo()}
          className="flex size-5 items-center justify-center rounded-sm hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
        >
          <Redo2 className="size-3.5" aria-hidden />
        </button>
      </div>

      <LensPanel />

      <div className="ml-auto flex items-center gap-eg-4" data-testid="status-area">
        {progress ? (
          <span className="flex items-center gap-2" data-testid="sync-task-strip">
            <span className="max-w-[420px] truncate text-ink-muted">
              {t(`sync.task.${progress.task}` as Parameters<typeof t>[0])} · {progress.message}
            </span>
            {progress.percent !== null ? (
              <span className="relative h-1 w-24 overflow-hidden rounded-full bg-surface-2">
                <span
                  className="absolute inset-y-0 left-0 bg-primary"
                  style={{ width: `${progress.percent}%` }}
                />
              </span>
            ) : null}
          </span>
        ) : (
          <span className="text-ink-tertiary">{t('bottom.task.none')}</span>
        )}
        <VersionChip />
      </div>
    </footer>
  );
}

function VersionChip() {
  const appVersion = useUiStore((s) => s.appVersion);
  if (!appVersion) {
    return (
      <span
        className="font-mono text-ink-tertiary"
        data-testid="ipc-status"
        data-state="disconnected"
      >
        {t('bottom.ipc.disconnected')}
      </span>
    );
  }
  return (
    <span
      className="font-mono text-ink-tertiary"
      data-testid="ipc-status"
      data-state="connected"
      title={`tauri ${appVersion.tauriVersion} · ${appVersion.os}`}
    >
      {`EasyGit v${appVersion.appVersion}`}
    </span>
  );
}
