import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SettingsPage } from './SettingsPage';
import { ToastHost } from '../../components';
import { useUiStore } from '../../stores/uiStore';
import { useToastStore } from '../../stores/toastStore';

const getGlobalConfigMock = vi.fn<(key: string) => Promise<string | null>>();
const setGlobalConfigMock = vi.fn<(key: string, value: string) => Promise<void>>();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getGlobalConfig: (key: string) => getGlobalConfigMock(key),
    setGlobalConfig: (key: string, value: string) => setGlobalConfigMock(key, value),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useToastStore.setState({ toasts: [] });
  useUiStore.setState({ view: 'settings', expertMode: false });
  // Regression rc.2: identity must be editable with NO repository open.
  getGlobalConfigMock.mockImplementation((key) =>
    Promise.resolve(key === 'user.name' ? 'Old Name' : 'old@example.com'),
  );
});

describe('SettingsPage (F-14)', () => {
  it('loads the stored global identity with no repository open', async () => {
    render(<SettingsPage />);
    expect(await screen.findByTestId('settings-name')).toHaveValue('Old Name');
    expect(screen.getByTestId('settings-email')).toHaveValue('old@example.com');
    expect(getGlobalConfigMock).toHaveBeenCalledWith('user.name');
    expect(getGlobalConfigMock).toHaveBeenCalledWith('user.email');
  });

  it('saves both keys with no repository open and toasts success', async () => {
    setGlobalConfigMock.mockResolvedValue();
    render(
      <>
        <SettingsPage />
        <ToastHost />
      </>,
    );
    const name = await screen.findByTestId('settings-name');
    await vi.waitFor(() => expect(name).toHaveValue('Old Name'));
    await userEvent.clear(name);
    await userEvent.type(name, '张三');
    await userEvent.clear(screen.getByTestId('settings-email'));
    await userEvent.type(screen.getByTestId('settings-email'), 'z@ex.com');
    await userEvent.click(screen.getByTestId('settings-save'));

    await vi.waitFor(() => {
      expect(setGlobalConfigMock).toHaveBeenCalledWith('user.name', '张三');
    });
    expect(setGlobalConfigMock).toHaveBeenCalledWith('user.email', 'z@ex.com');
    expect(await screen.findByText('Git 身份已保存')).toBeInTheDocument();
  });

  it('rejects an empty identity with an error toast', async () => {
    setGlobalConfigMock.mockResolvedValue();
    render(
      <>
        <SettingsPage />
        <ToastHost />
      </>,
    );
    const name = await screen.findByTestId('settings-name');
    await vi.waitFor(() => expect(name).toHaveValue('Old Name'));
    await userEvent.clear(name);
    await userEvent.clear(screen.getByTestId('settings-email'));
    await userEvent.click(screen.getByTestId('settings-save'));
    expect(await screen.findByText('用户名和邮箱都不能为空')).toBeInTheDocument();
    expect(setGlobalConfigMock).not.toHaveBeenCalled();
  });

  it('toggles the expert mode switch', async () => {
    render(<SettingsPage />);
    expect(screen.getByTestId('mode-switch')).toHaveAttribute('aria-checked', 'false');
    await userEvent.click(screen.getByTestId('mode-switch'));
    expect(screen.getByTestId('mode-switch')).toHaveAttribute('aria-checked', 'true');
    expect(localStorage.getItem('eg.mode.expert')).toBe('true');
  });
});
