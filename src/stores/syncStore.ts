import { create } from 'zustand';
import { reportError } from '../lib/ipc/report';
import { t } from '../lib/i18n';
import {
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
  /** Loads the merged reflog + op-log feed (F-28). */
  refreshTimeline: () => Promise<void>;
  /** Subscribes to sync://progress (call once at shell mount). */
  init: () => void;
  fetch: (remote: string) => Promise<boolean>;
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
  ) => Promise<'ok' | 'rejected' | 'auth' | 'cancelled' | 'error'>;
  testRemote: (name: string) => Promise<number | null>;
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

export const useSyncStore = create<SyncStoreState>((set, get) => ({
  remotes: [],
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
      set({ remotes: [], remoteBranches: [], undoRedo: null });
      return;
    }
    try {
      const [remotes, branches, state] = await Promise.all([
        remoteList(activeId),
        remoteBranchList(activeId),
        undoRedoState(activeId),
      ]);
      set({ remotes, remoteBranches: branches, undoRedo: state, error: null });
    } catch (error) {
      set({ error: formatIpcError(error as EgErrorLike) });
    }
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

  fetch: async (remote) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId || get().busy) return false;
    set({ busy: 'fetch' });
    try {
      record(`git fetch ${q(remote)}`);
      const status = await fetchRemoteIpc(activeId, remote, true);
      await useRepoStore.getState().seed({ status });
      toast.success(t('sync.fetched', { remote }));
      await get().refresh();
      return true;
    } catch (error) {
      reportError(error, 'sync');
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
      const outcome = await pullRemoteIpc(activeId, remote, branch, strategy);
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

  push: async (remote, branch, force) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId || get().busy) return 'error';
    set({ busy: 'push' });
    try {
      const flag = force ? '--force-with-lease ' : '';
      record(`git push ${flag}${q(remote)} ${q(branch)}`);
      // First attempt is ambient (system credential helpers); the askpass
      // fallback below only kicks in on an Auth rejection.
      const attempt = async (creds: PushCredentialsInput | null) => {
        const status = await pushRemoteIpc(activeId, remote, branch, force, creds);
        await useRepoStore.getState().seed({ status });
        toast.success(t('sync.pushed', { remote }));
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
        if (raw.code !== 'auth') {
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
            toast.error(t('sync.authFailed'));
            return 'auth';
          }
          throw retryError;
        }
        credentialsCache.set(credentialsKey(activeId, remote), creds);
        return 'ok';
      }
    } catch (error) {
      reportError(error, 'sync');
      return 'error';
    } finally {
      set({ busy: null, progress: null });
    }
  },

  testRemote: async (name) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return null;
    try {
      const count = await remoteTest(activeId, name);
      toast.success(t('sync.testOk', { count }));
      return count;
    } catch (error) {
      reportError(error, 'sync');
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
      remoteBranches: [],
      timeline: [],
      undoRedo: null,
      progress: null,
      credentialsRequest: null,
    });
  },
}));
