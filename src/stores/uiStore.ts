import { create } from 'zustand';
import { getAppVersion, getEnvStatus, type EnvStatus } from '../lib/ipc/commands';

export type ThemeMode = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';
export type MainView =
  'changes' | 'history' | 'branches' | 'storage' | 'timeline' | 'remotes' | 'settings';

export const THEME_MODE_STORAGE_KEY = 'eg.theme.mode';
export const EXPERT_MODE_STORAGE_KEY = 'eg.mode.expert';

/** Detail panel drag range (UI doc §5.1). */
export const DETAIL_DEFAULT_WIDTH = 360;
export const DETAIL_MIN_WIDTH = 280;
export const DETAIL_MAX_WIDTH = 480;

/** PRD: dark is the product default; "system" resolves via prefers-color-scheme. */
export function resolveTheme(mode: ThemeMode, systemPrefersDark: boolean): ResolvedTheme {
  if (mode === 'system') return systemPrefersDark ? 'dark' : 'light';
  return mode;
}

export function applyTheme(theme: ResolvedTheme): void {
  document.documentElement.dataset.theme = theme;
}

export function clampDetailWidth(width: number): number {
  return Math.min(DETAIL_MAX_WIDTH, Math.max(DETAIL_MIN_WIDTH, Math.round(width)));
}

function readStoredMode(): ThemeMode {
  const raw = localStorage.getItem(THEME_MODE_STORAGE_KEY);
  return raw === 'light' || raw === 'dark' || raw === 'system' ? raw : 'system';
}

export interface AppVersionInfo {
  appVersion: string;
  tauriVersion: string;
  os: string;
}

/** PRD §7: EasyGit supports system git ≥ 2.30 and guides the install below it. */
export const GIT_MIN_VERSION: readonly [number, number, number] = [2, 30, 0];

/** Parses `git version 2.53.0.windows.1` style output; null when unexpected. */
export function parseGitVersion(output: string): [number, number, number] | null {
  const line = output.trim().split('\n')[0]?.trim() ?? '';
  const rest = line.startsWith('git version') ? line.slice('git version'.length).trim() : line;
  const [major, minor, patch] = rest.split(/[.\-v]/);
  const majorNum = Number(major);
  const minorNum = Number(minor);
  if (!Number.isInteger(majorNum) || !Number.isInteger(minorNum)) return null;
  const patchNum = Number(patch);
  return [majorNum, minorNum, Number.isInteger(patchNum) ? patchNum : 0];
}

/**
 * Why the environment gate should block, derived from the probed version
 * string: 'missing' (no usable git) or 'tooOld' (below the PRD minimum).
 * `undefined` = not probed yet (browser previews) → never gates; `null` =
 * probed but no usable git answered → 'missing'.
 */
export function gitBlockingReason(
  gitVersion: string | null | undefined,
): 'missing' | 'tooOld' | null {
  if (gitVersion === undefined) return null;
  if (gitVersion === null) return 'missing';
  const parsed = parseGitVersion(gitVersion);
  if (!parsed) return 'missing';
  const [major, minor, patch] = parsed;
  const [minMajor, minMinor, minPatch] = GIT_MIN_VERSION;
  if (major !== minMajor) return major > minMajor ? null : 'tooOld';
  if (minor !== minMinor) return minor > minMinor ? null : 'tooOld';
  return patch >= minPatch ? null : 'tooOld';
}

interface UiState {
  themeMode: ThemeMode;
  systemPrefersDark: boolean;
  resolvedTheme: ResolvedTheme;
  /** Attach the system theme listener and apply the resolved theme. Call once on mount. */
  initTheme: () => void;
  setThemeMode: (mode: ThemeMode) => void;
  stopWatchingSystemTheme: () => void;

  view: MainView;
  setView: (view: MainView) => void;

  /** 简洁/专家 dual mode (PRD §1.3); v1 persists the choice and flips labels. */
  expertMode: boolean;
  toggleExpertMode: () => void;

  sidebarCollapsed: boolean;
  toggleSidebar: () => void;

