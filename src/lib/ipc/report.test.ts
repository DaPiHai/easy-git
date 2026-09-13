import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reportFailure } from './report';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';

const logError = vi.fn();

vi.mock('../logger', () => ({
  appLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => logError(...args),
  },
  describeError: (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error),
}));

beforeEach(() => {
  logError.mockClear();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ view: 'changes' });
});

describe('reportFailure', () => {
  it('keeps the caller copy but carries the raw cause and the log line', () => {
    reportFailure('repo.open-folder', '无法打开文件夹，请稍后重试', 'forbidden path: C:\\demo');

    const toasts = useToastStore.getState().toasts;
    const last = toasts[toasts.length - 1];
    expect(last.kind).toBe('error');
    expect(last.message).toBe('无法打开文件夹，请稍后重试');
    expect(last.reason).toBe('forbidden path: C:\\demo');
    expect(last.action?.label).toBe('查看日志');
    expect(logError).toHaveBeenCalledWith(
      'repo.open-folder',
      '无法打开文件夹，请稍后重试 — forbidden path: C:\\demo',
    );
  });

  it('routes the log hint to the settings log viewer', () => {
    reportFailure('settings.open-log-folder', '无法打开日志文件夹', new Error('denied'));

    const toasts = useToastStore.getState().toasts;
    toasts[toasts.length - 1].action?.onClick();
    expect(useUiStore.getState().view).toBe('settings');
  });

  it('reads the message out of Error rejections', () => {
    reportFailure('settings.open-log-folder', '无法打开日志文件夹', new Error('denied'));

    const toasts = useToastStore.getState().toasts;
    expect(toasts[toasts.length - 1].reason).toContain('denied');
  });
});
