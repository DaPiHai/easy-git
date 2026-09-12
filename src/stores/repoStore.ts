import { create } from 'zustand';
import { reportError } from '../lib/ipc/report';
import {
  cleanExecute,
  closeRepo,
  commitIndex,
  discardChanges,
  formatIpcError,
  getConfig,
  getStatus,
  ignorePaths as ignorePathsIpc,
  initRepo,
  isTauriAvailable,
  openRepo as openRepoIpc,
  pickDirectory,
  setConfig,
  stagePaths as stagePathsIpc,
  undoOperation as undoOperationIpc,
  type CommitRequest,
  type CommitOutcome,
  type ConfigScope,
  type DiffSourceKind,
  type EgErrorLike,
  type HumanizedError,
  type IgnoreMode,
  type RepoSummary,
  type StageMode,
  type StatusReport,
} from '../lib/ipc/commands';
import type { RepoChanged } from '../lib/ipc/bindings';
import { useMergeStore } from './mergeStore';
import type { ChangeEntry } from '../lib/ipc/commands';
import { useLensStore } from './lensStore';

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

/** Shell-quotes a path for the command lens (F-13). */
function q(value: string): string {
  return '"' + value.replace(/[\\$"']/g, '$&') + '"';
}

function recordLens(command: string): void {
  useLensStore.getState().record(command);
}

export interface RepoSeed {
  repos?: Record<string, RepoSummary>;
  activeId?: string | null;
  status?: StatusReport | null;
  recents?: RepoMeta[];
  favorites?: string[];
  selectedChange?: ChangeEntry | null;
  selectedSource?: DiffSourceKind | null;
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
  /** Which side the selected row lives on: staged→index, unstaged→worktree. */
  selectedSource: DiffSourceKind | null;

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
  setSelectedChange: (change: ChangeEntry | null, source: DiffSourceKind | null) => void;
  /** fs-watch callback; coalesces bursts before refreshing status. */
  onRepoChanged: (repoId: string) => void;
  /** W3 actions (R-05/R-06/F-10); each applies the returned fresh status. */
  stagePaths: (paths: string[], mode: StageMode) => Promise<void>;
  /** Returns the op id for the 撤销 toast, or null when nothing was discarded. */
  discardPaths: (paths: string[]) => Promise<string | null>;
  /** Returns the op id for the 撤销 toast, or null on failure. */
  cleanUntracked: (paths: string[]) => Promise<string | null>;
  /** Lists untracked entries for the clean confirmation dialog. */
  previewClean: () => Promise<string[]>;
  ignorePaths: (paths: string[], mode: IgnoreMode) => Promise<void>;
  undoOperation: (opId: string) => Promise<void>;
  /**
   * W4 commit (R-07/F-12). Rejects with the raw EgError so the commit box can
   * react to `unsafe_operation` (partial staging) distinctly; success updates
   * status + summary and clears the file selection.
   */
  commit: (request: CommitRequest) => Promise<CommitOutcome | null>;
  /** Config access for the settings page (R-09/F-14); repo id = active repo. */
  configGet: (scope: ConfigScope, key: string) => Promise<string | null>;
  configSet: (scope: ConfigScope, key: string, value: string) => Promise<void>;
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

  /**
   * Refreshes the active repo's status. The indeterminate loading bar only
   * shows for a FIRST load (no status yet) or an explicit user refresh —
   * fs-watch background refreshes must stay silent, otherwise the bar
   * flickers on every file touch.
   */
  const refreshActiveStatus = async (showLoading = false) => {
    const { activeId } = get();
    if (!activeId) return;
    if (showLoading || !get().status) set({ statusLoading: true });
    try {
      const status = await getStatus(activeId);
      if (get().activeId === activeId) set({ status });
    } catch (error) {
      set({ error: humanize(error) });
    } finally {
      set({ statusLoading: false });
    }
  };

  /** R-08: operation failures surface as a toast, not just the wizard banner. */
  const failLoudly = (error: unknown): void => {
    set({ error: reportError(error, 'repo') });
  };

  return {
    repos: {},
    activeId: null,
    status: null,
    statusLoading: false,
    error: null,
    selectedSource: null,
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
        failLoudly(error);
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

    refreshStatus: () => refreshActiveStatus(true),

    toggleFavorite: (path) => {
      const favorites = get().favorites.includes(path)
        ? get().favorites.filter((p) => p !== path)
        : [...get().favorites, path];
      saveJson(FAVORITES_KEY, favorites);
      set({ favorites });
    },

    dismissError: () => set({ error: null }),
    setSelectedChange: (change, source) => set({ selectedChange: change, selectedSource: source }),

    stagePaths: async (paths, mode) => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        const status = await stagePathsIpc(activeId, paths, mode);
        set({ status });
        recordLens(
          mode === 'stage'
            ? `git add -- ${paths.map(q).join(' ')}`
            : `git restore --staged -- ${paths.map(q).join(' ')}`,
        );
      } catch (error) {
        failLoudly(error);
      }
    },

    discardPaths: async (paths) => {
      const { activeId } = get();
      if (!activeId) return null;
      try {
        const outcome = await discardChanges(activeId, paths);
        set({ status: outcome.status });
        recordLens(`git restore --source=HEAD --staged --worktree -- ${paths.map(q).join(' ')}`);
        return outcome.opId;
      } catch (error) {
        failLoudly(error);
        return null;
      }
    },

    cleanUntracked: async (paths) => {
      const { activeId } = get();
      if (!activeId) return null;
      try {
        const outcome = await cleanExecute(activeId, paths);
        set({ status: outcome.status });
        recordLens(`git clean -f -- ${paths.map(q).join(' ')}`);
        return outcome.opId;
      } catch (error) {
        failLoudly(error);
        return null;
      }
    },

    previewClean: async () => {
      const { activeId } = get();
      if (!activeId) return [];
      try {
        return await import('../lib/ipc/commands').then((m) => m.cleanPreview(activeId));
      } catch (error) {
        failLoudly(error);
        return [];
      }
    },

    ignorePaths: async (paths, mode) => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        const status = await ignorePathsIpc(activeId, paths, mode);
        set({ status });
        const rules = paths.map((p) => (mode === 'by_path' ? `/${p}` : `*.${p.split('.').pop()}`));
        recordLens(`echo ${q(rules.join('\n'))} >> .gitignore`);
      } catch (error) {
        failLoudly(error);
      }
    },

    undoOperation: async (opId) => {
      const { activeId } = get();
      if (!activeId) return;
      try {
        const status = await undoOperationIpc(activeId, opId);
        set({ status });
      } catch (error) {
        failLoudly(error);
      }
    },

    commit: async (request) => {
      const { activeId } = get();
      if (!activeId) return null;
      const outcome = await commitIndex(activeId, request);
      set((s) => ({
        status: outcome.status,
        repos: { ...s.repos, [activeId]: outcome.summary },
        selectedChange: null,
      }));
      const flag = request.amend ? '--amend ' : '';
      recordLens(`git commit ${flag}-m ${q(request.subject)}`);
      return outcome;
    },

    configGet: async (scope, key) => {
      const { activeId } = get();
      if (!activeId) return null;
      return getConfig(activeId, scope, key);
    },

    configSet: async (scope, key, value) => {
      const { activeId } = get();
      if (!activeId) return;
      await setConfig(activeId, scope, key, value);
      const flag = scope === 'global' ? '--global ' : '';
      recordLens(`git config ${flag}${key} ${q(value)}`);
    },

    onRepoChanged: (repoId) => {
      if (repoId !== get().activeId) return;
      // Backend already debounces 300ms; this coalesces event bursts too.
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        refreshTimer = null;
        void refreshActiveStatus();
        void useMergeStore.getState().poll();
      }, 150);
    },

    seed: (partial) => set(partial),
  };
});
