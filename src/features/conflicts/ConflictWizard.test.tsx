import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictWizard, composeContent } from './ConflictWizard';
import { useMergeStore } from '../../stores/mergeStore';
import { useRepoStore } from '../../stores/repoStore';
import { useToastStore } from '../../stores/toastStore';
import type { ConflictFile, StatusReport } from '../../lib/ipc/commands';

const resolveMock = vi.fn<(...args: unknown[]) => unknown>();
const commitMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

vi.mock('../../stores/mergeStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../stores/mergeStore')>();
  return {
    ...original,
    useMergeStore: Object.assign(original.useMergeStore, {}),
  };
});

function conflictFile(overrides: Partial<ConflictFile> = {}): ConflictFile {
  return {
    path: 'shared.txt',
    baseContent: 'a\nb\n',
    oursContent: 'a\nours line\n',
    theirsContent: 'a\ntheirs line\n',
    segments: ['a\n'],
    blocks: [{ ours: ['ours line'], theirs: ['theirs line'] }],
    isBinary: false,
    ...overrides,
  };
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

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
  useRepoStore.setState({ activeId: 'r1', commit: commitMock as never });
  useMergeStore.setState({
    mergeState: { message: "Merge branch 'feature'", theirs: ['feature'] },
    conflicts: [conflictFile()],
    knownPaths: ['shared.txt'],
    loading: false,
    error: null,
  });
  useMergeStore.setState({ resolveFile: resolveMock as never });
});

describe('composeContent', () => {
  it('recomposes segments around the per-block decisions', () => {
    const file = conflictFile({
      segments: ['head\n', 'mid\n', 'tail\n'],
      blocks: [
        { ours: ['o1'], theirs: ['t1'] },
        { ours: ['o2'], theirs: ['t2'] },
      ],
    });
    const content = composeContent(file, {
      0: { kind: 'ours', lines: ['o1'] },
      1: { kind: 'both', lines: [] },
    });
    expect(content).toBe('head\no1\nmid\no2\nt2\ntail\n');
  });
});

describe('ConflictWizard', () => {
  it('shows progress, three columns and the block decisions', () => {
    render(<ConflictWizard />);
    expect(screen.getByTestId('conflict-wizard')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-progress')).toHaveTextContent('已解决 0/1');
    expect(screen.getByText('我方（当前分支）')).toBeInTheDocument();
    expect(screen.getByText('对方（feature）')).toBeInTheDocument();
    expect(screen.getByTestId('conflict-block-0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '中止合并' })).toBeInTheDocument();
  });

  it('resolves a file with 用我的 and calls conflict resolve', async () => {
    const user = userEvent.setup();
    resolveMock.mockResolvedValue(cleanStatus());
    render(<ConflictWizard />);
    await user.click(screen.getByRole('button', { name: '用我的' }));
    await user.click(screen.getByRole('button', { name: '解决此文件' }));
    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith('shared.txt', 'a\nours line\n');
    });
  });

  it('keeps both sides with 两者保留', async () => {
    const user = userEvent.setup();
    resolveMock.mockResolvedValue(cleanStatus());
    render(<ConflictWizard />);
    await user.click(screen.getByRole('button', { name: '两者保留' }));
    await user.click(screen.getByRole('button', { name: '解决此文件' }));
    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith('shared.txt', 'a\nours line\ntheirs line\n');
    });
  });

  it('supports manual editing per block', async () => {
    const user = userEvent.setup();
    resolveMock.mockResolvedValue(cleanStatus());
    render(<ConflictWizard />);
    await user.click(screen.getByRole('button', { name: '手动编辑' }));
    await user.type(screen.getByTestId('conflict-manual-0'), 'merged line');
    await user.click(screen.getByRole('button', { name: '应用编辑' }));
    await user.click(screen.getByRole('button', { name: '解决此文件' }));
    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith('shared.txt', 'a\nmerged line\n');
    });
  });

  it('offers only ours/theirs for binary files', async () => {
    useMergeStore.setState({
      conflicts: [conflictFile({ isBinary: true, blocks: [], segments: [] })],
    });
    const user = userEvent.setup();
    resolveMock.mockResolvedValue(cleanStatus());
    render(<ConflictWizard />);
    await user.click(screen.getByRole('button', { name: '用对方的' }));
    await user.click(screen.getByRole('button', { name: '解决此文件' }));
    await waitFor(() => {
      expect(resolveMock).toHaveBeenCalledWith('shared.txt', 'a\ntheirs line\n');
    });
  });

  it('when everything is resolved shows the 完成合并 entry', async () => {
    useMergeStore.setState({ conflicts: [], knownPaths: ['shared.txt'] });
    commitMock.mockResolvedValue({
      commitId: 'abc',
      amended: false,
      summary: {},
      status: cleanStatus(),
    });
    const user = userEvent.setup();
    render(<ConflictWizard />);
    expect(screen.getByText('所有冲突已解决，可以完成合并了')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '完成合并' }));
    expect(screen.getByTestId('merge-commit-subject')).toHaveValue("Merge branch 'feature'");
    await user.click(screen.getByRole('button', { name: '创建合并提交' }));
    await waitFor(() => {
      expect(commitMock).toHaveBeenCalledWith({
        subject: "Merge branch 'feature'",
        body: '',
        amend: false,
        allowPartial: false,
      });
    });
  });

  it('abort requires a danger confirmation', async () => {
    const abortMock = vi.fn(async () => true);
    useMergeStore.setState({ abortMerge: abortMock as never });
    const user = userEvent.setup();
    render(<ConflictWizard />);
    await user.click(screen.getByRole('button', { name: '中止合并' }));
    expect(screen.getByText(/中止将放弃所有已做的解决/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '中止' }));
    expect(abortMock).toHaveBeenCalled();
  });
});
