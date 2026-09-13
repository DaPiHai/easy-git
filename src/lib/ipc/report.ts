/**
 * Single funnel from a thrown EgError to the user surface (TDD §6 / PRD §5.12):
 * humanize once, toast with the expandable reason and the suggested action,
 * and mirror the failure into the frontend log line. Stores call this instead
 * of hand-wiring toast.error so every failure surfaces the same way.
 */
import { appLog, describeError } from '../logger';
import { t } from '../i18n';
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

/**
 * Failures from an integration outside the EgError contract — today the opener
 * plugin handing a folder to the OS file manager (opener 权限/路径 scope 被拒、
 * 路径已不存在等). [reportError] could only flatten these to the generic
 * fallback, so this keeps the caller's own copy while still refusing to swallow
 * the cause: the raw message rides along as the expandable toast reason, the
 * toast offers the log-viewer shortcut, and the line reaches the shared log
 * file (without it the UI showed a fixed sentence and the log stayed empty).
 */
export function reportFailure(scope: string, message: string, error: unknown): void {
  const reason = describeError(error);
  toast.error(message, undefined, {
    reason,
    action: { label: t('logs.view'), onClick: () => dispatchHint('open-logs') },
  });
  appLog.error(scope, `${message} — ${reason}`);
}
