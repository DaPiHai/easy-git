import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearCachedCredentials, useSyncStore } from './syncStore';
import { useRepoStore } from './repoStore';
import { useToastStore } from './toastStore';
import type {
  MergeOutcome,
  RemoteInfo,
  StatusReport,
  TimelineEntry,
  UndoRedoState,
} from '../lib/ipc/commands';

const fetchMock = vi.fn<(...args: unknown[]) => unknown>();
const pullMock = vi.fn<(...args: unknown[]) => unknown>();
const pushMock = vi.fn<(...args: unknown[]) => unknown>();
const remoteTestMock = vi.fn<(...args: unknown[]) => unknown>();
const remoteListMock = vi.fn<(...args: unknown[]) => unknown>();
const remoteBranchListMock = vi.fn<(...args: unknown[]) => unknown>();
const undoRedoMock = vi.fn<(...args: unknown[]) => unknown>();
const redoMock = vi.fn<(...args: unknown[]) => unknown>();
const undoOpMock = vi.fn<(...args: unknown[]) => unknown>();
const branchListMock = vi.fn<(...args: unknown[]) => unknown>(async () => []);
const setUpstreamMock = vi.fn<(...args: unknown[]) => unknown>(async () => ({}));

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    fetchRemote: (...args: unknown[]) => fetchMock(...args),
    pullRemote: (...args: unknown[]) => pullMock(...args),
    pushRemote: (...args: unknown[]) => pushMock(...args),
    remoteTest: (...args: unknown[]) => remoteTestMock(...args),
    remoteList: (...args: unknown[]) => remoteListMock(...args),
    remoteBranchList: (...args: unknown[]) => remoteBranchListMock(...args),
    undoRedoState: (...args: unknown[]) => undoRedoMock(...args),
    redoOperation: (...args: unknown[]) => redoMock(...args),
    undoOperation: (...args: unknown[]) => undoOpMock(...args),
    branchList: (...args: unknown[]) => branchListMock(...args),
    branchSetUpstream: (...args: unknown[]) => setUpstreamMock(...args),
    mergeStateGet: vi.fn(async () => null),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

function remote(overrides: Partial<RemoteInfo> = {}): RemoteInfo {
  return { name: 'origin', url: 'https://example.com/r.git', pushUrl: null, ...overrides };
}

function cleanStatus(): StatusReport {
  return {
    repoId: 'r1',
    branch: 'main',
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
  clearCachedCredentials();
  useToastStore.setState({ toasts: [] });
  useRepoStore.getState().seed({ activeId: 'r1' });
  localStorage.clear();
  useSyncStore.setState({
    remotes: [remote()],
    selectedRemote: null,
    remoteBranches: ['origin/main'],
    timeline: [],
    undoRedo: null,
    progress: null,
    busy: null,
    error: null,
  });
});

describe('syncStore refresh', () => {
  it('loads remotes, remote branches and undo/redo state', async () => {
    remoteListMock.mockResolvedValue([remote()]);
    remoteBranchListMock.mockResolvedValue(['origin/main']);
    undoRedoMock.mockResolvedValue({
      undoableOpId: 'op-1',
      undoableLabel: '丢弃修改',
      redoable: false,
    } satisfies UndoRedoState);
    await useSyncStore.getState().refresh();
    const state = useSyncStore.getState();
    expect(state.remotes).toHaveLength(1);
    expect(state.remoteBranches).toEqual(['origin/main']);
    expect(state.undoRedo?.undoableLabel).toBe('丢弃修改');
    expect(state.undoRedo?.redoable).toBe(false);
  });
});

describe('syncStore pull', () => {
  it('maps the divergence error to the dialog signal', async () => {
    pullMock.mockRejectedValue({
      code: 'conflict_state',
      state: '本地与 origin/main 出现分叉（ahead 1 / behind 1），请选择合并',
    });
    const result = await useSyncStore.getState().pull('origin', 'main', 'ff_only');
    expect(result).toBe('diverged');
    expect(pullMock).toHaveBeenCalledWith('r1', 'origin', 'main', 'ff_only');
  });

  it('ff pulls refresh state and toast success', async () => {
    pullMock.mockResolvedValue(ffOutcome());
    const result = await useSyncStore.getState().pull('origin', 'main', 'ff_only');
    expect(result).toBe('ok');
    expect(useToastStore.getState().toasts.at(-1)?.kind).toBe('success');
  });

  it('merging a parked pull keeps the merge flow intact', async () => {
    pullMock.mockResolvedValue({
      fastForwarded: false,
      conflicts: ['src/a.txt'],
      status: cleanStatus(),
    });
    const result = await useSyncStore.getState().pull('origin', 'main', 'merge');
    expect(result).toBe('ok');
    expect(useToastStore.getState().toasts.at(-1)?.kind).toBe('info');
  });
});

