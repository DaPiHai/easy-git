import { Archive, Tag } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge, Dialog, EmptyState } from '../../components';
import { t } from '../../lib/i18n';
import { useIsSshActive } from '../../lib/useSshRepo';
import { formatRelativeTime } from '../../lib/time';
import { useRepoStore } from '../../stores/repoStore';
import { useRefStore } from '../../stores/refsStore';

/**
 * Stash + tags hub (m1-plan F-22 / R-17 / R-18): save/apply/pop/drop stash
 * with untracked files, and annotated/lightweight tag management.
 */
export function StoragePage() {
  const activeId = useRepoStore((s) => s.activeId);
  const isEmpty = useRepoStore((s) => (s.activeId ? s.repos[s.activeId]?.isEmpty : false));
  const refresh = useRefStore((s) => s.refresh);

  useEffect(() => {
    void refresh();
  }, [activeId, refresh]);

  if (isEmpty) {
    return (
      <EmptyState
        icon={Archive}
        title={t('storage.empty.title')}
        description={t('storage.empty.desc')}
      />
    );
  }

  return (
    <div className="h-full overflow-y-auto" data-testid="storage-view">
      <div className="mx-auto max-w-[860px] px-eg-5 py-eg-4">
        <StashSection />
        <TagSection />
      </div>
    </div>
  );
}

