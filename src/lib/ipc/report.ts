/**
 * Single funnel from a thrown EgError to the user surface (TDD §6 / PRD §5.12):
 * humanize once, toast with the expandable reason and the suggested action,
 * and mirror the failure into the frontend log line. Stores call this instead
 * of hand-wiring toast.error so every failure surfaces the same way.
 */
import { appLog } from '../logger';
import { toast } from '../../stores/toastStore';
import { humanizeEgError, type EgErrorLike, type HumanizedError } from './errors';
import { dispatchHint } from './hints';

export function reportError(error: unknown, scope: string): HumanizedError {
  const humanized = humanizeEgError((error ?? {}) as EgErrorLike);
  const hint = humanized.hint;
  toast.error(humanized.title, humanized.detail, {
    reason: humanized.reason,
    action: hint ? { label: hint.label, onClick: () => dispatchHint(hint.action) } : undefined,
  });
  appLog.error(
    scope,
    humanized.reason ? `${humanized.title} — ${humanized.reason}` : humanized.title,
  );
  return humanized;
}
