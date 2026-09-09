/**
 * Thin wrappers around the generated tauri-specta bindings. Components never
 * call bindings directly (TDD §3); this layer owns result unwrapping, error
 * humanization and progress/cancel plumbing (from W9 for long tasks).
 */
import { open as dialogOpen } from '@tauri-apps/plugin-dialog';
import {
  commands,
  type AppVersion,
  type BranchInfo,
  type CommitDetail,
  type CommitLogEntry,
  type CommitOutcome,
  type CommitRequest,
  type ConflictBlock,
  type ConflictFile,
  type ConfigScope,
  type DiffRequest,
  type DiffResponse,
  type DiscardOutcome,
  type EgError,
  type IgnoreMode,
  type LogFilter,
  type LogPage,
  type MergeOutcome,
  type MergeState,
  type RepoSummary,
  type ResetMode,
  type ResetOutcome,
  type StageLinesRequest,
  type StageMode,
  type StatusReport,
  type StashEntry,
  type TagInfo,
} from './bindings';
import type { EgErrorLike, HumanizedError } from './errors';
import { humanizeEgError } from './errors';

export type {
  AppVersion,
  BranchInfo,
  CommitDetail,
  CommitLogEntry,
  CommitOutcome,
  CommitRequest,
  ConfigScope,
  ConflictBlock,
  ConflictFile,
  DiffRequest,
  DiffResponse,
  DiscardOutcome,
  EgError,
  IgnoreMode,
  LogFilter,
  LogPage,
  MergeOutcome,
  MergeState,
  RepoSummary,
  ResetMode,
  ResetOutcome,
  StageLinesRequest,
  StageMode,
  StatusReport,
  StashEntry,
  TagInfo,
};
export type {
  ChangeEntry,
  ChangeKind,
  DiffLine,
  DiffLineKind,
  DiffSourceKind,
  SelectedHunk,
} from './bindings';
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

/** One page of the lane-annotated history log (m1-plan R-10 / F-15). */
export async function logPage(
  repoId: string,
  offset: number,
  limit: number,
  filter: LogFilter,
): Promise<LogPage> {
  const result = await commands.logPage(repoId, offset, limit, filter);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Commit detail with the changed-file list (m1-plan F-16). */
export async function commitDetail(repoId: string, oid: string): Promise<CommitDetail> {
  const result = await commands.commitDetail(repoId, oid);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Local branch short names, current first (m1-plan F-17). */
export async function listBranches(repoId: string): Promise<string[]> {
  const result = await commands.listBranches(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** One file's unified diff (m1-plan R-12 / F-18). */
export async function diffFile(repoId: string, request: DiffRequest): Promise<DiffResponse> {
  const result = await commands.diffFile(repoId, request);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Hunk/line-level staging into the index (m1-plan R-13 / F-19). */
export async function stageLines(
  repoId: string,
  request: StageLinesRequest,
): Promise<StatusReport> {
  const result = await commands.stageLines(repoId, request);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Branch board (m1-plan F-21 / R-15). */
export async function branchList(repoId: string): Promise<BranchInfo[]> {
  const result = await commands.branchList(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function branchCreate(
  repoId: string,
  name: string,
  oid: string | null,
): Promise<BranchInfo> {
  const result = await commands.branchCreate(repoId, name, oid);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function branchRename(
  repoId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const result = await commands.branchRename(repoId, oldName, newName);
  if (result.status === 'error') throw result.error;
}

/** Returns the op id for the 撤销 toast (m1-plan R-16). */
export async function branchDelete(repoId: string, name: string): Promise<string> {
  const result = await commands.branchDelete(repoId, name);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function branchSwitch(repoId: string, name: string): Promise<StatusReport> {
  const result = await commands.branchSwitch(repoId, name);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Tags (m1-plan R-17). */
export async function tagList(repoId: string): Promise<TagInfo[]> {
  const result = await commands.tagList(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function tagCreate(
  repoId: string,
  name: string,
  oid: string,
  message: string | null,
): Promise<TagInfo> {
  const result = await commands.tagCreate(repoId, name, oid, message);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function tagDelete(repoId: string, name: string): Promise<string> {
  const result = await commands.tagDelete(repoId, name);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Stash (m1-plan R-18 / F-22). */
export async function stashList(repoId: string): Promise<StashEntry[]> {
  const result = await commands.stashList(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function stashPush(
  repoId: string,
  message: string | null,
  includeUntracked: boolean,
): Promise<StatusReport> {
  const result = await commands.stashPush(repoId, message, includeUntracked);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function stashApply(
  repoId: string,
  index: number,
  pop: boolean,
): Promise<StatusReport> {
  const result = await commands.stashApply(repoId, index, pop);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function stashDrop(repoId: string, index: number): Promise<StashEntry[]> {
  const result = await commands.stashDrop(repoId, index);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Native directory picker; null when cancelled or outside the Tauri shell. */
export async function mergeStart(
  repoId: string,
  name: string,
  noFf: boolean,
): Promise<MergeOutcome> {
  const r = await commands.mergeStart(repoId, name, noFf);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function mergeStateGet(repoId: string): Promise<MergeState | null> {
  const r = await commands.mergeState(repoId);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function mergeAbort(repoId: string): Promise<StatusReport> {
  const r = await commands.mergeAbort(repoId);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function conflictsGet(repoId: string): Promise<ConflictFile[]> {
  const r = await commands.conflictsGet(repoId);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function conflictResolve(
  repoId: string,
  path: string,
  content: string,
): Promise<StatusReport> {
  const r = await commands.conflictResolve(repoId, path, content);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function revertCommits(repoId: string, oids: string[]): Promise<StatusReport> {
  const r = await commands.revertCommits(repoId, oids);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function resetCommits(
  repoId: string,
  mode: ResetMode,
  target: string | null,
): Promise<ResetOutcome> {
  const r = await commands.resetCommits(repoId, mode, target);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function pickDirectory(title: string): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  const selection = await dialogOpen({ directory: true, multiple: false, title });
  return typeof selection === 'string' ? selection : null;
}

export function formatIpcError(error: EgErrorLike): HumanizedError {
  return humanizeEgError(error);
}
