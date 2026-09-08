import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CommitBox } from './CommitBox';
import { ToastHost } from '../../components';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';
import { useToastStore } from '../../stores/toastStore';
import type { CommitOutcome, StatusReport } from '../../lib/ipc/commands';

const getConfigMock =
  vi.fn<(repoId: string, scope: string, key: string) => Promise<string | null>>();
const commitMock = vi.fn<(repoId: string, request: unknown) => Promise<CommitOutcome>>();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getConfig: (...args: [string, string, string]) => getConfigMock(...args),
    commitIndex: (...args: [string, unknown]) => commitMock(...args),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
  };
});

function report(partial: Partial<StatusReport>): StatusReport {
  return {
    repoId: 'r1',
    branch: 'main',
    headOid: 'abc',
    staged: [],
    unstaged: [],
    conflicted: [],
    ...partial,
  };
}

function outcome(overrides: Partial<CommitOutcome> = {}): CommitOutcome {
  return {
    commitId: '0123456789abcdef',
    amended: false,
    summary: {
      repoId: 'r1',
      path: '/tmp/demo',
      name: 'demo',
      branch: 'main',
      headOid: '0123456789abcdef',
      ahead: 1,
      behind: 0,
      isEmpty: false,
    },
    status: report({ headOid: '0123456789abcdef' }),
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  useToastStore.setState({ toasts: [] });
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
    status: report({ staged: [{ path: 'a.txt', oldPath: null, kind: 'modified' }] }),
    selectedChange: null,
    error: null,
  });
  getConfigMock.mockResolvedValue('tester');
});

describe('CommitBox', () => {
  it('shows the identity warning and a working 去设置 link when identity is missing', async () => {
    getConfigMock.mockResolvedValue(null);
    render(
      <>
        <CommitBox />
        <ToastHost />
      </>,
    );
    expect(await screen.findByTestId('identity-warning')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('goto-settings'));
    expect(useUiStore.getState().view).toBe('settings');
  });

  it('disables submit for an empty subject and shows the nothing-staged hint', () => {
    useRepoStore.getState().seed({ status: report({ staged: [] }) });
    render(<CommitBox />);
    expect(screen.getByTestId('commit-submit')).toBeDisabled();
    expect(screen.getByTestId('nothing-staged')).toBeInTheDocument();
  });

  it('commits the staged subject and clears the form', async () => {
    commitMock.mockResolvedValue(outcome());
    render(
      <>
        <CommitBox />
        <ToastHost />
      </>,
    );
    await userEvent.type(await screen.findByTestId('commit-subject'), 'my commit');
    await userEvent.click(screen.getByTestId('commit-submit'));

    await vi.waitFor(() => {
      expect(commitMock).toHaveBeenCalledWith('r1', {
        subject: 'my commit',
        body: '',
        amend: false,
        allowPartial: false,
      });
    });
    expect(await screen.findByText('已创建提交 0123456')).toBeInTheDocument();
    expect(screen.getByTestId('commit-subject')).toHaveValue('');
  });

  it('offers the partial-staging confirmation and resubmits with allowPartial', async () => {
    commitMock
      .mockRejectedValueOnce({
        code: 'unsafe_operation',
        confirm_required: '部分暂存：a.txt',
      })
      .mockResolvedValueOnce(outcome());
    render(
      <>
        <CommitBox />
        <ToastHost />
      </>,
    );
    await userEvent.type(await screen.findByTestId('commit-subject'), 'partial');
    await userEvent.click(screen.getByTestId('commit-submit'));

    expect(await screen.findByTestId('partial-dialog-overlay')).toBeInTheDocument();
    expect(screen.getByText('a.txt')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('partial-confirm'));
    await vi.waitFor(() => {
      expect(commitMock).toHaveBeenLastCalledWith('r1', {
        subject: 'partial',
        body: '',
        amend: false,
        allowPartial: true,
      });
    });
    expect(screen.queryByTestId('partial-dialog-overlay')).not.toBeInTheDocument();
  });

  it('toasts a humanized error for non-guard failures', async () => {
    commitMock.mockRejectedValue({ code: 'internal', context: 'boom' });
    render(
      <>
        <CommitBox />
        <ToastHost />
      </>,
    );
    await userEvent.type(await screen.findByTestId('commit-subject'), 'x');
    await userEvent.click(screen.getByTestId('commit-submit'));
    expect(await screen.findByText('出了点问题')).toBeInTheDocument();
  });
});
