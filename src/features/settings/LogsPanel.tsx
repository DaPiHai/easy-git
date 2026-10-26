/**
 * In-app log viewer (settings → 日志, TDD §1 file sink). Read-only by design
 * (PRD §1.5: 不做可输入命令的终端): pick a daily file, filter by level, copy,
 * or reveal the folder via the opener plugin. Level filtering matches the
 * subscriber's line format; continuation lines (stack traces) follow their
 * entry line so a filtered ERROR keeps its stack.
 */
import { Copy, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { openPath } from '@tauri-apps/plugin-opener';
import { Select } from '../../components';
import { t, type MessageKey } from '../../lib/i18n';
import {
  formatIpcError,
  logsDir,
  logsList,
  logsRead,
  type LogFileInfo,
} from '../../lib/ipc/commands';
import type { EgErrorLike } from '../../lib/ipc/errors';
import { reportFailure } from '../../lib/ipc/report';
import { toast } from '../../stores/toastStore';

type LevelFilter = 'all' | 'error' | 'warn' | 'info';

const LEVEL_FILTERS: LevelFilter[] = ['all', 'error', 'warn', 'info'];

const LEVEL_LABEL: Record<LevelFilter, MessageKey> = {
  all: 'logs.level.all',
  error: 'logs.level.error',
  warn: 'logs.level.warn',
  info: 'logs.level.info',
};

/** Keeps entry lines matching the level plus their continuation lines. */
export function filterLog(content: string, filter: LevelFilter): string {
  if (filter === 'all') return content;
  const wanted = ` ${filter.toUpperCase()} `;
  const out: string[] = [];
  let keep = false;
  for (const line of content.split('\n')) {
    // tracing's fmt lines start with an ISO timestamp; anything else is a
    // continuation of the entry above it.
    if (/^\d{4}-\d{2}-\d{2}T/.test(line)) {
      keep = line.includes(wanted);
    }
    if (keep) out.push(line);
  }
  return out.join('\n');
}

function formatSize(bytes: number): string {
  return bytes >= 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${bytes} B`;
}

export function LogsPanel() {
  const [dir, setDir] = useState<string | null>(null);
  const [files, setFiles] = useState<LogFileInfo[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [contentFor, setContentFor] = useState<string | null>(null);
  const [content, setContent] = useState('');
  const [truncated, setTruncated] = useState(false);
  const [filter, setFilter] = useState<LevelFilter>('all');
  const [loaded, setLoaded] = useState(false);
  // Refresh re-runs the listing effect by bumping the tick.
  const [loadTick, setLoadTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await logsList();
        if (cancelled) return;
        setFiles(list);
        setSelected((current) => current ?? list[0]?.fileName ?? null);
        setLoaded(true);
      } catch (error) {
        if (cancelled) return;
        setLoaded(true);
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
      }
    })();
    void (async () => {
      const path = await logsDir();
      if (!cancelled) setDir(path);
    })();
    return () => {
      cancelled = true;
    };
  }, [loadTick]);

  useEffect(() => {
    if (!selected) return;
    let cancelled = false;
    logsRead(selected)
      .then((result) => {
        if (cancelled) return;
        setContent(result.content);
        setContentFor(result.fileName);
        setTruncated(result.truncated);
      })
      .catch((error) => {
        if (cancelled) return;
        setContent('');
        setContentFor(selected);
        const humanized = formatIpcError(error as EgErrorLike);
        toast.error(humanized.title, humanized.detail);
      });
    return () => {
      cancelled = true;
    };
  }, [selected]);

  // Stale content from the previous file is hidden while the new one loads.
  const shown = selected && contentFor === selected ? filterLog(content, filter) : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shown);
      toast.success(t('logs.copied'));
    } catch {
      toast.error(t('logs.copyFailed'));
    }
  };

  const openFolder = () => {
    if (!dir) return;
    Promise.resolve(openPath(dir)).catch((error: unknown) => {
      reportFailure('settings.open-log-folder', t('logs.openFailed'), error);
    });
  };

  return (
    <section
      className="mt-eg-5 rounded-xl border border-hairline bg-surface-1 px-eg-5 py-eg-4"
      data-testid="settings-logs"
    >
      <h2 className="text-section font-semibold text-ink">{t('settings.logs')}</h2>
      <p className="mt-0.5 text-caption text-ink-tertiary">{t('settings.logs.desc')}</p>

      <div className="mt-eg-3 flex flex-wrap items-center gap-2">
        <FileText className="size-4 shrink-0 text-ink-tertiary" aria-hidden />
        <Select
          value={selected ?? ''}
          options={
            files.length === 0
              ? [{ value: '', label: t('logs.empty') }]
              : files.map((file) => ({
                  value: file.fileName,
                  label: `${file.fileName}（${formatSize(file.sizeBytes)}）`,
                }))
          }
          onChange={setSelected}
          ariaLabel={t('logs.file')}
          testId="logs-file"
          className="max-w-64"
        />
        <div className="ml-auto flex items-center gap-1.5">
          {LEVEL_FILTERS.map((level) => (
            <button
              key={level}
              type="button"
              data-testid={`logs-level-${level}`}
              onClick={() => setFilter(level)}
              className={`h-7 rounded-md border px-2.5 text-caption transition-colors duration-80 ease-eg ${
                filter === level
                  ? 'border-primary bg-primary text-on-primary'
                  : 'border-hairline-strong text-ink-tertiary hover:text-ink'
              }`}
            >
              {t(LEVEL_LABEL[level])}
            </button>
          ))}
        </div>
      </div>

      <pre
        data-testid="logs-content"
        className="mt-eg-3 max-h-96 overflow-auto rounded-md border border-hairline bg-surface-2 p-eg-2 font-mono text-caption whitespace-pre-wrap break-words text-ink-muted"
      >
        {shown || (loaded ? t('logs.filter.empty') : '')}
      </pre>

      <div className="mt-eg-3 flex flex-wrap items-center gap-2">
        <span className="flex-1 text-caption text-ink-tertiary">
          {truncated ? t('logs.truncated') : ''}
        </span>
        <PanelButton
          icon={<RefreshCw className="size-3.5" aria-hidden />}
          onClick={() => setLoadTick((tick) => tick + 1)}
        >
          {t('logs.refresh')}
        </PanelButton>
        <PanelButton icon={<Copy className="size-3.5" aria-hidden />} onClick={() => void copy()}>
          {t('logs.copy')}
        </PanelButton>
        <PanelButton
          icon={<ExternalLink className="size-3.5" aria-hidden />}
          onClick={openFolder}
          disabled={!dir}
        >
          {t('logs.openFolder')}
        </PanelButton>
      </div>
      {dir ? <p className="mt-eg-2 font-mono text-caption text-ink-tertiary">{dir}</p> : null}
    </section>
  );
}

function PanelButton({
  icon,
  children,
  onClick,
  disabled,
}: {
  icon: React.ReactNode;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex h-8 items-center gap-1.5 rounded-md border border-hairline-strong bg-surface-2 px-2.5 text-secondary text-ink transition-colors duration-80 ease-eg hover:bg-surface-3 disabled:pointer-events-none disabled:opacity-40"
    >
      {icon}
      {children}
    </button>
  );
}
