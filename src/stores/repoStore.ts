import { create } from 'zustand';
import {
  closeRepo,
  formatIpcError,
  getStatus,
  initRepo,
  isTauriAvailable,
  openRepo as openRepoIpc,
  pickDirectory,
  type EgErrorLike,
  type HumanizedError,
  type RepoSummary,
  type StatusReport,
} from '../lib/ipc/commands';
import type { RepoChanged } from '../lib/ipc/bindings';
import type { ChangeEntry } from '../lib/ipc/commands';

export interface RepoMeta {
  path: string;
  name: string;
}

const RECENTS_KEY = 'eg.repo.recents';
const FAVORITES_KEY = 'eg.repo.favorites';
const MAX_RECENTS = 10;

function loadJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function saveJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Persistence is best-effort; the session keeps working without it.
  }
}

function toMeta(summary: RepoSummary): RepoMeta {
  return { path: summary.path, name: summary.name };
}

function humanize(error: unknown): HumanizedError {
  return formatIpcError(error as EgErrorLike);
}

export interface RepoSeed {
  repos?: Record<string, RepoSummary>;
  activeId?: string | null;
  status?: StatusReport | null;
  recents?: RepoMeta[];
  favorites?: string[];
  selectedChange?: ChangeEntry | null;
  error?: HumanizedError | null;
}

interface RepoState {
  /** Open repositories keyed by repo id. */
  repos: Record<string, RepoSummary>;
  activeId: string | null;
  status: StatusReport | null;
  statusLoading: boolean;
  /** Humanized failure of the last open/init attempt; null when dismissed. */
  error: HumanizedError | null;
  recents: RepoMeta[];
  favorites: string[];
  /** File row selected in the changes view; drives the detail panel. */
  selectedChange: ChangeEntry | null;

  /** Loads persisted prefs and subscribes to repo://changed. Call once. */
  init: () => void;
  dispose: () => void;

  openByPath: (path: string) => Promise<void>;
  initAt: (path: string) => Promise<void>;
  pickAndOpen: () => Promise<void>;
  pickAndInit: () => Promise<void>;
  activate: (repoId: string) => Promise<void>;
  close: (repoId: string) => Promise<void>;
  refreshStatus: () => Promise<void>;
  toggleFavorite: (path: string) => void;
  dismissError: () => void;
  setSelectedChange: (change: ChangeEntry | null) => void;
  /** fs-watch callback; coalesces bursts before refreshing status. */
  onRepoChanged: (repoId: string) => void;
  /** Test seam: seed state directly (tests / snapshot harness). */
  seed: (partial: RepoSeed) => void;
}

let unlisten: (() => void) | null = null;
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export const useRepoStore = create<RepoState>()((set, get) => {
  const putRecent = (summary: RepoSummary) => {
    const meta = toMeta(summary);
    const rest = get().recents.filter((r) => r.path !== meta.path);
    const recents = [meta, ...rest].slice(0, MAX_RECENTS);
    saveJson(RECENTS_KEY, recents);
    set({ recents });
  };

  const refreshActiveStatus = async () => {
    const { activeId } = get();
    if (!activeId) return;
    set({ statusLoading: true });
    try {
      const status = await getStatus(activeId);
      if (get().activeId === activeId) set({ status });
    } catch (error) {
      set({ error: humanize(error) });
    } finally {
      set({ statusLoading: false });
    }
  };

  return {
    repos: {},
    activeId: null,
    status: null,
    statusLoading: false,
    error: null,
    recents: loadJson<RepoMeta[]>(RECENTS_KEY, []),
    favorites: loadJson<string[]>(FAVORITES_KEY, []),
    selectedChange: null,

    init: () => {
      if (unlisten) return;
      // Browser previews have no Tauri event system; skip subscribing there.
      if (!isTauriAvailable()) return;
      void import('../lib/ipc/bindings')
        .then(({ events }) =>
          events.repoChanged.listen((event: { payload: RepoChanged }) => {
            get().onRepoChanged(event.payload.repoId);
          }),
        )
        .then((fn) => {
          unlisten = fn;
        });
    },
    dispose: () => {
      unlisten?.();
      unlisten = null;
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = null;
    },

    openByPath: async (path) => {
      set({ error: null });
      try {
        const summary = await openRepoIpc(path);
        set((s) => ({ repos: { ...s.repos, [summary.repoId]: summary } }));
        putRecent(summary);
        await get().activate(summary.repoId);
      } catch (error) {
        set({ error: humanize(error) });
      }
    },

    initAt: async (path) => {
      set({ error: null });
      try {
        const summary = await initRepo(path);
        set((s) => ({ repos: { ...s.repos, [summary.repoId]: summary } }));
        putRecent(summary);
        await get().activate(summary.repoId);
      } catch (error) {
        set({ error: humanize(error) });
      }
    },

    pickAndOpen: async () => {
      const path = await pickDirectory('打开仓库');
      if (path) await get().openByPath(path);
    },

    pickAndInit: async () => {
      const path = await pickDirectory('新建仓库');
      if (path) await get().initAt(path);
    },

    activate: async (repoId) => {
      if (get().activeId !== repoId) set({ activeId: repoId, status: null });
      await refreshActiveStatus();
    },

    close: async (repoId) => {
      try {
        await closeRepo(repoId);
      } catch (error) {
        set({ error: humanize(error) });
        return;
      }
      set((s) => {
        const repos = { ...s.repos };
        delete repos[repoId];
        const nextActive = s.activeId === repoId ? (Object.keys(repos)[0] ?? null) : s.activeId;
        return { repos, activeId: nextActive, status: null };
      });
      const { activeId } = get();
      if (activeId) await get().activate(activeId);
    },

    refreshStatus: refreshActiveStatus,

    toggleFavorite: (path) => {
      const favorites = get().favorites.includes(path)
        ? get().favorites.filter((p) => p !== path)
        : [...get().favorites, path];
      saveJson(FAVORITES_KEY, favorites);
      set({ favorites });
    },

    dismissError: () => set({ error: null }),
    setSelectedChange: (change) => set({ selectedChange: change }),

    onRepoChanged: (repoId) => {
      if (repoId !== get().activeId) return;
      // Backend already debounces 300ms; this coalesces event bursts too.
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshActiveStatus();
      }, 150);
    },

    seed: (partial) => set(partial),
  };
});
