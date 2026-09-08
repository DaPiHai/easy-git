/**
 * EgError -> human-facing copy (TDD §6).
 *
 * The Rust core serializes `eg_types::EgError` as a flat tagged enum
 * `{ code, ...params }`; the humanized Chinese copy and the suggested next
 * action live here so wording can be iterated without recompiling Rust.
 * Unmapped codes degrade to the generic fallback (plus a log hint).
 */

export type EgErrorCode =
  | 'repo_not_found'
  | 'dirty_worktree'
  | 'network'
  | 'auth'
  | 'conflict_state'
  | 'unsafe_operation'
  | 'not_supported'
  | 'cancelled'
  | 'internal';

export interface EgErrorLike {
  code: EgErrorCode | (string & {});
  [param: string]: unknown;
}

export interface HintAction {
  /** Machine-readable action consumed by the UI, e.g. 'open-conflict-wizard'. */
  action: string;
  /** Button label rendered on the error surface. */
  label: string;
}

export interface HumanizedError {
  title: string;
  detail: string;
  hint?: HintAction;
}

type ErrorTemplate = {
  title: string;
  detail: (params: Record<string, unknown>) => string;
  hint?: HintAction;
};

const templates: Record<EgErrorCode, ErrorTemplate> = {
  repo_not_found: {
    title: '找不到仓库',
    detail: (p) => `路径「${String(p.path ?? '')}」不是一个 Git 仓库`,
    hint: { action: 'open-repo-picker', label: '重新选择仓库' },
  },
  dirty_worktree: {
    title: '工作区有未提交的修改',
    detail: (p) => {
      const paths = Array.isArray(p.paths) ? p.paths.length : 0;
      return paths > 0
        ? `有 ${paths} 个文件未提交，无法安全执行该操作`
        : '有未提交的修改，无法安全执行该操作';
    },
    hint: { action: 'go-changes', label: '先提交或储藏修改' },
  },
  network: {
    title: '网络连接失败',
    detail: (p) =>
      `无法连接 ${String(p.url ?? '远程仓库')}（${String(p.kind ?? 'network')}），请检查网络或代理设置`,
    hint: { action: 'open-settings-network', label: '打开网络设置' },
  },
  auth: {
    title: '身份验证失败',
    detail: (p) => `${String(p.provider ?? '远程平台')} 拒绝了当前凭据，请更新登录信息`,
    hint: { action: 'open-credentials', label: '管理凭据' },
  },
  conflict_state: {
    title: '存在未解决的冲突',
    detail: (p) => `当前处于「${String(p.state ?? 'conflict')}」状态，请先完成冲突解决`,
    hint: { action: 'open-conflict-wizard', label: '打开冲突向导' },
  },
  unsafe_operation: {
    title: '这是一个有风险的操作',
    detail: (p) => `${String(p.confirm_required ?? '该操作')} 可能覆盖历史记录，需要再次确认`,
    hint: { action: 'show-unsafe-confirm', label: '了解风险' },
  },
  not_supported: {
    title: '该功能尚未支持',
    detail: (p) => `${String(p.feature ?? '此功能')} 在当前版本暂不可用`,
  },
  cancelled: {
    title: '操作已取消',
    detail: () => '你或系统取消了正在进行的操作',
  },
  internal: {
    title: '出了点问题',
    detail: (p) => `内部错误${p.context ? `（${String(p.context)}）` : ''}，已记录到日志`,
    hint: { action: 'open-logs', label: '查看日志' },
  },
};

const fallback: ErrorTemplate = {
  title: '出了点问题',
  detail: () => '发生了未知错误，已记录日志',
  hint: { action: 'open-logs', label: '查看日志' },
};

export function humanizeEgError(error: EgErrorLike): HumanizedError {
  const template =
    typeof error.code === 'string' && error.code in templates
      ? templates[error.code as EgErrorCode]
      : fallback;
  const rest: Record<string, unknown> = { ...error };
  delete rest.code;
  return {
    title: template.title,
    detail: template.detail(rest),
    hint: template.hint ? { ...template.hint } : undefined,
  };
}
