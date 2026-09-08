import { ChevronDown, ChevronsRight, Redo2, Undo2 } from 'lucide-react';
import { t } from '../../lib/i18n';
import { useUiStore } from '../../stores/uiStore';

/**
 * 28px bottom bar (UI doc §5.1): mode switch · undo/redo · command lens · task progress.
 * Undo/redo and tasks activate with eg-safety (W9); mode switch with settings (W4).
 */
export function BottomBar() {
  return (
    <footer
      className="flex shrink-0 items-center gap-eg-4 border-t border-hairline bg-canvas px-eg-3 text-micro text-ink-subtle"
      style={{ height: 'var(--eg-bottombar-h)' }}
    >
      <button
        type="button"
        disabled
        className="flex items-center gap-1 font-medium disabled:pointer-events-none disabled:opacity-40"
        data-testid="mode-switch"
      >
        {t('bottom.mode.simple')}
        <ChevronDown className="size-3" aria-hidden />
      </button>

      <div className="flex items-center gap-eg-2">
        <button
          type="button"
          disabled
          aria-label={t('bottom.undo')}
          title={t('bottom.undo')}
          className="flex size-5 items-center justify-center rounded-sm hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
        >
          <Undo2 className="size-3.5" aria-hidden />
        </button>
        <button
          type="button"
          disabled
          aria-label={t('bottom.redo')}
          title={t('bottom.redo')}
          className="flex size-5 items-center justify-center rounded-sm hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
        >
          <Redo2 className="size-3.5" aria-hidden />
        </button>
      </div>

      <button
        type="button"
        disabled
        className="flex items-center gap-1 disabled:pointer-events-none disabled:opacity-40"
        data-testid="command-lens"
      >
        {t('bottom.commandLens')}
        <ChevronsRight className="size-3" aria-hidden />
      </button>

      <div className="ml-auto flex items-center gap-eg-4" data-testid="status-area">
        <span className="text-ink-tertiary">{t('bottom.task.none')}</span>
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
