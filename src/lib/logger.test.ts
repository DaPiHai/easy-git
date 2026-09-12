import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installGlobalErrorLogging } from './logger';

const logWebMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('./ipc/commands', () => ({
  logWeb: (...args: unknown[]) => logWebMock(...args),
}));

beforeEach(() => {
  logWebMock.mockReset().mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('installGlobalErrorLogging', () => {
  it('forwards window errors into the Rust log sink', () => {
    installGlobalErrorLogging();
    window.dispatchEvent(
      new ErrorEvent('error', {
        message: 'boom',
        filename: 'app.tsx',
        lineno: 7,
        error: new TypeError('boom'),
      }),
    );
    expect(logWebMock.mock.calls.length).toBeGreaterThan(0);
    expect(
      logWebMock.mock.calls.every(
        ([level, scope]) => level === 'error' && scope === 'window.error',
      ),
    ).toBe(true);
    expect(logWebMock.mock.calls.map(([, , message]) => message).join('\n')).toContain('boom');
  });

  it('forwards unhandled rejections with the stack', () => {
    installGlobalErrorLogging();
    const rejection = new Event('unhandledrejection') as Event & { reason: unknown };
    rejection.reason = new Error('async gone');
    window.dispatchEvent(rejection);
    expect(logWebMock).toHaveBeenCalledWith(
      'error',
      'unhandledrejection',
      expect.stringContaining('async gone'),
    );
  });
});
