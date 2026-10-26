import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownToLine,
  ArrowUpToLine,
  CheckCircle2,
  CloudOff,
  Loader2,
  Pencil,
  PlugZap,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { Badge, Button, Checkbox, Dialog, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import type { RemoteActionResult } from '../../stores/syncStore';
import { useRepoStore } from '../../stores/repoStore';
import { useSyncStore } from '../../stores/syncStore';

type BulkAction = 'test' | 'fetch' | 'push' | 'pull';
type RowStatus = 'running' | 'ok' | 'fail';

/**
 * 远程管理页 (m1-plan F-29 / R-24): CRUD, 编辑地址, 连通性测试, prune fetch.
 * Sync buttons live in the top bar; this page owns configuration and the
 * multi-select batch actions (test/fetch/push; pull is single-remote only).
 */
export function RemotesPage() {
  const hasActiveRepo = useRepoStore((s) => s.activeId !== null);
  const branch = useRepoStore((s) => s.status?.branch ?? '');
  const remotes = useSyncStore((s) => s.remotes);
  const busy = useSyncStore((s) => s.busy);
  const refresh = useSyncStore((s) => s.refresh);
  const fetchRemote = useSyncStore((s) => s.fetch);
  const fetchMany = useSyncStore((s) => s.fetchMany);
  const testRemote = useSyncStore((s) => s.testRemote);
  const testMany = useSyncStore((s) => s.testMany);
  const pushMany = useSyncStore((s) => s.pushMany);
  const pull = useSyncStore((s) => s.pull);
  const removeRemote = useSyncStore((s) => s.removeRemote);

  const [form, setForm] = useState<{ mode: 'add' | 'edit'; name: string; url: string } | null>(
    null,
  );
  const [deleting, setDeleting] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<BulkAction | null>(null);
  const [rowStatus, setRowStatus] = useState<Record<string, RowStatus>>({});
  const [rowAction, setRowAction] = useState<Record<string, 'test' | 'fetch'>>({});
  const [divergedRemote, setDivergedRemote] = useState<string | null>(null);

  useEffect(() => {
    if (hasActiveRepo) void refresh();
  }, [hasActiveRepo, refresh]);

  // Derive from the current remote list instead of cleaning the Set in an
  // effect: a remote removed while selected simply stops counting.
  const selectedNames = useMemo(
    () => remotes.filter((remote) => selected.has(remote.name)).map((remote) => remote.name),
    [remotes, selected],
  );
  const allSelected = remotes.length > 0 && selectedNames.length === remotes.length;
  const someSelected = selectedNames.length > 0 && !allSelected;
  const hasSelection = selectedNames.length > 0;
  const rowBusy = Object.keys(rowAction).length > 0;
  const canSelect = bulk === null && busy === null && !rowBusy;
  const canBatch = canSelect && hasSelection;
  const canPushOrPull = canBatch && branch.length > 0;

  const setRowStates = (names: string[], status: RowStatus) => {
    setRowStatus((previous) => {
      const next = { ...previous };
      for (const name of names) next[name] = status;
      return next;
    });
  };

  const applyResults = (results: RemoteActionResult[]) => {
    setRowStatus((previous) => {
      const next = { ...previous };
      for (const result of results) {
        next[result.remote] = result.status === 'ok' ? 'ok' : 'fail';
      }
      return next;
    });
  };

  const toggleSelected = (name: string) => {
    if (!canSelect) return;
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleAll = () => {
    if (!canSelect) return;
    setSelected(allSelected ? new Set() : new Set(remotes.map((remote) => remote.name)));
  };

  const runBulk = async (kind: BulkAction) => {
    if (!canBatch || bulk !== null) return;
    if (kind === 'pull' && selectedNames.length !== 1) return;
    if ((kind === 'push' || kind === 'pull') && branch.length === 0) return;
    const names = selectedNames;
    setBulk(kind);
    setRowStates(names, 'running');
    try {
      if (kind === 'test') {
        applyResults(await testMany(names));
      } else if (kind === 'fetch') {
        applyResults(await fetchMany(names));
      } else if (kind === 'push') {
        applyResults(await pushMany(branch, names));
      } else {
        const remote = names[0];
        const result = await pull(remote, branch, 'ff_only');
        if (result === 'diverged') {
          setRowStatus((previous) => {
            const next = { ...previous };
            delete next[remote];
            return next;
          });
          setDivergedRemote(remote);
        } else {
          setRowStates([remote], result === 'ok' ? 'ok' : 'fail');
        }
      }
    } finally {
      setBulk(null);
    }
  };

  const runTestOne = async (name: string) => {
    if (!canSelect) return;
    setRowAction((previous) => ({ ...previous, [name]: 'test' }));
    setRowStates([name], 'running');
    try {
      const count = await testRemote(name);
      setRowStates([name], count === null ? 'fail' : 'ok');
    } finally {
      setRowAction((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
    }
  };

  const runFetchOne = async (name: string) => {
    if (!canSelect) return;
    setRowAction((previous) => ({ ...previous, [name]: 'fetch' }));
    setRowStates([name], 'running');
    try {
      const ok = await fetchRemote(name);
      setRowStates([name], ok ? 'ok' : 'fail');
    } finally {
      setRowAction((previous) => {
        const next = { ...previous };
        delete next[name];
        return next;
      });
    }
  };

  const confirmDivergedMerge = async () => {
    const remote = divergedRemote;
    if (!remote || bulk !== null) return;
    setDivergedRemote(null);
    setBulk('pull');
    setRowStates([remote], 'running');
    try {
      const result = await pull(remote, branch, 'merge');
      setRowStates([remote], result === 'ok' ? 'ok' : 'fail');
    } finally {
      setBulk(null);
    }
  };

  if (!hasActiveRepo) {
    return (
      <div className="h-full">
        <EmptyState icon={CloudOff} title={t('remotes.title')} description={t('remotes.empty')} />
      </div>
    );
  }

  const statusTitle = (name: string): string | undefined => {
    const status = rowStatus[name];
    if (status === 'running') return t('remotes.status.running');
    if (status === 'ok') return t('remotes.status.ok');
    if (status === 'fail') return t('remotes.status.fail');
    return undefined;
  };

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
          <>
            <div
              className="mt-eg-3 flex flex-wrap items-center gap-eg-2 rounded-lg border border-hairline bg-surface-1 px-eg-3 py-2"
              data-testid="remote-bulk-bar"
            >
              <Checkbox
                checked={allSelected}
                indeterminate={someSelected}
                onChange={toggleAll}
                ariaLabel={t('remotes.selectAll')}
                testId="remote-select-all"
                disabled={!canSelect}
              />
              <span className="text-caption text-ink-tertiary">
                {hasSelection
                  ? t('remotes.selectedCount', { count: selectedNames.length })
                  : t('remotes.bulkHint')}
              </span>
              <div className="ml-auto flex flex-wrap items-center gap-1.5">
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={!canBatch}
                  loading={bulk === 'test'}
                  data-testid="remote-bulk-test"
                  onClick={() => void runBulk('test')}
                >
                  <PlugZap className="size-3.5" aria-hidden />
                  {t('remotes.bulkTest')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={!canBatch}
                  loading={bulk === 'fetch'}
                  data-testid="remote-bulk-fetch"
                  onClick={() => void runBulk('fetch')}
                >
                  <RefreshCw className="size-3.5" aria-hidden />
                  {t('remotes.bulkFetch')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={!canPushOrPull}
                  loading={bulk === 'push'}
                  title={!branch ? t('remotes.noBranch') : undefined}
                  data-testid="remote-bulk-push"
                  onClick={() => void runBulk('push')}
                >
                  <ArrowUpToLine className="size-3.5" aria-hidden />
                  {t('remotes.bulkPush')}
                </Button>
                <Button
                  size="sm"
                  variant="tertiary"
                  disabled={!canPushOrPull || selectedNames.length !== 1}
                  loading={bulk === 'pull'}
                  title={
                    selectedNames.length > 1
                      ? t('remotes.pullOneOnly')
                      : !branch
                        ? t('remotes.noBranch')
                        : undefined
                  }
                  data-testid="remote-bulk-pull"
                  onClick={() => void runBulk('pull')}
                >
                  <ArrowDownToLine className="size-3.5" aria-hidden />
                  {t('remotes.bulkPull')}
                </Button>
              </div>
            </div>

            <ul
              className="mt-eg-2 overflow-hidden rounded-lg border border-hairline"
              data-testid="remote-list"
            >
              {remotes.map((remote) => {
                const status = rowStatus[remote.name];
                return (
                  <li
                    key={remote.name}
                    className="flex h-11 items-center gap-eg-2 border-b border-hairline px-eg-3 last:border-b-0 hover:bg-surface-1"
                  >
                    <Checkbox
                      checked={selected.has(remote.name)}
                      onChange={() => toggleSelected(remote.name)}
                      ariaLabel={t('remotes.selectRemote', { name: remote.name })}
                      testId={`remote-select-${remote.name}`}
                      disabled={!canSelect}
                    />
                    <span className="font-mono text-secondary font-medium text-ink">
                      {remote.name}
                    </span>
                    <span
                      className="min-w-0 flex-1 truncate text-caption text-ink-tertiary"
                      title={remote.url}
                    >
                      {remote.url}
                    </span>
                    {status ? (
                      <span
                        className="flex size-4 shrink-0 items-center justify-center"
                        title={statusTitle(remote.name)}
                        data-testid={`remote-status-${remote.name}`}
                        aria-label={statusTitle(remote.name)}
                      >
                        {status === 'running' ? (
                          <Loader2
                            className="size-3.5 animate-spin text-ink-tertiary"
                            aria-hidden
                          />
                        ) : status === 'ok' ? (
                          <CheckCircle2 className="size-3.5 text-success" aria-hidden />
                        ) : (
                          <AlertTriangle className="size-3.5 text-danger" aria-hidden />
                        )}
                      </span>
                    ) : null}
                    <Button
                      size="sm"
                      variant="tertiary"
                      data-testid={`remote-test-${remote.name}`}
                      disabled={!canSelect}
                      loading={rowAction[remote.name] === 'test'}
                      onClick={() => void runTestOne(remote.name)}
                    >
                      {t('remotes.test')}
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      data-testid={`remote-fetch-${remote.name}`}
                      disabled={!canSelect}
                      loading={rowAction[remote.name] === 'fetch'}
                      onClick={() => void runFetchOne(remote.name)}
                    >
                      <RefreshCw className="size-3" aria-hidden />
                      {t('remotes.fetch')}
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      aria-label={t('remotes.edit')}
                      disabled={bulk !== null}
                      onClick={() => setForm({ mode: 'edit', name: remote.name, url: remote.url })}
                    >
                      <Pencil className="size-3" aria-hidden />
                    </Button>
                    <Button
                      size="sm"
                      variant="tertiary"
                      aria-label={t('remotes.delete')}
                      data-testid={`remote-delete-${remote.name}`}
                      disabled={bulk !== null}
                      onClick={() => setDeleting(remote.name)}
                    >
                      <Trash2 className="size-3 text-danger" aria-hidden />
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
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

      <Dialog
        open={divergedRemote !== null}
        title={t('sync.divergedTitle')}
        onClose={() => setDivergedRemote(null)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setDivergedRemote(null)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              loading={bulk === 'pull'}
              data-testid="remote-pull-merge-confirm"
              onClick={() => void confirmDivergedMerge()}
            >
              {t('sync.divergedMerge')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('sync.divergedDesc')}</p>
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
  const [submitting, setSubmitting] = useState(false);

  const valid =
    form !== null &&
    name.trim().length > 0 &&
    url.trim().length > 0 &&
    (form.mode === 'edit' || !existing.includes(name.trim()));

  const submit = async () => {
    if (!form || !valid) return;
    setSubmitting(true);
    try {
      const ok =
        form.mode === 'add'
          ? await addRemote(name.trim(), url.trim())
          : form.name === name.trim()
            ? await setRemoteUrl(form.name, url.trim())
            : await renameRemote(form.name, name.trim()).then(async (renamed) =>
                renamed ? setRemoteUrl(name.trim(), url.trim()) : false,
              );
      if (ok) onClose();
    } finally {
      setSubmitting(false);
    }
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
            disabled={!valid || submitting}
            loading={submitting}
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
