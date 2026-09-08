import { X } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { t } from '../lib/i18n';

export interface DialogProps {
  open: boolean;
  title: string;
  children?: ReactNode;
  /** Footer actions; callers usually place Buttons here. */
  actions?: ReactNode;
  onClose: () => void;
  /** Danger dialogs tint the title (丢弃/清理 confirmations). */
  danger?: boolean;
}

/**
 * In-app dialog (UI doc §5.3 弹窗): overlay + surface-2 card, 12px radius,
 * 24px padding, the one allowed soft shadow. Native alert/confirm are banned.
 */
export function Dialog({ open, title, children, actions, onClose, danger = false }: DialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'var(--eg-overlay)' }}
      onMouseDown={onClose}
      data-testid="dialog-overlay"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-md rounded-xl border border-hairline-strong bg-surface-2 p-eg-5 shadow-[var(--eg-shadow-dialog)]"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="mb-eg-3 flex items-start justify-between gap-eg-3">
          <h2 className={`text-title font-semibold ${danger ? 'text-danger' : 'text-ink'}`}>
            {title}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('dialog.close')}
            className="flex size-6 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-3 hover:text-ink"
          >
            <X className="size-4" aria-hidden />
          </button>
        </div>
        <div className="text-secondary text-ink-muted">{children}</div>
        {actions ? <div className="mt-eg-5 flex justify-end gap-eg-2">{actions}</div> : null}
      </div>
    </div>
  );
}
