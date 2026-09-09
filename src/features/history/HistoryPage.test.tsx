import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HistoryPage } from './HistoryPage';
import { useHistoryStore } from '../../stores/historyStore';
import { useRepoStore } from '../../stores/repoStore';
import { entry } from './fixtures';

const logPageMock = vi.fn<(...args: unknown[]) => unknown>();
const detailMock = vi.fn<(...args: unknown[]) => unknown>();
const branchesMock = vi.fn<(...args: unknown[]) => unknown>(async () => ['main', 'feature']);

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    logPage: (...args: unknown[]) => logPageMock(...args),
    commitDetail: (...args: unknown[]) => detailMock(...args),
    listBranches: (...args: unknown[]) => branchesMock(...args),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver;
// jsdom has no canvas backend; the component guards on a null context.
window.HTMLCanvasElement.prototype.getContext = () => null;

/** Makes mount-time load() resolve with the given rows. */
function stubLog(entries: ReturnType<typeof entry>[], nextOffset: number | null = null) {
  logPageMock.mockImplementation(async () => ({
    repoId: 'r1',
    entries,
    nextOffset,
    branch: 'main',
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  useHistoryStore.getState().seed({
    entries: [],
    branches: ['main', 'feature'],
    nextOffset: null,
    loading: false,
    error: null,
    filter: { branch: null, author: null, message: null },
    selectedOid: null,
    detail: null,
    detailLoading: false,
  });
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

describe('HistoryPage (F-15/F-16/F-17)', () => {
  it('renders commit rows with refs, author, time and hash', async () => {
    stubLog([
      entry({
        subject: 'merge feature into main',
        refs: { branches: ['main'], remotes: [], tags: [] },
        node: { lane: 0, color: 0, merge: true },
        isHead: true,
      }),
      entry({
        oid: 'bbbb',
        shortOid: 'bbbbbbb',
        subject: 'feat: DAG lanes 渲染',
        authorName: '李四',
        refs: { branches: [], remotes: ['origin/feature'], tags: ['v0.9'] },
      }),
    ]);
    render(<HistoryPage />);

    expect(await screen.findByText('merge feature into main')).toBeInTheDocument();
    expect(screen.getByText('feat: DAG lanes 渲染')).toBeInTheDocument();
    expect(screen.getAllByTestId('ref-pill').length).toBeGreaterThan(0);
    expect(screen.getByText('origin/feature')).toBeInTheDocument();
    expect(screen.getByText('v0.9')).toBeInTheDocument();
    expect(screen.getByText('李')).toBeInTheDocument(); // avatar initial
    expect(screen.getByText('bbbbbbb')).toBeInTheDocument();
    expect(screen.getByTestId('history-canvas')).toBeInTheDocument();
  });

  it('virtualizes the list instead of mounting every row', async () => {
    const many = Array.from({ length: 500 }, (_, i) =>
      entry({ oid: `oid-${i}`, shortOid: `o${i}`, subject: `commit ${i}` }),
    );
    stubLog(many);
    render(<HistoryPage />);

    await screen.findByText('commit 0');
    const rows = screen.getAllByTestId('history-row');
    expect(rows.length).toBeLessThan(120);
    // Deep-tail rows stay unmounted until scrolled near.
    expect(screen.queryByText('commit 499')).not.toBeInTheDocument();
  });

  it('selects a commit on click and fetches its detail', async () => {
    detailMock.mockResolvedValue({
      oid: 'abc',
      shortOid: 'abc',
      subject: 'feat: something',
      body: 'body',
      authorName: '张三',
      authorEmail: 'z@ex.com',
      authorTime: 1,
      refs: { branches: [], remotes: [], tags: [] },
      files: [{ path: 'src/app.ts', oldPath: null, kind: 'modified', added: 3, deleted: 1 }],
    });
    stubLog([entry({ oid: 'abc', shortOid: 'abc' })]);
    render(<HistoryPage />);

    await userEvent.click(await screen.findByTestId('history-row'));
    expect(detailMock).toHaveBeenCalledWith('r1', 'abc');
    expect(useHistoryStore.getState().selectedOid).toBe('abc');
  });

  it('fetches more pages on scroll near the bottom', async () => {
    stubLog(
      Array.from({ length: 500 }, (_, i) => entry({ oid: `oid-${i}`, subject: `commit ${i}` })),
      500,
    );
    render(<HistoryPage />);
    await screen.findByText('commit 0');

    const list = screen.getByTestId('history-list');
    // jsdom reports zero sizes, so any scroll event counts as "near bottom".
    fireEvent.scroll(list);
    await vi.waitFor(() => {
      expect(logPageMock).toHaveBeenLastCalledWith('r1', 500, 500, expect.anything());
    });
  });

  it('applies the branch filter and debounced search', async () => {
    stubLog([]);
    render(<HistoryPage />);
    await vi.waitFor(() => expect(logPageMock).toHaveBeenCalledTimes(1));

    await userEvent.selectOptions(screen.getByTestId('history-filter-branch'), 'feature');
    await vi.waitFor(() => {
      const last = logPageMock.mock.calls.at(-1);
      expect((last?.[3] as { branch?: string }).branch).toBe('feature');
    });

    await userEvent.type(screen.getByTestId('history-filter-search'), 'fix');
    await vi.waitFor(
      () => {
        const last = logPageMock.mock.calls.at(-1);
        expect((last?.[3] as { message?: string }).message).toBe('fix');
        expect((last?.[3] as { branch?: string }).branch).toBe('feature');
      },
      { timeout: 1500 },
    );
  });

  it('shows the empty state for a repository without commits', () => {
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
          isEmpty: true,
        },
      },
    });
    render(<HistoryPage />);
    expect(screen.getByText('还没有任何提交')).toBeInTheDocument();
  });
});
