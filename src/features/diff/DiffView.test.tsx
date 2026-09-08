import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DiffView } from './DiffView';
import { useDiffStore } from '../../stores/diffStore';
import { useRepoStore } from '../../stores/repoStore';
import type { DiffResponse } from '../../lib/ipc/commands';

const applySelectionMock = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

vi.mock('../../stores/diffStore', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../stores/diffStore')>();
  return {
    ...original,
    useDiffStore: Object.assign(original.useDiffStore, {}),
  };
});

function response(overrides: Partial<DiffResponse> = {}): DiffResponse {
  return {
    repoId: 'r1',
    path: 'src/a.txt',
    oldPath: null,
    kind: 'modified',
    added: 2,
    deleted: 1,
    isBinary: false,
    truncated: false,
    hunks: [
      {
        header: '@@ -1,3 +1,4 @@',
        oldStart: 1,
        newStart: 1,
        lines: [
          { kind: 'context', oldLineno: 1, newLineno: 1, content: 'one', word: null },
          {
            kind: 'deleted',
            oldLineno: 2,
            newLineno: null,
            content: 'alpha beta gamma',
            word: { start: 6, end: 10 },
          },
          {
            kind: 'added',
            oldLineno: null,
            newLineno: 2,
            content: 'alpha BETA gamma',
            word: { start: 6, end: 10 },
          },
          { kind: 'added', oldLineno: null, newLineno: 3, content: 'tail', word: null },
        ],
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
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
  useDiffStore.getState().seed({
    request: { path: 'src/a.txt', oldPath: null, source: 'worktree', commitOid: null },
    error: null,
    loading: false,
  });
});

describe('DiffView (F-18/F-19)', () => {
  it('renders hunks, line numbers, tinted rows and the word-level mark', () => {
    useDiffStore.getState().seed({ data: response() });
    render(<DiffView interactive />);

    expect(screen.getByTestId('diff-view')).toBeInTheDocument();
    expect(screen.getByText('@@ -1,3 +1,4 @@')).toBeInTheDocument();
    expect(screen.getByText('one')).toBeInTheDocument();
    // The word-level mark isolates the changed middle segment.
    expect(screen.getByText('beta')).toBeInTheDocument();
    // +2 −1 in the header.
    expect(screen.getByText('+2')).toBeInTheDocument();
  });

  it('offers per-hunk staging that selects every changed row', async () => {
    useDiffStore.setState({ applySelection: applySelectionMock });
    useDiffStore.getState().seed({ data: response() });
    render(<DiffView interactive />);

    await userEvent.click(screen.getByTestId('diff-hunk-action-0'));
    expect(applySelectionMock).toHaveBeenCalledWith([{ hunkIndex: 0, lineIndexes: [1, 2, 3] }]);
  });

  it('collects individually checked rows into the apply button', async () => {
    useDiffStore.setState({ applySelection: applySelectionMock });
    useDiffStore.getState().seed({ data: response() });
    render(<DiffView interactive />);

    // Context rows are not selectable; changed rows are.
    expect(screen.queryByTestId('diff-line-check-0-0')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('diff-line-check-0-1'));
    await userEvent.click(screen.getByTestId('diff-line-check-0-3'));

    expect(screen.getByTestId('diff-apply-selection')).toHaveTextContent('暂存选中的 2 行');
    await userEvent.click(screen.getByTestId('diff-apply-selection'));
    expect(applySelectionMock).toHaveBeenCalledWith([{ hunkIndex: 0, lineIndexes: [1, 3] }]);
  });

  it('hides staging affordances for read-only commit diffs', () => {
    useDiffStore.getState().seed({
      data: response(),
      request: { path: 'src/a.txt', oldPath: null, source: 'commit', commitOid: 'abc' },
    });
    render(<DiffView />);
    expect(screen.queryByTestId('diff-hunk-action-0')).not.toBeInTheDocument();
    expect(screen.queryByTestId('diff-line-check-0-1')).not.toBeInTheDocument();
  });

  it('shows binary and empty placeholders', () => {
    useDiffStore.getState().seed({ data: response({ isBinary: true, hunks: [] }) });
    const first = render(<DiffView />);
    expect(screen.getByTestId('diff-binary')).toBeInTheDocument();
    first.unmount();

    useDiffStore.getState().seed({ data: response({ hunks: [], added: 0, deleted: 0 }) });
    const second = render(<DiffView />);
    expect(screen.getByTestId('diff-empty')).toBeInTheDocument();
    second.unmount();
  });

  it('folds huge diffs behind an expand button', async () => {
    const bigLines = Array.from({ length: 700 }, (_, i) => ({
      kind: 'added' as const,
      oldLineno: null,
      newLineno: i + 1,
      content: `line ${i}`,
      word: null,
    }));
    useDiffStore.getState().seed({
      data: response({
        truncated: true,
        hunks: [{ header: '@@ -0,0 +1,700 @@', oldStart: 0, newStart: 1, lines: bigLines }],
      }),
    });
    render(<DiffView />);
    expect(screen.getByTestId('diff-truncated')).toBeInTheDocument();
    expect(screen.getByText('line 299')).toBeInTheDocument();
    expect(screen.queryByText('line 299x')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('diff-expand'));
    expect(screen.getByText('line 699')).toBeInTheDocument();
  });
});
