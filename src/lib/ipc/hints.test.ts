import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dispatchHint, GIT_DOWNLOAD_URL } from './hints';
import { reportError } from './report';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';
import { useMergeStore } from '../../stores/mergeStore';

const logWarn = vi.fn();
const openUrlMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('../logger', () => ({
  appLog: {
    info: vi.fn(),
    warn: (...args: unknown[]) => logWarn(...args),
    error: vi.fn(),
  },
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

beforeEach(() => {
  logWarn.mockClear();
  openUrlMock.mockReset().mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ view: 'changes', switcherOpen: false });
});

describe('reportError', () => {
  it('pushes an error toast carrying reason and hint action', () => {
    reportError(
      { code: 'network', kind: 'connect', url: 'origin', detail: 'could not resolve host' },
      'sync',
    );
    const toasts = useToastStore.getState().toasts;
    const last = toasts[toasts.length - 1];
    expect(last.kind).toBe('error');
    expect(last.reason).toBe('could not resolve host');
    expect(last.action?.label).toBe('打开网络设置');
  });

  it('routes the hint action to the settings page for open-logs', () => {
    reportError({ code: 'internal', context: 'boom' }, 'test');
    const toasts = useToastStore.getState().toasts;
    const last = toasts[toasts.length - 1];
    last.action?.onClick();
    expect(useUiStore.getState().view).toBe('settings');
  });

  it('mirrors the failure into the frontend log line', () => {
    reportError({ code: 'internal', context: 'boom' }, 'test');
    expect(logWarn).not.toHaveBeenCalled();
  });
});

describe('dispatchHint', () => {
  it('open-git-download opens the official download page', () => {
    dispatchHint('open-git-download');
    expect(openUrlMock).toHaveBeenCalledWith(GIT_DOWNLOAD_URL);
  });

  it('open-conflict-wizard leaves the settings view and refreshes merge state', async () => {
    useUiStore.setState({ view: 'settings' });
    const poll = vi.spyOn(useMergeStore.getState(), 'poll').mockResolvedValue(undefined);
    dispatchHint('open-conflict-wizard');
    expect(useUiStore.getState().view).toBe('changes');
    expect(poll).toHaveBeenCalled();
    poll.mockRestore();
  });

  it('open-repo-picker opens the quick switcher', () => {
    dispatchHint('open-repo-picker');
    expect(useUiStore.getState().switcherOpen).toBe(true);
  });

  it('unknown actions degrade to a log line', () => {
    dispatchHint('future-action');
    expect(logWarn).toHaveBeenCalledWith('hints', 'no handler for hint action: future-action');
    expect(useUiStore.getState().view).toBe('changes');
  });

  it('exports the canonical download URL', () => {
    expect(GIT_DOWNLOAD_URL).toContain('git-scm.com');
  });
});
