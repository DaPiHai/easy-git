import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyTheme,
  clampDetailWidth,
  resolveTheme,
  THEME_MODE_STORAGE_KEY,
  useUiStore,
  DETAIL_MAX_WIDTH,
  DETAIL_MIN_WIDTH,
} from './uiStore';

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
