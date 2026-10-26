import { openUrl } from '@tauri-apps/plugin-opener';
import {
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  Terminal,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { appLog } from '../../lib/logger';
import { useSshStore } from '../../stores/sshStore';

const GITHUB_KEYS_URL = 'https://github.com/settings/ssh/new';

/**
 * Click-only SSH setup: diagnose the local OpenSSH/client state, generate or
 * copy a key, open GitHub's "add SSH key" page, then verify with
 * `ssh -T git@github.com`. No private key ever leaves `~/.ssh`; only the
 * matching `.pub` file is copied.
 */
export function SshSetupDialog() {
  const open = useSshStore((s) => s.setupOpen);
  const setOpen = useSshStore((s) => s.setSetupOpen);
  const overview = useSshStore((s) => s.overview);
  const loading = useSshStore((s) => s.overviewLoading);
  const refresh = useSshStore((s) => s.refreshOverview);
  const generate = useSshStore((s) => s.generateKey);
  const copyKey = useSshStore((s) => s.copyPublicKey);
  const testGithub = useSshStore((s) => s.testGithub);
  const githubUser = useSshStore((s) => s.githubUser);
  const githubError = useSshStore((s) => s.githubError);
  const [busy, setBusy] = useState<string | null>(null);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  const keys = overview?.publicKeys ?? [];
  const primaryKey = keys[0] ?? null;

  const run = async (name: string, action: () => Promise<unknown>) => {
    setBusy(name);
    try {
      await action();
    } finally {
      setBusy(null);
    }
  };

  const openGithub = async () => {
    await run('github', async () => {
      if (primaryKey) await copyKey(primaryKey.path);
      await openUrl(GITHUB_KEYS_URL).catch((error: unknown) => {
        appLog.warn('ssh.setup', `open github failed: ${String(error)}`);
      });
    });
  };

  return (
    <Dialog
      open={open}
      title={t('ssh.setup.title')}
      onClose={() => setOpen(false)}
      actions={
        <Button variant="secondary" onClick={() => setOpen(false)}>
          {t('dialog.close')}
        </Button>
      }
    >
      <p className="mb-eg-3 text-caption text-ink-muted">{t('ssh.setup.desc')}</p>

      <div className="rounded-md border border-hairline bg-surface-2 px-eg-3 py-eg-2">
        <div className="mb-1 flex items-center gap-2 text-caption font-medium text-ink-subtle">
          <Terminal className="size-4" aria-hidden />
          {t('ssh.setup.env')}
          <Button
            variant="tertiary"
            size="sm"
            className="ml-auto"
            loading={loading}
            onClick={() => void refresh()}
            data-testid="ssh-setup-refresh"
          >
            <RefreshCw className="size-3.5" aria-hidden />
            {t('ssh.setup.recheck')}
          </Button>
        </div>
        {overview ? (
          <dl className="grid grid-cols-[auto_1fr] gap-x-eg-3 gap-y-1 text-caption">
            <dt className="text-ink-tertiary">{t('ssh.setup.version')}</dt>
            <dd className="truncate font-mono text-mono text-ink-muted">
              {overview.sshVersion ?? t('ssh.setup.missing')}
            </dd>
            <dt className="text-ink-tertiary">{t('ssh.setup.agent')}</dt>
            <dd className="text-ink-muted">
              {overview.agent.running
                ? t('ssh.setup.agentRunning', { count: overview.agent.keys.length })
                : t('ssh.setup.agentStopped')}
            </dd>
            <dt className="text-ink-tertiary">{t('ssh.setup.keyDir')}</dt>
            <dd className="truncate font-mono text-mono text-ink-muted">
              {overview.keyDir ?? '—'}
            </dd>
          </dl>
        ) : (
          <p className="text-caption text-ink-tertiary">{t('ssh.setup.loading')}</p>
        )}
      </div>

      <div className="mt-eg-3 rounded-md border border-hairline px-eg-3 py-eg-2">
        <div className="flex items-center gap-2 text-caption font-medium text-ink-subtle">
          <KeyRound className="size-4" aria-hidden />
          {t('ssh.setup.keyStep')}
        </div>
        {keys.length > 0 ? (
          <ul className="mt-2 flex flex-col gap-1" data-testid="ssh-setup-keys">
            {keys.map((key) => (
              <li key={key.path} className="flex items-center gap-2 text-caption">
                <span className="min-w-0 flex-1 truncate font-mono text-mono text-ink-muted">
                  {key.path}
                </span>
                <Button
                  variant="tertiary"
                  size="sm"
                  data-testid={`ssh-setup-copy-${key.fingerprint}`}
                  onClick={() =>
                    void run('copy', async () => {
                      if (await copyKey(key.path)) setCopiedPath(key.path);
                    })
                  }
                >
                  {copiedPath === key.path ? (
                    <Check className="size-3.5" aria-hidden />
                  ) : (
                    <Copy className="size-3.5" aria-hidden />
                  )}
                  {copiedPath === key.path ? t('ssh.hostKey.copied') : t('ssh.setup.copy')}
                </Button>
              </li>
            ))}
          </ul>
        ) : (
          <div className="mt-2">
            <p className="text-caption text-ink-tertiary">{t('ssh.setup.noKey')}</p>
            <Button
              variant="secondary"
              size="sm"
              className="mt-2"
              loading={busy === 'generate'}
              disabled={!overview?.toolsAvailable}
              data-testid="ssh-setup-generate"
              onClick={() => void run('generate', generate)}
            >
              {t('ssh.setup.generate')}
            </Button>
            <p className="mt-1 text-caption text-ink-tertiary">{t('ssh.setup.generateHint')}</p>
          </div>
        )}
      </div>

      <div className="mt-eg-3 rounded-md border border-hairline px-eg-3 py-eg-2">
        <div className="flex items-center gap-2 text-caption font-medium text-ink-subtle">
          <ShieldCheck className="size-4" aria-hidden />
          {t('ssh.setup.githubStep')}
        </div>
        <p className="mt-1 text-caption text-ink-muted">{t('ssh.setup.githubDesc')}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          <Button
            variant="secondary"
            size="sm"
            loading={busy === 'github'}
            disabled={!primaryKey}
            data-testid="ssh-setup-open-github"
            onClick={() => void openGithub()}
          >
            <ExternalLink className="size-3.5" aria-hidden />
            {t('ssh.setup.openGithub')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            loading={busy === 'test'}
            data-testid="ssh-setup-test"
            onClick={() => void run('test', testGithub)}
          >
            {t('ssh.setup.test')}
          </Button>
        </div>
        {githubUser ? (
          <p className="mt-2 text-caption text-success" data-testid="ssh-setup-ok">
            {t('ssh.setup.ok', { user: githubUser })}
          </p>
        ) : null}
        {githubError ? (
          <p
            className="mt-2 whitespace-pre-wrap break-words text-caption text-danger"
            data-testid="ssh-setup-error"
          >
            {githubError.detail}
            {githubError.reason ? `\n${githubError.reason}` : ''}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}
