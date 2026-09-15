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
  | 'ssh_not_a_repo'
  | 'repo_ownership'
  | 'dirty_worktree'
  | 'network'
  | 'auth'
  | 'conflict_state'
  | 'unsafe_operation'
  | 'not_supported'
  | 'git_missing'
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
  /**
   * Raw failure reason (git stderr tail, libgit2 message) for the expandable
   * toast detail — the 人话 detail stays separate from the technical cause.
   */
  reason?: string;
  hint?: HintAction;
}

type ErrorTemplate = {
  title: string;
  detail: (params: Record<string, unknown>) => string;
  reason?: (params: Record<string, unknown>) => string | undefined;
  hint?: HintAction | ((params: Record<string, unknown>) => HintAction | undefined);
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value : undefined;

const templates: Record<EgErrorCode, ErrorTemplate> = {
  repo_not_found: {
    title: '找不到仓库',
    detail: (p) => {
      const path = String(p.path ?? '');
      // SSH remotes: name the host + path explicitly and suggest browsing
      // (真机: raw `fatal: not a git repository` confused users about
      // whether the HOST or the PATH was wrong).
      if (path.startsWith('ssh://')) {
        return `远端 ${path} 不是一个 Git 仓库：请检查服务器上的路径是否正确，或用「浏览远端目录」逐级确认`;
      }
      return `路径「${path}」不是一个 Git 仓库`;
    },
    reason: (p) => asString(p.detail),
    hint: { action: 'open-repo-picker', label: '重新选择仓库' },
  },
  ssh_not_a_repo: {
    title: '远端路径不是 Git 仓库',
    detail: (p) => {
      // Mirrors EgError::SshNotARepo in the Rust core. `target` is the
      // structured SshTarget; we surface the URI so the dialog stays
      // copy-pasteable, and let the existence flag switch the call to action.
      const target = (p.target ?? {}) as {
        path?: string;
        user?: string | null;
        host?: string;
        port?: number;
      };
      const port = target.port === 22 || !target.port ? '' : `:${target.port}`;
      const user = target.user ? `${target.user}@` : '';
      const uri = `ssh://${user}${target.host ?? ''}${port}${target.path ?? ''}`;
      if (p.exists) {
        return `远端 ${uri} 是一个普通目录，尚未初始化为 Git 仓库；可在此初始化一个新仓库`;
      }
      return `远端 ${uri} 不存在：请先确认路径拼写，再用「浏览远端目录」逐级定位`;
    },
    reason: (p) => asString(p.detail),
    hint: (p) =>
      p.exists
        ? { action: 'init-ssh-repo', label: '在此初始化仓库' }
        : { action: 'open-repo-picker', label: '重新选择仓库' },
  },
  repo_ownership: {
    title: '无法打开这个文件夹',
    detail: (p) =>
      `「${String(p.path ?? '')}」属于其他用户或系统账户，Git 出于安全默认拒绝访问（git 命令行同样会拒绝）`,
    reason: (p) => asString(p.detail),
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
    detail: (p) => {
      if (String(p.kind ?? '') === 'dns') {
        return `无法解析服务器地址 ${String(p.url ?? '')}，请检查主机名或 IP 是否正确`;
      }
      return `无法连接 ${String(p.url ?? '') || '远程仓库'}（${String(p.kind ?? 'network')}），请检查网络或代理设置`;
    },
    reason: (p) => asString(p.detail),
    hint: { action: 'open-settings-network', label: '打开网络设置' },
  },
  auth: {
    title: '身份验证失败',
    detail: (p) => {
      switch (String(p.provider ?? '')) {
        case 'ssh-host-key':
          return '服务器主机密钥未通过验证：首次连接请在命令行手动连接一次确认指纹；若指纹发生变化，请警惕中间人攻击，先在服务器上核实';
        case 'ssh-key':
          return 'SSH 密钥认证失败：请确认本机 ssh-agent 正在运行且已加载对应私钥，或检查服务器上 ~/.ssh/authorized_keys';
        case 'ssh-passphrase':
          return 'SSH 私钥需要解锁：请先在 ssh-agent 中解锁该密钥（ssh-add），EasyGit 不直接处理私钥口令';
        default:
          return `${String(p.provider ?? '远程平台')} 拒绝了当前凭据，请更新登录信息`;
      }
    },
    reason: (p) => asString(p.detail),
    hint: { action: 'open-credentials', label: '管理凭据' },
  },
  conflict_state: {
    title: '存在未解决的冲突',
    detail: (p) => `当前处于「${String(p.state ?? 'conflict')}」状态，请先完成冲突解决`,
    reason: (p) => asString(p.detail),
    hint: { action: 'open-conflict-wizard', label: '打开冲突向导' },
  },
  unsafe_operation: {
    title: '这是一个有风险的操作',
    detail: (p) => `${String(p.confirm_required ?? '该操作')} 可能覆盖历史记录，需要再次确认`,
    hint: { action: 'show-unsafe-confirm', label: '了解风险' },
  },
  not_supported: {
    title: '该功能尚未支持',
    detail: (p) => {
      const feature = String(p.feature ?? '此功能');
      // Remote-host policy refusals carry their own actionable sentence.
      if (feature.includes('远端仓库')) return feature;
      return `${feature} 在当前版本暂不可用`;
    },
  },
  git_missing: {
    title: '未检测到 Git',
    detail: () =>
      'EasyGit 需要系统安装 Git（2.30 或更高版本）才能完成该操作；安装完成后请重启 EasyGit',
    hint: { action: 'open-git-download', label: '打开 Git 下载页' },
  },
  cancelled: {
    title: '操作已取消',
    detail: () => '你或系统取消了正在进行的操作',
  },
  internal: {
    title: '出了点问题',
    detail: () => '内部错误，已记录到日志',
    reason: (p) => asString(p.context),
    hint: { action: 'open-logs', label: '查看日志' },
  },
};

const fallback: ErrorTemplate = {
  title: '出了点问题',
  detail: () => '发生了未知错误，已记录日志',
  reason: (p) => asString(p.detail) ?? asString(p.context),
  hint: { action: 'open-logs', label: '查看日志' },
};

export function humanizeEgError(error: EgErrorLike): HumanizedError {
  const template =
    typeof error.code === 'string' && error.code in templates
      ? templates[error.code as EgErrorCode]
      : fallback;
  const rest: Record<string, unknown> = { ...error };
  delete rest.code;
  const hint = template.hint
    ? typeof template.hint === 'function'
      ? template.hint(rest)
      : template.hint
    : undefined;
  return {
    title: template.title,
    detail: template.detail(rest),
    reason: template.reason?.(rest),
    hint: hint ? { ...hint } : undefined,
  };
}
