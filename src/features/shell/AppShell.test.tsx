import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppShell } from './AppShell';
import { useUiStore } from '../../stores/uiStore';

vi.mock('../../lib/ipc/commands', () => ({
  getAppVersion: vi.fn(async () => ({ appVersion: '0.1.0', tauriVersion: '2.0.0', os: 'test' })),
  isTauriAvailable: () => true,
  formatIpcError: vi.fn(),
}));

beforeEach(() => {
  localStorage.clear();
  useUiStore.setState({
    themeMode: 'dark',
    systemPrefersDark: true,
    resolvedTheme: 'dark',
    view: 'changes',
    sidebarCollapsed: false,
    detailOpen: true,
    detailWidth: 360,
    appVersion: null,
  });
});

describe('AppShell', () => {
  it('renders the four main view tabs with 变更 selected by default', () => {
    render(<AppShell />);
    const nav = screen.getByRole('navigation', { name: '主导航' });
    expect(within(nav).getByRole('button', { name: '变更' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    for (const tab of ['历史', '分支', '储藏']) {
      expect(within(nav).getByRole('button', { name: tab })).toBeInTheDocument();
    }
  });

  it('switches views from the tab bar', async () => {
    render(<AppShell />);
    await userEvent.click(screen.getByRole('button', { name: '历史' }));
    expect(screen.getByText('历史图将在这里显示')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '历史' }).getAttribute('aria-current')).toBe('page');
  });

  it('shows the IPC version chip once the shell answers', async () => {
    render(<AppShell />);
    const chip = await screen.findByTestId('ipc-status');
    expect(chip).toHaveAttribute('data-state', 'connected');
    expect(chip).toHaveTextContent('EasyGit v0.1.0');
  });

  it('collapses the repo sidebar to the icon rail', async () => {
    render(<AppShell />);
    await userEvent.click(screen.getByTestId('sidebar-collapse'));
    expect(screen.getByTestId('sidebar-expand')).toBeInTheDocument();
    expect(screen.queryByTestId('sidebar-collapse')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('sidebar-expand'));
    expect(screen.getByTestId('sidebar-collapse')).toBeInTheDocument();
  });

  it('collapses and restores the detail panel from the top bar', async () => {
    render(<AppShell />);
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
    await userEvent.click(screen.getByTestId('detail-toggle'));
    expect(screen.queryByTestId('detail-panel')).not.toBeInTheDocument();
    await userEvent.click(screen.getByTestId('detail-toggle'));
    expect(screen.getByTestId('detail-panel')).toBeInTheDocument();
  });
});
