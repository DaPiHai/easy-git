import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TimelinePage } from './TimelinePage';
import { RemotesPage } from '../remotes/RemotesPage';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';
import type { RemoteInfo, TimelineEntry } from '../../lib/ipc/commands';

const restoreMock = vi.fn<(...args: unknown[]) => unknown>();
const testMock = vi.fn<(...args: unknown[]) => unknown>();
const addMock = vi.fn<(...args: unknown[]) => unknown>();
const fetchMock = vi.fn<(...args: unknown[]) => unknown>();
const removeMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
    isTauriAvailable: () => true,
    restoreTo: (...args: unknown[]) => restoreMock(...args),
    remoteTest: (...args: unknown[]) => testMock(...args),
    remoteAdd: (...args: unknown[]) => addMock(...args),
    fetchRemote: (...args: unknown[]) => fetchMock(...args),
    remoteRemove: (...args: unknown[]) => removeMock(...args),
  };
});

function entry(overrides: Partial<TimelineEntry> = {}): TimelineEntry {
  return {
    oid: 'abc1234def5678',
    subject: 'commit: 接入时间线',
    kind: 'commit',
    danger: false,
    time: Math.floor(Date.now() / 1000) - 60,
    ...overrides,
  };
}

function remote(overrides: Partial<RemoteInfo> = {}): RemoteInfo {
  return { name: 'origin', url: 'https://example.com/r.git', pushUrl: null, ...overrides };
}

beforeEach(() => {
  vi.clearAllMocks();
  useRepoStore.setState({ activeId: 'r1' });
});

describe('TimelinePage (F-28)', () => {
  it('renders the merged feed with danger outlines and oids', () => {
    useSyncStore.setState({
      timeline: [
        entry(),
        entry({
          oid: null,
          subject: '丢弃修改（2 个路径）',
          kind: 'discard',
          danger: true,
        }),
      ],
    });
    render(<TimelinePage />);
    expect(screen.getByTestId('timeline-view')).toBeInTheDocument();
    expect(screen.getByText('commit: 接入时间线')).toBeInTheDocument();
    expect(screen.getByText('丢弃修改（2 个路径）')).toBeInTheDocument();
    expect(screen.getByText('abc1234')).toBeInTheDocument();
  });

  it('恢复到此状态 asks for confirmation and resets behind a snapshot', async () => {
    const user = userEvent.setup();
    restoreMock.mockResolvedValue({ opId: 'op-9' });
    useSyncStore.setState({ timeline: [entry()] });
    render(<TimelinePage />);
    await user.click(screen.getByTestId('timeline-restore-0'));
    expect(screen.getByText(/恢复到 abc1234/)).toBeInTheDocument();
    await user.click(screen.getByTestId('timeline-restore-confirm'));
    expect(restoreMock).toHaveBeenCalledWith('r1', 'abc1234def5678');
  });

  it('shows the empty state without entries', () => {
    useSyncStore.setState({ timeline: [] });
    render(<TimelinePage />);
    expect(screen.getByText('还没有操作记录')).toBeInTheDocument();
  });
});

describe('RemotesPage (F-29)', () => {
  it('lists remotes with test/fetch/delete actions', async () => {
    testMock.mockResolvedValue(12);
    const user = userEvent.setup();
    useSyncStore.setState({ remotes: [remote()] });
    render(<RemotesPage />);
    expect(screen.getByText('origin')).toBeInTheDocument();
    expect(screen.getByText('https://example.com/r.git')).toBeInTheDocument();
    await user.click(screen.getByTestId('remote-test-origin'));
    expect(testMock).toHaveBeenCalledWith('r1', 'origin');
  });

  it('adds a remote through the form dialog', async () => {
    addMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    useSyncStore.setState({ remotes: [] });
    render(<RemotesPage />);
    await user.click(screen.getByTestId('remote-add'));
    await user.type(screen.getByTestId('remote-name-input'), 'upstream');
    await user.type(screen.getByTestId('remote-url-input'), 'https://example.com/up.git');
    await user.click(screen.getByTestId('remote-form-confirm'));
    expect(addMock).toHaveBeenCalledWith('r1', 'upstream', 'https://example.com/up.git');
  });

  it('delete requires a danger confirmation', async () => {
    removeMock.mockResolvedValue(undefined);
    const user = userEvent.setup();
    useSyncStore.setState({ remotes: [remote()] });
    render(<RemotesPage />);
    await user.click(screen.getByTestId('remote-delete-origin'));
    expect(screen.getByText(/删除远程 origin/)).toBeInTheDocument();
    await user.click(screen.getByTestId('remote-delete-confirm'));
    expect(removeMock).toHaveBeenCalledWith('r1', 'origin');
  });
});
