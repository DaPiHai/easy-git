import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InitGitignoreDialog } from './InitGitignoreDialog';
import { useGitignorePrompt } from '../../stores/gitignoreStore';
import { useToastStore } from '../../stores/toastStore';

const writeMock = vi.fn<(...args: unknown[]) => Promise<boolean>>();

vi.mock('../../lib/ipc/commands', () => ({
  writeGitignoreTemplate: (...args: unknown[]) => writeMock(...args),
  // reportError → logger 链路会调用 logWeb；mock 工厂是整模块替换，缺了会炸
  logWeb: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  writeMock.mockReset();
  useToastStore.setState({ toasts: [] });
  useGitignorePrompt.setState({ target: null });
});

describe('InitGitignoreDialog (通用 .gitignore 提醒)', () => {
  it('renders nothing until a repository is offered, then shows its name', () => {
    const { container } = render(<InitGitignoreDialog />);
    expect(screen.queryByTestId('gitignore-desc')).toBeNull();
    expect(container).toBeEmptyDOMElement();

    act(() => useGitignorePrompt.getState().offer('r1', 'demo'));
    expect(screen.getByTestId('gitignore-desc')).toHaveTextContent('demo');
    expect(screen.getByTestId('gitignore-desc')).toHaveTextContent('.gitignore');
  });

  it('writes the template on confirm, toasts, and closes', async () => {
    writeMock.mockResolvedValue(true);
    act(() => useGitignorePrompt.getState().offer('r1', 'demo'));
    render(<InitGitignoreDialog />);
    await userEvent.click(screen.getByTestId('gitignore-confirm'));

    await waitFor(() => {
      expect(writeMock).toHaveBeenCalledWith('r1');
    });
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts.some((t) => t.kind === 'success' && t.message === '已创建 .gitignore')).toBe(
        true,
      );
    });
    await waitFor(() => {
      expect(useGitignorePrompt.getState().target).toBeNull();
    });
  });

  it('skips silently without toasting when the file appeared meanwhile', async () => {
    writeMock.mockResolvedValue(false);
    act(() => useGitignorePrompt.getState().offer('r1', 'demo'));
    render(<InitGitignoreDialog />);
    await userEvent.click(screen.getByTestId('gitignore-confirm'));

    expect(writeMock).toHaveBeenCalledWith('r1');
    await waitFor(() => {
      expect(useGitignorePrompt.getState().target).toBeNull();
    });
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });

  it('closes and reports through reportError on failure', async () => {
    writeMock.mockRejectedValue({ code: 'internal', context: 'boom' });
    act(() => useGitignorePrompt.getState().offer('r1', 'demo'));
    render(<InitGitignoreDialog />);
    await userEvent.click(screen.getByTestId('gitignore-confirm'));

    await waitFor(() => {
      expect(useGitignorePrompt.getState().target).toBeNull();
    });
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      expect(toasts[toasts.length - 1]?.kind).toBe('error');
    });
  });

  it('暂不 closes without calling the write command', async () => {
    act(() => useGitignorePrompt.getState().offer('r1', 'demo'));
    render(<InitGitignoreDialog />);
    await userEvent.click(screen.getByTestId('gitignore-skip'));

    expect(writeMock).not.toHaveBeenCalled();
    expect(useGitignorePrompt.getState().target).toBeNull();
  });
});
