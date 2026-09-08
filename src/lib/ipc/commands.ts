/**
 * Thin wrappers around the generated tauri-specta bindings. Components never
 * call bindings directly (TDD §3); this layer owns result unwrapping, error
 * humanization and progress/cancel plumbing (from W9 for long tasks).
 */
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import {
  commands,
  type AppVersion,
  type CommitOutcome,
  type CommitRequest,
  type ConfigScope,
  type DiscardOutcome,
  type EgError,
  type IgnoreMode,
  type RepoSummary,
  type StageMode,
  type StatusReport,
} from './bindings';
import type { EgErrorLike, HumanizedError } from './errors';
import { humanizeEgError } from './errors';

export type {
  AppVersion,
  CommitOutcome,
  CommitRequest,
  ConfigScope,
  DiscardOutcome,
  EgError,
  IgnoreMode,
  RepoSummary,
  StageMode,
  StatusReport,
};
export type { ChangeEntry, ChangeKind } from './bindings';
export type { EgErrorLike, HumanizedError } from './errors';

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

export async function openRepo(path: string): Promise<RepoSummary> {
  const result = await commands.repoOpen(path);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function initRepo(path: string): Promise<RepoSummary> {
  const result = await commands.repoInit(path);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function closeRepo(repoId: string): Promise<void> {
  const result = await commands.repoClose(repoId);
  if (result.status === 'error') throw result.error;
}

export async function getStatus(repoId: string): Promise<StatusReport> {
  const result = await commands.statusGet(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function stagePaths(
  repoId: string,
  paths: string[],
  mode: StageMode,
): Promise<StatusReport> {
  const result = await commands.stage(repoId, paths, mode);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function discardChanges(repoId: string, paths: string[]): Promise<DiscardOutcome> {
  const result = await commands.discardChanges(repoId, paths);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function cleanPreview(repoId: string): Promise<string[]> {
  const result = await commands.cleanPreview(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function cleanExecute(repoId: string, paths: string[]): Promise<DiscardOutcome> {
  const result = await commands.cleanExecute(repoId, paths);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function ignorePaths(
  repoId: string,
  paths: string[],
  mode: IgnoreMode,
): Promise<StatusReport> {
  const result = await commands.ignorePaths(repoId, paths, mode);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function undoOperation(repoId: string, opId: string): Promise<StatusReport> {
  const result = await commands.undoOperation(repoId, opId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Commits the index (or amends); throws EgError on guard failures (R-07). */
export async function commitIndex(repoId: string, request: CommitRequest): Promise<CommitOutcome> {
  const result = await commands.commit(repoId, request);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Reads one config key (repo scope falls back to global inside git2). */
export async function getConfig(
  repoId: string,
  scope: ConfigScope,
  key: string,
): Promise<string | null> {
  const result = await commands.configGet(repoId, scope, key);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Writes one config key in the requested scope. */
export async function setConfig(
  repoId: string,
  scope: ConfigScope,
  key: string,
  value: string,
): Promise<void> {
  const result = await commands.configSet(repoId, scope, key, value);
  if (result.status === 'error') throw result.error;
}

/** Native directory picker; null when cancelled or outside the Tauri shell. */
export async function pickDirectory(title: string): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  const selection = await dialogOpen({ directory: true, multiple: false, title });
  return typeof selection === 'string' ? selection : null;
}

export function formatIpcError(error: EgErrorLike): HumanizedError {
  return humanizeEgError(error);
}