function StashSection() {
  const stashes = useRefStore((s) => s.stashes);
  const status = useRepoStore((s) => s.status);
  const stashPush = useRefStore((s) => s.stashPush);
  const stashApply = useRefStore((s) => s.stashApply);
  const stashDrop = useRefStore((s) => s.stashDrop);
  const [saveOpen, setSaveOpen] = useState(false);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  // Remote-host repos disable stash deletion by policy (drop is destructive).
  const isSsh = useIsSshActive();
  const hasChanges =
    status !== null && status.staged.length + status.unstaged.length + status.conflicted.length > 0;

  return (
    <section data-testid="stash-section">
      <div className="flex items-center gap-eg-2">
        <Archive className="size-4 text-ink-subtle" aria-hidden />
        <h2 className="text-section font-semibold text-ink">{t('stash.section')}</h2>
        <Badge variant="count">{stashes.length}</Badge>
        <button
          type="button"
          data-testid="stash-save"
          disabled={!hasChanges}
          onClick={() => setSaveOpen(true)}
          className="ml-auto flex h-7 items-center rounded-md bg-primary px-3 text-caption font-medium text-on-primary hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
        >
          {t('stash.save')}
        </button>
      </div>

      {stashes.length === 0 ? (
        <p className="mt-eg-2 rounded-lg border border-dashed border-hairline px-eg-3 py-eg-3 text-caption text-ink-tertiary">
          {t('stash.empty')}
        </p>
      ) : (
        <ul
          className="mt-eg-2 overflow-hidden rounded-lg border border-hairline"
          data-testid="stash-list"
        >
          {stashes.map((entry) => (
            <li
              key={`${entry.index}:${entry.oid}`}
              className="flex h-11 items-center gap-eg-3 px-eg-3"
              data-testid="stash-row"
            >
              <span className="shrink-0 rounded-pill bg-surface-3 px-2 py-0.5 text-micro text-ink-muted">
                stash@{`{${entry.index}}`}
              </span>
              <span className="truncate text-secondary text-ink" title={entry.message}>
                {entry.message}
              </span>
              <div className="ml-auto flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  data-testid={`stash-apply-${entry.index}`}
                  onClick={() => void stashApply(entry.index, false)}
                  className="rounded-md px-2 py-1 text-caption text-ink-muted hover:bg-surface-2 hover:text-ink"
                >
                  {t('stash.apply')}
                </button>
                <button
                  type="button"
                  data-testid={`stash-pop-${entry.index}`}
                  onClick={() => void stashApply(entry.index, true)}
                  className="rounded-md px-2 py-1 text-caption text-primary hover:bg-surface-2"
                >
                  {t('stash.pop')}
                </button>
                {!isSsh ? (
                  <button
                    type="button"
                    data-testid={`stash-drop-${entry.index}`}
                    onClick={() => setDropIndex(entry.index)}
                    className="rounded-md px-2 py-1 text-caption text-danger hover:bg-danger-bg"
                  >
                    {t('stash.drop')}
                  </button>
                ) : null}
              </div>
            </li>
          ))}
        </ul>
      )}

      <StashSaveDialog open={saveOpen} onClose={() => setSaveOpen(false)} onSubmit={stashPush} />
      <Dialog
        open={dropIndex !== null}
        title={t('stash.dropTitle')}
        danger
        onClose={() => setDropIndex(null)}
      >
        <p className="text-secondary text-ink-muted">{t('stash.dropDesc')}</p>
        <div className="mt-eg-4 flex justify-end gap-eg-2">
          <button
            type="button"
            onClick={() => setDropIndex(null)}
            className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            data-testid="stash-drop-confirm"
            disabled={isSsh}
            title={isSsh ? t('remote.disabledOnSsh') : undefined}
            className="h-8 rounded-md bg-danger px-3.5 text-secondary font-medium text-on-primary hover:opacity-90 disabled:pointer-events-none disabled:opacity-45"
            onClick={() => {
              if (dropIndex !== null) void stashDrop(dropIndex);
              setDropIndex(null);
            }}
          >
            {t('stash.dropConfirm')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}

function StashSaveDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (message: string | null, includeUntracked: boolean) => Promise<boolean>;
}) {
  const [message, setMessage] = useState('');
  const [includeUntracked, setIncludeUntracked] = useState(true);

  const submit = () => {
    void onSubmit(message.trim() || null, includeUntracked).then((ok) => {
      if (ok) {
        setMessage('');
        onClose();
      }
    });
  };

  return (
    <Dialog open={open} title={t('stash.save')} onClose={onClose}>
      <input
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={t('stash.messagePlaceholder')}
        aria-label={t('stash.messagePlaceholder')}
        data-testid="stash-message-input"
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <label className="mt-eg-2 flex items-center gap-eg-2 text-caption text-ink-muted">
        <input
          type="checkbox"
          checked={includeUntracked}
          onChange={(e) => setIncludeUntracked(e.target.checked)}
          data-testid="stash-include-untracked"
          className="size-3.5 accent-[var(--eg-primary)]"
        />
        {t('stash.includeUntracked')}
      </label>
      <div className="mt-eg-4 flex justify-end gap-eg-2">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
        >
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          data-testid="stash-save-confirm"
          onClick={submit}
          className="h-8 rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary hover:opacity-90"
        >
          {t('stash.save')}
        </button>
      </div>
    </Dialog>
  );
}

