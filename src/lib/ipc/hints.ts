/**
 * Hint action dispatcher (TDD §6): the errors.ts table advertises a suggested
 * next action per error code; this module wires those actions to navigation.
 * Actions without a landing spot yet degrade to a log line — they must never
 * throw into the error path that produced them.
 */
import { openUrl } from '@tauri-apps/plugin-opener';
import { appLog } from '../logger';
import { useMergeStore } from '../../stores/mergeStore';
import { useSshStore } from '../../stores/sshStore';
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
      // 网络设置分区尚未落地，先落到设置页顶部。
      ui.setView('settings');
      break;
    case 'open-credentials':
      // 跳到设置页并高亮"身份凭证"分区，让 HTTPS 认证失败的用户有明确
      // 落点；高亮状态 2.5 秒后自动清除，不影响下一次触发。
      ui.setView('settings');
      ui.setCredentialsHighlighted(true);
      if (typeof window !== 'undefined') {
        window.setTimeout(() => ui.setCredentialsHighlighted(false), 2500);
      }
      break;
    case 'open-ssh-setup':
      // SSH auth failures get the actionable wizard instead of a read-only
      // status section: generate/copy a key, open GitHub, verify.
      useSshStore.getState().setSetupOpen(true);
      break;
    case 'open-git-download':
      openUrl(GIT_DOWNLOAD_URL).catch(() => appLog.warn('hints', `openUrl failed for ${action}`));
      break;
    case 'init-ssh-repo':
      // The SSH dialog owns this action: it carries the URI + 存在性 in the
      // error's target field, so opening the repo picker here would lose
      // context. The dialog listens for the action and runs its own flow.
      // Fall through to a log line if no consumer is wired (test/runtime gap).
      appLog.info('hints', `init-ssh-repo requested without an active dialog`);
      break;
    default:
      appLog.warn('hints', `no handler for hint action: ${action}`);
  }
}
