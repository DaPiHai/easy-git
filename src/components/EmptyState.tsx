import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  /** Optional call-to-action rendered under the description. */
  action?: ReactNode;
}

/** UI doc §6.11: centered illustration area + ink-subtle copy + guidance button. */
export function EmptyState({ icon: Icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="flex size-12 items-center justify-center rounded-lg bg-surface-2">
        <Icon className="size-5 text-ink-subtle" aria-hidden />
      </div>
      <div className="text-section font-semibold text-ink">{title}</div>
      {description ? (
        <p className="max-w-72 text-secondary text-ink-subtle">{description}</p>
      ) : null}
      {action}
    </div>
  );
}
