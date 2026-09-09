import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OpenRepoWizard } from './OpenRepoWizard';
import { useRepoStore } from '../../stores/repoStore';

beforeEach(() => {
  useRepoStore.getState().seed({
    recents: [],
    error: null,
  });
});

describe('OpenRepoWizard', () => {
  it('renders the three entries; clone opens the live 克隆 dialog (W9)', async () => {
    const user = userEvent.setup();
    render(<OpenRepoWizard />);
    expect(screen.getByText('打开本地仓库')).toBeInTheDocument();
    expect(screen.getByText('新建仓库')).toBeInTheDocument();
    const clone = screen.getByTestId('wizard-clone');
    expect(clone).toBeEnabled();
    await user.click(clone);
    expect(screen.getByTestId('clone-url-input')).toBeInTheDocument();
    expect(screen.getByTestId('clone-path-input')).toBeInTheDocument();
  });

  it('lists recent repositories for one-click opening', async () => {
    useRepoStore.getState().seed({
      recents: [{ path: '/tmp/demo', name: 'demo' }],
    });
    const openSpy = vi.spyOn(useRepoStore.getState(), 'openByPath').mockResolvedValue();
    render(<OpenRepoWizard />);

    await userEvent.click(screen.getByText('demo'));
    expect(openSpy).toHaveBeenCalledWith('/tmp/demo');
  });

  it('shows a humanized error with dismiss', async () => {
    useRepoStore.getState().seed({
      error: { title: '找不到仓库', detail: '路径无效', hint: undefined },
    });
    render(<OpenRepoWizard />);
    expect(screen.getByRole('alert')).toHaveTextContent('找不到仓库');

    await userEvent.click(screen.getByRole('button', { name: '知道了' }));
    expect(useRepoStore.getState().error).toBeNull();
  });
});
