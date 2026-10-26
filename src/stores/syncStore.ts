import { create } from 'zustand';
import { reportError } from '../lib/ipc/report';
import { withHostKeyTrust } from './sshStore';
import { t } from '../lib/i18n';
import {
  branchList,
  branchSetUpstream,
  fetchRemote as fetchRemoteIpc,
  formatIpcError,
  isTauriAvailable,
  mergeStateGet,
  events,
  pullRemote as pullRemoteIpc,
  pushRemote as pushRemoteIpc,
  redoOperation as redoIpc,
  remoteAdd,
  remoteBranchList,
  remoteList,
  remoteRemove,
  remoteRename,
  remoteSetUrl,
  remoteTest,
  restoreTo as restoreToIpc,
  timelineGet,
  undoRedoState,
  undoOperation,
  type EgErrorLike,
  type HumanizedError,
  type RemoteInfo,
  type SyncStrategy,
  type TimelineEntry,
  type UndoRedoState,
} from '../lib/ipc/commands';
import { useLensStore } from './lensStore';
import { useRepoStore } from './repoStore';
import { toast } from './toastStore';

const q = (value: string) => '"' + value.replace(/[\\$"']/g, '$&') + '"';
const record = (command: string) => useLensStore.getState().record(command);

/** Live sync task strip state (R-22 progress). */
export interface SyncProgressState {
  task: string;
  message: string;
  percent: number | null;
}

/** One remote's outcome in a sequential batch (remotes page). */
export interface RemoteActionResult {
  remote: string;
  status: 'ok' | 'error' | 'rejected' | 'auth' | 'cancelled';
}

/**
 * One-shot HTTPS credentials for pushing to legacy servers. Session memory
 * only: kept in a module-level Map (never in zustand state, never
 * persisted), cleared when the app exits. Passwords never reach logs —
 * `record()` callers must not interpolate them.
 */
export interface PushCredentialsInput {
  username: string;
  password: string;
}

const credentialsCache = new Map<string, PushCredentialsInput>();

/** Test seam: drops all cached session credentials. */
export function clearCachedCredentials(): void {
  credentialsCache.clear();
}

/** A pending credential prompt; resolved by the credentials dialog. */
export interface CredentialsRequest {
  /** Monotonic id so the dialog remounts (clearing inputs) per prompt. */
  id: number;
  remote: string;
  resolve: (creds: PushCredentialsInput | null) => void;
}

let nextCredentialsRequestId = 1;

export function credentialsKey(repoId: string, remote: string): string {
  return `${repoId}\0${remote}`;
}

interface SyncStoreState {
  remotes: RemoteInfo[];
  /** Currently targeted remote for fetch/pull/push (persisted per repo). */
  selectedRemote: string | null;
  /** `origin/main` style short names for the set-upstream dialog. */
  remoteBranches: string[];
  timeline: TimelineEntry[];
  undoRedo: UndoRedoState | null;
  progress: SyncProgressState | null;
  busy: string | null;
  error: HumanizedError | null;
  /** Pending HTTPS credential prompt for the credentials dialog; null when idle. */
  credentialsRequest: CredentialsRequest | null;

  /** Loads remotes, remote branches and the undo/redo state. */
  refresh: () => Promise<void>;
  /** Persists the remote used by the sync buttons for this repository. */
  setSelectedRemote: (remote: string) => void;
  /** Loads the merged reflog + op-log feed (F-28). */
  refreshTimeline: () => Promise<void>;
  /** Subscribes to sync://progress (call once at shell mount). */
  init: () => void;
  fetch: (remote: string, silent?: boolean) => Promise<boolean>;
  /** Returns 'ok' | 'diverged' | 'error'; diverged opens the 分叉 dialog. */
  pull: (
    remote: string,
    branch: string,
    strategy: SyncStrategy,
  ) => Promise<'ok' | 'diverged' | 'error'>;
  /** Returns 'ok' | 'rejected' | 'auth' | 'cancelled' | 'error';
   *  rejected opens the 强推 dialog, auth opens the credentials dialog,
   *  cancelled means the user dismissed a dialog (quiet, no toast). */
  push: (
    remote: string,
    branch: string,
    force: boolean,
    silent?: boolean,
  ) => Promise<'ok' | 'rejected' | 'auth' | 'cancelled' | 'error'>;
  /** Pushes the current branch to every remote (non-force, sequential). */
  pushAll: (branch: string) => Promise<RemoteActionResult[]>;
  /** Fetches the given remotes sequentially, suppressing per-remote toasts. */
  fetchMany: (names: string[]) => Promise<RemoteActionResult[]>;
  /** Tests the given remotes sequentially, suppressing per-remote toasts. */
  testMany: (names: string[]) => Promise<RemoteActionResult[]>;
  /** Pushes the current branch to the given remotes (non-force, sequential). */
  pushMany: (branch: string, names: string[]) => Promise<RemoteActionResult[]>;
  testRemote: (name: string, silent?: boolean) => Promise<number | null>;
  addRemote: (name: string, url: string) => Promise<boolean>;
  renameRemote: (oldName: string, newName: string) => Promise<boolean>;
  removeRemote: (name: string) => Promise<boolean>;
  setRemoteUrl: (name: string, url: string) => Promise<boolean>;
  /** Redoes the latest undone op; returns the op id for the toast. */
  redo: () => Promise<string | null>;
  /** Snapshot-protected hard reset to a timeline entry (F-28). */
  restoreTo: (oid: string) => Promise<string | null>;
  /** Sets (or clears with null) a branch's upstream (W7 顺延). */
  setUpstream: (branch: string, upstream: string | null) => Promise<boolean>;
  clear: () => void;
}

const remoteStorageKey = (repoId: string): string => `eg.sync.remote.${repoId}`;

/** Binds a branch with no upstream to the remote it was just pushed to. */
async function maybeSetUpstream(repoId: string, branch: string, remote: string): Promise<void> {
  try {
    const branches = await branchList(repoId);
    const current = branches.find((entry) => entry.isCurrent);
    if (current && !current.upstream) {
      await branchSetUpstream(repoId, branch, `${remote}/${branch}`);
    }
  } catch {
    // Upstream is a convenience; a failure must not fail the push.
  }
}

export const useSyncStore = create<SyncStoreState>()((set, get) => ({
  remotes: [],
  selectedRemote: null,
  remoteBranches: [],
  timeline: [],
  undoRedo: null,
  progress: null,
  busy: null,
  error: null,
  credentialsRequest: null,

  refresh: async () => {
    if (!isTauriAvailable()) return; // seed/test seam
    const { activeId } = useRepoStore.getState();
    if (!activeId) {
      set({ remotes: [], selectedRemote: null, remoteBranches: [], undoRedo: null });
      return;
    }
    try {
      const [remotes, branches, state] = await Promise.all([
        remoteList(activeId),
        remoteBranchList(activeId),
        undoRedoState(activeId),
      ]);
      const saved =
        typeof localStorage === 'undefined'
          ? null
          : localStorage.getItem(remoteStorageKey(activeId));
      let selected = remotes.find((remote) => remote.name === saved)?.name ?? null;
      if (!selected && remotes.length > 1) {
        // Prefer the current branch's upstream remote when the user has not
        // picked one yet; the extra branch_list call only happens in that case.
        try {
          const list = await branchList(activeId);
          const current = list.find((branch) => branch.isCurrent);
          const upstreamRemote = current?.upstream?.split('/')[0] ?? null;
          selected = remotes.find((remote) => remote.name === upstreamRemote)?.name ?? null;
        } catch {
          selected = null;
        }
      }
      selected ??=
        remotes.find((remote) => remote.name === 'origin')?.name ?? remotes[0]?.name ?? null;
      set({
        remotes,
        remoteBranches: branches,
        undoRedo: state,
        selectedRemote: selected,
        error: null,
      });
    } catch (error) {
      set({ error: formatIpcError(error as EgErrorLike) });
    }
  },

  setSelectedRemote: (remote) => {
    const { activeId } = useRepoStore.getState();
    if (activeId && typeof localStorage !== 'undefined') {
      localStorage.setItem(remoteStorageKey(activeId), remote);
    }
    set({ selectedRemote: remote });
  },

  refreshTimeline: async () => {
    if (!isTauriAvailable()) return;
    const { activeId } = useRepoStore.getState();
    if (!activeId) {
      set({ timeline: [] });
      return;
    }
    try {
      const timeline = await timelineGet(activeId, 200);
      set({ timeline, error: null });
    } catch (error) {
      set({ error: formatIpcError(error as EgErrorLike) });
    }
  },

  init: () => {
    // The unlisten hook mirrors repoStore's pattern (single subscription).
    let unlisten: (() => void) | null = null;
    void (async () => {
      unlisten = await events.syncProgress.listen((event) => {
        const { payload } = event;
        if (payload.done) {
          set({ progress: null, busy: null });
          return;
        }
        set({
          progress: {
            task: payload.task,
            message: payload.message,
            percent: payload.percent,
          },
        });
      });
    })();
    return () => unlisten?.();
  },

  fetch: async (remote, silent = false) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId || get().busy) return false;
    set({ busy: 'fetch' });
    try {
      record(`git fetch ${q(remote)}`);
      const status = await withHostKeyTrust(() => fetchRemoteIpc(activeId, remote, true));
      await useRepoStore.getState().seed({ status });
      if (!silent) toast.success(t('sync.fetched', { remote }));
      await get().refresh();
      return true;
    } catch (error) {
      if (!silent) reportError(error, 'sync');
      return false;
    } finally {
      set({ busy: null, progress: null });
    }
  },

  pull: async (remote, branch, strategy) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId || get().busy) return 'error';
    set({ busy: 'pull' });
    try {
      record(`git pull ${q(remote)} ${q(branch)}`);
      const outcome = await withHostKeyTrust(() =>
        pullRemoteIpc(activeId, remote, branch, strategy),
      );
      await useRepoStore.getState().seed({ status: outcome.status });
      if (outcome.conflicts.length > 0) {
        toast.info(t('merge.conflictsParked'));
      } else if (outcome.fastForwarded) {
        toast.success(t('sync.pulledFf', { remote }));
      } else {
        toast.success(t('sync.pulled', { remote }));
      }
      // A parked pull merge behaves exactly like a parked merge; refresh it.
      if (outcome.conflicts.length > 0) {
        await mergeStateGet(activeId);
      }
      await get().refresh();
      return 'ok';
    } catch (error) {
      const raw = error as EgErrorLike;
      if (raw.code === 'conflict_state' && String(raw.state ?? '').includes('分叉')) {
        return 'diverged';
      }
      reportError(raw, 'sync');
      return 'error';
    } finally {
      set({ busy: null, progress: null });
    }
  },

  push: async (remote, branch, force, silent = false) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId || get().busy) return 'error';
    set({ busy: 'push' });
    try {
      const flag = force ? '--force-with-lease ' : '';
      record(`git push ${flag}${q(remote)} ${q(branch)}`);
      // First attempt is ambient (system credential helpers); the askpass
      // fallback below only kicks in on an Auth rejection.
      const attempt = async (creds: PushCredentialsInput | null) => {
        const status = await withHostKeyTrust(() =>
          pushRemoteIpc(activeId, remote, branch, force, creds),
        );
        await useRepoStore.getState().seed({ status });
        if (!silent) {
          toast.success(t('sync.pushed', { remote }));
          // First successful push to a remote becomes the branch upstream;
          // an existing upstream is left alone (mirror pushes stay one-off).
          await maybeSetUpstream(activeId, branch, remote);
        }
        await get().refresh();
      };
      try {
        await attempt(credentialsCache.get(credentialsKey(activeId, remote)) ?? null);
        return 'ok';
      } catch (error) {
        const raw = error as EgErrorLike;
        if (raw.code === 'conflict_state') {
          return 'rejected';
        }
        // SSH key failures must not open the HTTPS username/password dialog:
        // the actionable path is the SSH setup wizard (hint action).
        if (raw.code !== 'auth' || String(raw.provider ?? '').startsWith('ssh-')) {
          throw error;
        }
        // Auth fallback for legacy HTTPS servers: the cached session
        // credential (if any) already failed above, so prompt and retry once.
        credentialsCache.delete(credentialsKey(activeId, remote));
        const creds = await new Promise<PushCredentialsInput | null>((resolve) => {
          const id = nextCredentialsRequestId;
          nextCredentialsRequestId += 1;
          set({ credentialsRequest: { id, remote, resolve } });
        });
        set({ credentialsRequest: null });
        if (!creds) return 'cancelled';
        try {
          await attempt(creds);
        } catch (retryError) {
          if ((retryError as EgErrorLike).code === 'auth') {
            if (!silent) {
              toast.error(t('sync.authFailed'), formatIpcError(retryError as EgErrorLike).reason);
            }
            return 'auth';
          }
          throw retryError;
        }
        credentialsCache.set(credentialsKey(activeId, remote), creds);
        return 'ok';
      }
    } catch (error) {
      if (!silent) reportError(error, 'sync');
      return 'error';
    } finally {
      set({ busy: null, progress: null });
    }
  },

  pushMany: async (branch, names) => {
    const { activeId } = useRepoStore.getState();
    const unique = [...new Set(names)];
    if (!activeId || get().busy || unique.length === 0) return [];
    const results: RemoteActionResult[] = [];
    for (const remote of unique) {
      const status = await get().push(remote, branch, false, true);
      results.push({ remote, status });
      if (status === 'cancelled') break;
    }
    const ok = results.filter((result) => result.status === 'ok').length;
    const failed = results.filter(
      (result) => result.status !== 'ok' && result.status !== 'cancelled',
    );
    if (failed.length > 0) {
      toast.error(
        t('sync.pushAllPartial', { ok, failed: failed.length }),
        failed.map((result) => result.remote).join('、'),
      );
    } else if (results.some((result) => result.status === 'cancelled')) {
      toast.info(t('sync.pushAllCancelled'));
    } else {
      toast.success(t('sync.pushAllDone', { count: ok }));
    }
    return results;
  },

  pushAll: async (branch) => {
    const { activeId } = useRepoStore.getState();
    const { remotes, selectedRemote } = get();
    if (!activeId || get().busy || remotes.length === 0) return [];
    const ordered = [
      ...remotes.filter((remote) => remote.name === selectedRemote),
      ...remotes.filter((remote) => remote.name !== selectedRemote),
    ];
    return get().pushMany(
      branch,
      ordered.map((remote) => remote.name),
    );
  },

  fetchMany: async (names) => {
    const { activeId } = useRepoStore.getState();
    const unique = [...new Set(names)];
    if (!activeId || get().busy || unique.length === 0) return [];
    const results: RemoteActionResult[] = [];
    for (const remote of unique) {
      const ok = await get().fetch(remote, true);
      results.push({ remote, status: ok ? 'ok' : 'error' });
    }
    const ok = results.filter((result) => result.status === 'ok').length;
    const failed = results.filter((result) => result.status !== 'ok');
    if (failed.length > 0) {
      toast.error(
        t('remotes.bulkFetchPartial', { ok, failed: failed.length }),
        failed.map((result) => result.remote).join('、'),
      );
    } else {
      toast.success(t('remotes.bulkFetchDone', { count: ok }));
    }
    return results;
  },

  testMany: async (names) => {
    const { activeId } = useRepoStore.getState();
    const unique = [...new Set(names)];
    if (!activeId || get().busy || unique.length === 0) return [];
    const results: RemoteActionResult[] = [];
    for (const remote of unique) {
      const count = await get().testRemote(remote, true);
      results.push({ remote, status: count === null ? 'error' : 'ok' });
    }
    const ok = results.filter((result) => result.status === 'ok').length;
    const failed = results.filter((result) => result.status !== 'ok');
    if (failed.length > 0) {
      toast.error(
        t('remotes.bulkTestPartial', { ok, failed: failed.length }),
        failed.map((result) => result.remote).join('、'),
      );
    } else {
      toast.success(t('remotes.bulkTestDone', { count: ok }));
    }
    return results;
  },

  testRemote: async (name, silent = false) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return null;
    try {
      const count = await withHostKeyTrust(() => remoteTest(activeId, name));
      if (!silent) toast.success(t('sync.testOk', { count }));
      return count;
    } catch (error) {
      if (!silent) reportError(error, 'sync');
      return null;
    }
  },

  addRemote: async (name, url) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      await remoteAdd(activeId, name, url);
      record(`git remote add ${q(name)} ${q(url)}`);
      toast.success(t('sync.remoteAdded', { name }));
      await get().refresh();
      return true;
    } catch (error) {
      reportError(error, 'sync');
      return false;
    }
  },

  renameRemote: async (oldName, newName) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      await remoteRename(activeId, oldName, newName);
      record(`git remote rename ${q(oldName)} ${q(newName)}`);
      toast.success(t('sync.remoteRenamed', { newName }));
      await get().refresh();
      return true;
    } catch (error) {
      reportError(error, 'sync');
      return false;
    }
  },

  removeRemote: async (name) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      await remoteRemove(activeId, name);
      record(`git remote remove ${q(name)}`);
      toast.success(t('sync.remoteRemoved', { name }));
      await get().refresh();
      return true;
    } catch (error) {
      reportError(error, 'sync');
      return false;
    }
  },

  setRemoteUrl: async (name, url) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      await remoteSetUrl(activeId, name, url);
      record(`git remote set-url ${q(name)} ${q(url)}`);
      toast.success(t('sync.remoteUrlSet', { name }));
      await get().refresh();
      return true;
    } catch (error) {
      reportError(error, 'sync');
      return false;
    }
  },

  redo: async () => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return null;
    try {
      const outcome = await redoIpc(activeId);
      await useRepoStore.getState().seed({ status: outcome.status });
      toast.success(t('toast.undone'));
      await get().refresh();
      return outcome.opId;
    } catch (error) {
      reportError(error, 'sync');
      return null;
    }
  },

  restoreTo: async (oid) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return null;
    try {
      const outcome = await restoreToIpc(activeId, oid);
      await useRepoStore.getState().seed({ status: outcome.status });
      if (outcome.opId) {
        toast.info(t('sync.restored'), {
          label: t('toast.undo'),
          onClick: () => void undoOperation(activeId, outcome.opId as string),
        });
      }
      await get().refresh();
      await get().refreshTimeline();
      return outcome.opId;
    } catch (error) {
      reportError(error, 'sync');
      return null;
    }
  },

  setUpstream: async (branch, upstream) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      await branchSetUpstream(activeId, branch, upstream);
      record(
        upstream
          ? `git branch --set-upstream-to=${q(upstream)} ${q(branch)}`
          : `git branch --unset-upstream ${q(branch)}`,
      );
      toast.success(t('sync.upstreamSet', { branch }));
      // The refs store keeps its own branch cache; seed refreshes status but
      // the branch board re-fetches on view mount.
      await get().refresh();
      return true;
    } catch (error) {
      reportError(error, 'sync');
      return false;
    }
  },

  clear: () => {
    set({
      remotes: [],
      selectedRemote: null,
      remoteBranches: [],
      timeline: [],
      undoRedo: null,
      progress: null,
      credentialsRequest: null,
    });
  },
}));
