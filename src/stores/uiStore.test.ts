import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  clampDetailWidth,
  gitBlockingReason,
  parseGitVersion,
  resolveTheme,
  THEME_MODE_STORAGE_KEY,
  useUiStore,
  DETAIL_MAX_WIDTH,
  DETAIL_MIN_WIDTH,
} from './uiStore';

const getEnvStatusMock = vi.fn<() => Promise<{ gitVersion: string | null } | null>>();

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getAppVersion: vi.fn(async () => null),
    getEnvStatus: (...args: unknown[]) => getEnvStatusMock(...(args as [])),
  };
});

beforeEach(() => {
  localStorage.clear();
  document.documentElement.dataset.theme = '';
  useUiStore.setState({
    themeMode: 'system',
    systemPrefersDark: false,
    resolvedTheme: 'dark',
    sidebarCollapsed: false,
    detailOpen: true,
    detailWidth: 360,
  });
});

describe('resolveTheme', () => {
  it('follows the system preference in system mode', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });

  it('overrides the system preference in explicit modes', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
  });
});

describe('setThemeMode', () => {
  it('persists the mode and applies data-theme', () => {
    useUiStore.getState().setThemeMode('light');
    expect(localStorage.getItem(THEME_MODE_STORAGE_KEY)).toBe('light');
    expect(document.documentElement.dataset.theme).toBe('light');
    expect(useUiStore.getState().resolvedTheme).toBe('light');
  });

  it('resolves system mode from the stored system preference', () => {
    useUiStore.setState({ systemPrefersDark: true });
    useUiStore.getState().setThemeMode('system');
    expect(document.documentElement.dataset.theme).toBe('dark');
  });
});

describe('startup', () => {
  it('reads the persisted mode instead of defaulting to system', async () => {
    localStorage.setItem(THEME_MODE_STORAGE_KEY, 'dark');
    vi.resetModules();
    const { useUiStore: freshStore } = await import('./uiStore');
    expect(freshStore.getState().themeMode).toBe('dark');
  });
});

describe('applyTheme', () => {
  it('sets data-theme on the document root', () => {
    applyTheme('light');
    expect(document.documentElement.dataset.theme).toBe('light');
  });
});

describe('clampDetailWidth', () => {
  it('keeps the drag range within 280–480 and rounds', () => {
    expect(clampDetailWidth(100)).toBe(DETAIL_MIN_WIDTH);
    expect(clampDetailWidth(999)).toBe(DETAIL_MAX_WIDTH);
    expect(clampDetailWidth(360.4)).toBe(360);
    expect(clampDetailWidth(420)).toBe(420);
  });
});

describe('panel state', () => {
  it('toggles sidebar collapse and detail visibility', () => {
    const store = useUiStore.getState();
    expect(store.detailOpen).toBe(true);
    store.toggleSidebar();
    store.toggleDetail();
    const next = useUiStore.getState();
    expect(next.sidebarCollapsed).toBe(true);
    expect(next.detailOpen).toBe(false);
  });
});

describe('environment gate (PRD §7)', () => {
  it('parses plain and windows-suffixed git version output', () => {
    expect(parseGitVersion('git version 2.53.0\n')).toEqual([2, 53, 0]);
    expect(parseGitVersion('git version 2.45.1.windows.1')).toEqual([2, 45, 1]);
    expect(parseGitVersion('git version 2.30')).toEqual([2, 30, 0]);
    expect(parseGitVersion('unexpected')).toBeNull();
  });

  it('gates on missing git and versions below 2.30 only', () => {
    // undefined = not probed yet → no gate; null = probed but git missing.
    expect(gitBlockingReason(undefined)).toBeNull();
    expect(gitBlockingReason(null)).toBe('missing');
    expect(gitBlockingReason('git version 2.53.0.windows.1')).toBeNull();
    expect(gitBlockingReason('git version 2.30.1')).toBeNull();
    expect(gitBlockingReason('git version 2.29.3')).toBe('tooOld');
    expect(gitBlockingReason('git version 1.9.0')).toBe('tooOld');
    expect(gitBlockingReason('not a version')).toBe('missing');
  });

  it('stores the probe result and never gates in browser previews', async () => {
    useUiStore.setState({ envStatus: null });
    getEnvStatusMock.mockResolvedValue({ gitVersion: 'git version 2.53.0' });
    await useUiStore.getState().fetchEnvStatus();
    expect(useUiStore.getState().envStatus?.gitVersion).toContain('2.53.0');
    expect(gitBlockingReason(useUiStore.getState().envStatus?.gitVersion)).toBeNull();

    // Browser preview: the commands wrapper resolves null, envStatus stays null
    // and the undefined version (not probed) never gates.
    getEnvStatusMock.mockResolvedValue(null);
    await useUiStore.getState().fetchEnvStatus();
    expect(useUiStore.getState().envStatus).toBeNull();
    expect(gitBlockingReason(useUiStore.getState().envStatus?.gitVersion)).toBeNull();
  });
});
