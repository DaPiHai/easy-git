import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { ChangesPage } from './ChangesPage';
import { useRepoStore } from '../../stores/repoStore';
import type { StatusReport } from '../../lib/ipc/commands';

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
  useRepoStore.getState().seed({ status: null, selectedChange: null });
});

describe('ChangesPage', () => {
  it('shows the clean state when there is nothing to do', () => {
    useRepoStore.getState().seed({ status: report({}) });
    render(<ChangesPage />);
    expect(screen.getByText('工作区很干净')).toBeInTheDocument();
  });

  it('renders the three zones with counts and change rows', () => {
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

    const staged = container.querySelector('[data-zone="已暂存"]');
    expect(staged).toHaveTextContent('app.ts');
    expect(staged).toHaveTextContent('新增');

    const unstaged = container.querySelector('[data-zone="未暂存"]');
    expect(unstaged).toHaveTextContent('dag.ts');
    expect(unstaged).toHaveTextContent('修改');
    expect(unstaged).toHaveTextContent('assets/');
    expect(unstaged).toHaveTextContent('未跟踪');

    const conflicted = container.querySelector('[data-zone="冲突"]');
    expect(conflicted).toHaveTextContent('plan.txt');
    expect(conflicted?.querySelector('.text-git-conflict')).toHaveTextContent('冲突');
  });

  it('selects a row and mirrors it into the detail panel data', async () => {
    useRepoStore.getState().seed({
      status: report({
        staged: [{ path: 'src/app.ts', oldPath: null, kind: 'added' }],
      }),
    });
    render(<ChangesPage />);

    await userEvent.click(screen.getByText('app.ts'));
    expect(useRepoStore.getState().selectedChange?.path).toBe('src/app.ts');
    expect(screen.getByText('app.ts').closest('button')).toHaveAttribute('aria-selected', 'true');
  });
});
