import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resetSshStoreForTests, useSshStore, withHostKeyTrust } from './sshStore';

const probeMock = vi.fn<(...args: unknown[]) => unknown>();
const trustMock = vi.fn<(...args: unknown[]) => unknown>();

vi.mock('../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    probeSshHostKey: (...args: unknown[]) => probeMock(...args),
    trustSshHostKey: (...args: unknown[]) => trustMock(...args),
    getSshCredentialsOverview: vi.fn(async () => null),
    generateSshKey: vi.fn(async () => ({})),
    readSshPublicKey: vi.fn(async () => 'ssh-ed25519 AAAA EasyGit'),
    testGithubSsh: vi.fn(async () => 'octocat'),
    formatIpcError: vi.fn((error: { detail?: string; reason?: string }) => ({
      title: 'err',
      detail: error?.detail ?? '',
      reason: error?.reason,
    })),
  };
});

beforeEach(() => {
  vi.clearAllMocks();
  resetSshStoreForTests();
  probeMock.mockResolvedValue({
    host: 'github.com',
    port: 22,
    keyType: 'ED25519',
    fingerprint: 'SHA256:abc',
  });
  trustMock.mockResolvedValue({
    host: 'github.com',
    port: 22,
    keyType: 'ED25519',
    fingerprint: 'SHA256:abc',
  });
});

describe('withHostKeyTrust', () => {
  it('shows the fingerprint, writes known_hosts and retries once', async () => {
    const action = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce({
        code: 'ssh_host_key',
        host: 'github.com',
        port: 22,
        changed: false,
      })
      .mockResolvedValueOnce('ok');

    const pending = withHostKeyTrust(action);
    await vi.waitFor(() => {
      expect(useSshStore.getState().hostKeyPrompt?.fingerprint).toBe('SHA256:abc');
    });
    await useSshStore.getState().confirmHostKey();

    expect(await pending).toBe('ok');
    expect(trustMock).toHaveBeenCalledWith('github.com', 22, 'SHA256:abc');
    expect(action).toHaveBeenCalledTimes(2);
  });

  it('rethrows the original error when the user cancels', async () => {
    const error = { code: 'ssh_host_key', host: 'github.com', port: 22, changed: false };
    const action = vi.fn<() => Promise<string>>().mockRejectedValue(error);

    const pending = withHostKeyTrust(action);
    await vi.waitFor(() => {
      expect(useSshStore.getState().hostKeyPrompt).not.toBeNull();
    });
    useSshStore.getState().cancelHostKey();

    await expect(pending).rejects.toBe(error);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it('does not prompt for unrelated failures', async () => {
    const error = { code: 'network', kind: 'connect' };
    await expect(withHostKeyTrust(() => Promise.reject(error))).rejects.toBe(error);
    expect(useSshStore.getState().hostKeyPrompt).toBeNull();
  });
});
