import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BottomBar } from './BottomBar';
import { useLensStore } from '../../stores/lensStore';
import { useUiStore } from '../../stores/uiStore';

beforeEach(() => {
  useLensStore.setState({ entries: [] });
  useUiStore.setState({ expertMode: false });
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
