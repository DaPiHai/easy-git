import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QuickSwitcher } from './QuickSwitcher';
import { useUiStore } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';

const activateSpy = vi.fn();
const openByPathSpy = vi.fn();

vi.mock('../../lib/ipc/commands', () => ({
  openRepo: vi.fn(),
  initRepo: vi.fn(),
  closeRepo: vi.fn(),
  getStatus: vi.fn(async () => ({
    repoId: 'r1',
    branch: null,
    headOid: null,
    staged: [],
    unstaged: [],
    conflicted: [],
  })),
  pickDirectory: vi.fn(async () => null),
  formatIpcError: (e: unknown) => ({ title: String(e), detail: '' }),
  events: {
    repoChanged: { listen: vi.fn(async () => () => {}) },
    syncProgress: { listen: vi.fn(async () => () => {}) },
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.getState().setSwitcherOpen(false);
  useRepoStore.getState().seed({
    repos: {
      r1: {
        repoId: 'r1',
        path: '/w/demo',
        name: 'demo',
        branch: 'main',
        headOid: null,
        ahead: 0,
        behind: 0,
        isEmpty: false,
      },
    },
    recents: [
      { path: '/w/demo', name: 'demo' },
      { path: '/w/other', name: 'other' },
    ],
  });
  vi.spyOn(useRepoStore.getState(), 'activate').mockImplementation(activateSpy);
  vi.spyOn(useRepoStore.getState(), 'openByPath').mockImplementation(openByPathSpy);
});

describe('QuickSwitcher', () => {
  it('renders nothing while closed', () => {
    render(<QuickSwitcher />);
    expect(screen.queryByTestId('quick-switcher')).not.toBeInTheDocument();
  });

  it('lists open repos first then recents, filters by query', async () => {
    useUiStore.getState().setSwitcherOpen(true);
    render(<QuickSwitcher />);

    expect(screen.getByText('demo')).toBeInTheDocument();
    expect(screen.getByText('other')).toBeInTheDocument();

    await userEvent.type(screen.getByRole('textbox'), 'oth');
    expect(screen.getByText('other')).toBeInTheDocument();
    expect(screen.queryByText('demo')).not.toBeInTheDocument();
  });

  it('activates an open repo on Enter and closes', async () => {
    useUiStore.getState().setSwitcherOpen(true);
    render(<QuickSwitcher />);

    await userEvent.type(screen.getByRole('textbox'), '{Enter}');
    expect(activateSpy).toHaveBeenCalledWith('r1');
    expect(useUiStore.getState().switcherOpen).toBe(false);
  });

  it('opens a non-open recent directly', async () => {
    useUiStore.getState().setSwitcherOpen(true);
    render(<QuickSwitcher />);

    await userEvent.type(screen.getByRole('textbox'), 'oth{Enter}');
    expect(openByPathSpy).toHaveBeenCalledWith('/w/other');
  });
});
