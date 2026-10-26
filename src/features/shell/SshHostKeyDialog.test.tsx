import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SshHostKeyDialog } from './SshHostKeyDialog';
import { resetSshStoreForTests, useSshStore } from '../../stores/sshStore';

const trustMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    trustSshHostKey: (...args: unknown[]) => trustMock(...args),
    probeSshHostKey: vi.fn(),
    getSshCredentialsOverview: vi.fn(),
    generateSshKey: vi.fn(),
    readSshPublicKey: vi.fn(),
    testGithubSsh: vi.fn(),
    formatIpcError: vi.fn(() => ({ title: 'err', detail: '' })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSshStoreForTests();
  trustMock.mockResolvedValue({
    host: 'github.com',
    port: 22,
    keyType: 'ED25519',
    fingerprint: 'SHA256:abc',
  });
});

function openPrompt(changed = false) {
  const resolve = vi.fn();
  useSshStore.setState({
    hostKeyPrompt: {
      id: 1,
      host: 'github.com',
      port: 22,
      changed,
      fingerprint: 'SHA256:abc',
      keyType: 'ED25519',
      loading: false,
      error: null,
      resolve,
    },
  });
  return resolve;
}

describe('SshHostKeyDialog', () => {
  it('shows the fingerprint and trusts the host', async () => {
    const user = userEvent.setup();
    const resolve = openPrompt();
    render(<SshHostKeyDialog />);

    expect(screen.getByTestId('hostkey-fingerprint')).toHaveTextContent('SHA256:abc');
    expect(screen.getByText(/ED25519/)).toBeInTheDocument();
    await user.click(screen.getByTestId('hostkey-trust'));

    expect(trustMock).toHaveBeenCalledWith('github.com', 22, 'SHA256:abc');
    expect(resolve).toHaveBeenCalledWith(true);
  });

  it('requires the risk acknowledgement for a changed key', async () => {
    const user = userEvent.setup();
    openPrompt(true);
    render(<SshHostKeyDialog />);

    const trust = screen.getByTestId('hostkey-trust');
    expect(trust).toBeDisabled();
    await user.click(screen.getByTestId('hostkey-ack'));
    expect(trust).toBeEnabled();
  });

  it('cancels without writing known_hosts', async () => {
    const user = userEvent.setup();
    const resolve = openPrompt();
    render(<SshHostKeyDialog />);
    await user.click(screen.getByText('取消'));
    expect(resolve).toHaveBeenCalledWith(false);
    expect(trustMock).not.toHaveBeenCalled();
  });
});
