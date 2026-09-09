import { create } from 'zustand';
import { t } from '../lib/i18n';
import {
  conflictsGet,
  conflictResolve,
  formatIpcError,
  isTauriAvailable,
  mergeAbort,
  mergeStart,
  mergeStateGet,
  resetCommits,
  revertCommits,
  type ConflictFile,
  type EgErrorLike,
  type HumanizedError,
  type MergeState,
  type ResetMode,
} from '../lib/ipc/commands';
import { useLensStore } from './lensStore';
import { useRepoStore } from './repoStore';
import { toast } from './toastStore';

const q = (value: string) => '"' + value.replace(/[\\$"']/g, '$&') + '"';
const record = (command: string) => useLensStore.getState().record(command);

interface MergeStateStore {
  /** Non-null while a merge is parked on conflicts (`.git/MERGE_HEAD`). */
  mergeState: MergeState | null;
  /** Conflicted files with wizard payloads; empty when not mid-merge. */
  conflicts: ConflictFile[];
  /**
   * Every conflict path seen since the merge started. Files leave the
   * conflict list once staged, so resolved = knownPaths - current conflicts.
   */
  knownPaths: string[];
  loading: boolean;
  error: HumanizedError | null;

  /** Re-reads merge state + conflicts for the active repo (fs-watch safe). */
  poll: () => Promise<void>;
  /** Files already resolved: known minus still-conflicted, first-seen order. */
  resolvedPaths: () => string[];
  /** Starts merging `name`; parks on conflicts and opens the wizard. */
  startMerge: (name: string, noFf: boolean) => Promise<boolean>;
  /** Aborts the parked merge, restoring the pre-merge state (danger). */
  abortMerge: () => Promise<boolean>;
  /** Stages one resolved file; returns true when it left the conflict list. */
  resolveFile: (path: string, content: string) => Promise<boolean>;
  /** Reverts commits into the index + worktree for the user to commit. */
  revert: (oids: string[]) => Promise<boolean>;
  /** Resets to a target commit with the three git modes. */
  reset: (mode: ResetMode, target: string | null) => Promise<{ opId: string | null } | null>;
  /** Clears wizard state when the repo closes. */
  clear: () => void;
}

export const useMergeStore = create<MergeStateStore>((set, get) => ({
  mergeState: null,
  conflicts: [],
  knownPaths: [],
  loading: false,
  error: null,

  poll: async () => {
    if (!isTauriAvailable()) return; // seed/test seam: keep state untouched
    const { activeId } = useRepoStore.getState();
    if (!activeId) {
      set({ mergeState: null, conflicts: [], knownPaths: [] });
      return;
    }
    try {
      const state = await mergeStateGet(activeId);
      if (!state) {
        set({ mergeState: null, conflicts: [], knownPaths: [] });
        return;
      }
      const files = await conflictsGet(activeId);
      set((s) => ({
        mergeState: state,
        conflicts: files,
        knownPaths: [...new Set([...s.knownPaths, ...files.map((f) => f.path)])],
      }));
    } catch (error) {
      set({ error: formatIpcError(error as EgErrorLike) });
    }
  },

  resolvedPaths: () => {
    const { knownPaths, conflicts } = get();
    const conflicted = new Set(conflicts.map((f) => f.path));
    return knownPaths.filter((p) => !conflicted.has(p));
  },

  startMerge: async (name, noFf) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    set({ loading: true, error: null });
    try {
      record(`git merge ${q(name)}`);
      const outcome = await mergeStart(activeId, name, noFf);
      await Promise.all([useRepoStore.getState().seed({ status: outcome.status }), get().poll()]);
      if (outcome.conflicts.length > 0) {
        toast.info(t('merge.conflictsParked'));
      } else if (outcome.fastForwarded) {
        toast.success(t('merge.fastForwarded', { name }));
      } else {
        toast.success(t('merge.merged', { name }));
      }
      return true;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      set({ error: humanized });
      toast.error(humanized.title, humanized.detail);
      return false;
    } finally {
      set({ loading: false });
    }
  },

  abortMerge: async () => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      record('git merge --abort');
      const status = await mergeAbort(activeId);
      set({ mergeState: null, conflicts: [], knownPaths: [] });
      await useRepoStore.getState().seed({ status });
      toast.success(t('merge.aborted'));
      return true;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      toast.error(humanized.title, humanized.detail);
      return false;
    }
  },

  resolveFile: async (path, content) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      const status = await conflictResolve(activeId, path, content);
      set((s) => ({ knownPaths: [...new Set([...s.knownPaths, path])] }));
      record(`git add ${q(path)}`);
      await useRepoStore.getState().seed({ status });
      return true;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      toast.error(humanized.title, humanized.detail);
      return false;
    }
  },

  revert: async (oids) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return false;
    try {
      const status = await revertCommits(activeId, oids);
      record(`git revert ${oids.map((o) => o.slice(0, 7)).join(' ')}`);
      await useRepoStore.getState().seed({ status });
      toast.success(t('history.revert.done'));
      return true;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      toast.error(humanized.title, humanized.detail);
      return false;
    }
  },

  reset: async (mode, target) => {
    const { activeId } = useRepoStore.getState();
    if (!activeId) return null;
    const repoStore = useRepoStore.getState();
    try {
      const outcome = await resetCommits(activeId, mode, target);
      record(`git reset --${mode} ${target ? q(target.slice(0, 7)) : 'HEAD'}`);
      await repoStore.seed({ status: outcome.status });
      await get().poll();
      return { opId: outcome.opId };
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      toast.error(humanized.title, humanized.detail);
      return null;
    }
  },

  clear: () => {
    set({ mergeState: null, conflicts: [], knownPaths: [], error: null });
  },
}));
