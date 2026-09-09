import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useMergeStore } from './mergeStore';
import { useRepoStore } from './repoStore';
import { useToastStore } from './toastStore';
import type { ConflictFile, MergeOutcome, MergeState, ResetOutcome } from '../lib/ipc/commands';

const mergeStartMock = vi.fn<(...args: unknown[]) => unknown>();
const mergeStateMock = vi.fn<(...args: unknown[]) => unknown>();
const mergeAbortMock = vi.fn<(...args: unknown[]) => unknown>();
const conflictsGetMock = vi.fn<(...args: unknown[]) => unknown>();
const conflictResolveMock = vi.fn<(...args: unknown[]) => unknown>();
const revertMock = vi.fn<(...args: unknown[]) => unknown>();
const resetMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    mergeStart: (...args: unknown[]) => mergeStartMock(...args),
    mergeStateGet: (...args: unknown[]) => mergeStateMock(...args),
    mergeAbort: (...args: unknown[]) => mergeAbortMock(...args),
    conflictsGet: (...args: unknown[]) => conflictsGetMock(...args),
    conflictResolve: (...args: unknown[]) => conflictResolveMock(...args),
    revertCommits: (...args: unknown[]) => revertMock(...args),
    resetCommits: (...args: unknown[]) => resetMock(...args),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

function parkedState(): MergeState {
  return { message: "Merge branch 'feature'", theirs: ['feature'] };
}

function conflictFile(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    path: 'shared.txt',
    baseContent: 'line1\n',
    oursContent: 'main edit\n',
    theirsContent: 'feature edit\n',
    segments: [''],
    blocks: [{ ours: ['main edit'], theirs: ['feature edit'] }],
    isBinary: false,
    ...overrides,
  };
}

function parkedOutcome(conflicts = ['shared.txt']): MergeOutcome {
  return {
    fastForwarded: false,
    conflicts,
    status: {
      repoId: 'r1',
      branch: 'main',
      headOid: 'abc',
      staged: [],
      unstaged: [],
      conflicted: [],
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useRepoStore.getState().seed({ activeId: 'r1' });
  useMergeStore.setState({
    mergeState: null,
    conflicts: [],
    knownPaths: [],
    loading: false,
    error: null,
  });
});

describe('mergeStore poll', () => {
  it('keeps parked state and accumulates known paths', async () => {
    mergeStateMock.mockResolvedValue(parkedState());
    conflictsGetMock.mockResolvedValue([conflictFile()]);
    await useMergeStore.getState().poll();
    expect(useMergeStore.getState().mergeState?.theirs).toEqual(['feature']);
    expect(useMergeStore.getState().knownPaths).toEqual(['shared.txt']);

    // Resolve the file: it leaves the conflict list but stays known.
    conflictsGetMock.mockResolvedValue([]);
    await useMergeStore.getState().poll();
    expect(useMergeStore.getState().conflicts).toEqual([]);
    expect(useMergeStore.getState().resolvedPaths()).toEqual(['shared.txt']);
  });

  it('clears state when no merge is parked (test seam keeps state untouched)', async () => {
    mergeStateMock.mockResolvedValue(null);
    useMergeStore.setState({ mergeState: parkedState() });
    await useMergeStore.getState().poll();
    expect(useMergeStore.getState().mergeState).toBeNull();
  });
});

describe('mergeStore startMerge', () => {
  it('parks on conflicts and toasts the wizard hint', async () => {
    mergeStartMock.mockResolvedValue(parkedOutcome());
    mergeStateMock.mockResolvedValue(parkedState());
    conflictsGetMock.mockResolvedValue([conflictFile()]);
    const ok = await useMergeStore.getState().startMerge('feature', false);
    expect(ok).toBe(true);
    expect(mergeStartMock).toHaveBeenCalledWith('r1', 'feature', false);
    expect(useMergeStore.getState().mergeState).not.toBeNull();
    const toasts = useToastStore.getState().toasts;
    expect(toasts.at(-1)?.kind).toBe('info');
  });

  it('toasts success on a clean merge', async () => {
    mergeStartMock.mockResolvedValue(parkedOutcome([]));
    const ok = await useMergeStore.getState().startMerge('feature', true);
    expect(ok).toBe(true);
    expect(mergeStartMock).toHaveBeenCalledWith('r1', 'feature', true);
    expect(useToastStore.getState().toasts.at(-1)?.kind).toBe('success');
  });

  it('surfaces merge errors as error toasts', async () => {
    mergeStartMock.mockRejectedValue({ code: 'dirty_worktree' });
    const ok = await useMergeStore.getState().startMerge('feature', false);
    expect(ok).toBe(false);
    expect(useToastStore.getState().toasts.at(-1)?.kind).toBe('error');
  });
});

describe('mergeStore abort / resolve / reset', () => {
  it('abort clears the wizard state and restores status', async () => {
    mergeAbortMock.mockResolvedValue(parkedOutcome([]).status);
    useMergeStore.setState({ mergeState: parkedState(), conflicts: [conflictFile()] });
    const ok = await useMergeStore.getState().abortMerge();
    expect(ok).toBe(true);
    expect(useMergeStore.getState().mergeState).toBeNull();
    expect(useMergeStore.getState().conflicts).toEqual([]);
  });

  it('resolveFile stages the content and marks the path known', async () => {
    conflictResolveMock.mockResolvedValue(parkedOutcome([]).status);
    const ok = await useMergeStore
      .getState()
      .resolveFile('shared.txt', 'main edit\nfeature edit\n');
    expect(ok).toBe(true);
    expect(conflictResolveMock).toHaveBeenCalledWith(
      'r1',
      'shared.txt',
      'main edit\nfeature edit\n',
    );
    expect(useMergeStore.getState().knownPaths).toContain('shared.txt');
  });

  it('revert stages inverse changes and toasts success', async () => {
    revertMock.mockResolvedValue(parkedOutcome([]).status);
    const ok = await useMergeStore.getState().revert(['abc123']);
    expect(ok).toBe(true);
    expect(revertMock).toHaveBeenCalledWith('r1', ['abc123']);
    expect(useToastStore.getState().toasts.at(-1)?.kind).toBe('success');
  });

  it('hard reset returns the undoable op id', async () => {
    const outcome: ResetOutcome = { opId: 'op-1', status: parkedOutcome([]).status };
    resetMock.mockResolvedValue(outcome);
    const result = await useMergeStore.getState().reset('hard', 'abc123');
    expect(result?.opId).toBe('op-1');
    expect(resetMock).toHaveBeenCalledWith('r1', 'hard', 'abc123');
  });
});
