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
  type EnvStatus,
  type IgnoreMode,
  type LogContent,
  type LogFileInfo,
  type LogFilter,
  type LogPage,
  type MergeOutcome,
  type MergeState,
  type PushCredentials,
  type RepoSummary,
  type ResetMode,
  type ResetOutcome,
  type RemoteInfo,
  type StageLinesRequest,
  type StageMode,
  type StatusReport,
  type StashEntry,
  type SyncStrategy,
  type SyncProgressEvent,
  type TagInfo,
  type TimelineEntry,
  type UndoRedoState,
} from './bindings';
import type { EgErrorLike, HumanizedError } from './errors';
import { humanizeEgError } from './errors';
import type { MessageKey } from '../i18n';
import { useBusyStore } from '../../stores/busyStore';

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
  EnvStatus,
  IgnoreMode,
  LogContent,
  LogFileInfo,
  LogFilter,
  LogPage,
  MergeOutcome,
  MergeState,
  RemoteInfo,
  RepoSummary,
  ResetMode,
  ResetOutcome,
  StageLinesRequest,
  StageMode,
  StatusReport,
  StashEntry,
  SyncStrategy,
  SyncProgressEvent,
  TagInfo,
  TimelineEntry,
  UndoRedoState,
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
export { events } from './bindings';

/** The shape tauri-specta's ErrorHandlingMode::Result produces per command. */
export type CommandResult<T, E> = { status: 'ok'; data: T } | { status: 'error'; error: E };

