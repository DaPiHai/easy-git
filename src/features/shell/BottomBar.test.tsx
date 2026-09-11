import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomBar } from './BottomBar';
import { useBusyStore } from '../../stores/busyStore';
import { useLensStore } from '../../stores/lensStore';
import { useSyncStore } from '../../stores/syncStore';
import { useUiStore } from '../../stores/uiStore';

beforeEach(() => {
  useLensStore.setState({ entries: [] });
  useUiStore.setState({ expertMode: false });
  useSyncStore.setState({ progress: null });
  useBusyStore.getState().reset();
});

describe('BottomBar command lens (F-13)', () => {
  it('opens the panel and shows the empty hint', async () => {
    render(<BottomBar />);
    await userEvent.click(screen.getByTestId('command-lens'));
    expect(screen.getByTestId('lens-panel')).toBeInTheDocument();
    expect(screen.getByText('执行 Git 操作后，这里会显示对应的命令')).toBeInTheDocument();
  });

  it('lists recorded commands with a count badge and supports clear', async () => {
    useLensStore.getState().record('git add -- "a.txt"');
    useLensStore.getState().record('git commit -m "first"');
    render(<BottomBar />);
    expect(screen.getByTestId('lens-count')).toHaveTextContent('2');

    await userEvent.click(screen.getByTestId('command-lens'));
    expect(screen.getByText('git add -- "a.txt"')).toBeInTheDocument();
    expect(screen.getByText('git commit -m "first"')).toBeInTheDocument();

    await userEvent.click(screen.getByTestId('lens-clear'));
    expect(useLensStore.getState().entries).toEqual([]);
    expect(screen.queryByTestId('lens-count')).not.toBeInTheDocument();
  });

  it('copies all entries to the clipboard', async () => {
    const writeText = vi.fn(async () => undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    useLensStore.getState().record('git status');
    render(<BottomBar />);
    await userEvent.click(screen.getByTestId('command-lens'));
    await userEvent.click(screen.getByTestId('lens-copy'));
    expect(writeText).toHaveBeenCalledWith('git status');
  });

  it('reflects the expert mode from the ui store', async () => {
    render(<BottomBar />);
    expect(screen.getByTestId('mode-switch')).toHaveTextContent('简洁模式');
    await userEvent.click(screen.getByTestId('mode-switch'));
    expect(screen.getByTestId('mode-switch')).toHaveTextContent('专家模式');
  });
});

describe('BottomBar wait indicator', () => {
  it('shows the running operation name when there is no network progress', () => {
    useBusyStore.setState({ visible: true, label: 'busy.branch.switch' });
    render(<BottomBar />);
    expect(screen.getByTestId('busy-strip')).toHaveTextContent('正在切换分支…');
    expect(screen.queryByTestId('sync-task-strip')).not.toBeInTheDocument();
  });

  it('prefers the network progress strip while fetch/pull/push reports progress', () => {
    useSyncStore.setState({
      progress: { task: 'push', message: 'Writing objects: 42%', percent: 42 },
    });
    useBusyStore.setState({ visible: true, label: 'busy.push' });
    render(<BottomBar />);
    expect(screen.getByTestId('sync-task-strip')).toBeInTheDocument();
    expect(screen.queryByTestId('busy-strip')).not.toBeInTheDocument();
  });

  it('falls back to the idle hint when nothing is running', () => {
    render(<BottomBar />);
    expect(screen.getByText('暂无后台任务')).toBeInTheDocument();
    expect(screen.queryByTestId('busy-strip')).not.toBeInTheDocument();
  });
});
