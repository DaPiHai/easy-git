import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { ChevronDown, Folder, FolderGit2, FolderOpen, FolderPlus } from 'lucide-react';
import { openPath } from '@tauri-apps/plugin-opener';
import { t } from '../../lib/i18n';
import { reportFailure } from '../../lib/ipc/report';
import { useRepoStore } from '../../stores/repoStore';

const contentClass =
  'z-50 min-w-56 rounded-lg border border-hairline bg-surface-3 p-1 shadow-[var(--eg-shadow-dialog)]';

const itemClass =
  'flex cursor-pointer select-none items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted outline-none data-[highlighted]:bg-surface-2 data-[highlighted]:text-ink data-[disabled]:pointer-events-none data-[disabled]:opacity-40';

/** canonicalize() 产物可能是 \\?\C:\… 扩展路径；资源管理器更认普通形态。 */
export function displayPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) return `\\\\${path.slice(8)}`;
  if (path.startsWith('\\\\?\\')) return path.slice(4);
  return path;
}

/** 在系统文件管理器中打开仓库文件夹（opener:allow-open-path 权限 + 路径 scope）。 */
export function openRepoFolder(path: string): void {
  void openPath(displayPath(path)).catch((error: unknown) => {
    reportFailure('repo.open-folder', t('toast.openFolderFailed'), error);
  });
}

/** Top-bar repo switcher (PRD §6.1): open repos + open/new entries (F-05). */
export function RepoSwitcher() {
  const repos = useRepoStore((s) => s.repos);
  const activeId = useRepoStore((s) => s.activeId);
  const activate = useRepoStore((s) => s.activate);
  const pickAndOpen = useRepoStore((s) => s.pickAndOpen);
  const pickAndInit = useRepoStore((s) => s.pickAndInit);
  const active = activeId ? repos[activeId] : null;
  const repoList = Object.values(repos);

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger
        asChild
        data-testid="repo-switcher"
        aria-label={active ? active.name : t('topbar.openRepo')}
      >
        <button
          type="button"
          className="flex items-center gap-eg-2 rounded-md px-eg-2 py-1 text-secondary text-ink-muted transition-colors duration-80 ease-eg hover:bg-surface-1 hover:text-ink data-[state=open]:bg-surface-1 data-[state=open]:text-ink"
        >
          <FolderGit2 className="size-4 text-ink-subtle" aria-hidden />
          {active ? (
            <span className="max-w-52 truncate font-medium text-ink">{active.name}</span>
          ) : (
            <span>{t('topbar.openRepo')}</span>
          )}
          {active?.branch ? (
            <span className="font-mono text-caption text-ink-tertiary">{active.branch}</span>
          ) : null}
          <ChevronDown className="size-3.5 text-ink-tertiary" aria-hidden />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content align="start" sideOffset={6} className={contentClass}>
          {repoList.map((repo) => (
            <DropdownMenu.Item
              key={repo.repoId}
              className={itemClass}
              onSelect={() => void activate(repo.repoId)}
            >
              <span className="truncate">{repo.name}</span>
              {repo.repoId === activeId ? (
                <span className="ml-auto rounded-pill bg-primary px-2 py-0.5 text-caption leading-none text-on-primary">
                  {t('sidebar.item.active')}
                </span>
              ) : repo.branch ? (
                <span className="ml-auto font-mono text-caption text-ink-tertiary">
                  {repo.branch}
                </span>
              ) : null}
            </DropdownMenu.Item>
          ))}
          {repoList.length > 0 ? (
            <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
          ) : null}
          {active ? (
            <DropdownMenu.Item
              className={itemClass}
              data-testid="open-folder-item"
              onSelect={() => openRepoFolder(active.path)}
            >
              <Folder className="size-4 text-ink-tertiary" aria-hidden />
              {t('topbar.openFolder')}
            </DropdownMenu.Item>
          ) : null}
          <DropdownMenu.Item className={itemClass} onSelect={() => void pickAndOpen()}>
            <FolderOpen className="size-4 text-ink-tertiary" aria-hidden />
            {t('topbar.openRepo')}
          </DropdownMenu.Item>
          <DropdownMenu.Item className={itemClass} onSelect={() => void pickAndInit()}>
            <FolderPlus className="size-4 text-ink-tertiary" aria-hidden />
            {t('sidebar.newRepo')}
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
