import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SshDialog } from './SshDialog';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';
import { useToastStore } from '../../stores/toastStore';

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/ipc/commands')>();
  return {
    ...actual,
    testSshConnection: vi.fn(),
    browseSshDir: vi.fn(),
    initSshRepo: vi.fn(),
  };
});

const commands = await import('../../lib/ipc/commands');
const testSshConnection = vi.mocked(commands.testSshConnection);
const browseSshDir = vi.mocked(commands.browseSshDir);
const initSshRepo = vi.mocked(commands.initSshRepo);

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ sshDialogOpen: true });
  useRepoStore.getState().seed({ repos: {}, activeId: null, error: null });
  useToastStore.setState({ toasts: [] });
});

describe('SshDialog', () => {
  it('tests the connection and shows the canonical URI on success', async () => {
    const user = userEvent.setup();
    testSshConnection.mockResolvedValue('ssh://root@host/srv/repo');
    render(<SshDialog />);

    await user.type(screen.getByTestId('ssh-location-input'), 'root@host:/srv/repo');
    await user.click(screen.getByTestId('ssh-test'));

    expect(testSshConnection).toHaveBeenCalledWith('root@host:/srv/repo');
    expect(await screen.findByTestId('ssh-test-ok')).toHaveTextContent('ssh://root@host/srv/repo');
  });

  it('surfaces connection failures inline', async () => {
    const user = userEvent.setup();
    testSshConnection.mockRejectedValue({ code: 'auth', provider: 'ssh-key' });
    render(<SshDialog />);

    await user.type(screen.getByTestId('ssh-location-input'), 'root@host:/srv/repo');
    await user.click(screen.getByTestId('ssh-test'));

    expect(await screen.findByTestId('ssh-error')).toHaveTextContent('ssh-agent');
  });

  it('keeps confirm disabled until the address is SSH-shaped', async () => {
    const user = userEvent.setup();
    render(<SshDialog />);

    expect(screen.getByTestId('ssh-confirm')).toBeDisabled();
    await user.type(screen.getByTestId('ssh-location-input'), 'C:\\local\\repo');
    expect(screen.getByTestId('ssh-confirm')).toBeDisabled();
    await user.clear(screen.getByTestId('ssh-location-input'));
    await user.type(screen.getByTestId('ssh-location-input'), 'root@host:/srv/repo');
    expect(screen.getByTestId('ssh-confirm')).toBeEnabled();
  });

  it('browses remote directories and fills the path from entries', async () => {
    const user = userEvent.setup();
    browseSshDir.mockResolvedValue(['repo.git/', 'other/']);
    render(<SshDialog />);

    await user.type(screen.getByTestId('ssh-location-input'), 'root@host:/srv');
    await user.type(screen.getByTestId('ssh-browse-input'), '/srv');
    await user.click(screen.getByText('…'));

    expect(await screen.findByTestId('ssh-browse-list')).toBeInTheDocument();
    await user.click(screen.getByText('repo.git/'));
    expect(screen.getByTestId('ssh-location-input')).toHaveValue('root@host:/srv/repo.git');
  });

  it('opens the remote repo through the store and closes on success', async () => {
    const user = userEvent.setup();
    const summary = {
      repoId: 'r1',
      path: 'ssh://root@host/srv/repo',
      name: 'repo',
      branch: 'main',
      headOid: 'abc',
      ahead: 0,
      behind: 0,
      isEmpty: false,
    };
    const openSpy = vi
      .spyOn(useRepoStore.getState(), 'openByPathReturning')
      .mockResolvedValue(summary);
    render(<SshDialog />);

    await user.type(screen.getByTestId('ssh-location-input'), 'root@host:/srv/repo');
    await user.click(screen.getByTestId('ssh-confirm'));

    expect(openSpy).toHaveBeenCalledWith('root@host:/srv/repo');
    expect(useUiStore.getState().sshDialogOpen).toBe(false);
  });

  it('offers an "initialize here" button when the open fails with ssh_not_a_repo / exists=true', async () => {
    const user = userEvent.setup();
    const sshTarget = {
      host: '192.168.5.3',
      port: 22,
      user: 'hhdlj',
      path: '/home/hhdlj/easy-desktop',
    };
    const openSpy = vi
      .spyOn(useRepoStore.getState(), 'openByPathReturning')
      .mockRejectedValueOnce({
        code: 'ssh_not_a_repo',
        target: sshTarget,
        exists: true,
        detail: 'fatal: not a git repository (or any of the parent directories): .git',
      })
      .mockResolvedValueOnce({
        repoId: 'r1',
        path: 'ssh://hhdlj@192.168.5.3/home/hhdlj/easy-desktop',
        name: 'easy-desktop',
        branch: 'main',
        headOid: null,
        ahead: 0,
        behind: 0,
        isEmpty: true,
      });
    initSshRepo.mockResolvedValue(undefined);
    render(<SshDialog />);

    await user.type(
      screen.getByTestId('ssh-location-input'),
      'hhdlj@192.168.5.3:/home/hhdlj/easy-desktop',
    );
    await user.click(screen.getByTestId('ssh-confirm'));

    // First call fails, dialog stays open with the recovery button.
    expect(openSpy).toHaveBeenCalledTimes(1);
    const initBtn = await screen.findByTestId('ssh-init-here');
    expect(initBtn).toBeInTheDocument();

    await user.click(initBtn);

    expect(initSshRepo).toHaveBeenCalledWith('hhdlj@192.168.5.3:/home/hhdlj/easy-desktop');
    // Second openByPathReturning call follows the init success.
    expect(openSpy).toHaveBeenCalledTimes(2);
    expect(useUiStore.getState().sshDialogOpen).toBe(false);
  });

  it('does not offer init when the open failure is something else', async () => {
    const user = userEvent.setup();
    vi.spyOn(useRepoStore.getState(), 'openByPathReturning').mockRejectedValueOnce({
      code: 'auth',
      provider: 'ssh-key',
    });
    render(<SshDialog />);

    await user.type(screen.getByTestId('ssh-location-input'), 'root@host:/srv/repo');
    await user.click(screen.getByTestId('ssh-confirm'));

    expect(await screen.findByTestId('ssh-error')).toBeInTheDocument();
    expect(screen.queryByTestId('ssh-init-here')).not.toBeInTheDocument();
  });
});
