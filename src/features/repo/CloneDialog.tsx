import { ChevronDown, ChevronUp } from 'lucide-react';
import { useState } from 'react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import { cloneRepo, pickDirectory } from '../../lib/ipc/commands';
import { reportError } from '../../lib/ipc/report';
import { useRepoStore } from '../../stores/repoStore';
import { useSshStore, withHostKeyTrust } from '../../stores/sshStore';
import { useSyncStore } from '../../stores/syncStore';
import { useUiStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';

/** The IPC layer throws the flat EgError shape; only the code matters here. */
const isAuthError = (error: unknown): boolean =>
  typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'auth';

/** SSH key rejection: guide to the setup wizard, not the HTTPS credential form. */
const isSshAuthError = (error: unknown): boolean => {
  if (!isAuthError(error)) return false;
  const provider = String((error as { provider?: unknown }).provider ?? '');
  return provider.startsWith('ssh-');
};

/**
 * 克隆仓库 dialog (R-22): url + 目标目录, progress rides the sync task strip.
 * Mounted once at the AppShell level so the sidebar entry works whether or
 * not a repository is already open.
 *
 * 私有服务器凭据（可选）走与 push 相同的一次性 askpass 通道：系统凭据管理器
 * 仍被先询问，被拒（如 GCM 拒绝明文 HTTP 的 GitLab）后 git 落到 askpass 应答。
 * 凭据仅存于会话内存，不落盘、不进日志。
 */
export function CloneDialog() {
  const open = useUiStore((s) => s.cloneDialogOpen);
  const setCloneDialogOpen = useUiStore((s) => s.setCloneDialogOpen);
  const [url, setUrl] = useState('');
  const [target, setTarget] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showCreds, setShowCreds] = useState(false);
  const [authHint, setAuthHint] = useState(false);
  const [busy, setBusy] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);
  const progress = useSyncStore((s) => s.progress);

  const valid = url.trim().length > 0 && target.trim().length > 0 && !busy;
  const insecureHttp = url.trim().toLowerCase().startsWith('http://');

  const close = () => {
    setCloneDialogOpen(false);
    setPassword('');
    setAuthHint(false);
  };

  const submit = async () => {
    if (!valid) return;
    setBusy(true);
    setErrorText(null);
    setAuthHint(false);
    const credentials =
      username.trim() || password ? { username: username.trim(), password } : null;
    try {
      const summary = await withHostKeyTrust(() =>
        cloneRepo(url.trim(), target.trim(), credentials),
      );
      toast.success(t('wizard.clone.done', { name: summary.name }));
      close();
      void useRepoStore.getState().openByPath(summary.path);
    } catch (error) {
      // 失败原因必须就地可见：右下角 toast 容易错过（rc.2 真人反馈），
      // reportError 同时带出可展开的原因与「查看日志」等建议动作。
      const humanized = reportError(error, 'clone');
      const lines = [humanized.detail];
      if (humanized.reason && humanized.reason !== humanized.detail) {
        lines.push(humanized.reason);
      }
      setErrorText(lines.filter(Boolean).join('\n'));
      // SSH 密钥失败走配置向导；HTTPS auth 类失败（含 GCM 拒绝明文 HTTP、
      // 无凭据可问）就地引导填凭据。
      if (isSshAuthError(error)) {
        useSshStore.getState().setSetupOpen(true);
      } else if (isAuthError(error)) {
        setShowCreds(true);
        setAuthHint(true);
      }
    } finally {
      setBusy(false);
    }
  };

  const inputClass =
    'h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary';

  return (
    <Dialog
      open={open}
      title={t('wizard.clone')}
      onClose={close}
      actions={
        <>
          <Button variant="secondary" onClick={close}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            loading={busy}
            data-testid="clone-confirm"
            onClick={() => void submit()}
          >
            {busy ? t('wizard.clone.running') : t('wizard.clone.confirm')}
          </Button>
        </>
      }
    >
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t('wizard.clone.urlPlaceholder')}
        aria-label={t('wizard.clone.urlPlaceholder')}
        data-testid="clone-url-input"
        className={`mb-2 ${inputClass}`}
      />
      {insecureHttp ? (
        <p className="mb-2 text-caption text-ink-tertiary" data-testid="clone-http-warning">
          {t('wizard.clone.httpWarning')}
        </p>
      ) : null}
      <div className="flex gap-2">
        <input
          value={target}
          onChange={(e) => setTarget(e.target.value)}
          placeholder={t('wizard.clone.pathPlaceholder')}
          aria-label={t('wizard.clone.pathPlaceholder')}
          data-testid="clone-path-input"
          className={`flex-1 ${inputClass}`}
        />
        <Button
          variant="secondary"
          onClick={async () => {
            const dir = await pickDirectory(t('wizard.clone.pathPlaceholder'));
            if (dir) setTarget(dir);
          }}
        >
          …
        </Button>
      </div>
      <button
        type="button"
        aria-expanded={showCreds}
        data-testid="clone-creds-toggle"
        onClick={() => setShowCreds((v) => !v)}
        className="mt-eg-2 flex items-center gap-1 text-caption text-ink-muted transition-opacity duration-80 ease-eg hover:opacity-80"
      >
        {showCreds ? (
          <ChevronUp className="size-3.5" aria-hidden />
        ) : (
          <ChevronDown className="size-3.5" aria-hidden />
        )}
        {t('wizard.clone.credentials')}
      </button>
      {showCreds ? (
        <div className="mt-1">
          <p className="mb-1.5 text-caption text-ink-tertiary">
            {t('wizard.clone.credentialsDesc')}
          </p>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder={t('sync.authUsername')}
            aria-label={t('sync.authUsername')}
            autoComplete="off"
            data-testid="clone-username-input"
            className={`mb-2 ${inputClass}`}
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={t('sync.authPassword')}
            aria-label={t('sync.authPassword')}
            autoComplete="new-password"
            data-testid="clone-password-input"
            className={inputClass}
          />
        </div>
      ) : null}
      {errorText ? (
        <p
          role="alert"
          data-testid="clone-error"
          className="mt-2 rounded-md border border-danger-border bg-danger-bg px-eg-2 py-1.5 text-caption whitespace-pre-wrap break-words text-danger"
        >
          {errorText}
        </p>
      ) : null}
      {authHint ? (
        <p className="mt-1.5 text-caption text-ink-muted" data-testid="clone-auth-hint">
          {t('wizard.clone.authRequired')}
        </p>
      ) : null}
      {busy && progress ? (
        <p className="mt-2 truncate text-caption text-ink-subtle" data-testid="clone-progress">
          {progress.message}
        </p>
      ) : null}
    </Dialog>
  );
}
