import { Check, Copy, ShieldAlert } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { useSshStore } from '../../stores/sshStore';

/**
 * First-connection / changed-key confirmation. Nothing is written to
 * known_hosts until 「信任并继续」 is pressed; a changed key additionally
 * requires ticking the risk acknowledgement checkbox.
 */
export function SshHostKeyDialog() {
  const prompt = useSshStore((s) => s.hostKeyPrompt);
  const confirm = useSshStore((s) => s.confirmHostKey);
  const retryProbe = useSshStore((s) => s.retryHostKeyProbe);
  const cancel = useSshStore((s) => s.cancelHostKey);
  const [copied, setCopied] = useState(false);
  const [acknowledged, setAcknowledged] = useState(false);

  if (!prompt) return null;
  const where = prompt.port === 22 ? prompt.host : `${prompt.host}:${prompt.port}`;
  const canTrust =
    Boolean(prompt.fingerprint) && !prompt.loading && (!prompt.changed || acknowledged);

  const copy = () => {
    if (!prompt.fingerprint) return;
    if (!navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(prompt.fingerprint)
      .then(() => setCopied(true))
      .catch(() => undefined);
  };

  return (
    <Dialog
      open
      danger={prompt.changed}
      title={prompt.changed ? t('ssh.hostKey.titleChanged') : t('ssh.hostKey.title')}
      onClose={cancel}
      actions={
        <>
          <Button variant="secondary" onClick={cancel}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant={prompt.changed ? 'danger' : 'primary'}
            disabled={!canTrust}
            loading={prompt.loading}
            data-testid="hostkey-trust"
            onClick={() => void confirm()}
          >
            {t('ssh.hostKey.trust')}
          </Button>
        </>
      }
    >
      {prompt.changed ? (
        <p
          className="mb-eg-3 flex items-start gap-eg-2 rounded-md border border-danger-border bg-danger-bg px-eg-3 py-eg-2 text-caption text-danger"
          data-testid="hostkey-changed"
        >
          <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {t('ssh.hostKey.changed', { host: where })}
        </p>
      ) : (
        <p className="mb-eg-3 text-caption text-ink-muted" data-testid="hostkey-first">
          {t('ssh.hostKey.first', { host: where })}
        </p>
      )}

      <div className="rounded-md border border-hairline bg-surface-2 px-eg-3 py-eg-2">
        <div className="text-caption text-ink-subtle">{t('ssh.hostKey.fingerprint')}</div>
        <div className="mt-1 flex items-center gap-eg-2">
          <code
            className="min-w-0 flex-1 break-all font-mono text-mono text-ink"
            data-testid="hostkey-fingerprint"
          >
            {prompt.loading ? t('ssh.hostKey.probing') : (prompt.fingerprint ?? '—')}
          </code>
          <Button
            variant="tertiary"
            size="sm"
            disabled={!prompt.fingerprint}
            onClick={copy}
            data-testid="hostkey-copy"
          >
            {copied ? (
              <Check className="size-4" aria-hidden />
            ) : (
              <Copy className="size-4" aria-hidden />
            )}
            {copied ? t('ssh.hostKey.copied') : t('ssh.hostKey.copy')}
          </Button>
        </div>
        {prompt.keyType ? (
          <div className="mt-1 text-caption text-ink-tertiary">
            {t('ssh.hostKey.type')}: {prompt.keyType}
          </div>
        ) : null}
      </div>

      {prompt.changed ? (
        <label className="mt-eg-3 flex items-start gap-eg-2 text-caption text-ink-muted">
          <input
            type="checkbox"
            checked={acknowledged}
            onChange={(event) => setAcknowledged(event.target.checked)}
            data-testid="hostkey-ack"
          />
          {t('ssh.hostKey.ack')}
        </label>
      ) : null}

      {prompt.error ? (
        <div className="mt-eg-3 rounded-md border border-danger-border bg-danger-bg px-eg-3 py-eg-2">
          <p
            role="alert"
            data-testid="hostkey-error"
            className="text-caption whitespace-pre-wrap break-words text-danger"
          >
            {prompt.error}
          </p>
          <Button
            variant="secondary"
            size="sm"
            className="mt-2"
            loading={prompt.loading}
            data-testid="hostkey-retry"
            onClick={() => void retryProbe()}
          >
            {t('ssh.hostKey.retryProbe')}
          </Button>
        </div>
      ) : null}
    </Dialog>
  );
}
