import { type MessageKey } from './i18n';
import type { MainView } from '../stores/uiStore';
import { useRepoStore } from '../stores/repoStore';
import { useSyncStore } from '../stores/syncStore';
import { useUiStore } from '../stores/uiStore';

/**
 * Shortcut scheme v1 (m1-plan X-03). One keydown entry point in AppShell;
 * editable targets (inputs/textareas/contenteditable) keep their native
 * editing keys — only the webview-reloading refresh is intercepted there.
 */
export interface ShortcutSpec {
  id: string;
  /** Display form for the settings cheat sheet. */
  keys: string;
  /** i18n key describing the action. */
  actionKey: MessageKey;
}

/** Main views in Alt+1..6 order (matches top-bar tab order). */
export const MAIN_VIEW_ORDER: MainView[] = [
  'changes',
  'history',
  'branches',
  'storage',
  'timeline',
  'remotes',
];

export const SHORTCUTS: ShortcutSpec[] = [
  { id: 'switcher', keys: 'Ctrl+K', actionKey: 'shortcuts.switcher' },
  { id: 'views', keys: 'Alt+1…6', actionKey: 'shortcuts.views' },
  { id: 'refresh', keys: 'Ctrl+R / F5', actionKey: 'shortcuts.refresh' },
  { id: 'undo', keys: 'Ctrl+Z', actionKey: 'shortcuts.undo' },
  { id: 'redo', keys: 'Ctrl+Y', actionKey: 'shortcuts.redo' },
  { id: 'settings', keys: 'Ctrl+,', actionKey: 'shortcuts.settings' },
];

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.isContentEditable
  );
}

/**
 * Handles one keydown; returns true when the event was consumed (AppShell
 * then prevents default). Pure dispatch — store access goes through
 * getState() so no React re-subscription is needed.
 *
 * View switching uses Alt+digit, not Ctrl+digit: WebKitGTK swallows the
 * latter in its native key pipeline (verified on the real app; synthetic
 * events and other platforms are fine).
 */
export function handleShortcut(event: KeyboardEvent): boolean {
  const mod = event.ctrlKey || event.metaKey;
  const key = event.key.toLowerCase();

  if (mod && key === 'k') {
    const { switcherOpen, setSwitcherOpen } = useUiStore.getState();
    setSwitcherOpen(!switcherOpen);
    return true;
  }
  if (mod && event.key === ',') {
    const { view, setView } = useUiStore.getState();
    setView(view === 'settings' ? 'changes' : 'settings');
    return true;
  }
  // Ctrl+R / F5: refresh repo state (and block the webview page reload).
  if (mod && key === 'r') {
    if (useRepoStore.getState().activeId) void useRepoStore.getState().refreshStatus();
    return true;
  }
  if (event.key === 'F5') {
    if (!useRepoStore.getState().activeId) return false;
    void useRepoStore.getState().refreshStatus();
    return true;
  }
  if (mod && key === 'z' && !event.shiftKey && !isEditable(event.target)) {
    const state = useSyncStore.getState().undoRedo;
    const opId = state?.undoableOpId;
    if (!opId) return true;
    void useRepoStore
      .getState()
      .undoOperation(opId)
      .then(() => useSyncStore.getState().refresh());
    return true;
  }
  if (mod && (key === 'y' || (key === 'z' && event.shiftKey)) && !isEditable(event.target)) {
    void useSyncStore.getState().redo();
    return true;
  }
  if (event.altKey && !mod && !isEditable(event.target) && /^[1-6]$/.test(event.key)) {
    const target = MAIN_VIEW_ORDER[Number(event.key) - 1];
    if (target) useUiStore.getState().setView(target);
    return true;
  }
  return false;
}
