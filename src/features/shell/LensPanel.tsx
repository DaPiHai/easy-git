import { ChevronDown, ChevronsRight, Copy, Eraser, TerminalSquare } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { t } from '../../lib/i18n';
import { copyText, useLensStore } from '../../stores/lensStore';
import { toast } from '../../stores/toastStore';

/**
 * Command lens panel (m1-plan F-13): opens upward from the bottom bar and
 * lists the git command each action maps to, with copy/clear.
 */
export function LensPanel() {
  const entries = useLensStore((s) => s.entries);
  const clear = useLensStore((s) => s.clear);
  const [open, setOpen] = useState(false);
  const [justCopied, setJustCopied] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  // Dismiss on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!panelRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    window.addEventListener('mousedown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  const copyAll = () => {
    void copyText(entries.join('\n')).then((ok) => {
      if (!ok) return;
      setJustCopied(true);
      toast.success(t('lens.copied'));
      window.setTimeout(() => setJustCopied(false), 1500);
    });
  };

  return (
    <div className="relative" ref={panelRef}>
      <button
        type="button"
        data-testid="command-lens"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1 rounded-md px-1.5 py-0.5 hover:bg-surface-2 hover:text-ink"
      >
        <TerminalSquare className="size-3.5" aria-hidden />
        {t('bottom.commandLens')}
        {entries.length > 0 ? (
          <span
            className="rounded-pill bg-surface-3 px-1.5 text-micro text-ink-muted"
            data-testid="lens-count"
          >
            {entries.length}
          </span>
        ) : null}
        {open ? (
          <ChevronDown className="size-3" aria-hidden />
        ) : (
          <ChevronsRight className="size-3" aria-hidden />
        )}
      </button>

      {open ? (
        <div
          data-testid="lens-panel"
          className="absolute bottom-6 left-0 z-40 w-[420px] overflow-hidden rounded-lg border border-hairline bg-surface-2 shadow-[var(--eg-shadow-dialog)]"
        >
          <div className="flex items-center gap-eg-2 border-b border-hairline px-eg-3 py-1.5">
            <span className="text-caption font-semibold text-ink">{t('lens.title')}</span>
            <span className="text-micro text-ink-tertiary">{t('lens.desc')}</span>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                data-testid="lens-copy"
                disabled={entries.length === 0}
                onClick={copyAll}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-ink-subtle hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <Copy className="size-3" aria-hidden />
                {justCopied ? t('lens.copied') : t('lens.copy')}
              </button>
              <button
                type="button"
                data-testid="lens-clear"
                disabled={entries.length === 0}
                onClick={clear}
                aria-label={t('lens.clear')}
                className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-micro text-ink-subtle hover:bg-surface-3 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
              >
                <Eraser className="size-3" aria-hidden />
                {t('lens.clear')}
              </button>
            </div>
          </div>
          <div className="max-h-56 overflow-y-auto px-eg-3 py-eg-2">
            {entries.length === 0 ? (
              <p className="py-eg-3 text-center text-caption text-ink-tertiary">
                {t('lens.empty')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1" data-testid="lens-list">
                {entries.map((entry, index) => (
                  <li
                    key={`${index}:${entry}`}
                    className="break-all rounded-md bg-surface-1 px-eg-2 py-1 font-mono text-mono text-ink"
                  >
                    <span className="mr-1.5 select-none text-ink-tertiary">$</span>
                    {entry}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
