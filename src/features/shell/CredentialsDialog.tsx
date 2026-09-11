import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { useSyncStore } from '../../stores/syncStore';

/**
 * HTTPS credentials dialog (R-22 auth fallback for legacy servers).
 * Mounted once at the AppShell level; opens when a push is rejected with
 * `auth` and no working session credential exists. Credentials live in
 * session memory only — never persisted, never logged.
 */
export function CredentialsDialog() {
  const request = useSyncStore((s) => s.credentialsRequest);
  if (!request) return null;
  // Keyed per prompt so inputs always start empty; the form clears its own
  // secrets before resolving.
  return <CredentialsForm key={request.id} remote={request.remote} resolve={request.resolve} />;
}

function CredentialsForm({
  remote,
  resolve,
}: {
  remote: string;
  resolve: (creds: { username: string; password: string } | null) => void;
}) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');

  const valid = username.trim().length > 0 && password.length > 0;
  const close = (creds: { username: string; password: string } | null) => {
    setUsername('');
    setPassword('');
    resolve(creds);
  };

  return (
    <Dialog
      open
      title={t('sync.authTitle', { remote })}
      onClose={() => close(null)}
      actions={
        <>
          <Button variant="secondary" onClick={() => close(null)}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="auth-confirm"
            onClick={() => close({ username: username.trim(), password })}
          >
            {t('sync.authConfirm')}
          </Button>
        </>
      }
    >
      <p className="mb-eg-3 text-caption text-ink-muted">{t('sync.authDesc')}</p>
      <input
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder={t('sync.authUsername')}
        aria-label={t('sync.authUsername')}
        autoComplete="off"
        data-testid="auth-username-input"
        className="mb-2 h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder={t('sync.authPassword')}
        aria-label={t('sync.authPassword')}
        autoComplete="new-password"
        data-testid="auth-password-input"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && valid) close({ username: username.trim(), password });
        }}
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
    </Dialog>
  );
}
