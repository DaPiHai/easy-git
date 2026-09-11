import { t } from '../lib/i18n';

export interface LoadingBarProps {
  /** Accessible name for the bar; defaults to the generic waiting label. */
  label?: string;
  /** Positioning comes from the caller; the bar itself is absolute to its container. */
  className?: string;
}

/**
 * 2px indeterminate progress bar (UI doc §6.11 / §6.8) over the view it belongs
 * to. Used by the changes/history first-load states and, once, globally by the
 * AppShell while a user-initiated git operation runs.
 */
export function LoadingBar({ label, className = '' }: LoadingBarProps) {
  return (
    <div
      className={`absolute inset-x-0 top-0 h-0.5 overflow-hidden ${className}`}
      role="progressbar"
      aria-label={label ?? t('busy.generic')}
      data-testid="loading-bar"
    >
      <div className="h-full w-1/3 animate-pulse rounded-full bg-primary" />
    </div>
  );
}
