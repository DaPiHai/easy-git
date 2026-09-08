import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRefStore } from './refsStore';
import { useRepoStore } from './repoStore';
import { useToastStore } from './toastStore';
import type { BranchInfo, StatusReport } from '../lib/ipc/commands';

const branchListMock = vi.fn<(...args: unknown[]) => unknown>();
const branchCreateMock = vi.fn<(...args: unknown[]) => unknown>();
const branchSwitchMock = vi.fn<(...args: unknown[]) => unknown>();
const branchDeleteMock = vi.fn<(...args: unknown[]) => unknown>();
const stashPushMock = vi.fn<(...args: unknown[]) => unknown>();
const undoMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    branchList: (...args: unknown[]) => branchListMock(...args),
    branchCreate: (...args: unknown[]) => branchCreateMock(...args),
    branchSwitch: (...args: unknown[]) => branchSwitchMock(...args),
    branchDelete: (...args: unknown[]) => branchDeleteMock(...args),
    stashPush: (...args: unknown[]) => stashPushMock(...args),
    tagList: vi.fn(async () => []),
    stashList: vi.fn(async () => []),
    undoOperation: async (...args: unknown[]) => undoMock(...args),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

function branch(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    name: 'main',
    isCurrent: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    tipOid: 'abc1234',
    tipSubject: 'feat: something',
    tipTime: Math.floor(Date.now() / 1000),
    ...overrides,
  };
}

function cleanStatus(): StatusReport {
  return {
    repoId: 'r1',
    branch: 'feature',
    headOid: 'abc',
    staged: [],
    unstaged: [],
    conflicted: [],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useRefStore.getState().seed({ branches: [], tags: [], stashes: [], error: null });
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
  branchListMock.mockResolvedValue([branch({ isCurrent: true }), branch({ name: 'feature' })]);
});

describe('refsStore (F-21/R-15~R-18)', () => {
  it('refreshes branches, tags and stashes together', async () => {
    await useRefStore.getState().refresh();
    expect(useRefStore.getState().branches).toHaveLength(2);
    expect(useRefStore.getState().branches[0].isCurrent).toBe(true);
  });

  it('creates a branch and records the lens command', async () => {
    branchCreateMock.mockResolvedValue(branch({ name: 'feature/login' }));
    await useRefStore.getState().createBranch('feature/login', null);
    expect(branchCreateMock).toHaveBeenCalledWith('r1', 'feature/login', null);
    const { useLensStore } = await import('./lensStore');
    expect(useLensStore.getState().entries.at(-1)).toBe('git branch "feature/login"');
    expect(useToastStore.getState().toasts[0]?.message).toBe('已创建分支 feature/login');
  });

  it('switches branches, syncing status and repo summary', async () => {
    branchSwitchMock.mockResolvedValue(cleanStatus());
    const result = await useRefStore.getState().switchBranch('feature');
    expect(result).toBe('ok');
    expect(useRepoStore.getState().status?.branch).toBe('feature');
    expect(useRepoStore.getState().repos.r1?.branch).toBe('feature');
    const { useLensStore } = await import('./lensStore');
    expect(useLensStore.getState().entries.at(-1)).toBe('git switch "feature"');
  });

  it('reports dirty worktree without a toast so the dialog can take over', async () => {
    branchSwitchMock.mockRejectedValue({ code: 'dirty_worktree', paths: ['a.txt'] });
    const result = await useRefStore.getState().switchBranch('feature');
    expect(result).toBe('dirty');
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('delete offers the undo toast wired to undoOperation', async () => {
    branchDeleteMock.mockResolvedValue('op-1');
    const opId = await useRefStore.getState().deleteBranch('feature');
    expect(opId).toBe('op-1');
    expect(useToastStore.getState().toasts[0]?.kind).toBe('info');
    useToastStore.getState().toasts[0]?.action?.onClick();
    await vi.waitFor(() => expect(undoMock).toHaveBeenCalledWith('r1', 'op-1'));
  });

  it('stash push applies the fresh status and toasts', async () => {
    stashPushMock.mockResolvedValue(cleanStatus());
    const ok = await useRefStore.getState().stashPush('wip', true);
    expect(ok).toBe(true);
    expect(stashPushMock).toHaveBeenCalledWith('r1', 'wip', true);
    expect(useToastStore.getState().toasts[0]?.message).toBe('已存入储藏');
  });
});
