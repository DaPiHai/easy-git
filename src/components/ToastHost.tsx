import { AlertTriangle, CheckCircle2, Info, X } from 'lucide-react';
import { useToastStore, type ToastItem, type ToastKind } from '../stores/toastStore';

const kindIcon: Record<ToastKind, typeof Info> = {
  success: CheckCircle2,
  error: AlertTriangle,
  info: Info,
};

const kindClass: Record<ToastKind, string> = {
  success: 'text-success',
  error: 'text-git-deleted',
  info: 'text-primary',
};

/** Bottom-right toast stack (UI doc §6.11): auto-dismiss, optional action. */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  const dismiss = useToastStore((s) => s.dismiss);
  if (toasts.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-10 right-4 z-50 flex flex-col items-end gap-2">
      {toasts.map((item) => (
        <Toast key={item.id} item={item} onDismiss={() => dismiss(item.id)} />
      ))}
    </div>
  );
}

function Toast({ item, onDismiss }: { item: ToastItem; onDismiss: () => void }) {
  const Icon = kindIcon[item.kind];
  return (
    <div
      role="status"
      data-testid="toast"
      className="pointer-events-auto flex max-w-sm items-start gap-2 rounded-lg border border-hairline-strong bg-surface-3 px-eg-3 py-eg-2 shadow-[var(--eg-shadow-dialog)]"
    >
      <Icon className={`mt-0.5 size-4 shrink-0 ${kindClass[item.kind]}`} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="text-secondary text-ink">{item.message}</div>
        {item.detail ? (
          <div className="truncate font-mono text-caption text-ink-tertiary" title={item.detail}>
            {item.detail}
          </div>
        ) : null}
      </div>
      {item.action ? (
        <button
          type="button"
          onClick={() => {
            item.action?.onClick();
            onDismiss();
          }}
          className="shrink-0 rounded-md px-2 py-0.5 text-secondary font-medium text-primary hover:bg-surface-2"
        >
          {item.action.label}
        </button>
      ) : null}
      <button
        type="button"
        onClick={onDismiss}
        aria-label="关闭"
        className="flex size-5 shrink-0 items-center justify-center rounded-md text-ink-tertiary hover:bg-surface-2 hover:text-ink"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
