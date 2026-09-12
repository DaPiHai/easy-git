/**
 * Hint action dispatcher (TDD §6): the errors.ts table advertises a suggested
 * next action per error code; this module wires those actions to navigation.
 * Actions without a landing spot yet degrade to a log line — they must never
 * throw into the error path that produced them.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { appLog } from '../logger';
import { useMergeStore } from '../../stores/mergeStore';
import { useUiStore } from '../../stores/uiStore';

export const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';

export function dispatchHint(action: string): void {
  const ui = useUiStore.getState();
  switch (action) {
    case 'open-logs':
      // The log viewer lives in the settings page (TDD §6 查看日志 entry).
      ui.setView('settings');
      break;
    case 'go-changes':
      ui.setView('changes');
      break;
    case 'open-conflict-wizard':
      // A parked merge takes over the main view (AppShell F-24); leave the
      // settings page and refresh the state so the wizard mounts.
      ui.setView('changes');
      void useMergeStore.getState().poll();
      break;
    case 'open-repo-picker':
      ui.setSwitcherOpen(true);
      break;
    case 'open-settings-network':
    case 'open-credentials':
      // 网络与凭据分区尚未落地（SettingsPage v1），先落到设置页顶部。
      ui.setView('settings');
      break;
    case 'open-git-download':
      openUrl(GIT_DOWNLOAD_URL).catch(() => appLog.warn('hints', `openUrl failed for ${action}`));
      break;
    default:
      appLog.warn('hints', `no handler for hint action: ${action}`);
  }
}
