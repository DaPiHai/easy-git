import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RemotesPage } from './RemotesPage';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import { useToastStore } from '../../stores/toastStore';
import type { MergeOutcome, RemoteInfo, StatusReport } from '../../lib/ipc/commands';

const testMock = vi.fn<(...args: unknown[]) => unknown>();
const fetchMock = vi.fn<(...args: unknown[]) => unknown>();
const pushMock = vi.fn<(...args: unknown[]) => unknown>();
const pullMock = vi.fn<(...args: unknown[]) => unknown>();
const remoteListMock = vi.fn<(...args: unknown[]) => unknown>();
const remoteBranchListMock = vi.fn<(...args: unknown[]) => unknown>();
const undoRedoMock = vi.fn<(...args: unknown[]) => unknown>();
const branchListMock = vi.fn<(...args: unknown[]) => unknown>(async () => []);
const setUpstreamMock = vi.fn<(...args: unknown[]) => unknown>(async () => ({}));

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    remoteTest: (...args: unknown[]) => testMock(...args),
    fetchRemote: (...args: unknown[]) => fetchMock(...args),
    pushRemote: (...args: unknown[]) => pushMock(...args),
    pullRemote: (...args: unknown[]) => pullMock(...args),
    remoteList: (...args: unknown[]) => remoteListMock(...args),
    remoteBranchList: (...args: unknown[]) => remoteBranchListMock(...args),
    undoRedoState: (...args: unknown[]) => undoRedoMock(...args),
    branchList: (...args: unknown[]) => branchListMock(...args),
    branchSetUpstream: (...args: unknown[]) => setUpstreamMock(...args),
    mergeStateGet: vi.fn(async () => null),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

const remotes: RemoteInfo[] = [
  { name: 'origin', url: 'https://example.com/r.git', pushUrl: null },
  { name: 'mirror', url: 'git@example.com:r.git', pushUrl: null },
];

function cleanStatus(branch = 'main'): StatusReport {
  return {
    repoId: 'r1',
    branch,
    headOid: 'abc',
    staged: [],
    unstaged: [],
    conflicted: [],
  };
}

function ffOutcome(): MergeOutcome {
  return { fastForwarded: true, conflicts: [], status: cleanStatus() };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useRepoStore.setState({ activeId: 'r1', status: cleanStatus(), repos: {} });
  useSyncStore.setState({
    remotes,
    selectedRemote: 'origin',
    remoteBranches: [],
    timeline: [],
    undoRedo: null,
    progress: null,
    busy: null,
    error: null,
    credentialsRequest: null,
  });
  remoteListMock.mockResolvedValue(remotes);
  remoteBranchListMock.mockResolvedValue([]);
  undoRedoMock.mockResolvedValue(null);
  branchListMock.mockResolvedValue([]);
  testMock.mockResolvedValue(2);
  fetchMock.mockResolvedValue(cleanStatus());
  pushMock.mockResolvedValue(cleanStatus());
  pullMock.mockResolvedValue(ffOutcome());
});

async function renderPage() {
  render(<RemotesPage />);
  await screen.findByTestId('remote-list');
}

describe('RemotesPage multi-select batch actions', () => {
  it('selects all and reports an indeterminate header state', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId('remote-select-all'));
    expect(screen.getByTestId('remote-select-origin')).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('remote-select-mirror')).toHaveAttribute('aria-checked', 'true');

    await user.click(screen.getByTestId('remote-select-origin'));
    expect(screen.getByTestId('remote-select-all')).toHaveAttribute('aria-checked', 'mixed');
  });

  it('tests only the selected remotes and marks each row', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId('remote-select-origin'));
    await user.click(screen.getByTestId('remote-select-mirror'));
    await user.click(screen.getByTestId('remote-bulk-test'));

    await waitFor(() => expect(testMock).toHaveBeenCalledTimes(2));
    expect(testMock.mock.calls.map((call) => call[1])).toEqual(['origin', 'mirror']);
    await waitFor(() => {
      expect(screen.getByTestId('remote-status-origin')).toHaveAttribute('aria-label', '成功');
      expect(screen.getByTestId('remote-status-mirror')).toHaveAttribute('aria-label', '成功');
    });
  });

  it('fetches and pushes only the selected remotes', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId('remote-select-mirror'));
    await user.click(screen.getByTestId('remote-bulk-fetch'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(fetchMock.mock.calls[0][1]).toBe('mirror');

    await user.click(screen.getByTestId('remote-bulk-push'));
    await waitFor(() => expect(pushMock).toHaveBeenCalledTimes(1));
    expect(pushMock.mock.calls[0][1]).toBe('mirror');
    expect(pushMock.mock.calls[0][3]).toBe(false);
  });

  it('allows pull only when exactly one remote is selected', async () => {
    const user = userEvent.setup();
    await renderPage();

    await user.click(screen.getByTestId('remote-select-origin'));
    await user.click(screen.getByTestId('remote-select-mirror'));
    expect(screen.getByTestId('remote-bulk-pull')).toBeDisabled();

    await user.click(screen.getByTestId('remote-select-mirror'));
    await user.click(screen.getByTestId('remote-bulk-pull'));
    await waitFor(() => expect(pullMock).toHaveBeenCalledTimes(1));
    expect(pullMock.mock.calls[0]).toEqual(['r1', 'origin', 'main', 'ff_only']);
  });

  it('disables push and pull without a current branch', async () => {
    const user = userEvent.setup();
    useRepoStore.setState({ status: cleanStatus('') });
    await renderPage();

    await user.click(screen.getByTestId('remote-select-origin'));
    expect(screen.getByTestId('remote-bulk-push')).toBeDisabled();
    expect(screen.getByTestId('remote-bulk-pull')).toBeDisabled();
  });

  it('marks the failed row and keeps going on partial failure', async () => {
    const user = userEvent.setup();
    testMock.mockResolvedValueOnce(2).mockRejectedValueOnce(new Error('offline'));
    await renderPage();

    await user.click(screen.getByTestId('remote-select-origin'));
    await user.click(screen.getByTestId('remote-select-mirror'));
    await user.click(screen.getByTestId('remote-bulk-test'));

    await waitFor(() => expect(testMock).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTestId('remote-status-origin')).toHaveAttribute('aria-label', '成功');
      expect(screen.getByTestId('remote-status-mirror')).toHaveAttribute('aria-label', '失败');
    });
    expect(useToastStore.getState().toasts.some((toast) => toast.kind === 'error')).toBe(true);
  });
});
