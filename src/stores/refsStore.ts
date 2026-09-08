import { create } from 'zustand';
import { t } from '../lib/i18n';
import {
  branchCreate,
  branchDelete,
  branchList,
  branchRename,
  branchSwitch,
  formatIpcError,
  isTauriAvailable,
  stashApply,
  stashDrop,
  stashList,
  stashPush,
  tagCreate,
  tagDelete,
  tagList,
  undoOperation,
  type BranchInfo,
  type EgErrorLike,
  type HumanizedError,
  type StashEntry,
  type TagInfo,
} from '../lib/ipc/commands';
import { useLensStore } from './lensStore';
import { useRepoStore } from './repoStore';
import { toast } from './toastStore';

const q = (value: string) => '"' + value.replace(/[\\$"']/g, '$&') + '"';
const record = (command: string) => useLensStore.getState().record(command);

/** Outcome of switchBranch: 'dirty' drives the stash-suggestion dialog. */
export type SwitchResult = 'ok' | 'dirty' | 'error';

interface RefsState {
  branches: BranchInfo[];
  tags: TagInfo[];
  stashes: StashEntry[];
  loading: boolean;
  error: HumanizedError | null;

  /** Reloads branches, tags and stashes for the active repo. */
  refresh: () => Promise<void>;
  createBranch: (name: string, oid: string | null) => Promise<boolean>;
  renameBranch: (oldName: string, newName: string) => Promise<boolean>;
  /** Returns the op id for the 撤销 toast, or null on failure. */
  deleteBranch: (name: string) => Promise<string | null>;
  switchBranch: (name: string) => Promise<SwitchResult>;
  createTag: (name: string, oid: string | null, message: string | null) => Promise<boolean>;
  deleteTag: (name: string) => Promise<string | null>;
  stashPush: (message: string | null, includeUntracked: boolean) => Promise<boolean>;
  stashApply: (index: number, pop: boolean) => Promise<boolean>;
  stashDrop: (index: number) => Promise<boolean>;
  seed: (partial: Partial<RefsState>) => void;
}

export const useRefStore = create<RefsState>()((set, get) => {
  const activeId = () => useRepoStore.getState().activeId;

  const refreshActiveStatus = async (status: import('../lib/ipc/commands').StatusReport) => {
    useRepoStore.getState().seed({ status });
  };

  /** Keeps the top-bar repo summary's branch in sync after a switch. */
  const syncRepoBranch = (branch: string | null) => {
    const { activeId, repos } = useRepoStore.getState();
    if (!activeId || !branch) return;
    const summary = repos[activeId];
    if (summary) {
      useRepoStore.getState().seed({
        repos: { ...repos, [activeId]: { ...summary, branch } },
      });
    }
  };

  return {
    branches: [],
    tags: [],
    stashes: [],
    loading: false,
    error: null,

    refresh: async () => {
      const repoId = activeId();
      if (!repoId || !isTauriAvailable()) return;
      set({ loading: true });
      try {
        const [branches, tags, stashes] = await Promise.all([
          branchList(repoId),
          tagList(repoId),
          stashList(repoId),
        ]);
        set({ branches, tags, stashes });
      } catch (error) {
        set({ error: formatIpcError(error as EgErrorLike) });
      } finally {
        set({ loading: false });
      }
    },

    createBranch: async (name, oid) => {
      const repoId = activeId();
      if (!repoId) return false;
      try {
        await branchCreate(repoId, name, oid);
        record(oid ? `git branch ${q(name)} ${oid.slice(0, 7)}` : `git branch ${q(name)}`);
        toast.success(t('branch.created', { name }));
        await get().refresh();
        return true;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return false;
      }
    },

    renameBranch: async (oldName, newName) => {
      const repoId = activeId();
      if (!repoId) return false;
      try {
        await branchRename(repoId, oldName, newName);
        record(`git branch -m ${q(oldName)} ${q(newName)}`);
        toast.success(t('branch.renamed', { name: newName }));
        await get().refresh();
        return true;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return false;
      }
    },

    deleteBranch: async (name) => {
      const repoId = activeId();
      if (!repoId) return null;
      try {
        const opId = await branchDelete(repoId, name);
        record(`git branch -D ${q(name)}`);
        toast.info(t('branch.deleted', { name }), {
          label: t('toast.undo'),
          onClick: () => {
            void undoOperation(repoId, opId).then(() => void get().refresh());
          },
        });
        await get().refresh();
        return opId;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return null;
      }
    },

    switchBranch: async (name) => {
      const repoId = activeId();
      if (!repoId) return 'error';
      try {
        const status = await branchSwitch(repoId, name);
        record(`git switch ${q(name)}`);
        syncRepoBranch(status.branch);
        await Promise.all([get().refresh(), refreshActiveStatus(status)]);
        return 'ok';
      } catch (error) {
        if ((error as EgErrorLike).code === 'dirty_worktree') return 'dirty';
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return 'error';
      }
    },

    createTag: async (name, oid, message) => {
      const repoId = activeId();
      if (!repoId) return false;
      try {
        const target = oid ?? get().branches.find((b) => b.isCurrent)?.tipOid ?? null;
        if (!target) {
          toast.error(t('tag.targetMissing'));
          return false;
        }
        await tagCreate(repoId, name, target, message);
        record(message ? `git tag -a ${q(name)} -m ${q(message)}` : `git tag ${q(name)}`);
        toast.success(t('tag.created', { name }));
        await get().refresh();
        return true;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return false;
      }
    },

    deleteTag: async (name) => {
      const repoId = activeId();
      if (!repoId) return null;
      try {
        const opId = await tagDelete(repoId, name);
        record(`git tag -d ${q(name)}`);
        toast.info(t('tag.deleted', { name }), {
          label: t('toast.undo'),
          onClick: () => {
            void undoOperation(repoId, opId).then(() => void get().refresh());
          },
        });
        await get().refresh();
        return opId;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return null;
      }
    },

    stashPush: async (message, includeUntracked) => {
      const repoId = activeId();
      if (!repoId) return false;
      try {
        const status = await stashPush(repoId, message, includeUntracked);
        record(
          includeUntracked
            ? `git stash push -u ${message ? `-m ${q(message)}` : ''}`.trim()
            : `git stash push ${message ? `-m ${q(message)}` : ''}`.trim(),
        );
        toast.success(t('stash.saved'));
        await refreshActiveStatus(status);
        await get().refresh();
        return true;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return false;
      }
    },

    stashApply: async (index, pop) => {
      const repoId = activeId();
      if (!repoId) return false;
      try {
        const status = await stashApply(repoId, index, pop);
        record(pop ? `git stash pop stash@{${index}}` : `git stash apply stash@{${index}}`);
        toast.success(t(pop ? 'stash.popped' : 'stash.applied'));
        await refreshActiveStatus(status);
        await get().refresh();
        return true;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return false;
      }
    },

    stashDrop: async (index) => {
      const repoId = activeId();
      if (!repoId) return false;
      try {
        await stashDrop(repoId, index);
        record(`git stash drop stash@{${index}}`);
        toast.success(t('stash.dropped'));
        await get().refresh();
        return true;
      } catch (error) {
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
        return false;
      }
    },

    seed: (partial) => set(partial),
  };
});
