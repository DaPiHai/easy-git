import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LogsPanel, filterLog } from './LogsPanel';
import { useToastStore } from '../../stores/toastStore';

const logsDirMock = vi.fn<(...args: unknown[]) => Promise<string | null>>();
const logsListMock = vi.fn<(...args: unknown[]) => Promise<unknown[]>>();
const logsReadMock = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const openPathMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const logWebMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('../../lib/ipc/commands', () => ({
  logsDir: (...args: unknown[]) => logsDirMock(...args),
  logsList: (...args: unknown[]) => logsListMock(...args),
  logsRead: (...args: unknown[]) => logsReadMock(...args),
  formatIpcError: (error: unknown) => ({
    title: '错误',
    detail: String(error),
  }),
  // reportFailure → logger → logWeb；mock 工厂是整模块替换，缺了会炸。
  logWeb: (...args: unknown[]) => logWebMock(...args),
}));

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (...args: unknown[]) => openPathMock(...args),
  openUrl: vi.fn(),
}));

const SAMPLE = [
  '2026-09-12T01:00:00Z  INFO easy_git: app starting',
  '2026-09-12T01:01:00Z ERROR easy_git: repo command failed',
  '  at some frame',
  '2026-09-12T01:02:00Z  WARN easy_git: idle maintenance skipped',
].join('\n');

beforeEach(() => {
  vi.clearAllMocks();
  logsDirMock.mockResolvedValue('C:/logs');
  logsListMock.mockResolvedValue([
    { fileName: 'easygit.log.2026-09-12', sizeBytes: 1024, modifiedAt: 1 },
    { fileName: 'easygit.log.2026-09-11', sizeBytes: 512, modifiedAt: 0 },
  ]);
  logsReadMock.mockResolvedValue({
    fileName: 'easygit.log.2026-09-12',
    content: SAMPLE,
    truncated: false,
  });
  openPathMock.mockResolvedValue(undefined);
  useToastStore.setState({ toasts: [] });
});

describe('filterLog', () => {
  it('keeps matching entries and their continuation lines', () => {
    const filtered = filterLog(SAMPLE, 'error');
    expect(filtered).toContain('ERROR');
    expect(filtered).toContain('at some frame');
    expect(filtered).not.toContain('INFO');
    expect(filtered).not.toContain('WARN');
  });

  it('returns everything for the all filter', () => {
    expect(filterLog(SAMPLE, 'all')).toBe(SAMPLE);
  });
});

describe('LogsPanel', () => {
  it('selects the newest file and shows its content', async () => {
    render(<LogsPanel />);
    await waitFor(() => {
      expect(screen.getByTestId('logs-content')).toHaveTextContent('app starting');
    });
    expect(logsReadMock).toHaveBeenCalledWith('easygit.log.2026-09-12');
    expect(screen.getByTestId('logs-file')).toHaveTextContent('2026-09-12');
  });

  it('switches to another log file through the styled menu', async () => {
    render(<LogsPanel />);
    await screen.findByTestId('logs-content');
    fireEvent.click(screen.getByTestId('logs-file'));
    fireEvent.click(screen.getByTestId('logs-file-option-easygit.log.2026-09-11'));
    await waitFor(() => expect(logsReadMock).toHaveBeenCalledWith('easygit.log.2026-09-11'));
  });

  it('hides other levels after picking the error filter', async () => {
    render(<LogsPanel />);
    await screen.findByTestId('logs-content');
    await userEvent.click(screen.getByTestId('logs-level-error'));
    const content = screen.getByTestId('logs-content');
    expect(content).toHaveTextContent('repo command failed');
    expect(content).not.toHaveTextContent('app starting');
  });

  it('copies the visible content and reports success', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(<LogsPanel />);
    await screen.findByTestId('logs-content');
    await userEvent.click(screen.getByText('复制'));
    expect(writeText).toHaveBeenCalledWith(SAMPLE);
    await waitFor(() => {
      expect(useToastStore.getState().toasts[0]?.message).toBe('日志已复制');
    });
  });

  it('opens the log folder through the opener plugin', async () => {
    render(<LogsPanel />);
    await screen.findByTestId('logs-content');
    await userEvent.click(screen.getByText('打开文件夹'));
    expect(openPathMock).toHaveBeenCalledWith('C:/logs');
  });

  it('keeps the cause and logs it when the opener refuses the folder', async () => {
    // ACL/scope 被拒时插件回的是字符串（forbidden path…），用户排查全靠这行日志。
    openPathMock.mockRejectedValue('forbidden path: C:/logs');
    render(<LogsPanel />);
    await screen.findByTestId('logs-content');
    await userEvent.click(screen.getByText('打开文件夹'));
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      const last = toasts[toasts.length - 1];
      expect(last?.message).toBe('无法打开日志文件夹');
      expect(last?.reason).toContain('forbidden path');
    });
    expect(logWebMock).toHaveBeenCalledWith(
      'error',
      'settings.open-log-folder',
      expect.stringContaining('forbidden path'),
    );
  });
});
