/**
 * UI strings, Chinese-first (PRD §6.7 glossary). Structured so i18next can be
 * adopted later without renaming keys; `t()` is the only access path.
 */
export const zhCN = {
  'app.title': 'EasyGit',

  'topbar.openRepo': '打开仓库',
  'topbar.search': '搜索',
  'topbar.detailPanel': '详情面板',

  'tab.changes': '变更',
  'tab.history': '历史',
  'tab.branches': '分支',
  'tab.storage': '储藏',

  'sync.fetch': '获取',
  'sync.pull': '拉取',
  'sync.push': '推送',

  'sidebar.title': '仓库',
  'sidebar.favorites': '收藏',
  'sidebar.recent': '最近',
  'sidebar.newRepo': '新建仓库',
  'sidebar.cloneRepo': '克隆仓库',
  'sidebar.empty.favorites': '暂无收藏仓库',
  'sidebar.empty.recent': '暂无最近打开的仓库',

  'detail.title': '详情',
  'detail.empty.title': '未选中任何内容',
  'detail.empty.desc': '在列表中选择文件、提交或分支后，这里会显示对应的详情',

  'bottom.mode.simple': '简洁模式',
  'bottom.mode.expert': '专家模式',
  'bottom.undo': '撤销',
  'bottom.redo': '重做',
  'bottom.commandLens': '命令透视',
  'bottom.task.none': '暂无后台任务',
  'bottom.ipc.disconnected': 'IPC 未连接（浏览器预览）',

  'changes.title': '变更',
  'changes.empty.title': '打开一个仓库开始',
  'changes.empty.desc': '打开仓库后，这里将显示工作区、暂存区与本地提交的三区状态',
  'changes.empty.action': '打开仓库',

  'history.title': '历史',
  'history.empty.title': '历史图将在这里显示',
  'history.empty.desc': '打开仓库后，这里以 DAG 图展示提交历史，支持搜索与过滤',

  'branches.title': '分支',
  'branches.empty.title': '分支看板将在这里显示',
  'branches.empty.desc': '打开仓库后，这里展示本地与远程分支，支持新建、切换与删除',

  'storage.title': '储藏',
  'storage.empty.title': '储藏 · 标签 · 子模块 · 工作树',
  'storage.empty.desc': '打开仓库后，这里集中管理储藏（stash）、标签、子模块与工作树',

  'theme.system': '跟随系统',
  'theme.light': '亮色',
  'theme.dark': '暗色',
  'theme.toggle': '切换主题',
} as const;

export type MessageKey = keyof typeof zhCN;
