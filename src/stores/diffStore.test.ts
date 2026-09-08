import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useDiffStore } from './diffStore';
import { useRepoStore } from './repoStore';
import { useToastStore } from './toastStore';
import type { DiffResponse } from '../lib/ipc/commands';

const diffFileMock = vi.fn<(...args: unknown[]) => unknown>();
const stageLinesMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    diffFile: (...args: unknown[]) => diffFileMock(...args),
    stageLines: (...args: unknown[]) => stageLinesMock(...args),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

function response(path = 'a.txt', added = 1): DiffResponse {
  return {
    repoId: 'r1',
    path,
    oldPath: null,
    kind: 'modified',
    added,
    deleted: 0,
    isBinary: false,
    truncated: false,
    hunks: [
      {
        header: '@@ -1,2 +1,3 @@',
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: 'context', oldLineno: 1, newLineno: 1, content: 'one', word: null },
          { kind: 'added', oldLineno: null, newLineno: 2, content: 'TWO', word: null },
        ],
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useDiffStore.getState().seed({ request: null, data: null, loading: false, error: null });
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

describe('diffStore (F-18/F-19)', () => {
  it('opens a diff and keeps the payload', async () => {
    diffFileMock.mockResolvedValue(response());
    await useDiffStore.getState().open({
      path: 'a.txt',
      oldPath: null,
      source: 'worktree',
      commitOid: null,
    });
    expect(diffFileMock).toHaveBeenCalledWith('r1', {
      path: 'a.txt',
      oldPath: null,
      source: 'worktree',
      commitOid: null,
    });
    expect(useDiffStore.getState().data?.hunks).toHaveLength(1);
    expect(useDiffStore.getState().error).toBeNull();
  });

  it('drops stale replies after the request changed mid-flight', async () => {
    let resolveFirst!: (v: DiffResponse) => void;
    diffFileMock.mockImplementationOnce(
      () =>
        new Promise<DiffResponse>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const first = useDiffStore.getState().open({
      path: 'a.txt',
      oldPath: null,
      source: 'worktree',
      commitOid: null,
    });
    diffFileMock.mockResolvedValue(response('b.txt'));
    await useDiffStore.getState().open({
      path: 'b.txt',
      oldPath: null,
      source: 'worktree',
      commitOid: null,
    });
    resolveFirst(response('a.txt'));
    await first;
    expect(useDiffStore.getState().data?.path).toBe('b.txt');
  });

  it('applies a selection, refreshes status and refetches the diff', async () => {
    diffFileMock.mockResolvedValue(response());
    stageLinesMock.mockResolvedValue({
      repoId: 'r1',
      branch: 'main',
      headOid: 'abc',
      staged: [],
      unstaged: [],
      conflicted: [],
    });
    await useDiffStore.getState().open({
      path: 'a.txt',
      oldPath: null,
      source: 'worktree',
      commitOid: null,
    });
    const ok = await useDiffStore.getState().applySelection([{ hunkIndex: 0, lineIndexes: [1] }]);

    expect(ok).toBe(true);
    expect(stageLinesMock).toHaveBeenCalledWith('r1', {
      path: 'a.txt',
      source: 'worktree',
      hunks: [{ hunkIndex: 0, lineIndexes: [1] }],
    });
    expect(useToastStore.getState().toasts[0]?.message).toBe('已暂存选中行');
    // Two diff fetches: the initial open + the refetch after staging.
    expect(diffFileMock).toHaveBeenCalledTimes(2);
  });

  it('returns false without IPC when nothing is open', async () => {
    const ok = await useDiffStore.getState().applySelection([{ hunkIndex: 0, lineIndexes: [0] }]);
    expect(ok).toBe(false);
    expect(stageLinesMock).not.toHaveBeenCalled();
  });
});
