import { create } from 'zustand';
import { t } from '../lib/i18n';
import {
  diffFile,
  formatIpcError,
  isTauriAvailable,
  stageLines,
  type DiffRequest,
  type DiffResponse,
  type EgErrorLike,
  type HumanizedError,
  type SelectedHunk,
} from '../lib/ipc/commands';
import { useRepoStore } from './repoStore';
import { toast } from './toastStore';

/**
 * Single-slot diff viewer state (m1-plan F-18/F-19): the detail panel shows
 * one file diff at a time; `applySelection` stages/unstages the selected
 * hunks/lines and refreshes status + the diff itself.
 */
interface DiffState {
  request: DiffRequest | null;
  data: DiffResponse | null;
  loading: boolean;
  error: HumanizedError | null;

  open: (request: DiffRequest) => Promise<void>;
  close: () => void;
  /** Applies the selection on the current request; true on success. */
  applySelection: (hunks: SelectedHunk[]) => Promise<boolean>;
  seed: (partial: Partial<DiffState>) => void;
}

export const useDiffStore = create<DiffState>()((set, get) => ({
  request: null,
  data: null,
  loading: false,
  error: null,

  open: async (request) => {
    // Snapshot harness has no IPC; keep whatever the harness seeded.
    if (!isTauriAvailable()) return;
    set({ request, data: null, error: null });
    const repoId = useRepoStore.getState().activeId;
    if (!repoId) return;
    set({ loading: true });
    try {
      const data = await diffFile(repoId, request);
      // Ignore a stale reply when the user switched files mid-flight.
      const current = get().request;
      if (
        current?.path === request.path &&
        current?.source === request.source &&
        current?.commitOid === request.commitOid
      ) {
        set({ data });
      }
    } catch (error) {
      set({ error: formatIpcError(error as EgErrorLike) });
    } finally {
      set({ loading: false });
    }
  },

  close: () => set({ request: null, data: null, error: null, loading: false }),

  applySelection: async (hunks) => {
    const { request } = get();
    const repoId = useRepoStore.getState().activeId;
    if (!request || !repoId || hunks.length === 0) return false;
    try {
      const status = await stageLines(repoId, {
        path: request.path,
        source: request.source,
        hunks,
      });
      useRepoStore.getState().seed({ status });
      toast.success(
        request.source === 'worktree' ? t('toast.lineStaged') : t('toast.lineUnstaged'),
      );
      await get().open(request); // refetch the shrunken diff
      return true;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      toast.error(humanized.title, humanized.detail);
      return false;
    }
  },

  seed: (partial) => set(partial),
}));
