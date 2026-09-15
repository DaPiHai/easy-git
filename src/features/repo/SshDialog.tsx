import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import {
  browseSshDir,
  initSshRepo,
  isSshRepoPath,
  testSshConnection,
} from '../../lib/ipc/commands';
import { appLog } from '../../lib/logger';
import { reportError } from '../../lib/ipc/report';
import { humanizeEgError, type EgErrorLike } from '../../lib/ipc/errors';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';

/**
 * SSH 远端仓库 dialog (feat/ssh-remote-manage): address + test + open.
 *
 * Connects to a repository on a server without a desktop over the system
 * `ssh` client — no local clone. Authentication reuses the system SSH agent
 * and `~/.ssh/config`; EasyGit never asks for or stores private key material.
 * Destructive writes stay disabled on remote repos (policy note below).
 */
export function SshDialog() {
  const open = useUiStore((s) => s.sshDialogOpen);
  const setSshDialogOpen = useUiStore((s) => s.setSshDialogOpen);
  const [location, setLocation] = useState('');
  const [browseDir, setBrowseDir] = useState('');
  const [entries, setEntries] = useState<string[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [opening, setOpening] = useState(false);
  const [initializing, setInitializing] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [testOk, setTestOk] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  // Last structured failure kept around so the dialog can render a recovery
  // action (the "initialize here" button on ssh_not_a_repo / exists=true).
  const [lastError, setLastError] = useState<EgErrorLike | null>(null);

  const trimmed = location.trim();
  const valid =
    trimmed.length > 0 && isSshRepoPath(trimmed) && !testing && !opening && !initializing;

  const close = () => {
    setSshDialogOpen(false);
    setTestOk(null);
    setErrorText(null);
    setLastError(null);
  };

  /**
   * Renders a failure inline without a global toast. Used for the
   * "initialize here" recovery path so the user can retry without the
   * toast queue piling up; the open/browse/test failures still go through
   * `reportError` so their hints reach the rest of the UI.
   *
   * The log line is NOT optional: skipping the toast means this is the only
   * trace a failure leaves, and the generic fallback copy even promises
   * "已记录日志" (真机: an unregistered IPC command surfaced here as
   * "出了点问题" with zero trace, which made it undiagnosable).
   */
  const renderInline = (error: unknown, scope: string) => {
    const humanized = humanizeEgError((error ?? {}) as EgErrorLike);
    appLog.error(
      scope,
      humanized.reason ? `${humanized.title} — ${humanized.reason}` : humanized.title,
    );
    const lines = [humanized.detail];
    if (humanized.reason && humanized.reason !== humanized.detail) {
      lines.push(humanized.reason);
    }
    setErrorText(lines.filter(Boolean).join('\n'));
  };

  const showFailure = (error: unknown, scope: string) => {
    setLastError((error ?? {}) as EgErrorLike);
    const humanized = reportError(error, scope);
    const lines = [humanized.detail];
    if (humanized.reason && humanized.reason !== humanized.detail) {
      lines.push(humanized.reason);
    }
    setErrorText(lines.filter(Boolean).join('\n'));
  };

  const test = async () => {
    if (!valid) return;
    setTesting(true);
    setTestOk(null);
    setErrorText(null);
    setLastError(null);
    try {
      const uri = await testSshConnection(trimmed);
      setTestOk(uri);
    } catch (error) {
      showFailure(error, 'ssh-test');
    } finally {
      setTesting(false);
    }
  };

  const browse = async () => {
    const dir = browseDir.trim() || '~';
    if (!valid) return;
    setBrowsing(true);
    setErrorText(null);
    setLastError(null);
    try {
      setEntries(await browseSshDir(trimmed, dir));
    } catch (error) {
      setEntries(null);
      showFailure(error, 'ssh-browse');
    } finally {
      setBrowsing(false);
    }
  };

  const submit = async () => {
    if (!valid) return;
    setOpening(true);
    setErrorText(null);
    setLastError(null);
    try {
      const summary = await useRepoStore.getState().openByPathReturning(trimmed);
      toast.success(t('wizard.ssh.done', { name: summary.name }));
      close();
    } catch (error) {
      showFailure(error, 'ssh-open');
    } finally {
      setOpening(false);
    }
  };

  /**
   * Initializes a fresh Git repo on the SSH host at `trimmed`, then opens
   * it. Only enabled when the last open failure was `ssh_not_a_repo` with
   * `exists=true` — any other failure (or a successful open) leaves this
   * hidden so we never offer to init paths we cannot reach.
   */
  const initHere = async () => {
    if (!valid) return;
    setInitializing(true);
    setErrorText(null);
    try {
      await initSshRepo(trimmed);
      const summary = await useRepoStore.getState().openByPathReturning(trimmed);
      toast.success(t('wizard.ssh.done', { name: summary.name }));
      close();
    } catch (error) {
      // Inline render: the init failure is local to this dialog, not a
      // global toast — the user is staring at the path they typed.
      renderInline(error, 'ssh-init');
    } finally {
      setInitializing(false);
    }
  };

  const canInitHere =
    lastError?.code === 'ssh_not_a_repo' && lastError.exists === true && !initializing;

  /** Appends a browsed directory entry to the repo path input. */
  const pickEntry = (entry: string) => {
    const dir = browseDir.trim() || '~';
    const base = dir.endsWith('/') ? dir.slice(0, -1) : dir;
    const joined = entry.endsWith('/') ? `${base}/${entry.slice(0, -1)}` : `${base}/${entry}`;
    // Keep the host part the user typed; only swap the path portion.
    const at = trimmed.indexOf(':');
    const scheme = trimmed.indexOf('://');
    if (scheme >= 0) {
      const slash = trimmed.indexOf('/', scheme + 3);
      if (slash >= 0)
        setLocation(`${trimmed.slice(0, slash)}${joined.startsWith('/') ? joined : `/${joined}`}`);
    } else if (at >= 0) {
      setLocation(`${trimmed.slice(0, at + 1)}${joined}`);
    }
  };

  const inputClass =
    'h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary';

  return (
    <Dialog
      open={open}
      title={t('wizard.ssh')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="secondary"
            disabled={!valid}
            loading={testing}
            data-testid="ssh-test"
            onClick={() => void test()}
          >
            {testing ? t('wizard.ssh.testing') : t('wizard.ssh.test')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={opening}
            data-testid="ssh-confirm"
            onClick={() => void submit()}
          >
            {opening ? t('wizard.ssh.opening') : t('wizard.ssh.open')}
          </Button>
        </>
      }
    >
      <input
        value={location}
        onChange={(e) => {
          setLocation(e.target.value);
          setTestOk(null);
        }}
        placeholder={t('wizard.ssh.locationPlaceholder')}
        aria-label={t('wizard.ssh.location')}
        data-testid="ssh-location-input"
        className={`mb-2 ${inputClass}`}
      />
      {testOk ? (
        <p
          className="mb-2 truncate font-mono text-caption text-ink-subtle"
          data-testid="ssh-test-ok"
        >
          {t('wizard.ssh.testOk')}：{testOk}
        </p>
      ) : null}
      <div className="flex gap-2">
        <input
          value={browseDir}
          onChange={(e) => setBrowseDir(e.target.value)}
          placeholder={t('wizard.ssh.browsePlaceholder')}
          aria-label={t('wizard.ssh.browse')}
          data-testid="ssh-browse-input"
          className={`flex-1 ${inputClass}`}
        />
        <Button variant="secondary" disabled={!valid || browsing} onClick={() => void browse()}>
          …
        </Button>
      </div>
      {entries ? (
        entries.length > 0 ? (
          <ul
            data-testid="ssh-browse-list"
            className="mt-2 max-h-40 overflow-y-auto rounded-md border border-hairline"
          >
            {entries.map((entry) => (
              <li key={entry}>
                <button
                  type="button"
                  onClick={() => pickEntry(entry)}
                  className="w-full truncate px-eg-2 py-1 text-left font-mono text-caption text-ink-muted hover:bg-surface-1"
                >
                  {entry}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-caption text-ink-tertiary">{t('wizard.ssh.browseEmpty')}</p>
        )
      ) : null}
      <p className="mt-2 text-caption text-ink-tertiary">{t('wizard.ssh.policyNote')}</p>
      {errorText ? (
        <div
          role="alert"
          data-testid="ssh-error"
          className="mt-2 rounded-md border border-danger-border bg-danger-bg px-eg-2 py-1.5 text-caption whitespace-pre-wrap break-words text-danger"
        >
          <p>{errorText}</p>
          {canInitHere ? (
            <Button
              variant="primary"
              loading={initializing}
              data-testid="ssh-init-here"
              onClick={() => void initHere()}
              className="mt-2"
            >
              {initializing ? t('wizard.ssh.initializing') : t('wizard.ssh.initHere')}
            </Button>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}
