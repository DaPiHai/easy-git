import { beforeEach, describe, expect, it, vi } from 'vitest';
import { handleShortcut, MAIN_VIEW_ORDER } from './shortcuts';
import { useRepoStore } from '../stores/repoStore';
import { useUiStore } from '../stores/uiStore';
import { useSyncStore } from '../stores/syncStore';

const getStatusMock = vi.fn(async (_repoId: string) => ({
  repoId: 'r1',
  branch: 'main',
  headOid: null,
  staged: [],
  unstaged: [],
  conflicted: [],
}));

vi.mock('../lib/ipc/commands', () => ({
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  closeRepo: vi.fn(),
  getStatus: (repoId: string) => getStatusMock(repoId),
  pickDirectory: vi.fn(async () => null),
  formatIpcError: (e: unknown) => ({ title: String(e), detail: '' }),
  undoOperation: vi.fn(async () => null),
  redoOperation: vi.fn(async () => null),
  undoRedoState: vi.fn(async () => null),
  remoteList: vi.fn(async () => []),
  remoteBranchList: vi.fn(async () => []),
  timelineGet: vi.fn(async () => []),
  events: {
    repoChanged: { listen: vi.fn(async () => () => {}) },
    syncProgress: { listen: vi.fn(async () => () => {}) },
  },
}));

function press(init: {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  target?: EventTarget;
}) {
  const event = new KeyboardEvent('keydown', {
    key: init.key,
    ctrlKey: init.ctrl ?? false,
    altKey: init.alt ?? false,
    shiftKey: init.shift ?? false,
    bubbles: true,
  });
  Object.defineProperty(event, 'target', { value: init.target ?? window });
  return handleShortcut(event);
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useUiStore.setState({ view: 'changes', switcherOpen: false });
  useRepoStore.setState({ repos: {}, activeId: null, status: null });
  useSyncStore.setState({ undoRedo: null });
});

describe('handleShortcut (X-03)', () => {
  it('toggles the quick switcher with Ctrl+K', () => {
    expect(press({ key: 'k', ctrl: true })).toBe(true);
    expect(useUiStore.getState().switcherOpen).toBe(true);
    expect(press({ key: 'k', ctrl: true })).toBe(true);
    expect(useUiStore.getState().switcherOpen).toBe(false);
  });

  it('switches main views with Alt+1..6 in tab order', () => {
    MAIN_VIEW_ORDER.forEach((view, index) => {
      expect(press({ key: String(index + 1), alt: true })).toBe(true);
      expect(useUiStore.getState().view).toBe(view);
    });
  });

  it('does not switch views on Ctrl+digit (WebKitGTK swallows it anyway)', () => {
    expect(press({ key: '3', ctrl: true })).toBe(false);
    expect(useUiStore.getState().view).toBe('changes');
  });

  it('opens and closes the settings page with Ctrl+,', () => {
    expect(press({ key: ',', ctrl: true })).toBe(true);
    expect(useUiStore.getState().view).toBe('settings');
    expect(press({ key: ',', ctrl: true })).toBe(true);
    expect(useUiStore.getState().view).toBe('changes');
  });

  it('guards editable targets: view switching stays native', () => {
    const input = document.createElement('input');
    document.body.appendChild(input);
    expect(press({ key: '1', alt: true, target: input })).toBe(false);
    expect(useUiStore.getState().view).toBe('changes');
    expect(press({ key: 'z', ctrl: true, target: input })).toBe(false);
    input.remove();
  });

  it('swallows Ctrl+R but only refreshes when a repo is active', () => {
    expect(press({ key: 'r', ctrl: true })).toBe(true);
    expect(getStatusMock).not.toHaveBeenCalled();

    useRepoStore.setState({
      repos: {
        r1: {
          repoId: 'r1',
          path: '/tmp/demo',
          name: 'demo',
          branch: 'main',
          headOid: null,
          ahead: 0,
          behind: 0,
          isEmpty: true,
        },
      },
      activeId: 'r1',
    });
    expect(press({ key: 'r', ctrl: true })).toBe(true);
    expect(getStatusMock).toHaveBeenCalledWith('r1');
  });

  it('consumes undo/redo keys even when the engine has nothing to do', () => {
    expect(press({ key: 'z', ctrl: true })).toBe(true);
    expect(press({ key: 'y', ctrl: true })).toBe(true);
    expect(press({ key: 'z', ctrl: true, shift: true })).toBe(true);
  });
});
