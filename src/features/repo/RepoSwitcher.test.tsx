import { beforeAll } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RepoSwitcher, displayPath, openRepoFolder } from './RepoSwitcher';
import { useRepoStore } from '../../stores/repoStore';
import { useToastStore } from '../../stores/toastStore';

const openPathMock = vi.fn<(...args: unknown[]) => Promise<void>>();
const logErrorMock = vi.fn();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openPath: (...args: unknown[]) => openPathMock(...args),
  openUrl: vi.fn(),
}));

vi.mock('../../lib/logger', () => ({
  appLog: {
    info: vi.fn(),
    warn: vi.fn(),
    error: (...args: unknown[]) => logErrorMock(...args),
  },
  describeError: (error: unknown) =>
    error instanceof Error ? (error.stack ?? error.message) : String(error),
}));

// jsdom 不实现 pointer capture / scrollIntoView，radix DropdownMenu 需要它们。
beforeAll(() => {
  Element.prototype.hasPointerCapture = () => false;
  Element.prototype.setPointerCapture = () => {};
  Element.prototype.releasePointerCapture = () => {};
  Element.prototype.scrollIntoView = () => {};
});

function seedRepo(path: string): void {
  useRepoStore.getState().seed({
    repos: {
      r1: {
        repoId: 'r1',
        path,
        name: 'demo',
        branch: 'main',
        headOid: null,
        ahead: 0,
        behind: 0,
        isEmpty: false,
      },
    },
    activeId: 'r1',
  });
}

beforeEach(() => {
  openPathMock.mockReset();
  useToastStore.setState({ toasts: [] });
  useRepoStore.getState().seed({ repos: {}, activeId: null });
});

describe('displayPath', () => {
  it('strips the Windows verbatim prefix', () => {
    expect(displayPath('\\\\?\\C:\\demo')).toBe('C:\\demo');
  });

  it('converts verbatim UNC back to a share path', () => {
    expect(displayPath('\\\\?\\UNC\\server\\share\\repo')).toBe('\\\\server\\share\\repo');
  });

  it('leaves ordinary paths untouched', () => {
    expect(displayPath('C:\\demo')).toBe('C:\\demo');
    expect(displayPath('/tmp/demo')).toBe('/tmp/demo');
  });
});

describe('openRepoFolder', () => {
  it('opens the stripped path', () => {
    openPathMock.mockResolvedValue(undefined);
    openRepoFolder('\\\\?\\C:\\demo');
    expect(openPathMock).toHaveBeenCalledTimes(1);
    expect(openPathMock).toHaveBeenCalledWith('C:\\demo');
  });

  it('toasts the cause and logs it when the opener fails', async () => {
    // 权限/路径 scope 被拒时插件回的是字符串（forbidden path…）：这句必须
    // 既出现在 toast 的可展开原因里，也落到日志文件里。
    openPathMock.mockRejectedValue('forbidden path: C:\\demo');
    openRepoFolder('\\\\?\\C:\\demo');
    await waitFor(() => {
      const toasts = useToastStore.getState().toasts;
      const last = toasts[toasts.length - 1];
      expect(last?.kind).toBe('error');
      expect(last?.message).toBe('无法打开文件夹，请稍后重试');
      expect(last?.reason).toContain('forbidden path');
      expect(last?.action?.label).toBe('查看日志');
    });
    expect(logErrorMock).toHaveBeenCalledWith(
      'repo.open-folder',
      expect.stringContaining('forbidden path'),
    );
  });

  it('does not toast on success', async () => {
    openPathMock.mockResolvedValue(undefined);
    openRepoFolder('C:\\demo');
    expect(openPathMock).toHaveBeenCalledWith('C:\\demo');
    await new Promise((r) => setTimeout(r, 0));
    expect(useToastStore.getState().toasts).toHaveLength(0);
  });
});

// radix trigger 以 Enter 键开合菜单（jsdom 下 userEvent 会挂起，用 fireEvent）。
function openMenu() {
  fireEvent.keyDown(screen.getByTestId('repo-switcher'), { key: 'Enter' });
}

describe('RepoSwitcher 打开文件夹菜单项', () => {
  it('opens the active repo folder with the verbatim prefix stripped', () => {
    openPathMock.mockResolvedValue(undefined);
    // Rust canonicalize() 在 Windows 上返回 \\?\ 扩展路径。
    seedRepo('\\\\?\\C:\\demo');
    render(<RepoSwitcher />);
    openMenu();
    fireEvent.click(screen.getByTestId('open-folder-item'));

    expect(openPathMock).toHaveBeenCalledTimes(1);
    expect(openPathMock).toHaveBeenCalledWith('C:\\demo');
  });

  it('hides the entry when no repository is open', () => {
    render(<RepoSwitcher />);
    openMenu();
    expect(screen.getByRole('menu')).toBeInTheDocument();
    expect(screen.queryByTestId('open-folder-item')).toBeNull();
  });
});