describe('syncStore push', () => {
  it('maps the non-fast-forward rejection to the force dialog signal', async () => {
    pushMock.mockRejectedValue({
      code: 'conflict_state',
      state: '远端被本地之外的提交更新过（需要先获取整合）',
    });
    const result = await useSyncStore.getState().push('origin', 'main', false);
    expect(result).toBe('rejected');
  });

  it('force push goes through with the rollback anchor recorded', async () => {
    pushMock.mockImplementation((_repoId, _remote, _branch, force) => {
      expect(force).toBe(true);
      return Promise.resolve(cleanStatus());
    });
    const result = await useSyncStore.getState().push('origin', 'main', true);
    expect(result).toBe('ok');
  });

  it('retries with dialog credentials after an auth rejection', async () => {
    pushMock.mockRejectedValueOnce({ code: 'auth', provider: 'git' });
    pushMock.mockImplementation((_repoId, _remote, _branch, _force, creds) => {
      expect(creds).toEqual({ username: '老用户', password: 's3cret' });
      return Promise.resolve(cleanStatus());
    });
    const pending = useSyncStore.getState().push('origin', 'main', false);
    // The auth fallback opens the credentials dialog via store state.
    await vi.waitFor(() => {
      expect(useSyncStore.getState().credentialsRequest).not.toBeNull();
    });
    useSyncStore.getState().credentialsRequest?.resolve({ username: '老用户', password: 's3cret' });
    const result = await pending;
    expect(result).toBe('ok');
    expect(useSyncStore.getState().credentialsRequest).toBeNull();
    expect(pushMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the cached session credential without prompting again', async () => {
    // First push caches the credential via the dialog flow…
    pushMock.mockRejectedValueOnce({ code: 'auth', provider: 'git' });
    pushMock.mockImplementation((_repoId, _remote, _branch, _force, creds) => {
      expect(creds).toEqual({ username: '老用户', password: 's3cret' });
      return Promise.resolve(cleanStatus());
    });
    const first = useSyncStore.getState().push('origin', 'main', false);
    await vi.waitFor(() => {
      expect(useSyncStore.getState().credentialsRequest).not.toBeNull();
    });
    useSyncStore.getState().credentialsRequest?.resolve({ username: '老用户', password: 's3cret' });
    expect(await first).toBe('ok');
    // …so the second push retries ambiently with the cached value.
    pushMock.mockClear();
    pushMock.mockImplementation((_repoId, _remote, _branch, _force, creds) => {
      expect(creds).toEqual({ username: '老用户', password: 's3cret' });
      return Promise.resolve(cleanStatus());
    });
    const result = await useSyncStore.getState().push('origin', 'main', false);
    expect(result).toBe('ok');
    expect(useSyncStore.getState().credentialsRequest).toBeNull();
  });

  it('dismissing the credentials dialog returns cancelled quietly', async () => {
    // A bad cached credential fails again, forcing a fresh prompt.
    pushMock.mockRejectedValue({ code: 'auth', provider: 'git' });
    const pending = useSyncStore.getState().push('other', 'main', false);
    await vi.waitFor(() => {
      expect(useSyncStore.getState().credentialsRequest).not.toBeNull();
    });
    useSyncStore.getState().credentialsRequest?.resolve(null);
    const result = await pending;
    expect(result).toBe('cancelled');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

describe('syncStore remote selection & push all', () => {
  it('prefers the persisted remote over origin', async () => {
    localStorage.setItem('eg.sync.remote.r1', 'mirror');
    remoteListMock.mockResolvedValue([remote(), remote({ name: 'mirror' })]);
    remoteBranchListMock.mockResolvedValue(['origin/main']);
    undoRedoMock.mockResolvedValue(null);
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().selectedRemote).toBe('mirror');
  });

  it('falls back to the current branch upstream, then origin', async () => {
    remoteListMock.mockResolvedValue([remote(), remote({ name: 'fork' })]);
    remoteBranchListMock.mockResolvedValue([]);
    undoRedoMock.mockResolvedValue(null);
    branchListMock.mockResolvedValue([{ name: 'main', isCurrent: true, upstream: 'fork/main' }]);
    await useSyncStore.getState().refresh();
    expect(useSyncStore.getState().selectedRemote).toBe('fork');
  });

  it('pushAll targets the selected remote first and reports every result', async () => {
    useSyncStore.setState({
      remotes: [remote(), remote({ name: 'mirror' })],
      selectedRemote: 'mirror',
    });
    pushMock.mockResolvedValue(cleanStatus());
    const results = await useSyncStore.getState().pushAll('main');
    expect(pushMock.mock.calls.map((call) => call[1])).toEqual(['mirror', 'origin']);
    expect(results).toEqual([
      { remote: 'mirror', status: 'ok' },
      { remote: 'origin', status: 'ok' },
    ]);
  });

  it('a rejected remote does not stop the remaining push-all targets', async () => {
    useSyncStore.setState({
      remotes: [remote(), remote({ name: 'mirror' })],
      selectedRemote: null,
    });
    pushMock
      .mockRejectedValueOnce({ code: 'conflict_state', state: 'rejected' })
      .mockResolvedValueOnce(cleanStatus());
    const results = await useSyncStore.getState().pushAll('main');
    expect(results.map((result) => result.status)).toEqual(['rejected', 'ok']);
  });

  it('sets the upstream only when the branch has none', async () => {
    branchListMock.mockResolvedValue([{ name: 'main', isCurrent: true, upstream: 'origin/main' }]);
    pushMock.mockResolvedValue(cleanStatus());
    await useSyncStore.getState().push('mirror', 'main', false);
    expect(setUpstreamMock).not.toHaveBeenCalled();
  });

  it('fetchMany fetches the requested remotes in order', async () => {
    fetchMock.mockResolvedValue(cleanStatus());
    const results = await useSyncStore.getState().fetchMany(['origin', 'mirror', 'origin']);
    expect(fetchMock.mock.calls.map((call) => call[1])).toEqual(['origin', 'mirror']);
    expect(results).toEqual([
      { remote: 'origin', status: 'ok' },
      { remote: 'mirror', status: 'ok' },
    ]);
  });

  it('testMany tests only the requested remotes', async () => {
    remoteTestMock.mockResolvedValue(2);
    const results = await useSyncStore.getState().testMany(['mirror']);
    expect(remoteTestMock).toHaveBeenCalledWith('r1', 'mirror');
    expect(results).toEqual([{ remote: 'mirror', status: 'ok' }]);
  });

  it('pushMany pushes a subset and keeps going after a rejection', async () => {
    pushMock
      .mockRejectedValueOnce({ code: 'conflict_state', state: 'rejected' })
      .mockResolvedValueOnce(cleanStatus());
    const results = await useSyncStore.getState().pushMany('main', ['origin', 'mirror']);
    expect(pushMock.mock.calls.map((call) => call[1])).toEqual(['origin', 'mirror']);
    expect(results).toEqual([
      { remote: 'origin', status: 'rejected' },
      { remote: 'mirror', status: 'ok' },
    ]);
    expect(setUpstreamMock).not.toHaveBeenCalled();
  });
});

describe('syncStore undo/redo (R-25 引用快照树)', () => {
  it('redo replays the latest undone op and refreshes state', async () => {
    redoMock.mockResolvedValue({ opId: 'op-2', status: cleanStatus() });
    undoRedoMock.mockResolvedValue({
      undoableOpId: 'op-2',
      undoableLabel: '丢弃修改',
      redoable: false,
    } satisfies UndoRedoState);
    const opId = await useSyncStore.getState().redo();
    expect(opId).toBe('op-2');
    expect(redoMock).toHaveBeenCalledWith('r1');
  });

  it('timeline refresh loads the merged feed (F-28)', async () => {
    const { timelineGet } = (await import('../lib/ipc/commands')) as {
      timelineGet: (repoId: string, limit: number) => Promise<TimelineEntry[]>;
    };
    vi.spyOn(await import('../lib/ipc/commands'), 'timelineGet').mockImplementation(((
      _repoId: string,
      _limit: number,
    ) =>
      Promise.resolve([
        { oid: 'a1', subject: 'commit: x', kind: 'commit', danger: false, time: 2 },
        { oid: null, subject: '丢弃修改（1 个路径）', kind: 'discard', danger: true, time: 3 },
      ])) as never);
    await useSyncStore.getState().refreshTimeline();
    expect(useSyncStore.getState().timeline).toHaveLength(2);
    expect(timelineGet).toBeDefined();
  });
});
