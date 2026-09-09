import { useMemo, useState } from 'react';
import { CheckCircle2, Circle, FileWarning } from 'lucide-react';
import { Button, Dialog } from '../../components';
import { t } from '../../lib/i18n';
import type { ConflictFile } from '../../lib/ipc/commands';
import { useMergeStore } from '../../stores/mergeStore';
import { useRepoStore } from '../../stores/repoStore';
import { toast } from '../../stores/toastStore';

/** Per-block decision: preset picks or the manually edited lines. */
interface BlockDecision {
  kind: 'ours' | 'theirs' | 'both' | 'manual';
  lines: string[];
}

type Decisions = Record<string, Record<number, BlockDecision>>;

/** Recomposes the file content from segments + per-block decisions. */
export function composeContent(
  file: ConflictFile,
  decisions: Record<number, BlockDecision>,
): string {
  let out = file.segments[0] ?? '';
  file.blocks.forEach((block, index) => {
    const decision = decisions[index];
    if (decision) {
      const add = (lines: string[]) => {
        if (lines.length > 0) out += lines.join('\n') + '\n';
      };
      if (decision.kind === 'ours') add(block.ours);
      else if (decision.kind === 'theirs') add(block.theirs);
      else if (decision.kind === 'both') {
        add(block.ours);
        add(block.theirs);
      } else add(decision.lines);
    }
    out += file.segments[index + 1] ?? '';
  });
  return out;
}

/** One conflict block card: ours vs theirs snippets + the four decisions. */
function BlockCard({
  block,
  index,
  total,
  decision,
  onDecide,
}: {
  block: { ours: string[]; theirs: string[] };
  index: number;
  total: number;
  decision?: BlockDecision;
  onDecide: (kind: BlockDecision['kind'], lines: string[]) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [manual, setManual] = useState(
    decision?.kind === 'manual' ? decision.lines.join('\n') : '',
  );
  const resolved = decision !== undefined;

  const applyManual = () => {
    if (manual.trim().length === 0 && manual !== '') return;
    onDecide('manual', manual.length === 0 ? [] : manual.split('\n'));
    setEditing(false);
  };

  return (
    <div
      data-testid={`conflict-block-${index}`}
      className={`rounded-md border border-hairline bg-surface-1 p-3 ${
        resolved ? 'opacity-60' : ''
      }`}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-caption text-ink-subtle">
          {t('conflict.block', { n: index + 1, total })}
        </span>
        {resolved && (
          <span className="inline-flex items-center gap-1 text-caption text-git-conflict">
            <CheckCircle2 size={12} /> {t('conflict.blockDone')}
          </span>
        )}
      </div>
      {!editing && (
        <div className="mb-2 grid grid-cols-2 gap-2">
          <pre className="overflow-x-auto rounded bg-danger-bg p-2 font-mono text-caption text-ink">
            {block.ours.join('\n') || ' '}
          </pre>
          <pre className="overflow-x-auto rounded bg-git-conflict-bg p-2 font-mono text-caption text-ink">
            {block.theirs.join('\n') || ' '}
          </pre>
        </div>
      )}
      {editing ? (
        <textarea
          data-testid={`conflict-manual-${index}`}
          className="mb-2 h-24 w-full resize-y rounded border border-hairline-strong bg-canvas p-2 font-mono text-caption text-ink focus:border-primary focus:outline-none"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          spellCheck={false}
        />
      ) : null}
      <div className="flex flex-wrap gap-1.5">
        <Button
          size="sm"
          variant={decision?.kind === 'ours' ? 'primary' : 'secondary'}
          onClick={() => onDecide('ours', block.ours)}
        >
          {t('conflict.useOurs')}
        </Button>
        <Button
          size="sm"
          variant={decision?.kind === 'theirs' ? 'primary' : 'secondary'}
          onClick={() => onDecide('theirs', block.theirs)}
        >
          {t('conflict.useTheirs')}
        </Button>
        <Button
          size="sm"
          variant={decision?.kind === 'both' ? 'primary' : 'secondary'}
          onClick={() => onDecide('both', [...block.ours, ...block.theirs])}
        >
          {t('conflict.keepBoth')}
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setEditing((v) => !v)}>
          {t('conflict.editManually')}
        </Button>
        {editing && (
          <Button size="sm" variant="primary" onClick={applyManual}>
            {t('conflict.applyEdit')}
          </Button>
        )}
      </div>
    </div>
  );
}

