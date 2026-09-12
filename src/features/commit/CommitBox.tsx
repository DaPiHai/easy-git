import { AlertTriangle, GitCommitHorizontal, Loader2, UserRoundX } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Checkbox } from '../../components';
import { t } from '../../lib/i18n';
import { reportError } from '../../lib/ipc/report';
import type { EgErrorLike } from '../../lib/ipc/errors';
import { useLensStore } from '../../stores/lensStore';
import { useMergeStore } from '../../stores/mergeStore';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';
import { toast } from '../../stores/toastStore';

/**
 * Commit box (m1-plan F-12): subject + optional body + amend, Ctrl+Enter to
 * submit. Guards live in the backend; `unsafe_operation` (partial staging)
 * surfaces the confirm dialog and resubmits with allow_partial.
 */
export function CommitBox() {
  const status = useRepoStore((s) => s.status);
  const commit = useRepoStore((s) => s.commit);
  const configGet = useRepoStore((s) => s.configGet);
  const setView = useUiStore((s) => s.setView);
  const lensCount = useLensStore((s) => s.entries.length);

  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [amend, setAmend] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [identityMissing, setIdentityMissing] = useState(false);
  const [partialFiles, setPartialFiles] = useState<string[] | null>(null);
  const subjectRef = useRef<HTMLInputElement>(null);

  // F-26: finalizing a parked merge prefills the git merge message. Adjusted
  // during render (React's state-from-props pattern), not in an effect.
  const mergeState = useMergeStore((s) => s.mergeState);
  const [prefilledMerge, setPrefilledMerge] = useState(false);
  if (mergeState && !prefilledMerge) {
    setPrefilledMerge(true);
    setSubject(mergeState.message ?? '');
  }
  if (!mergeState && prefilledMerge) {
    setPrefilledMerge(false);
  }

  // Effective identity (repo-local falls back to global inside git2).
  useEffect(() => {
    let alive = true;
    void Promise.all([configGet('repo', 'user.name'), configGet('repo', 'user.email')]).then(
      ([name, email]) => {
        if (alive) setIdentityMissing(!name || !email);
      },
    );
    return () => {
      alive = false;
    };
  }, [configGet, lensCount]);

  const stagedCount = status?.staged.length ?? 0;
  const canSubmit = subject.trim().length > 0 && !submitting && (amend || stagedCount > 0);

  const submit = (allowPartial: boolean) => {
    if (!canSubmit && !allowPartial) return;
    setSubmitting(true);
    void commit({
      subject: subject.trim(),
      body: body.trim(),
      amend,
      allowPartial: allowPartial,
    })
      .then((outcome) => {
        if (!outcome) return;
        setSubject('');
        setBody('');
        setPartialFiles(null);
        toast.success(
          outcome.amended
            ? t('toast.amended')
            : t('toast.committed', { id: outcome.commitId.slice(0, 7) }),
        );
      })
      .catch((error: EgErrorLike) => {
        if (error.code === 'unsafe_operation') {
          setPartialFiles(
            String(error.confirm_required ?? '')
              .replace(/^部分暂存：/, '')
              .split('、'),
          );
          return;
        }
        reportError(error, 'commit');
      })
      .finally(() => setSubmitting(false));
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
      event.preventDefault();
      submit(false);
    }
  };

  return (
    <div
      className="flex min-h-0 flex-1 flex-col overflow-y-auto px-eg-4 py-eg-3"
      data-testid="commit-box"
    >
      <div className="flex items-center gap-eg-2">
        <GitCommitHorizontal className="size-4 text-ink-subtle" aria-hidden />
        <span className="text-section font-semibold text-ink">{t('commit.title')}</span>
      </div>

      {identityMissing ? (
        <div
          className="mt-eg-3 flex items-start gap-eg-2 rounded-lg border border-hairline-strong bg-git-conflict-bg px-eg-3 py-eg-2"
          data-testid="identity-warning"
        >
          <UserRoundX className="mt-0.5 size-4 shrink-0 text-git-conflict" aria-hidden />
          <div className="text-caption text-ink-muted">
            <p>{t('commit.identity.missing')}</p>
            <button
              type="button"
              data-testid="goto-settings"
              className="mt-1 font-medium text-git-conflict underline underline-offset-2 hover:opacity-80"
              onClick={() => setView('settings')}
            >
              {t('commit.identity.goto')}
            </button>
          </div>
        </div>
      ) : null}

      <input
        ref={subjectRef}
        value={subject}
        onChange={(e) => setSubject(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('commit.subject.placeholder')}
        aria-label={t('commit.subject.placeholder')}
        data-testid="commit-subject"
        disabled={mergeState !== null ? true : undefined}
        title={mergeState ? t('conflict.finishDesc') : undefined}
        className="mt-eg-3 h-8 w-full rounded-md border border-hairline-strong bg-surface-1 px-eg-2 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={t('commit.body.placeholder')}
        aria-label={t('commit.body.placeholder')}
        data-testid="commit-body"
        rows={4}
        className="mt-eg-2 w-full resize-none rounded-md border border-hairline-strong bg-surface-1 px-eg-2 py-1.5 text-secondary text-ink outline-none placeholder:text-ink-tertiary focus:border-primary"
      />

      <label className="mt-eg-2 flex cursor-default items-center gap-eg-2 text-caption text-ink-muted">
        <Checkbox
          checked={amend}
          onChange={setAmend}
          ariaLabel={t('commit.amend')}
          testId="commit-amend"
        />
        {t('commit.amend')}
      </label>

      {!amend && stagedCount === 0 ? (
        <p className="mt-eg-2 text-caption text-ink-tertiary" data-testid="nothing-staged">
          {t('commit.nothingStaged')}
        </p>
      ) : null}

      <button
        type="button"
        data-testid="commit-submit"
        disabled={!canSubmit}
        onClick={() => submit(false)}
        className="mt-eg-3 flex h-8 shrink-0 items-center justify-center gap-1.5 rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary transition-opacity duration-80 ease-eg hover:opacity-90 disabled:pointer-events-none disabled:opacity-40"
      >
        {submitting ? <Loader2 className="size-3.5 shrink-0 animate-spin" aria-hidden /> : null}
        {submitting
          ? t('commit.submitting')
          : amend
            ? t('commit.amend.submit')
            : t('commit.submit')}
      </button>

      {/* Partial-staging confirmation (R-07): only the staged part would land. */}
      {partialFiles ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: 'var(--eg-overlay)' }}
          onMouseDown={() => setPartialFiles(null)}
          data-testid="partial-dialog-overlay"
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('commit.partial.title')}
            className="w-full max-w-md rounded-xl border border-hairline-strong bg-surface-2 p-eg-5 shadow-[var(--eg-shadow-dialog)]"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-start gap-eg-2">
              <AlertTriangle className="mt-0.5 size-5 shrink-0 text-git-conflict" aria-hidden />
              <div>
                <h2 className="text-title font-semibold text-ink">{t('commit.partial.title')}</h2>
                <p className="mt-1 text-secondary text-ink-muted">{t('commit.partial.desc')}</p>
              </div>
            </div>
            <ul className="mt-eg-3 max-h-48 overflow-y-auto font-mono text-caption text-ink">
              {partialFiles.map((path) => (
                <li key={path}>{path}</li>
              ))}
            </ul>
            <div className="mt-eg-5 flex justify-end gap-eg-2">
              <button
                type="button"
                onClick={() => setPartialFiles(null)}
                className="h-8 rounded-md border border-hairline bg-surface-1 px-3.5 text-secondary font-medium text-ink hover:bg-surface-2"
              >
                {t('dialog.cancel')}
              </button>
              <button
                type="button"
                data-testid="partial-confirm"
                className="h-8 rounded-md bg-primary px-3.5 text-secondary font-medium text-on-primary hover:opacity-90"
                onClick={() => {
                  setPartialFiles(null);
                  submit(true);
                }}
              >
                {t('commit.partial.confirm')}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
