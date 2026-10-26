import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncButtons } from './SyncButtons';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';

const pushMock = vi.fn<(...args: unknown[]) => unknown>();
const branchListMock = vi.fn<(...args: unknown[]) => unknown>(async () => []);

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    pushRemote: (...args: unknown[]) => pushMock(...args),
    branchList: (...args: unknown[]) => branchListMock(...args),
    branchSetUpstream: vi.fn(async () => ({})),
    remoteList: vi.fn(async () => []),
    remoteBranchList: vi.fn(async () => []),
    undoRedoState: vi.fn(async () => null),
    isTauriAvailable: () => true,
  };
});

const status = {
  repoId: 'r1',
  branch: 'main',
  headOid: 'abc',
  staged: [],
  unstaged: [],
  conflicted: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useRepoStore.setState({ activeId: 'r1', status, repos: {} });
  useSyncStore.setState({
    remotes: [
      { name: 'origin', url: 'https://example.com/r.git', pushUrl: null },
      { name: 'mirror', url: 'git@example.com:r.git', pushUrl: null },
    ],
    selectedRemote: 'mirror',
    busy: null,
    progress: null,
  });
  pushMock.mockResolvedValue(status);
});

describe('SyncButtons multi-remote', () => {
  it('shows the selected remote and pushes to it', async () => {
    const user = userEvent.setup();
    render(<SyncButtons hasActiveRepo />);

    const select = screen.getByTestId('sync-remote');
    expect(select).toHaveValue('mirror');

    await user.click(screen.getByTestId('sync-push'));
    expect(pushMock).toHaveBeenCalledWith('r1', 'mirror', 'main', false, null);
  });

  it('pushes to every remote after confirmation', async () => {
    const user = userEvent.setup();
    render(<SyncButtons hasActiveRepo />);

    await user.click(screen.getByTestId('sync-push-all'));
    expect(screen.getByTestId('push-all-confirm')).toBeInTheDocument();
    await user.click(screen.getByTestId('push-all-confirm'));

    expect(pushMock.mock.calls.map((call) => call[1])).toEqual(['mirror', 'origin']);
  });
});
