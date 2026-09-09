import { useEffect, useState } from 'react';
import { CloudOff, Pencil, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { Badge, Button, Dialog, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';

/**
 * 远程管理页 (m1-plan F-29 / R-24): CRUD, 编辑地址, 连通性测试, prune fetch.
 * Sync buttons live in the top bar; this page owns configuration.
 */
export function RemotesPage() {
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);
  const remotes = useSyncStore((s) => s.remotes);
  const busy = useSyncStore((s) => s.busy);
  const refresh = useSyncStore((s) => s.refresh);
  const fetchRemote = useSyncStore((s) => s.fetch);
  const testRemote = useSyncStore((s) => s.testRemote);
  const removeRemote = useSyncStore((s) => s.removeRemote);
  const [form, setForm] = useState<{ mode: 'add' | 'edit'; name: string; url: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<string | null>(null);

  useEffect(() => {
    if (hasActiveRepo) void refresh();
  }, [hasActiveRepo, refresh]);

  if (!hasActiveRepo) {
    return (
      <div className="h-full">
        <EmptyState icon={CloudOff} title={t('remotes.title')} description={t('remotes.empty')} />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="remotes-view">
      <div className="mx-auto max-w-[860px] px-eg-5 py-eg-4">
        <div className="flex items-center gap-eg-2">
          <h2 className="text-section font-semibold text-ink">{t('remotes.title')}</h2>
          <Badge variant="count">{remotes.length}</Badge>
          <Button
            size="sm"
            variant="primary"
            className="ml-auto"
            data-testid="remote-add"
            onClick={() => setForm({ mode: 'add', name: '', url: '' })}
          >
            <Plus className="size-3.5" aria-hidden />
            {t('remotes.add')}
          </Button>
        </div>

        {remotes.length === 0 ? (
          <p className="mt-eg-4 rounded-lg border border-hairline bg-surface-1 px-eg-3 py-eg-3 text-caption text-ink-tertiary">
            {t('remotes.empty')}
          </p>
        ) : (
          <ul
            className="mt-eg-2 overflow-hidden rounded-lg border border-hairline"
            data-testid="remote-list"
          >
            {remotes.map((remote) => (
              <li
                key={remote.name}
                className="flex h-11 items-center gap-eg-3 border-b border-hairline px-eg-3 last:border-b-0 hover:bg-surface-1"
              >
                <span className="font-mono text-secondary font-medium text-ink">{remote.name}</span>
                <span
                  className="min-w-0 flex-1 truncate text-caption text-ink-tertiary"
                  title={remote.url}
                >
                  {remote.url}
                </span>
                <Button
                  size="sm"
                  variant="tertiary"
                  data-testid={`remote-test-${remote.name}`}
                  disabled={busy !== null}
                  onClick={() => void testRemote(remote.name)}
                >
                  {t('remotes.test')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  data-testid={`remote-fetch-${remote.name}`}
                  disabled={busy !== null}
                  onClick={() => void fetchRemote(remote.name)}
                >
                  <RefreshCw className="size-3" aria-hidden />
                  {t('remotes.fetch')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  aria-label={t('remotes.edit')}
                  onClick={() => setForm({ mode: 'edit', name: remote.name, url: remote.url })}
                >
                  <Pencil className="size-3" aria-hidden />
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  aria-label={t('remotes.delete')}
                  data-testid={`remote-delete-${remote.name}`}
                  onClick={() => setDeleting(remote.name)}
                >
                  <Trash2 className="size-3 text-danger" aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <RemoteFormDialog
        form={form}
        existing={remotes.map((r) => r.name)}
        onClose={() => setForm(null)}
      />

      <Dialog
        open={deleting !== null}
        title={t('remotes.deleteTitle', { name: deleting ?? '' })}
        danger
        onClose={() => setDeleting(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDeleting(null)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              data-testid="remote-delete-confirm"
              onClick={() => {
                const name = deleting;
                setDeleting(null);
                if (name) void removeRemote(name);
              }}
            >
              {t('remotes.deleteConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('remotes.deleteDesc')}</p>
      </Dialog>
    </div>
  );
}

/** 添加 / 编辑地址 shared form (R-24). */
function RemoteFormDialog({
  form,
  existing,
  onClose,
}: {
  form: { mode: 'add' | 'edit'; name: string; url: string } | null;
  existing: string[];
  onClose: () => void;
}) {
  const addRemote = useSyncStore((s) => s.addRemote);
  const renameRemote = useSyncStore((s) => s.renameRemote);
  const setRemoteUrl = useSyncStore((s) => s.setRemoteUrl);
  const [name, setName] = useState(form?.name ?? '');
  const [url, setUrl] = useState(form?.url ?? '');

  const valid =
    form !== null &&
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    (form.mode === 'edit' || !existing.includes(name.trim()));

  const submit = async () => {
    if (!form || !valid) return;
    const ok =
      form.mode === 'add'
        ? await addRemote(name.trim(), url.trim())
        : form.name === name.trim()
          ? await setRemoteUrl(form.name, url.trim())
          : await renameRemote(form.name, name.trim()).then(async (renamed) =>
              renamed ? setRemoteUrl(name.trim(), url.trim()) : false,
            );
    if (ok) onClose();
  };

  return (
    <Dialog
      open={form !== null}
      title={form?.mode === 'add' ? t('remotes.add') : t('remotes.edit')}
      onClose={onClose}
      actions={
        <>
          <Button variant="secondary" onClick={onClose}>
            {t('dialog.cancel')}
          </Button>
          <Button
            variant="primary"
            disabled={!valid}
            data-testid="remote-form-confirm"
            onClick={() => void submit()}
          >
            {form?.mode === 'add' ? t('remotes.add') : t('dialog.confirm')}
          </Button>
        </>
      }
    >
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('remotes.namePlaceholder')}
        aria-label={t('remotes.namePlaceholder')}
        disabled={form?.mode === 'edit'}
        data-testid="remote-name-input"
        className="mb-2 h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary disabled:opacity-60"
      />
      <input
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder={t('remotes.urlPlaceholder')}
        aria-label={t('remotes.urlPlaceholder')}
        data-testid="remote-url-input"
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
    </Dialog>
  );
}