  detailOpen: boolean;
  detailWidth: number;
  setDetailWidth: (width: number) => void;
  toggleDetail: () => void;

  /** Ctrl/Cmd+K quick repo switcher (F-05 prototype). */
  switcherOpen: boolean;
  setSwitcherOpen: (open: boolean) => void;

  /** 克隆仓库 dialog (R-22): reachable from the wizard card and the sidebar. */
  cloneDialogOpen: boolean;
  setCloneDialogOpen: (open: boolean) => void;

  /** SSH 远端仓库 dialog: host/port/user/path form + test + remote browser. */
  sshDialogOpen: boolean;
  setSshDialogOpen: (open: boolean) => void;

  /** Populated via IPC once the Tauri shell is up; null in browser previews. */
  appVersion: AppVersionInfo | null;
  fetchAppVersion: () => Promise<void>;

  /** PRD §7 environment probe; null until probed (and in browser previews). */
  envStatus: EnvStatus | null;
  fetchEnvStatus: () => Promise<void>;
}

export const useUiStore = create<UiState>()((set, get) => {
  let watchingSystemTheme = false;
  let systemThemeQuery: MediaQueryList | null = null;
  let onSystemThemeChange: ((event: MediaQueryListEvent) => void) | null = null;

  const syncTheme = () => {
    const { themeMode, systemPrefersDark: prefersDark } = get();
    const resolved = resolveTheme(themeMode, prefersDark);
    applyTheme(resolved);
    set({ resolvedTheme: resolved });
  };

  return {
    themeMode: readStoredMode(),
    systemPrefersDark: false,
    resolvedTheme: 'dark',
    initTheme: () => {
      if (watchingSystemTheme) return;
      watchingSystemTheme = true;
      systemThemeQuery = window.matchMedia('(prefers-color-scheme: dark)');
      onSystemThemeChange = (event) => {
        set({ systemPrefersDark: event.matches });
        syncTheme();
      };
      systemThemeQuery.addEventListener('change', onSystemThemeChange);
      set({ systemPrefersDark: systemThemeQuery.matches });
      syncTheme();
    },
    setThemeMode: (mode) => {
      localStorage.setItem(THEME_MODE_STORAGE_KEY, mode);
      set({ themeMode: mode });
      syncTheme();
    },
    stopWatchingSystemTheme: () => {
      if (onSystemThemeChange && systemThemeQuery) {
        systemThemeQuery.removeEventListener('change', onSystemThemeChange);
      }
      watchingSystemTheme = false;
      systemThemeQuery = null;
      onSystemThemeChange = null;
    },

    view: 'changes',
    setView: (view) => set({ view }),

    expertMode: localStorage.getItem(EXPERT_MODE_STORAGE_KEY) === 'true',
    toggleExpertMode: () =>
      set((s) => {
        const expertMode = !s.expertMode;
        try {
          localStorage.setItem(EXPERT_MODE_STORAGE_KEY, String(expertMode));
        } catch {
          // Persistence is best-effort.
        }
        return { expertMode };
      }),

    sidebarCollapsed: false,
    toggleSidebar: () => set((s) => ({ sidebarCollapsed: !s.sidebarCollapsed })),

    detailOpen: true,
    detailWidth: DETAIL_DEFAULT_WIDTH,
    setDetailWidth: (width) => set({ detailWidth: width }),
    toggleDetail: () => set((s) => ({ detailOpen: !s.detailOpen })),

    switcherOpen: false,
    setSwitcherOpen: (open) => set({ switcherOpen: open }),

    cloneDialogOpen: false,
    setCloneDialogOpen: (open) => set({ cloneDialogOpen: open }),

    sshDialogOpen: false,
    setSshDialogOpen: (open) => set({ sshDialogOpen: open }),

    appVersion: null,
    fetchAppVersion: async () => {
      set({ appVersion: await getAppVersion() });
    },

    envStatus: null,
    fetchEnvStatus: async () => {
      set({ envStatus: await getEnvStatus() });
    },
  };
});
