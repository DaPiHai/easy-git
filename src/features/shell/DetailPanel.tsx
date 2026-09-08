import { PanelRightClose } from 'lucide-react';
import { useRef } from 'react';
import { Badge } from '../../components';
import { t } from '../../lib/i18n';
import { clampDetailWidth, useUiStore, DETAIL_DEFAULT_WIDTH } from '../../stores/uiStore';
import { useRepoStore } from '../../stores/repoStore';
import { KIND_META } from '../changes/kind';

/**
 * Detail panel (UI doc §5.1): 360px default, draggable 280–480, collapsible.
 * Content is context-driven (commit / file diff / wizard) once features land.
 */
export function DetailPanel() {
  const open = useUiStore((s) => s.detailOpen);
  const width = useUiStore((s) => s.detailWidth);
  const setDetailWidth = useUiStore((s) => s.setDetailWidth);
  const toggleDetail = useUiStore((s) => s.toggleDetail);
  const dragState = useRef<{ pointerId: number; startPointerX: number; startWidth: number } | null>(
    null,
  );

  if (!open) return null;

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    dragState.current = {
      pointerId: event.pointerId,
      startPointerX: event.clientX,
      startWidth: useUiStore.getState().detailWidth,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const state = dragState.current;
    if (!state || state.pointerId !== event.pointerId) return;
    // Panel sits on the right edge: dragging left grows it.
    setDetailWidth(clampDetailWidth(state.startWidth + (state.startPointerX - event.clientX)));
  };

  const onPointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (dragState.current?.pointerId === event.pointerId) dragState.current = null;
  };

  return (
    <aside
      data-testid="detail-panel"
      className="relative flex shrink-0 flex-col border-l border-hairline bg-surface-1"
      style={{ width }}
    >
      {/* Drag handle: resize between 280–480px; double-click resets to 360px. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t('detail.title')}
        data-testid="detail-resize-handle"
        className="absolute inset-y-0 left-0 z-10 w-1 cursor-col-resize hover:bg-primary-focus"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onDoubleClick={() => setDetailWidth(DETAIL_DEFAULT_WIDTH)}
      />
      <div className="flex h-10 shrink-0 items-center justify-between px-eg-3">
        <span className="text-section font-semibold text-ink">{t('detail.title')}</span>
        <button
          type="button"
          onClick={toggleDetail}
          className="flex size-6 items-center justify-center rounded-md text-ink-subtle hover:bg-surface-2 hover:text-ink"
          aria-label={t('topbar.detailPanel')}
        >
          <PanelRightClose className="size-4" aria-hidden />
        </button>
      </div>
      <DetailContent />
    </aside>
  );
}

/** Context-driven content (PRD §6.1): selected change now; diff W6, commits W5. */
function DetailContent() {
  const selectedChange = useRepoStore((s) => s.selectedChange);

  if (selectedChange) {
    const meta = KIND_META[selectedChange.kind];
    const Icon = meta.icon;
    return (
      <div
        className="flex min-h-0 flex-1 flex-col overflow-y-auto px-eg-4 py-eg-2"
        data-testid="detail-change"
      >
        <div className="flex items-center gap-eg-2">
          <Icon className={`size-4 ${meta.iconClass}`} aria-hidden />
          <span className="truncate font-mono text-secondary text-ink">{selectedChange.path}</span>
        </div>
        <div className="mt-eg-2 flex items-center gap-eg-2">
          <Badge variant={meta.badgeVariant}>{t(meta.labelKey)}</Badge>
        </div>
        {selectedChange.oldPath ? (
          <div className="mt-eg-2 font-mono text-caption text-ink-tertiary">
            {t('changes.detail.oldPath')}: {selectedChange.oldPath}
          </div>
        ) : null}
        <p className="mt-eg-4 text-caption text-ink-tertiary">{t('changes.detail.note')}</p>
      </div>
    );
  }

  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center px-eg-5 text-center"
      data-testid="detail-empty"
    >
      <div>
        <div className="text-secondary text-ink-subtle">{t('detail.empty.title')}</div>
        <p className="mt-1 max-w-64 text-caption text-ink-tertiary">{t('detail.empty.desc')}</p>
      </div>
    </div>
  );
}
