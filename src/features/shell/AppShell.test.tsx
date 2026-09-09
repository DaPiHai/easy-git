import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { useUiStore } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';

const getStatusMock = vi.fn(async (_repoId: string) => ({
  repoId: 'r1',
  branch: 'main',
  headOid: null,
  staged: [],
  unstaged: [],
  conflicted: [],
}));

vi.mock('../../lib/ipc/commands', () => ({
  getAppVersion: vi.fn(async () => ({ appVersion: '0.1.0', tauriVersion: '2.0.0', os: 'test' })),
  isTauriAvailable: () => true,
  formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  closeRepo: vi.fn(),
  getStatus: (repoId: string) => getStatusMock(repoId),
  pickDirectory: vi.fn(async () => null),
  stagePaths: vi.fn(),
  discardChanges: vi.fn(),
  cleanPreview: vi.fn(async () => []),
  cleanExecute: vi.fn(),
  ignorePaths: vi.fn(),
  undoOperation: vi.fn(),
  commitIndex: vi.fn(),
  getConfig: vi.fn(async () => 'tester'),
  setConfig: vi.fn(async () => undefined),
  events: {
    repoChanged: { listen: vi.fn(async () => () => undefined) },
    syncProgress: { listen: vi.fn(async () => () => undefined) },
  },
}));

vi.mock('../../lib/ipc/bindings', () => ({
  events: {
    repoChanged: {
      listen: vi.fn(async () => () => undefined),
    },
    syncProgress: {
      listen: vi.fn(async () => () => undefined),
    },
  },
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useUiStore.setState({
    themeMode: 'dark',
    systemPrefersDark: true,
    resolvedTheme: 'dark',
    view: 'changes',
    sidebarCollapsed: false,
    detailOpen: true,
    detailWidth: 360,
    switcherOpen: false,
  });
  useRepoStore.getState().seed({
    repos: {},
    activeId: null,
    status: null,
    recents: [],
    favorites: [],
    selectedChange: null,
  });
});

describe('AppShell without an active repository', () => {
  it('shows the open-repo wizard instead of the main view content', () => {
    render(<AppShell />);
    expect(screen.getByTestId('open-wizard')).toBeInTheDocument();
    expect(screen.queryByTestId('changes-view')).not.toBeInTheDocument();
  });

  it('still shows the version chip via the IPC pipeline', async () => {
    render(<AppShell />);
    const chip = await screen.findByTestId('ipc-status');
    expect(chip).toHaveAttribute('data-state', 'connected');
    expect(chip).toHaveTextContent('EasyGit v0.1.0');
  });
});

describe('AppShell with an active repository', () => {
  beforeEach(() => {
    useRepoStore.getState().seed({
      repos: {
        r1: {
          repoId: 'r1',
          path: '/tmp/demo',
          name: 'demo',
          branch: 'main',
          headOid: null,
          ahead: 0,
          behind: 0,
          isEmpty: false,
        },
      },
      activeId: 'r1',
    });
  });

  it('renders the four main view tabs with 变更 selected by default', () => {
    render(<AppShell />);
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('button', { name: '变更' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const tab of ['历史', '分支', '储藏']) {
      expect(within(nav).getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('shows the top-bar repo switcher with the active repo name', () => {
    render(<AppShell />);
    expect(screen.getByTestId('repo-switcher')).toHaveTextContent('demo');
  });

  it('shows the three-zone changes view fed by status_get', async () => {
    // activate() is what triggers status_get in the real flow.
    await useRepoStore.getState().activate('r1');
    render(<AppShell />);
    expect(await screen.findByTestId('changes-view')).toBeInTheDocument();
    expect(getStatusMock).toHaveBeenCalledWith('r1');
  });

  it('opens the quick switcher with Ctrl+K and closes on Escape', async () => {
    render(<AppShell />);
    await userEvent.keyboard('{Control>}k');
    expect(screen.getByTestId('quick-switcher')).toBeInTheDocument();
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByTestId('quick-switcher')).not.toBeInTheDocument();
  });

  it('collapses the repo sidebar to the icon rail', async () => {
    render(<AppShell />);
    await userEvent.click(screen.getByTestId('sidebar-collapse'));
    expect(screen.getByTestId('sidebar-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sidebar-expand'));
    expect(screen.getByTestId('sidebar-collapse')).toBeInTheDocument();
  });

  it('collapses and restores the detail panel from the top bar', async () => {
    render(<AppShell />);
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('detail-toggle'));
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('detail-toggle'));
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });
});
