import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CloneDialog } from './CloneDialog';
import { useToastStore } from '../../stores/toastStore';
import { useUiStore } from '../../stores/uiStore';

const cloneRepoMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();

vi.mock('../../lib/ipc/commands', () => ({
  cloneRepo: (...args: unknown[]) => cloneRepoMock(...args),
  pickDirectory: vi.fn().mockResolvedValue(null),
  // 克隆成功后 openByPath 被 fire-and-forget：让它走 reject → humanize（mock
  // 的 formatIpcError）就地吞掉，避免未处理的 rejection 污染测试结果。
  openRepo: vi.fn().mockRejectedValue({ code: 'internal', context: 'skipped in test' }),
  formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
  isTauriAvailable: vi.fn(() => false),
  // reportError → logger 链路会调用 logWeb；mock 工厂是整模块替换，缺了会炸
  logWeb: vi.fn().mockResolvedValue(undefined),
}));

beforeEach(() => {
  cloneRepoMock.mockReset();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ cloneDialogOpen: true });
});

function renderOpenDialog() {
  render(<CloneDialog />);
  return waitFor(() => screen.getByTestId('clone-url-input'));
}

async function fillAndSubmit() {
  await userEvent.type(screen.getByTestId('clone-url-input'), 'http://example.com/demo.git');
  await userEvent.type(screen.getByTestId('clone-path-input'), 'C:/tmp/demo');
  await userEvent.click(screen.getByTestId('clone-confirm'));
}

describe('CloneDialog failure surfacing (rc.2 真人反馈)', () => {
  it('shows the failure reason inline in the dialog, not just 克隆失败', async () => {
    cloneRepoMock.mockRejectedValue({
      code: 'internal',
      context: 'network command failed: fatal: unable to access',
    });
    await renderOpenDialog();
    await fillAndSubmit();
    const inline = await screen.findByTestId('clone-error');
    expect(inline).toHaveTextContent('fatal: unable to access');
    expect(inline).not.toHaveTextContent('克隆失败');
  });

  it('surfaces the network detail and reason from the structured error', async () => {
    cloneRepoMock.mockRejectedValue({
      code: 'network',
      kind: 'connect',
      url: 'http://example.com/demo.git',
      detail: 'fatal: could not resolve host: example.com',
    });
    await renderOpenDialog();
    await fillAndSubmit();
    const inline = await screen.findByTestId('clone-error');
    expect(inline).toHaveTextContent('无法连接 http://example.com/demo.git');
    expect(inline).toHaveTextContent('could not resolve host');
  });

  it('keeps the error toast with the 查看日志 hint action', async () => {
    cloneRepoMock.mockRejectedValue({ code: 'internal', context: 'boom' });
    await renderOpenDialog();
    await fillAndSubmit();
    await screen.findByTestId('clone-error');
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      const last = toasts[toasts.length - 1];
      expect(last.kind).toBe('error');
      expect(last.action?.label).toBe('查看日志');
    });
  });

  it('clears the inline error when retrying', async () => {
    cloneRepoMock.mockRejectedValueOnce({ code: 'internal', context: 'boom' });
    await renderOpenDialog();
    await fillAndSubmit();
    await screen.findByTestId('clone-error');
    cloneRepoMock.mockResolvedValue({ name: 'demo', path: 'C:/tmp/demo' });
    await userEvent.click(screen.getByTestId('clone-confirm'));
    await waitFor(() => {
      expect(screen.queryByTestId('clone-error')).toBeNull();
    });
  });
});

describe('CloneDialog credentials (rc.2 HTTP GitLab 克隆失败)', () => {
  it('warns about plaintext HTTP when the url is http://', async () => {
    await renderOpenDialog();
    await userEvent.type(screen.getByTestId('clone-url-input'), 'http://47.108.131.92/a/b.git');
    expect(screen.getByTestId('clone-http-warning')).toBeInTheDocument();
  });

  it('passes no credentials by default', async () => {
    cloneRepoMock.mockResolvedValue({ name: 'demo', path: 'C:/tmp/demo' });
    await renderOpenDialog();
    await fillAndSubmit();
    await waitFor(() => {
      expect(cloneRepoMock).toHaveBeenCalledWith(
        'http://example.com/demo.git',
        'C:/tmp/demo',
        null,
      );
    });
  });

  it('passes typed session credentials through to the clone command', async () => {
    cloneRepoMock.mockResolvedValue({ name: 'demo', path: 'C:/tmp/demo' });
    await renderOpenDialog();
    await userEvent.click(screen.getByTestId('clone-creds-toggle'));
    await userEvent.type(screen.getByTestId('clone-username-input'), 'zhang');
    await userEvent.type(screen.getByTestId('clone-password-input'), 'pw');
    await fillAndSubmit();
    await waitFor(() => {
      expect(cloneRepoMock).toHaveBeenCalledWith('http://example.com/demo.git', 'C:/tmp/demo', {
        username: 'zhang',
        password: 'pw',
      });
    });
  });

  it('expands the credentials form and guides the user on an auth failure', async () => {
    cloneRepoMock.mockRejectedValue({
      code: 'auth',
      provider: 'git',
      detail: 'fatal: Unencrypted HTTP is not recommended for GitLab',
    });
    await renderOpenDialog();
    await fillAndSubmit();
    await screen.findByTestId('clone-error');
    // The credentials form auto-expands with an actionable hint.
    expect(screen.getByTestId('clone-username-input')).toBeInTheDocument();
    expect(screen.getByTestId('clone-auth-hint')).toHaveTextContent('填写用户名与密码');
  });
});
