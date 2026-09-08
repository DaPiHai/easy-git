import { create } from 'zustand';
import {
  commitDetail,
  formatIpcError,
  isTauriAvailable,
  listBranches,
  logPage,
  type CommitDetail,
  type CommitLogEntry,
  type EgErrorLike,
  type HumanizedError,
  type LogFilter,
} from '../lib/ipc/commands';
import { useRepoStore } from './repoStore';

/** PRD §5.3: first page loads 500 commits, scrolling fetches more. */
export const PAGE_SIZE = 500;

interface HistoryState {
  entries: CommitLogEntry[];
  branch: string | null;
  branches: string[];
  /** Offset for the next page request; null when the walk is exhausted. */
  nextOffset: number | null;
  loading: boolean;
  error: HumanizedError | null;
  filter: LogFilter;
  selectedOid: string | null;
  detail: CommitDetail | null;
  detailLoading: boolean;

  /** Resets state and loads the first page for the active repo. */
  load: () => Promise<void>;
  /** Appends the next page (scroll续读). */
  loadMore: () => Promise<void>;
  /** Applies a partial filter and reloads from the first page. */
  setFilter: (partial: Partial<LogFilter>) => Promise<void>;
  /** Selects a commit and fetches its detail (F-16). */
  selectCommit: (oid: string | null) => Promise<void>;
  seed: (partial: Partial<HistoryState>) => void;
}

export const useHistoryStore = create<HistoryState>()((set, get) => {
  const activeId = () => useRepoStore.getState().activeId;

  const fetchBranches = async () => {
    const repoId = activeId();
    if (!repoId) return;
    try {
      const branches = await listBranches(repoId);
      set({ branches });
    } catch {
      // The dropdown degrades to an empty list; the log still works.
    }
  };

  return {
    entries: [],
    branch: null,
    branches: [],
    nextOffset: null,
    loading: false,
    error: null,
    filter: { branch: null, author: null, message: null },
    selectedOid: null,
    detail: null,
    detailLoading: false,

    load: async () => {
      // Browser previews have no IPC; keep whatever the harness seeded.
      if (!isTauriAvailable()) return;
      const repoId = activeId();
      if (!repoId) {
        set({
          entries: [],
          branches: [],
          nextOffset: null,
          branch: null,
          selectedOid: null,
          detail: null,
          error: null,
        });
        return;
      }
      set({ loading: true, entries: [], nextOffset: null, selectedOid: null, detail: null });
      try {
        const page = await logPage(repoId, 0, PAGE_SIZE, get().filter);
        set({ entries: page.entries, nextOffset: page.nextOffset, branch: page.branch });
        void fetchBranches();
      } catch (error) {
        set({ error: formatIpcError(error as EgErrorLike) });
      } finally {
        set({ loading: false });
      }
    },

    loadMore: async () => {
      if (!isTauriAvailable()) return;
      const repoId = activeId();
      const { nextOffset, loading, entries } = get();
      if (!repoId || nextOffset === null || loading || entries.length === 0) return;
      set({ loading: true });
      try {
        const page = await logPage(repoId, nextOffset, PAGE_SIZE, get().filter);
        // Guard against a watch-triggered reload racing the append.
        if (get().nextOffset === nextOffset) {
          set((s) => ({ entries: [...s.entries, ...page.entries], nextOffset: page.nextOffset }));
        }
      } catch (error) {
        set({ error: formatIpcError(error as EgErrorLike) });
      } finally {
        set({ loading: false });
      }
    },

    setFilter: async (partial) => {
      set((s) => ({ filter: { ...s.filter, ...partial } }));
      await get().load();
    },

    selectCommit: async (oid) => {
      if (!oid) {
        set({ selectedOid: null, detail: null });
        return;
      }
      set({ selectedOid: oid, detailLoading: true });
      const repoId = activeId();
      if (!repoId || !isTauriAvailable()) return;
      try {
        const detail = await commitDetail(repoId, oid);
        if (get().selectedOid === oid) set({ detail });
      } catch (error) {
        set({ error: formatIpcError(error as EgErrorLike) });
      } finally {
        set({ detailLoading: false });
      }
    },

    seed: (partial) => set(partial),
  };
});