function TagSection() {
  const tags = useRefStore((s) => s.tags);
  const createTag = useRefStore((s) => s.createTag);
  const deleteTag = useRefStore((s) => s.deleteTag);
  const [createOpen, setCreateOpen] = useState(false);
  const [deleteName, setDeleteName] = useState<string | null>(null);
  // Remote-host repos disable tag deletion by policy (no trash-bin net).
  const isSshTag = useIsSshActive();

  return (
    <section className="mt-eg-6" data-testid="tag-section">
      <div className="flex items-center gap-eg-2">
        <Tag className="size-4 text-ink-subtle" aria-hidden />
        <h2 className="text-section font-semibold text-ink">{t('tag.section')}</h2>
        <Badge variant="count">{tags.length}</Badge>
        <button
          type="button"
          data-testid="tag-new"
          onClick={() => setCreateOpen(true)}
          className="ml-auto flex h-7 items-center rounded-md bg-primary px-3 text-caption font-medium text-on-primary hover:opacity-90"
        >
          {t('tag.new')}
        </button>
      </div>

      {tags.length === 0 ? (
        <p className="mt-eg-2 rounded-lg border border-dashed border-hairline px-eg-3 py-eg-3 text-caption text-ink-tertiary">
          {t('tag.empty')}
        </p>
      ) : (
        <ul
          className="mt-eg-2 overflow-hidden rounded-lg border border-hairline"
          data-testid="tag-list"
        >
          {tags.map((tag) => (
            <li
              key={tag.name}
              className="flex h-11 items-center gap-eg-3 px-eg-3"
              data-testid="tag-row"
            >
              <Tag className="size-3.5 shrink-0 text-ink-subtle" aria-hidden />
              <span className="font-mono text-secondary text-ink">{tag.name}</span>
              {tag.annotated ? <Badge variant="neutral">{t('tag.annotated')}</Badge> : null}
              {tag.message ? (
                <span className="truncate text-caption text-ink-tertiary" title={tag.message}>
                  {tag.message}
                </span>
              ) : null}
              <span className="ml-auto shrink-0 font-mono text-caption text-ink-tertiary">
                {tag.targetOid.slice(0, 7)}
              </span>
              <span className="shrink-0 text-caption text-ink-tertiary">
                {formatRelativeTime(tag.time ?? 0)}
              </span>
              {!isSshTag ? (
                <button
                  type="button"
                  data-testid={`tag-delete-${tag.name}`}
                  onClick={() => setDeleteName(tag.name)}
                  className="ml-1 shrink-0 rounded-md px-2 py-1 text-caption text-danger hover:bg-danger-bg"
                >
                  {t('branch.delete')}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}

      <TagCreateDialog
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        onSubmit={createTag}
      />
      <Dialog
        open={deleteName !== null}
        title={t('tag.deleteTitle', { name: deleteName ?? '' })}
        danger
        onClose={() => setDeleteName(null)}
      >
        <div className="mt-eg-4 flex justify-end gap-eg-2">
          <button
            type="button"
            onClick={() => setDeleteName(null)}
            className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
          >
            {t('dialog.cancel')}
          </button>
          <button
            type="button"
            data-testid="tag-delete-confirm"
            disabled={isSshTag}
            title={isSshTag ? t('remote.disabledOnSsh') : undefined}
            className="h-8 rounded-md bg-danger px-3.5 text-secondary font-medium text-on-primary hover:opacity-90 disabled:pointer-events-none disabled:opacity-45"
            onClick={() => {
              if (deleteName) void deleteTag(deleteName);
              setDeleteName(null);
            }}
          >
            {t('tag.deleteConfirm')}
          </button>
        </div>
      </Dialog>
    </section>
  );
}

function TagCreateDialog({
  open,
  onClose,
  onSubmit,
}: {
  open: boolean;
  onClose: () => void;
  onSubmit: (name: string, oid: string | null, message: string | null) => Promise<boolean>;
}) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    void onSubmit(trimmed, null, message.trim() || null).then((ok) => {
      if (ok) {
        setName('');
        setMessage('');
        onClose();
      }
    });
  };

  return (
    <Dialog open={open} title={t('tag.new')} onClose={onClose}>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t('tag.namePlaceholder')}
        aria-label={t('tag.namePlaceholder')}
        data-testid="tag-name-input"
        className="h-8 w-full rounded-md border border-hairline-strong bg-surface-2 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <textarea
        value={message}
        onChange={(e) => setMessage(e.target.value)}
        placeholder={t('tag.messagePlaceholder')}
        aria-label={t('tag.messagePlaceholder')}
        data-testid="tag-message-input"
        rows={2}
        className="mt-eg-2 w-full resize-none rounded-md border border-hairline-strong bg-surface-2 px-eg-2 py-1.5 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <div className="mt-eg-3 flex justify-end gap-eg-2">
        <button
          type="button"
          onClick={onClose}
          className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
        >
          {t('dialog.cancel')}
        </button>
        <button
          type="button"
          data-testid="tag-create-confirm"
          onClick={submit}
          className="h-8 rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary hover:opacity-90"
        >
          {t('tag.create')}
        </button>
      </div>
    </Dialog>
  );
}
