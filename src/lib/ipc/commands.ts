/**
 * Thin wrappers around the generated tauri-specta bindings. Components never
 * call bindings directly (TDD §3); this layer owns result unwrapping, error
 * humanization and, from W2, progress/cancel plumbing.
 */
import { commands, type AppVersion, type EgError } from './bindings';
import type { EgErrorLike, HumanizedError } from './errors';
import { humanizeEgError } from './errors';

export type { AppVersion, EgError };

/** The shape tauri-specta's ErrorHandlingMode::Result produces per command. */
export type CommandResult<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

/** True only inside the Tauri shell; the browser preview shows fallbacks. */
export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Fetches app/tauri/os versions. Returns null when IPC is unavailable so the
 * shell can degrade gracefully (browser preview).
 */
export async function getAppVersion(): Promise<AppVersion | null> {
  if (!isTauriAvailable()) return null;
  const result: CommandResult<AppVersion, EgError> = await commands.appVersion();
  return result.status === 'ok' ? result.data : null;
}

export function formatIpcError(error: EgErrorLike): HumanizedError {
  return humanizeEgError(error);
}
