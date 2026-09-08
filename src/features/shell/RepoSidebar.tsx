import {
  ChevronRight,
  Clock,
  FolderGit2,
  FolderPlus,
  PanelLeftClose,
  PanelLeftOpen,
  Star,
} from 'lucide-react';
import { t } from '../../lib/i18n';
import { useUiStore } from '../../stores/uiStore';

/**
 * Repo sidebar (UI doc §5.1): 232px list, collapsible to a 48px icon rail.
 * Repo data arrives in W2 (F-05); sections render honest empty states meanwhile.
 */
export function RepoSidebar() {
  const collapsed = useUiStore((s) => s.sidebarCollapsed);
  const toggleSidebar = useUiStore((s) => s.toggleSidebar);

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
          <Star className="size-4" aria-hidden />
          <Clock className="size-4" aria-hidden />
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
          {t('sidebar.empty.favorites')}
        </SidebarSection>
        <SidebarSection
          icon={<Clock className="size-3.5" aria-hidden />}
          label={t('sidebar.recent')}
        >
          {t('sidebar.empty.recent')}
        </SidebarSection>
      </div>

      {/* Repo creation entries — functional in W2 (F-06). */}
      <div className="shrink-0 border-t border-hairline p-eg-2">
        <button
          type="button"
          disabled
          className="flex w-full items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
        >
          <FolderPlus className="size-4" aria-hidden />
          {t('sidebar.newRepo')}
        </button>
        <button
          type="button"
          disabled
          className="flex w-full items-center gap-eg-2 rounded-md px-eg-2 py-1.5 text-secondary text-ink-muted hover:bg-surface-2 disabled:pointer-events-none disabled:opacity-40"
        >
          <FolderGit2 className="size-4" aria-hidden />
          {t('sidebar.cloneRepo')}
        </button>
      </div>
    </aside>
  );
}

function SidebarSection({
  icon,
  label,
  children,
}: {
  icon: React.ReactNode;
  label: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-1 flex items-center gap-1.5 px-eg-2 text-caption font-medium text-ink-subtle">
        {icon}
        {label}
      </div>
      <div className="flex items-center gap-1.5 px-eg-2 py-1 text-caption text-ink-tertiary">
        <ChevronRight className="size-3" aria-hidden />
        {children}
      </div>
    </section>
  );
}
