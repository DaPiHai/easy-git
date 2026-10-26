import { CircleAlert, KeyRound, LoaderCircle, RefreshCw, ShieldCheck, ShieldX } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '../../components';
import { t } from '../../lib/i18n';
import { getSshCredentialsOverview } from '../../lib/ipc/commands';
import { reportError } from '../../lib/ipc/report';
import type { SshCredentialsOverview, SshKeyInfo } from '../../lib/ipc/bindings';
import { useSshStore } from '../../stores/sshStore';
import { useUiStore } from '../../stores/uiStore';

/**
 * Settings "身份凭证" section (feat/ssh-remote-manage): a read-only view of
 * the local ssh-agent and `~/.ssh/*.pub`. EasyGit never stores credentials
 * and never reads private keys — the worst thing this section can do is tell
 * the user where to look next (terminal ssh-add / system credential store).
 */
export function CredentialsSection() {
  const sectionRef = useRef<HTMLElement | null>(null);
  const highlighted = useUiStore((s) => s.credentialsHighlighted);
  const [overview, setOverview] = useState<SshCredentialsOverview | null>(null);
  const [loading, setLoading] = useState(false);
  // `error` is shown inline but does NOT block the rest of the section:
  // a single failing probe should not hide the rest of the diagnostics.
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    void getSshCredentialsOverview().then(
      (result) => {
        setOverview(result);
        setError(null);
        setLoading(false);
      },
      (caught) => {
        // Only the IPC-level error (Rust panic, channel closed, etc.) lands
        // here — the backend itself always returns Ok(()) and degrades to
        // empty fields on probe failures. Still: surface it so the user
        // does not stare at a blank section thinking everything is fine.
        reportError(caught, 'settings.credentials');
        setError(t('settings.credentials.error'));
        setLoading(false);
      },
    );
  }, []);

  // First paint: kick off the initial fetch via `then` so the setState calls
  // live in async callbacks — the `react-hooks/set-state-in-effect` lint
  // rejects synchronous setState in effect bodies. Subsequent paints only
  // trigger when the user clicks 刷新.
  useEffect(() => {
    let started = false;
    void getSshCredentialsOverview().then(
      (result) => {
        if (started) return;
        setOverview(result);
      },
      (caught) => {
        if (started) return;
        reportError(caught, 'settings.credentials');
        setError(t('settings.credentials.error'));
      },
    );
    return () => {
      // Unmount before the IPC resolves → don't apply stale data.
      started = true;
    };
  }, []);

  // The `open-credentials` hint flips `credentialsHighlighted` to true on
  // mount and back to false after 2.5 s (see `src/lib/ipc/hints.ts`).
  // While it is true, scroll the section into view and outline it so the
  // user has an obvious landing spot — exactly what the previous toast
  // promised when it offered a "管理凭据" button.
  useEffect(() => {
    if (!highlighted) return;
    sectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [highlighted]);

  return (
    <section
      ref={sectionRef}
      data-testid="settings-credentials"
      className={`mt-eg-5 rounded-xl border bg-surface-1 px-eg-5 py-eg-4 transition-colors duration-200 ease-eg ${
        highlighted ? 'border-primary ring-2 ring-primary/30' : 'border-hairline'
      }`}
    >
      <header className="flex items-start justify-between gap-eg-3">
        <div>
          <h2 className="flex items-center gap-2 text-section font-semibold text-ink">
            <KeyRound className="size-4 text-ink-subtle" aria-hidden />
            {t('settings.credentials')}
          </h2>
          <p className="mt-0.5 text-caption text-ink-tertiary">{t('settings.credentials.desc')}</p>
        </div>
        <Button
          variant="primary"
          size="sm"
          data-testid="settings-ssh-setup"
          onClick={() => useSshStore.getState().setSetupOpen(true)}
        >
          {t('ssh.setup.open')}
        </Button>
        <button
          type="button"
          data-testid="settings-credentials-refresh"
          disabled={loading}
          onClick={refresh}
          className="flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-2 px-3 text-secondary text-ink-muted transition-colors duration-80 ease-eg hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-40"
        >
          {loading ? (
            <LoaderCircle className="size-4 animate-spin" aria-hidden />
          ) : (
            <RefreshCw className="size-4" aria-hidden />
          )}
          {loading ? t('settings.credentials.refreshing') : t('settings.credentials.refresh')}
        </button>
      </header>

      {error ? (
        <p
          data-testid="settings-credentials-error"
          className="mt-eg-3 flex items-center gap-1.5 rounded-md bg-danger/10 px-3 py-2 text-caption text-danger"
        >
          <CircleAlert className="size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      <AgentBlock
        running={overview?.agent.running ?? false}
        authSock={overview?.agent.authSock ?? null}
        keys={overview?.agent.keys ?? []}
      />

      <PublicKeysBlock
        keys={overview?.publicKeys ?? []}
        sshDirPresent={overview?.sshDirPresent ?? false}
      />
    </section>
  );
}

function AgentBlock({
  running,
  authSock,
  keys,
}: {
  running: boolean;
  authSock: string | null;
  keys: SshKeyInfo[];
}) {
  return (
    <div className="mt-eg-4">
      <div className="flex items-center gap-2">
        {running ? (
          <ShieldCheck className="size-4 text-success" aria-hidden />
        ) : (
          <ShieldX className="size-4 text-danger" aria-hidden />
        )}
        <span className="text-secondary text-ink">
          {running
            ? t('settings.credentials.agent.running')
            : t('settings.credentials.agent.stopped')}
        </span>
        {authSock ? (
          <span
            data-testid="settings-credentials-sock"
            className="ml-2 truncate rounded-md border border-hairline bg-surface-2 px-2 py-0.5 font-mono text-mono text-ink-muted"
            title={authSock}
          >
            {t('settings.credentials.agent.sock')}: {authSock}
          </span>
        ) : null}
      </div>

      {running ? (
        keys.length > 0 ? (
          <KeyList
            testId="settings-credentials-agent-keys"
            caption={t('settings.credentials.agent.keys')}
            keys={keys}
          />
        ) : (
          <p
            data-testid="settings-credentials-agent-keys-empty"
            className="mt-2 text-caption text-ink-tertiary"
          >
            {t('settings.credentials.agent.keys.empty')}
          </p>
        )
      ) : (
        <p
          data-testid="settings-credentials-agent-stopped"
          className="mt-2 text-caption text-ink-tertiary"
        >
          {t('settings.credentials.agent.help')}
        </p>
      )}
    </div>
  );
}

function PublicKeysBlock({
  keys,
  sshDirPresent,
}: {
  keys: SshCredentialsOverview['publicKeys'];
  sshDirPresent: boolean;
}) {
  return (
    <div className="mt-eg-4">
      <h3 className="text-caption font-medium text-ink-subtle">
        {t('settings.credentials.publicKeys')}
      </h3>
      {keys.length > 0 ? (
        <KeyList testId="settings-credentials-public-keys" keys={keys} caption={null} showPath />
      ) : (
        <p
          data-testid="settings-credentials-public-keys-empty"
          className="mt-2 text-caption text-ink-tertiary"
        >
          {sshDirPresent
            ? t('settings.credentials.publicKeys.empty')
            : t('settings.credentials.publicKeys.empty.dirMissing')}
        </p>
      )}
    </div>
  );
}

function KeyList({
  keys,
  caption,
  testId,
  showPath = false,
}: {
  keys: ReadonlyArray<SshKeyInfo | SshCredentialsOverview['publicKeys'][number]>;
  caption: string | null;
  testId: string;
  showPath?: boolean;
}) {
  return (
    <div data-testid={testId} className="mt-2 overflow-x-auto rounded-md border border-hairline">
      <table className="w-full text-left text-caption">
        <thead className="bg-surface-2 text-ink-subtle">
          <tr>
            <th className="px-3 py-1.5 font-medium">{t('settings.credentials.fingerprint')}</th>
            <th className="px-3 py-1.5 font-medium">{t('settings.credentials.comment')}</th>
            <th className="px-3 py-1.5 font-medium">{t('settings.credentials.type')}</th>
            {showPath ? <th className="px-3 py-1.5 font-medium">path</th> : null}
          </tr>
        </thead>
        <tbody>
          {keys.map((k) => (
            <tr
              key={k.fingerprint + k.comment}
              className="border-t border-hairline font-mono text-mono text-ink-muted"
            >
              <td className="px-3 py-1.5 break-all">{k.fingerprint}</td>
              <td className="px-3 py-1.5 break-all">{k.comment}</td>
              <td className="px-3 py-1.5 break-all">{k.keyType}</td>
              {showPath ? (
                <td className="px-3 py-1.5 break-all">{(k as { path?: string }).path ?? ''}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
      {caption ? <p className="px-3 py-1 text-caption text-ink-tertiary">{caption}</p> : null}
    </div>
  );
}