/** F-24 冲突解决向导: takes over the main view while a merge is parked. */
export function ConflictWizard() {
  const mergeState = useMergeStore((s) => s.mergeState);
  const conflicts = useMergeStore((s) => s.conflicts);
  const resolved = useMergeStore((s) => s.resolvedPaths)();
  const resolveFile = useMergeStore((s) => s.resolveFile);
  const abortMerge = useMergeStore((s) => s.abortMerge);
  const poll = useMergeStore((s) => s.poll);
  const commit = useRepoStore((s) => s.commit);

  const [currentPath, setCurrentPath] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decisions>({});
  const [abortOpen, setAbortOpen] = useState(false);
  const [finishOpen, setFinishOpen] = useState(false);
  const [subject, setSubject] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const current = conflicts.find((f) => f.path === currentPath) ?? conflicts[0] ?? null;
  const allResolved = conflicts.length === 0 && mergeState !== null;

  const fileDecisions = current ? (decisions[current.path] ?? {}) : {};
  const allBlocksDecided =
    current !== null &&
    (current.isBinary || current.blocks.every((_, i) => fileDecisions[i] !== undefined));
  const resolvedSet = useMemo(() => new Set(resolved), [resolved]);

  const decide = (index: number, kind: BlockDecision['kind'], lines: string[]) => {
    if (!current) return;
    setDecisions((d) => ({
      ...d,
      [current.path]: { ...(d[current.path] ?? {}), [index]: { kind, lines } },
    }));
  };

  const resolveCurrent = async () => {
    if (!current) return;
    const content = current.isBinary
      ? fileDecisions[0]?.kind === 'theirs'
        ? (current.theirsContent ?? '')
        : (current.oursContent ?? '')
      : composeContent(current, fileDecisions);
    const ok = await resolveFile(current.path, content);
    if (!ok) return;
    const next = conflicts.find((f) => f.path !== current.path && !resolvedSet.has(f.path));
    setCurrentPath(next?.path ?? null);
    setDecisions((d) => {
      const rest = { ...d };
      delete rest[current.path];
      return rest;
    });
  };

  const finishMerge = async () => {
    setSubmitting(true);
    try {
      const outcome = await commit({
        subject: subject.trim(),
        body: '',
        amend: false,
        allowPartial: false,
      });
      if (!outcome) return;
      setFinishOpen(false);
      await poll();
      toast.success(t('merge.committed'));
    } finally {
      setSubmitting(false);
    }
  };

  const progress = { done: resolved.length, total: resolved.length + conflicts.length };

  return (
    <div className="flex h-full flex-col overflow-hidden" data-testid="conflict-wizard">
      {/* Top bar: progress + persistent 中止合并 (danger). */}
      <div className="flex items-center justify-between border-b border-hairline bg-surface-1 px-5 py-3">
        <div className="flex items-center gap-3">
          <span className="font-medium text-ink">{t('conflict.wizardTitle')}</span>
          <span className="text-caption text-ink-subtle" data-testid="conflict-progress">
            {t('conflict.progress', { done: progress.done, total: progress.total })}
          </span>
        </div>
        <Button variant="danger" size="sm" onClick={() => setAbortOpen(true)}>
          {t('conflict.abort')}
        </Button>
      </div>

      {allResolved ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8">
          <CheckCircle2 size={40} className="text-git-added" />
          <p className="text-ink">{t('conflict.allResolved')}</p>
          <Button
            variant="primary"
            onClick={() => {
              setSubject(mergeState?.message ?? '');
              setFinishOpen(true);
            }}
          >
            {t('conflict.finishMerge')}
          </Button>
        </div>
      ) : (
        <>
          {/* File chips: resolved vs pending. */}
          <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-5 py-2.5">
            {resolved.map((path) => (
              <span
                key={path}
                className="inline-flex items-center gap-1 rounded border border-hairline bg-surface-2 px-2 py-0.5 text-caption text-ink-subtle line-through"
              >
                <CheckCircle2 size={11} className="text-git-added" /> {path}
              </span>
            ))}
            {conflicts.map((f) => (
              <button
                key={f.path}
                type="button"
                onClick={() => setCurrentPath(f.path)}
                className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-caption ${
                  f.path === current?.path
                    ? 'border-primary bg-surface-2 text-primary'
                    : 'border-hairline bg-surface-1 text-ink hover:bg-surface-2'
                }`}
              >
                {f.isBinary ? <FileWarning size={11} /> : <Circle size={11} />} {f.path}
              </button>
            ))}
          </div>

          {current && (
            <div className="min-h-0 flex-1 overflow-y-auto p-5">
              <h3 className="mb-3 font-mono text-caption text-ink-muted">{current.path}</h3>
              {current.isBinary ? (
                <div className="rounded-md border border-hairline bg-surface-1 p-4">
                  <p className="mb-3 text-caption text-ink-subtle">{t('conflict.binaryDesc')}</p>
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      variant={fileDecisions[0]?.kind === 'ours' ? 'primary' : 'secondary'}
                      onClick={() => decide(0, 'ours', [])}
                    >
                      {t('conflict.useOurs')}
                    </Button>
                    <Button
                      size="sm"
                      variant={fileDecisions[0]?.kind === 'theirs' ? 'primary' : 'secondary'}
                      onClick={() => decide(0, 'theirs', [])}
                    >
                      {t('conflict.useTheirs')}
                    </Button>
                    <Button
                      size="sm"
                      variant="primary"
                      disabled={fileDecisions[0] === undefined}
                      onClick={() => void resolveCurrent()}
                    >
                      {t('conflict.resolveFile')}
                    </Button>
                  </div>
                </div>
              ) : (
                <>
                  {/* 三栏对照: 基础 / 我方 / 对方 (UI §6.8). */}
                  <div className="mb-4 grid grid-cols-3 gap-2">
                    {[
                      { title: t('conflict.colBase'), body: current.baseContent ?? '' },
                      {
                        title: t('conflict.colOurs'),
                        body: current.oursContent ?? '',
                        tone: 'ours' as const,
                      },
                      {
                        title: t('conflict.colTheirs', { name: mergeState?.theirs[0] ?? '' }),
                        body: current.theirsContent ?? '',
                        tone: 'theirs' as const,
                      },
                    ].map((col) => (
                      <div
                        key={col.title}
                        className="rounded-md border border-hairline bg-surface-1"
                      >
                        <div
                          className={`flex items-center gap-1.5 border-b border-hairline px-2.5 py-1.5 text-caption ${
                            col.tone === 'ours'
                              ? 'text-danger'
                              : col.tone === 'theirs'
                                ? 'text-git-conflict'
                                : 'text-ink-subtle'
                          }`}
                        >
                          <span
                            className={`inline-block h-1.5 w-1.5 rounded-full ${col.tone === 'ours' ? 'bg-danger' : col.tone === 'theirs' ? 'bg-git-conflict' : 'bg-ink-subtle'}`}
                          />
                          {col.title}
                        </div>
                        <pre className="max-h-48 overflow-auto p-2.5 font-mono text-caption text-ink">
                          {col.body || ' '}
                        </pre>
                      </div>
                    ))}
                  </div>

                  {/* 逐块决策. */}
                  <div className="flex flex-col gap-2">
                    {current.blocks.map((block, index) => (
                      <BlockCard
                        key={index}
                        block={block}
                        index={index}
                        total={current.blocks.length}
                        decision={fileDecisions[index]}
                        onDecide={(kind, lines) => decide(index, kind, lines)}
                      />
                    ))}
                  </div>

                  <div className="mt-4 flex justify-end">
                    <Button
                      variant="primary"
                      disabled={!allBlocksDecided}
                      onClick={() => void resolveCurrent()}
                    >
                      {t('conflict.resolveFile')}
                    </Button>
                  </div>
                </>
              )}
            </div>
          )}
        </>
      )}

      {/* 中止合并 confirmation (danger op restores the pre-merge state). */}
      <Dialog
        open={abortOpen}
        title={t('conflict.abort')}
        danger
        onClose={() => setAbortOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setAbortOpen(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setAbortOpen(false);
                void abortMerge();
              }}
            >
              {t('conflict.abortConfirm')}
            </Button>
          </>
        }
      >
        <p className="text-caption text-ink-muted">{t('conflict.abortDesc')}</p>
      </Dialog>

      {/* 完成合并: prefilled with the git merge message. */}
      <Dialog
        open={finishOpen}
        title={t('conflict.finishMerge')}
        onClose={() => setFinishOpen(false)}
        actions={
          <>
            <Button variant="secondary" onClick={() => setFinishOpen(false)}>
              {t('dialog.cancel')}
            </Button>
            <Button
              variant="primary"
              disabled={subject.trim().length === 0 || submitting}
              onClick={() => void finishMerge()}
            >
              {t('conflict.finishConfirm')}
            </Button>
          </>
        }
      >
        <input
          data-testid="merge-commit-subject"
          className="mb-2 h-9 w-full rounded border border-hairline-strong bg-canvas px-2.5 text-body text-ink focus:border-primary focus:outline-none"
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          placeholder={t('commit.subject.placeholder')}
        />
        <p className="text-caption text-ink-subtle">{t('conflict.finishDesc')}</p>
      </Dialog>
    </div>
  );
}
