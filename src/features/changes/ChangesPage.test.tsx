import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangesPage, useChangesDialogs } from './ChangesPage';
import { ToastHost } from '../../components';
import { useRepoStore } from '../../stores/repoStore';
import { useToastStore } from '../../stores/toastStore';
import type { StatusReport } from '../../lib/ipc/commands';

const stageMock = vi.fn();
const discardMock = vi.fn();
const undoMock = vi.fn();
const ignoreMock = vi.fn();
const cleanExecuteMock = vi.fn();
const cleanPreviewMock = vi.fn();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    stagePaths: (...args: unknown[]) => stageMock(...args),
    discardChanges: (...args: unknown[]) => discardMock(...args),
    undoOperation: (...args: unknown[]) => undoMock(...args),
    ignorePaths: (...args: unknown[]) => ignoreMock(...args),
    cleanExecute: (...args: unknown[]) => cleanExecuteMock(...args),
    cleanPreview: (...args: unknown[]) => cleanPreviewMock(...args),
    getStatus: vi.fn(),
    openRepo: vi.fn(),
    initRepo: vi.fn(),
    closeRepo: vi.fn(),
    pickDirectory: vi.fn(),
    getAppVersion: vi.fn(),
    isTauriAvailable: () => true,
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
        ahead: 2,
        behind: 0,
        isEmpty: false,
      },
    },
    activeId: 'r1',
    status: null,
    selectedChange: null,
  });
});

describe('ChangesPage', () => {
  it('shows the clean state when there is nothing to do', () => {
    useRepoStore.getState().seed({ status: report({}) });
    render(
      <>
        <ChangesPage />
        <ToastHost />
      </>,
    );
    expect(screen.getByText('工作区很干净')).toBeInTheDocument();
  });

  it('renders the flow strip, three zones and change rows', () => {
    useRepoStore.getState().seed({
      status: report({
        conflicted: [{ path: 'src/plan.txt', oldPath: null, kind: 'conflicted' }],
        staged: [{ path: 'src/app.ts', oldPath: null, kind: 'added' }],
        unstaged: [
          { path: 'src/dag.ts', oldPath: null, kind: 'modified' },
          { path: 'assets/', oldPath: null, kind: 'untracked' },
        ],
      }),
    });
    const { container } = render(<ChangesPage />);

    const strip = screen.getByTestId('flow-strip');
    expect(strip).toHaveTextContent('工作区');
    expect(strip).toHaveTextContent('↑2');

    const staged = container.querySelector('[data-zone="已暂存"]');
    expect(staged).toHaveTextContent('app.ts');
    expect(staged).toHaveTextContent('新增');

    const conflicted = container.querySelector('[data-zone="冲突"]');
    expect(conflicted).toHaveTextContent('plan.txt');
    // Conflicted rows have no staging checkbox.
    expect(conflicted?.querySelector('[data-testid="row-check"]')).toBeNull();
  });

  it('filters rows by query', async () => {
    useRepoStore.getState().seed({
      status: report({
        unstaged: [
          { path: 'src/dag.ts', oldPath: null, kind: 'modified' },
          { path: 'src/app.ts', oldPath: null, kind: 'modified' },
        ],
      }),
    });
    render(
      <>
        <ChangesPage />
        <ToastHost />
      </>,
    );
    await userEvent.type(screen.getByTestId('changes-filter'), 'dag');
    const unstaged = document.querySelector('[data-zone="未暂存"]');
    expect(unstaged).toHaveTextContent('dag.ts');
    expect(unstaged).not.toHaveTextContent('app.ts');
  });

  it('row checkbox stages the file immediately (勾选即暂存)', async () => {
    stageMock.mockResolvedValue(
      report({ staged: [{ path: 'src/dag.ts', oldPath: null, kind: 'modified' }] }),
    );
    useRepoStore.getState().seed({
      status: report({
        unstaged: [{ path: 'src/dag.ts', oldPath: null, kind: 'modified' }],
      }),
    });
    render(
      <>
        <ChangesPage />
        <ToastHost />
      </>,
    );

    await userEvent.click(screen.getByTestId('row-check'));
    expect(stageMock).toHaveBeenCalledWith('r1', ['src/dag.ts'], 'stage');
  });

  it('zone header checkbox batches unstaging the staged zone', async () => {
    stageMock.mockResolvedValue(report({}));
    useRepoStore.getState().seed({
      status: report({
        staged: [
          { path: 'src/a.ts', oldPath: null, kind: 'added' },
          { path: 'src/b.ts', oldPath: null, kind: 'added' },
        ],
      }),
    });
    render(
      <>
        <ChangesPage />
        <ToastHost />
      </>,
    );

    await userEvent.click(screen.getByTestId('zone-check-staged'));
    expect(stageMock).toHaveBeenCalledWith('r1', ['src/a.ts', 'src/b.ts'], 'unstage');
  });

  it('discard opens a confirm dialog; confirming fires IPC and an undo toast', async () => {
    discardMock.mockResolvedValue({
      opId: 'op-1',
      status: report({}),
    });
    undoMock.mockResolvedValue(report({}));
    useRepoStore.getState().seed({
      status: report({
        unstaged: [{ path: 'src/dag.ts', oldPath: null, kind: 'modified' }],
      }),
    });
    render(
      <>
        <ChangesPage />
        <ToastHost />
      </>,
    );

    useChangesDialogs
      .getState()
      .openDiscard([{ path: 'src/dag.ts', oldPath: null, kind: 'modified' }]);
    expect(await screen.findByRole('dialog')).toHaveTextContent('丢弃这些修改');

    await userEvent.click(screen.getByTestId('discard-confirm'));
    expect(discardMock).toHaveBeenCalledWith('r1', ['src/dag.ts']);
    const toastNode = await screen.findByTestId('toast');
    expect(toastNode).toHaveTextContent('撤销');

    await userEvent.click(screen.getByText('撤销'));
    expect(undoMock).toHaveBeenCalledWith('r1', 'op-1');
  });

  it('untracked rows offer clean + ignore; clean confirm uses the dialog list', async () => {
    cleanExecuteMock.mockResolvedValue({ opId: 'op-2', status: report({}) });
    useRepoStore.getState().seed({
      status: report({
        unstaged: [{ path: 'assets/', oldPath: null, kind: 'untracked' }],
      }),
    });
    render(
      <>
        <ChangesPage />
        <ToastHost />
      </>,
    );

    useChangesDialogs.getState().openClean(['assets/']);
    expect(await screen.findByTestId('clean-list')).toHaveTextContent('assets/');

    await userEvent.click(screen.getByTestId('clean-confirm'));
    expect(cleanExecuteMock).toHaveBeenCalledWith('r1', ['assets/']);
  });
});
