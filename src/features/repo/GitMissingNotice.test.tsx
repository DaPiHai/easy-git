import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GitMissingNotice } from './GitMissingNotice';
import { useUiStore } from '../../stores/uiStore';

const openUrlMock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock('@tauri-apps/plugin-opener', () => ({
  openUrl: (...args: unknown[]) => openUrlMock(...args),
}));

beforeEach(() => {
  openUrlMock.mockReset().mockResolvedValue(undefined);
  useUiStore.setState({ envStatus: null });
});

describe('GitMissingNotice (PRD §7)', () => {
  it('renders the missing-git variant without a version', () => {
    useUiStore.setState({ envStatus: { gitVersion: null } });
    render(<GitMissingNotice />);
    expect(screen.getByTestId('git-missing-notice')).toHaveTextContent('未检测到 Git');
    expect(screen.getByTestId('git-missing-notice')).toHaveTextContent('2.30');
  });

  it('renders the too-old variant with the detected version', () => {
    useUiStore.setState({ envStatus: { gitVersion: 'git version 2.29.3' } });
    render(<GitMissingNotice />);
    expect(screen.getByTestId('git-missing-notice')).toHaveTextContent('Git 版本过旧');
    expect(screen.getByTestId('git-missing-notice')).toHaveTextContent('git version 2.29.3');
  });

  it('opens the official download page from the primary button', async () => {
    useUiStore.setState({ envStatus: { gitVersion: null } });
    render(<GitMissingNotice />);
    await userEvent.click(screen.getByTestId('git-download'));
    expect(openUrlMock).toHaveBeenCalledWith('https://git-scm.com/downloads');
  });

  it('re-runs the probe from the recheck button', async () => {
    useUiStore.setState({ envStatus: { gitVersion: null } });
    const fetchEnvStatus = vi.spyOn(useUiStore.getState(), 'fetchEnvStatus');
    render(<GitMissingNotice />);
    await userEvent.click(screen.getByTestId('git-recheck'));
    await waitFor(() => expect(fetchEnvStatus).toHaveBeenCalledOnce());
  });
});
