import {
  ChevronRight,
  Clock,
  FolderGit2,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Star,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { t } from '../../lib/i18n';
import { useRepoStore } from '../../stores/repoStore';
import { useUiStore } from '../../stores/uiStore';

/**
 * Repo sidebar (UI doc §5.1): 232px list, collapsible to a 48px icon rail.
 * Favorites + recents give one-click opening (m1-plan F-05).
 */
export function RepoSidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);
  const favorites = useRepoStore((s) => s.favorites);
  const recents = useRepoStore((s) => s.recents);
  const openByPath = useRepoStore((s) => s.openByPath);
  const toggleFavorite = useRepoStore((s) => s.toggleFavorite);
  const pickAndInit = useRepoStore((s) => s.pickAndInit);

  const favoriteRepos = recents.filter((r) => favorites.includes(r.path));

  if (collapsed) {
    return (
      <aside
        data-testid="repo-sidebar"
        className="flex shrink-0 flex-col items-center gap-eg-2 border-r border-hairline bg-surface-1 py-eg-2"
        style={{ width: 'var(--eg-sidebar-rail-w)' }}
      >
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex size-8 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-2 hover:text-ink"
          aria-label={t('sidebar.title')}
          data-testid="sidebar-expand"
        >
          <PanelLeftOpen className="size-4" aria-hidden />
        </button>
        <div className="mt-1 flex flex-col items-center gap-eg-2 text-ink-tertiary">
          {favoriteRepos.slice(0, 3).map((repo) => (
            <button
              key={repo.path}
              type="button"
              title={repo.name}
              onClick={() => void openByPath(repo.path)}
              className="flex size-8 items-center justify-center rounded-md hover:bg-surface-2"
            >
              <FolderGit2 className="size-4" aria-hidden />
            </button>
          ))}
        </div>
      </aside>
    );
  }

  return (
    <aside
      data-testid="repo-sidebar"
      className="flex shrink-0 flex-col border-r border-hairline bg-surface-1 transition-[width] duration-120 ease-eg"
      style={{ width: 'var(--eg-sidebar-w)' }}
    >
      <div className="flex h-10 shrink-0 items-center justify-between px-eg-3">
        <span className="text-section font-semibold text-ink">{t('sidebar.title')}</span>
        <button
          type="button"
          onClick={toggleSidebar}
          className="flex size-6 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-2 hover:text-ink"
          aria-label={t('sidebar.title')}
          data-testid="sidebar-collapse"
        >
          <PanelLeftClose className="size-4" aria-hidden />
        </button>
      </div>

      <div className="flex min-h-0 flex-1 flex-col gap-eg-4 overflow-y-auto px-eg-3 py-eg-2">
        <SidebarSection
          icon={<Star className="size-3.5" aria-hidden />}
          label={t('sidebar.favorites')}
        >
          {favoriteRepos.length > 0 ? (
            favoriteRepos.map((repo) => (
              <RepoItem
                key={repo.path}
                name={repo.name}
                path={repo.path}
                starred
                onOpen={() => void openByPath(repo.path)}
                onToggleStar={() => toggleFavorite(repo.path)}
              />
            ))
          ) : (
            <SectionHint text={t('sidebar.empty.favorites')} />
          )}
        </SidebarSection>

        <SidebarSection
          icon={<Clock className="size-3.5" aria-hidden />}
          label={t('sidebar.recent')}
        >
          {recents.length > 0 ? (
            recents.map((repo) => (
              <RepoItem
                key={repo.path}
                name={repo.name}
                path={repo.path}
                starred={favorites.includes(repo.path)}
                onOpen={() => void openByPath(repo.path)}
                onToggleStar={() => toggleFavorite(repo.path)}
              />
            ))
          ) : (
            <SectionHint text={t('sidebar.empty.recent')} />
          )}
        </SidebarSection>
      </div>

      {/* Repo creation entries; clone arrives with R-04 (TaskHandle progress). */}
      <div className="shrink-0 border-t border-hairline p-eg-2">
        <button
          type="button"
          onClick={() => void pickAndInit()}
          className="flex w-full items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <FolderPlus className="size-4" aria-hidden />
          {t('sidebar.newRepo')}
        </button>
        <button
          type="button"
          data-testid="sidebar-clone"
          onClick={() => useUiStore.getState().setCloneDialogOpen(true)}
          className="flex w-full items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted hover:bg-surface-2 hover:text-ink"
        >
          <FolderGit2 className="size-4" aria-hidden />
          {t('sidebar.cloneRepo')}
        </button>
      </div>
    </aside>
  );
}

function RepoItem({
  name,
  path,
  starred = false,
  onOpen,
  onToggleStar,
}: {
  name: string;
  path: string;
  starred?: boolean;
  onOpen: () => void;
  onToggleStar: () => void;
}) {
  return (
    <div className="group flex items-center rounded-md hover:bg-surface-2">
      <button
        type="button"
        onClick={onOpen}
        title={path}
        className="flex min-w-0 flex-1 items-center gap-eg-2 px-eg-2 py-1.5 text-left"
      >
        <FolderGit2 className="size-3.5 shrink-0 text-ink-tertiary" aria-hidden />
        <span className="truncate text-secondary text-ink-muted">{name}</span>
      </button>
      <button
        type="button"
        onClick={onToggleStar}
        aria-label={t('sidebar.favorites')}
        title={starred ? '取消收藏' : '收藏'}
        data-testid={`star-${name}`}
        className={`mr-1 flex size-6 shrink-0 items-center justify-center rounded-md ${
          starred ? 'text-primary' : 'text-ink-tertiary opacity-0 group-hover:opacity-100'
        } hover:bg-surface-3`}
      >
        <Star className="size-3.5" fill={starred ? 'currentColor' : 'none'} aria-hidden />
      </button>
    </div>
  );
}

function SidebarSection({
  icon,
  label,
  children,
}: {
  icon: ReactNode;
  label: string;
  children: ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-1.5 px-eg-2 text-caption font-medium text-ink-subtle">
        {icon}
        {label}
      </div>
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

function SectionHint({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-1.5 px-eg-2 py-1 text-caption text-ink-tertiary">
      <ChevronRight className="size-3" aria-hidden />
      {text}
    </div>
  );
}
