import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useRepoStore } from './repoStore';

const getStatusMock = vi.fn(async (_repoId: string) => ({
  repoId: 'r1',
  branch: 'main',
  headOid: 'abc',
  staged: [],
  unstaged: [],
  conflicted: [],
}));

const openRepoMock = vi.fn(async (_path: string) => ({
  repoId: 'r1',
  path: '/tmp/demo',
  name: 'demo',
  branch: 'main',
  headOid: 'abc',
  ahead: 0,
  behind: 0,
  isEmpty: false,
}));

const closeRepoMock = vi.fn(async (_repoId: string) => undefined);
const initRepoMock = vi.fn(async (_path: string) => ({
  repoId: 'r2',
  path: '/tmp/fresh',
  name: 'fresh',
  branch: null,
  headOid: null,
  ahead: 0,
  behind: 0,
  isEmpty: true,
}));

vi.mock('../lib/ipc/commands', () => ({
  openRepo: (path: string) => openRepoMock(path),
  initRepo: (path: string) => initRepoMock(path),
  closeRepo: (repoId: string) => closeRepoMock(repoId),
  getStatus: (repoId: string) => getStatusMock(repoId),
  pickDirectory: vi.fn(async () => null),
  formatIpcError: (e: unknown) => ({ title: '找不到仓库', detail: String(e) }),
  events: {
    repoChanged: { listen: vi.fn(async () => () => {}) },
    syncProgress: { listen: vi.fn(async () => () => {}) },
  },
}));

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useRepoStore.getState().seed({
    repos: {},
    activeId: null,
    status: null,
    recents: [],
    favorites: [],
    selectedChange: null,
  });
});

describe('repoStore.openByPath', () => {
  it('registers the repo, activates it and records a recent entry', async () => {
    await useRepoStore.getState().openByPath('/tmp/demo');

    expect(openRepoMock).toHaveBeenCalledWith('/tmp/demo');
    expect(useRepoStore.getState().activeId).toBe('r1');
    expect(useRepoStore.getState().repos['r1']?.name).toBe('demo');
    expect(getStatusMock).toHaveBeenCalledWith('r1');
    expect(useRepoStore.getState().recents[0]?.path).toBe('/tmp/demo');
    expect(JSON.parse(localStorage.getItem('eg.repo.recents') ?? '[]')[0]?.name).toBe('demo');
  });

  it('stores a humanized error when the open fails', async () => {
    openRepoMock.mockRejectedValueOnce({ code: 'repo_not_found', path: '/nope' });
    await useRepoStore.getState().openByPath('/nope');

    expect(useRepoStore.getState().activeId).toBeNull();
    expect(useRepoStore.getState().error?.title).toBe('找不到仓库');
  });
});

describe('repoStore.initAt', () => {
  it('registers an unborn repo', async () => {
    await useRepoStore.getState().initAt('/tmp/fresh');
    expect(initRepoMock).toHaveBeenCalledWith('/tmp/fresh');
    expect(useRepoStore.getState().repos['r2']?.isEmpty).toBe(true);
    expect(useRepoStore.getState().activeId).toBe('r2');
  });
});

describe('repoStore.close', () => {
  it('switches to the remaining repo and refreshes', async () => {
    useRepoStore.getState().seed({
      repos: {
        r1: {
          repoId: 'r1',
          path: '/a',
          name: 'a',
          branch: 'main',
          headOid: null,
          ahead: 0,
          behind: 0,
          isEmpty: false,
        },
        r2: {
          repoId: 'r2',
          path: '/b',
          name: 'b',
          branch: 'dev',
          headOid: null,
          ahead: 0,
          behind: 0,
          isEmpty: false,
        },
      },
      activeId: 'r1',
    });

    await useRepoStore.getState().close('r1');
    expect(closeRepoMock).toHaveBeenCalledWith('r1');
    expect(useRepoStore.getState().activeId).toBe('r2');
    expect(getStatusMock).toHaveBeenCalledWith('r2');
  });
});

describe('repoStore.toggleFavorite', () => {
  it('persists favorites', () => {
    useRepoStore.getState().toggleFavorite('/a');
    expect(useRepoStore.getState().favorites).toEqual(['/a']);
    expect(JSON.parse(localStorage.getItem('eg.repo.favorites') ?? '[]')).toEqual(['/a']);
    useRepoStore.getState().toggleFavorite('/a');
    expect(useRepoStore.getState().favorites).toEqual([]);
  });
});

describe('repoStore.onRepoChanged', () => {
  it('ignores events from inactive repos', () => {
    useRepoStore.getState().seed({ activeId: 'r1' });
    useRepoStore.getState().onRepoChanged('r9');
    expect(getStatusMock).not.toHaveBeenCalled();
  });
});
