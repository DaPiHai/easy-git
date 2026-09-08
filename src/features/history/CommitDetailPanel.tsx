import { t } from '../../lib/i18n';
import { KIND_META } from '../changes/kind';
import { authorInitial, formatRelativeTime } from '../../lib/time';
import { Badge } from '../../components';
import { useHistoryStore } from '../../stores/historyStore';

/**
 * Commit detail (m1-plan F-16): metadata, refs and the changed-file list.
 * Clicking a file shows the diff placeholder until W6 ships the diff view.
 */
export function CommitDetailPanel() {
  const detail = useHistoryStore((s) => s.detail);
  const detailLoading = useHistoryStore((s) => s.detailLoading);

  if (detailLoading) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center"
        data-testid="commit-detail-loading"
      >
        <span className="text-caption text-ink-tertiary">{t('history.detail.loading')}</span>
      </div>
    );
  }
  if (!detail) {
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center px-eg-5 text-center"
        data-testid="commit-detail-empty"
      >
        <p className="max-w-56 text-caption text-ink-tertiary">{t('history.detail.empty')}</p>
      </div>
    );
  }

  const totalAdded = detail.files.reduce((sum, f) => sum + f.added, 0);
  const totalDeleted = detail.files.reduce((sum, f) => sum + f.deleted, 0);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-eg-4 py-eg-3"
      data-testid="commit-detail"
    >
      <h3 className="text-section font-semibold leading-snug text-ink">{detail.subject}</h3>
      {detail.refs.branches.length + detail.refs.remotes.length + detail.refs.tags.length > 0 ? (
        <div className="mt-eg-2 flex flex-wrap items-center gap-1">
          {detail.refs.branches.map((b) => (
            <Badge key={b} variant="count">
              {b}
            </Badge>
          ))}
          {detail.refs.remotes.map((r) => (
            <Badge key={r} variant="neutral">
              {r}
            </Badge>
          ))}
          {detail.refs.tags.map((tag) => (
            <Badge key={tag} variant="neutral">
              {tag}
            </Badge>
          ))}
        </div>
      ) : null}
      <div className="mt-eg-2 flex items-center gap-eg-2 text-caption text-ink-subtle">
        <span
          className="flex size-4 items-center justify-center rounded-full bg-surface-3 text-micro text-ink-muted"
          aria-hidden
        >
          {authorInitial(detail.authorName)}
        </span>
        <span className="text-ink-muted">{detail.authorName}</span>
        <span>{formatRelativeTime(detail.authorTime ?? 0)}</span>
        <span className="font-mono text-ink-tertiary">{detail.shortOid}</span>
      </div>
      {detail.body ? (
        <p className="mt-eg-2 whitespace-pre-wrap text-secondary text-ink-muted">{detail.body}</p>
      ) : null}

      <div className="mt-eg-4 flex items-center gap-eg-2">
        <span className="text-section font-semibold text-ink">{t('history.detail.files')}</span>
        <Badge variant="count">{detail.files.length}</Badge>
        <span className="ml-auto font-mono text-caption text-ink-tertiary">
          <span className="text-git-added">+{totalAdded}</span>{' '}
          <span className="text-git-deleted">−{totalDeleted}</span>
        </span>
      </div>
      <ul
        className="mt-eg-2 overflow-hidden rounded-lg border border-hairline"
        data-testid="commit-files"
      >
        {detail.files.map((file) => {
          const meta = KIND_META[file.kind];
          const Icon = meta.icon;
          return (
            <li key={`${file.kind}:${file.path}`}>
              <button
                type="button"
                onClick={() => undefined}
                data-testid="commit-file-row"
                title={t('history.detail.diffPlaceholder')}
                className="flex h-9 w-full items-center gap-eg-2 px-eg-3 text-left transition-colors duration-80 ease-eg hover:bg-surface-2"
              >
                <Icon className={`size-4 shrink-0 ${meta.iconClass}`} aria-hidden />
                <span className="truncate font-mono text-mono text-ink" title={file.path}>
                  {file.oldPath ? <span className="text-ink-subtle">{file.oldPath} → </span> : null}
                  {file.path}
                </span>
                <span className="ml-auto shrink-0 pl-eg-2 font-mono text-caption text-ink-tertiary">
                  <span className="text-git-added">+{file.added}</span>{' '}
                  <span className="text-git-deleted">−{file.deleted}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      <p className="mt-eg-3 text-caption text-ink-tertiary">
        {t('history.detail.diffPlaceholder')}
      </p>
    </div>
  );
}
