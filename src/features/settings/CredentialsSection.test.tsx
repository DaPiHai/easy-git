import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CredentialsSection } from './CredentialsSection';
import { useUiStore } from '../../stores/uiStore';
import type { SshCredentialsOverview } from '../../lib/ipc/commands';

const getSshCredentialsOverviewMock = vi.fn<() => Promise<SshCredentialsOverview>>();

vi.mock('../../lib/ipc/commands', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    getSshCredentialsOverview: () => getSshCredentialsOverviewMock(),
  };
});

// jsdom does not implement scrollIntoView; the section calls it on highlight
// so the user has an obvious landing spot. Provide a no-op so the effect
// does not throw.
if (!HTMLElement.prototype.scrollIntoView) {
  HTMLElement.prototype.scrollIntoView = function scrollIntoView() {
    /* no-op for tests */
  };
}

const overviewRunning: SshCredentialsOverview = {
  agent: {
    running: true,
    authSock: 'C:\\Users\\hhdlj\\.ssh\\agent.sock',
    keys: [
      {
        fingerprint: 'SHA256:aaa111',
        comment: 'hhdlj@desktop',
        keyType: 'ED25519',
      },
    ],
  },
  publicKeys: [
    {
      path: 'C:\\Users\\hhdlj\\.ssh\\id_ed25519.pub',
      fingerprint: 'SHA256:aaa111',
      comment: 'hhdlj@desktop',
      keyType: 'ED25519',
    },
    {
      path: 'C:\\Users\\hhdlj\\.ssh\\id_rsa.pub',
      fingerprint: 'SHA256:bbb222',
      comment: 'work-laptop',
      keyType: 'RSA 4096',
    },
  ],
  homeDir: 'C:\\Users\\hhdlj',
  sshDirPresent: true,
};

const overviewStopped: SshCredentialsOverview = {
  agent: { running: false, authSock: null, keys: [] },
  publicKeys: [],
  homeDir: 'C:\\Users\\hhdlj',
  sshDirPresent: true,
};

const overviewNoSshDir: SshCredentialsOverview = {
  agent: { running: false, authSock: null, keys: [] },
  publicKeys: [],
  homeDir: 'C:\\Users\\hhdlj',
  sshDirPresent: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  useUiStore.setState({ credentialsHighlighted: false });
  getSshCredentialsOverviewMock.mockResolvedValue(overviewRunning);
});

describe('CredentialsSection (settings 身份凭证)', () => {
  it('shows the running agent badge and the loaded key fingerprint', async () => {
    render(<CredentialsSection />);
    expect(await screen.findByTestId('settings-credentials')).toBeInTheDocument();
    // The Chinese string resolves via i18n at runtime; assert on the data
    // attribute instead so this test stays stable across translation edits.
    expect(
      screen.getByTestId('settings-credentials-sock'),
    ).toHaveTextContent(/agent\.sock/);
    const agentKeys = await screen.findByTestId('settings-credentials-agent-keys');
    expect(agentKeys).toHaveTextContent('SHA256:aaa111');
    expect(agentKeys).toHaveTextContent('hhdlj@desktop');
  });

  it('lists all ~/.ssh/*.pub under the 本机公钥 table', async () => {
    render(<CredentialsSection />);
    const pubTable = await screen.findByTestId('settings-credentials-public-keys');
    expect(pubTable).toHaveTextContent('id_ed25519.pub');
    expect(pubTable).toHaveTextContent('id_rsa.pub');
    expect(pubTable).toHaveTextContent('RSA 4096');
  });

  it('shows the agent-down guidance when ssh-agent is not running', async () => {
    getSshCredentialsOverviewMock.mockResolvedValue(overviewStopped);
    render(<CredentialsSection />);
    // No agent-keys table is rendered; instead an empty-state line appears.
    await waitFor(() => {
      expect(
        screen.queryByTestId('settings-credentials-agent-keys'),
      ).not.toBeInTheDocument();
    });
    const stopped = await screen.findByTestId('settings-credentials-agent-stopped');
    expect(stopped).toHaveTextContent(/ssh-add|terminal/);
  });

  it('falls back to the dir-missing message when ~/.ssh does not exist', async () => {
    getSshCredentialsOverviewMock.mockResolvedValue(overviewNoSshDir);
    render(<CredentialsSection />);
    expect(
      await screen.findByTestId('settings-credentials-public-keys-empty'),
    ).toHaveTextContent(/~\/\.ssh/);
  });

  it('outlines the section when the open-credentials hint highlights it', async () => {
    render(<CredentialsSection />);
    // Wait for the initial fetch to settle, otherwise the empty class
    // check is meaningless.
    await screen.findByTestId('settings-credentials');
    const beforeClass = document.querySelector('[data-testid="settings-credentials"]')!
      .className;
    expect(beforeClass).not.toContain('ring-2');

    useUiStore.getState().setCredentialsHighlighted(true);
    await waitFor(() => {
      const afterClass = document.querySelector('[data-testid="settings-credentials"]')!
        .className;
      expect(afterClass).toContain('ring-2');
    });
  });

  it('re-fetches the overview when the refresh button is clicked', async () => {
    const user = userEvent.setup();
    render(<CredentialsSection />);
    await screen.findByTestId('settings-credentials-refresh');
    expect(getSshCredentialsOverviewMock).toHaveBeenCalledTimes(1);

    await user.click(screen.getByTestId('settings-credentials-refresh'));
    await waitFor(() =>
      expect(getSshCredentialsOverviewMock).toHaveBeenCalledTimes(2),
    );
  });
});