/** True only inside the Tauri shell; the browser preview shows fallbacks. */
export function isTauriAvailable(): boolean {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

/**
 * Wait-indicator labels, keyed by the frontend export name below. Wrapping is
 * opt-in: only user-initiated write/network calls that can take seconds are
 * listed. Read-only calls (status refresh, log/diff pages, polling) are
 * deliberately absent so background work never lights the indicator up —
 * that would reintroduce the flicker rc.2 removed (docs/easy-git-tdd.md W10 ③).
 */
const BUSY_LABELS: Partial<Record<string, MessageKey>> = {
  openRepo: 'busy.repo.open',
  initRepo: 'busy.repo.init',
  closeRepo: 'busy.repo.close',
  stagePaths: 'busy.stage',
  stageLines: 'busy.stage.lines',
  discardChanges: 'busy.discard',
  cleanExecute: 'busy.clean',
  ignorePaths: 'busy.ignore',
  writeGitignoreTemplate: 'busy.ignore',
  undoOperation: 'busy.undo',
  redoOperation: 'busy.redo',
  restoreTo: 'busy.restore',
  commitIndex: 'busy.commit',
  setConfig: 'busy.config',
  branchCreate: 'busy.branch.create',
  branchRename: 'busy.branch.rename',
  branchDelete: 'busy.branch.delete',
  branchSwitch: 'busy.branch.switch',
  branchSetUpstream: 'busy.branch.upstream',
  tagCreate: 'busy.tag.create',
  tagDelete: 'busy.tag.delete',
  stashPush: 'busy.stash.push',
  stashApply: 'busy.stash.apply',
  stashDrop: 'busy.stash.drop',
  mergeStart: 'busy.merge',
  mergeAbort: 'busy.merge.abort',
  conflictResolve: 'busy.conflict.resolve',
  revertCommits: 'busy.revert',
  resetCommits: 'busy.reset',
  fetchRemote: 'busy.fetch',
  pullRemote: 'busy.pull',
  pushRemote: 'busy.push',
  remoteTest: 'busy.remote.test',
  cloneRepo: 'busy.clone',
  testSshConnection: 'busy.ssh.test',
  remoteAdd: 'busy.remote.add',
  remoteRename: 'busy.remote.rename',
  remoteRemove: 'busy.remote.remove',
  remoteSetUrl: 'busy.remote.url',
};

/**
 * Runs one command under the global wait indicator (busyStore owns the
 * reference counting and the show/hide timing, so instant commands never
 * flash and overlapping ones cannot clear each other early).
 */
async function tracked<T>(name: string, run: () => Promise<T>): Promise<T> {
  const end = useBusyStore.getState().begin(BUSY_LABELS[name] ?? 'busy.generic');
  try {
    return await run();
  } finally {
    end();
  }
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

/**
 * Environment probe (PRD §7): system git version, null when unavailable.
 * Returns null outside the Tauri shell so the browser preview never gates.
 */
export async function getEnvStatus(): Promise<EnvStatus | null> {
  if (!isTauriAvailable()) return null;
  const result = await commands.envCheck();
  return result.status === 'ok' ? result.data : null;
}

export async function openRepo(path: string): Promise<RepoSummary> {
  const result = await tracked('openRepo', () => commands.repoOpen(path));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function initRepo(path: string): Promise<RepoSummary> {
  const result = await tracked('initRepo', () => commands.repoInit(path));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function closeRepo(repoId: string): Promise<void> {
  const result = await tracked('closeRepo', () => commands.repoClose(repoId));
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
  const result = await tracked('stagePaths', () => commands.stage(repoId, paths, mode));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function discardChanges(repoId: string, paths: string[]): Promise<DiscardOutcome> {
  const result = await tracked('discardChanges', () => commands.discardChanges(repoId, paths));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function cleanPreview(repoId: string): Promise<string[]> {
  const result = await commands.cleanPreview(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function cleanExecute(repoId: string, paths: string[]): Promise<DiscardOutcome> {
  const result = await tracked('cleanExecute', () => commands.cleanExecute(repoId, paths));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function ignorePaths(
  repoId: string,
  paths: string[],
  mode: IgnoreMode,
): Promise<StatusReport> {
  const result = await tracked('ignorePaths', () => commands.ignorePaths(repoId, paths, mode));
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** True when the repository workdir has no `.gitignore` (lightweight read). */
export async function gitignoreMissing(repoId: string): Promise<boolean> {
  const result = await commands.gitignoreMissing(repoId);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Writes the generic template when absent; returns whether it was created. */
export async function writeGitignoreTemplate(repoId: string): Promise<boolean> {
  const result = await tracked('writeGitignoreTemplate', () => commands.gitignoreWrite(repoId));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function undoOperation(repoId: string, opId: string): Promise<StatusReport> {
  const result = await tracked('undoOperation', () => commands.undoOperation(repoId, opId));
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Commits the index (or amends); throws EgError on guard failures (R-07). */
export async function commitIndex(repoId: string, request: CommitRequest): Promise<CommitOutcome> {
  const result = await tracked('commitIndex', () => commands.commit(repoId, request));
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
  const result = await tracked('setConfig', () => commands.configSet(repoId, scope, key, value));
  if (result.status === 'error') throw result.error;
}

/** Reads one global config key with no repository open (settings identity). */
export async function getGlobalConfig(key: string): Promise<string | null> {
  const result = await commands.globalConfigGet(key);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Writes one global config key with no repository open (settings identity). */
export async function setGlobalConfig(key: string, value: string): Promise<void> {
  const result = await tracked('setGlobalConfig', () => commands.globalConfigSet(key, value));
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
  const result = await tracked('stageLines', () => commands.stageLines(repoId, request));
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
  const result = await tracked('branchCreate', () => commands.branchCreate(repoId, name, oid));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function branchRename(
  repoId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const result = await tracked('branchRename', () =>
    commands.branchRename(repoId, oldName, newName),
  );
  if (result.status === 'error') throw result.error;
}

/** Returns the op id for the 撤销 toast (m1-plan R-16). */
export async function branchDelete(repoId: string, name: string): Promise<string> {
  const result = await tracked('branchDelete', () => commands.branchDelete(repoId, name));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function branchSwitch(repoId: string, name: string): Promise<StatusReport> {
  const result = await tracked('branchSwitch', () => commands.branchSwitch(repoId, name));
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
  const result = await tracked('tagCreate', () => commands.tagCreate(repoId, name, oid, message));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function tagDelete(repoId: string, name: string): Promise<string> {
  const result = await tracked('tagDelete', () => commands.tagDelete(repoId, name));
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
  const result = await tracked('stashPush', () =>
    commands.stashPush(repoId, message, includeUntracked),
  );
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function stashApply(
  repoId: string,
  index: number,
  pop: boolean,
): Promise<StatusReport> {
  const result = await tracked('stashApply', () => commands.stashApply(repoId, index, pop));
  if (result.status === 'error') throw result.error;
  return result.data;
}

export async function stashDrop(repoId: string, index: number): Promise<StashEntry[]> {
  const result = await tracked('stashDrop', () => commands.stashDrop(repoId, index));
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Native directory picker; null when cancelled or outside the Tauri shell. */
export async function mergeStart(
  repoId: string,
  name: string,
  noFf: boolean,
): Promise<MergeOutcome> {
  const r = await tracked('mergeStart', () => commands.mergeStart(repoId, name, noFf));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function mergeStateGet(repoId: string): Promise<MergeState | null> {
  const r = await commands.mergeState(repoId);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function mergeAbort(repoId: string): Promise<StatusReport> {
  const r = await tracked('mergeAbort', () => commands.mergeAbort(repoId));
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
  const r = await tracked('conflictResolve', () => commands.conflictResolve(repoId, path, content));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function revertCommits(repoId: string, oids: string[]): Promise<StatusReport> {
  const r = await tracked('revertCommits', () => commands.revertCommits(repoId, oids));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function resetCommits(
  repoId: string,
  mode: ResetMode,
  target: string | null,
): Promise<ResetOutcome> {
  const r = await tracked('resetCommits', () => commands.resetCommits(repoId, mode, target));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function fetchRemote(
  repoId: string,
  remote: string,
  prune: boolean,
): Promise<StatusReport> {
  const r = await tracked('fetchRemote', () => commands.syncFetch(repoId, remote, prune));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function pullRemote(
  repoId: string,
  remote: string,
  branch: string,
  strategy: SyncStrategy,
): Promise<MergeOutcome> {
  const r = await tracked('pullRemote', () => commands.syncPull(repoId, remote, branch, strategy));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export type { PushCredentials };

export async function pushRemote(
  repoId: string,
  remote: string,
  branch: string,
  force: boolean,
  credentials?: PushCredentials | null,
): Promise<StatusReport> {
  const r = await tracked('pushRemote', () =>
    commands.syncPush(repoId, remote, branch, force, credentials ?? null),
  );
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function remoteTest(repoId: string, remote: string): Promise<number> {
  const r = await tracked('remoteTest', () => commands.remoteTest(repoId, remote));
  if (r.status === 'error') throw r.error;
  return r.data;
}

/**
 * Clones `url` into `path`. `credentials` is an optional session-only askpass
 * fallback for private servers; never persisted (same contract as push).
 */
export async function cloneRepo(
  url: string,
  path: string,
  credentials?: PushCredentials | null,
): Promise<RepoSummary> {
  const r = await tracked('cloneRepo', () => commands.repoClone(url, path, credentials ?? null));
  if (r.status === 'error') throw r.error;
  return r.data;
}

/** True when a repo path is an SSH remote-host coordinate, not a local dir. */
export function isSshRepoPath(path: string): boolean {
  const text = path.trim();
  if (text.startsWith('ssh://')) return true;
  // scp-like `user@host:/abs/path`, excluding Windows drive paths (`C:\…`).
  if (/^[a-zA-Z]:[\\/]/.test(text) || text.includes('://')) return false;
  const colon = text.indexOf(':');
  if (colon < 0) return false;
  const host = text.slice(0, colon);
  const rest = text.slice(colon + 1);
  return (
    host.length > 0 &&
    !host.includes('/') &&
    !host.includes('\\') &&
    (rest.startsWith('/') || rest.startsWith('~/') || rest === '~')
  );
}

/**
 * Tests an SSH host connection without opening a repository (SSH wizard).
 * Returns the canonical `ssh://…` URI on success; throws the flat EgError
 * (auth/network) otherwise.
 */
export async function testSshConnection(location: string): Promise<string> {
  const r = await tracked('testSshConnection', () => commands.sshTestConnection(location));
  if (r.status === 'error') throw r.error;
  return r.data;
}

/**
 * Runs `git init` on an SSH host at `location` (SSH wizard recovery flow).
 * Offered only when `repo_open` rejects the path with `SshNotARepo` and the
 * directory exists — a missing path stays an error.
 */
export async function initSshRepo(location: string): Promise<void> {
  const r = await commands.sshInitRepo(location);
  if (r.status === 'error') throw r.error;
}

/** Lists a directory on an SSH host (SSH wizard remote browser). */
export async function browseSshDir(location: string, dir: string): Promise<string[]> {
  const r = await commands.sshBrowseDir(location, dir);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function remoteList(repoId: string): Promise<RemoteInfo[]> {
  const r = await commands.remoteList(repoId);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function remoteAdd(repoId: string, name: string, url: string): Promise<void> {
  const r = await tracked('remoteAdd', () => commands.remoteAdd(repoId, name, url));
  if (r.status === 'error') throw r.error;
}

export async function remoteRename(
  repoId: string,
  oldName: string,
  newName: string,
): Promise<void> {
  const r = await tracked('remoteRename', () => commands.remoteRename(repoId, oldName, newName));
  if (r.status === 'error') throw r.error;
}

export async function remoteRemove(repoId: string, name: string): Promise<void> {
  const r = await tracked('remoteRemove', () => commands.remoteRemove(repoId, name));
  if (r.status === 'error') throw r.error;
}

export async function remoteSetUrl(repoId: string, name: string, url: string): Promise<void> {
  const r = await tracked('remoteSetUrl', () => commands.remoteSetUrl(repoId, name, url));
  if (r.status === 'error') throw r.error;
}

export async function redoOperation(repoId: string): Promise<DiscardOutcome> {
  const r = await tracked('redoOperation', () => commands.redoOperation(repoId));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function timelineGet(repoId: string, limit: number): Promise<TimelineEntry[]> {
  const r = await commands.timelineGet(repoId, limit);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function restoreTo(repoId: string, oid: string): Promise<ResetOutcome> {
  const r = await tracked('restoreTo', () => commands.timelineRestore(repoId, oid));
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function branchSetUpstream(
  repoId: string,
  branch: string,
  upstream: string | null,
): Promise<BranchInfo> {
  const r = await tracked('branchSetUpstream', () =>
    commands.branchSetUpstream(repoId, branch, upstream),
  );
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function undoRedoState(repoId: string): Promise<UndoRedoState> {
  const r = await commands.undoRedoState(repoId);
  if (r.status === 'error') throw r.error;
  return r.data;
}

export async function remoteBranchList(repoId: string): Promise<string[]> {
  const r = await commands.remoteBranchList(repoId);
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

// ---------------------------------------------------------------------------
// Log file plumbing (in-app viewer + frontend exception entry, TDD §1 sink).
// ---------------------------------------------------------------------------

/** Absolute path of the rolling log directory; null outside the Tauri shell. */
export async function logsDir(): Promise<string | null> {
  if (!isTauriAvailable()) return null;
  const result = await commands.logsDir();
  return result.status === 'ok' ? result.data : null;
}

/** Rolling log files, newest first. */
export async function logsList(): Promise<LogFileInfo[]> {
  const result = await commands.logsList();
  if (result.status === 'error') throw result.error;
  return result.data;
}

/** Tail of one log file for the viewer content pane. */
export async function logsRead(fileName: string, maxBytes?: number): Promise<LogContent> {
  const result = await commands.logsRead(fileName, maxBytes ?? null);
  if (result.status === 'error') throw result.error;
  return result.data;
}

/**
 * One frontend log line into the Rust file sink (shared format). Best-effort:
 * resolves silently outside the Tauri shell and never throws into the caller.
 */
export async function logWeb(
  level: 'info' | 'warn' | 'error',
  scope: string,
  message: string,
): Promise<void> {
  if (!isTauriAvailable()) return;
  try {
    await commands.logWrite(level, scope, message);
  } catch {
    // Logging must never fail the caller, even when the sink is broken.
  }
}
