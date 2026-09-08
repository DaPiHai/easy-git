import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useHistoryStore } from './historyStore';
import { useRepoStore } from './repoStore';
import { entry } from '../features/history/fixtures';
import type { CommitDetail, CommitLogEntry, LogPage } from '../lib/ipc/commands';

const logPageMock =
  vi.fn<(repoId: string, offset: number, limit: number, filter: unknown) => Promise<LogPage>>();
const detailMock = vi.fn<(repoId: string, oid: string) => Promise<CommitDetail>>();
const branchesMock = vi.fn<(repoId: string) => Promise<string[]>>();

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    logPage: (...args: [string, number, number, unknown]) => logPageMock(...args),
    commitDetail: (...args: [string, string]) => detailMock(...args),
    listBranches: (...args: [string]) => branchesMock(...args),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
  };
});

function page(entries: CommitLogEntry[], nextOffset: number | null = null): LogPage {
  return { repoId: 'r1', entries, nextOffset, branch: 'main' };
}

beforeEach(() => {
  vi.clearAllMocks();
  useHistoryStore.getState().seed({
    entries: [],
    branches: [],
    nextOffset: null,
    branch: null,
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
  branchesMock.mockResolvedValue(['main', 'feature']);
});

describe('historyStore (F-15/F-16/F-17)', () => {
  it('loads the first page, branch list and next offset', async () => {
    logPageMock.mockResolvedValue(page([entry(), entry({ subject: 'fix: later' })], 500));
    await useHistoryStore.getState().load();

    expect(logPageMock).toHaveBeenCalledWith('r1', 0, 500, {
      branch: null,
      author: null,
      message: null,
    });
    expect(useHistoryStore.getState().entries).toHaveLength(2);
    expect(useHistoryStore.getState().nextOffset).toBe(500);
    expect(useHistoryStore.getState().branches).toEqual(['main', 'feature']);
  });

  it('appends pages via loadMore and exhausts the walk', async () => {
    useHistoryStore.getState().seed({ entries: [entry()], nextOffset: 500 });
    logPageMock.mockResolvedValue(page([entry({ subject: 'fix: older page 2' })], null));
    await useHistoryStore.getState().loadMore();

    expect(logPageMock).toHaveBeenCalledWith('r1', 500, 500, expect.anything());
    expect(useHistoryStore.getState().entries).toHaveLength(2);
    expect(useHistoryStore.getState().nextOffset).toBeNull();
  });

  it('skips loadMore when exhausted or already loading', async () => {
    useHistoryStore.getState().seed({ nextOffset: null, entries: [entry()] });
    await useHistoryStore.getState().loadMore();
    expect(logPageMock).not.toHaveBeenCalled();

    useHistoryStore.getState().seed({ nextOffset: 500 });
    useHistoryStore.setState({ loading: true });
    await useHistoryStore.getState().loadMore();
    expect(logPageMock).not.toHaveBeenCalled();
  });

  it('applies filters and reloads with them', async () => {
    logPageMock.mockResolvedValue(page([], null));
    await useHistoryStore.getState().setFilter({ author: '李四', branch: 'feature' });

    expect(logPageMock).toHaveBeenLastCalledWith(
      'r1',
      0,
      500,
      expect.objectContaining({ author: '李四', branch: 'feature' }),
    );
    expect(useHistoryStore.getState().filter).toEqual({
      branch: 'feature',
      author: '李四',
      message: null,
    });
  });

  it('fetches commit detail on selection and clears on deselect', async () => {
    detailMock.mockResolvedValue({
      oid: 'abc',
      shortOid: 'abc',
      subject: 'feat: something',
      body: '',
      authorName: '张三',
      authorEmail: 'z@ex.com',
      authorTime: 1,
      refs: { branches: [], remotes: [], tags: [] },
      files: [{ path: 'a.txt', oldPath: null, kind: 'modified', added: 1, deleted: 2 }],
    });
    await useHistoryStore.getState().selectCommit('abc');
    expect(useHistoryStore.getState().detail?.files).toHaveLength(1);

    await useHistoryStore.getState().selectCommit(null);
    expect(useHistoryStore.getState().selectedOid).toBeNull();
    expect(useHistoryStore.getState().detail).toBeNull();
  });

  it('clears state when no repository is active', async () => {
    useHistoryStore.getState().seed({ entries: [entry()], branches: ['main'] });
    useRepoStore.getState().seed({ activeId: null });
    await useHistoryStore.getState().load();

    expect(useHistoryStore.getState().entries).toEqual([]);
    expect(useHistoryStore.getState().branches).toEqual([]);
    expect(logPageMock).not.toHaveBeenCalled();
  });
});
