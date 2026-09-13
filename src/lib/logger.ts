/**
 * Frontend-originated logging (TDD §1 file sink): uncaught window errors and
 * unhandled rejections are forwarded into the same local file the Rust core
 * writes, so a crash report tells the whole story. Best-effort by design —
 * outside the Tauri shell (browser preview) it is a no-op and it never throws
 * into the caller's path.
 */
import { logWeb } from './ipc/commands';

export const appLog = {
  info: (scope: string, message: string) => void logWeb('info', scope, message),
  warn: (scope: string, message: string) => void logWeb('warn', scope, message),
  error: (scope: string, message: string) => void logWeb('error', scope, message),
};

/** Human-readable form of a thrown value: stack for Errors, `String()` otherwise
 * (IPC rejections arrive as plain strings). */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.stack ?? error.message;
  return String(error);
}

/** Installs the global hooks; call once during app bootstrap. */
export function installGlobalErrorLogging(): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('error', (event) => {
    appLog.error('window.error', `${event.message} @ ${event.filename}:${event.lineno}`);
    if (event.error) appLog.error('window.error', describeError(event.error));
  });
  window.addEventListener('unhandledrejection', (event) => {
    appLog.error('unhandledrejection', describeError(event.reason));
  });
}
