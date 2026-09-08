import {
  ArrowRightLeft,
  CirclePlus,
  FileQuestion,
  PenLine,
  TriangleAlert,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import type { ChangeKind } from '../../lib/ipc/commands';
import type { BadgeVariant } from '../../components/Badge';
import type { MessageKey } from '../../lib/i18n';

/** UI doc §3.3 semantic colors + §9 icon mapping for change kinds. */
export const KIND_META: Record<
  ChangeKind,
  {
    icon: LucideIcon;
    labelKey: MessageKey;
    iconClass: string;
    badgeVariant: BadgeVariant;
  }
> = {
  added: {
    icon: CirclePlus,
    labelKey: 'changes.kind.added',
    iconClass: 'text-git-added',
    badgeVariant: 'added',
  },
  modified: {
    icon: PenLine,
    labelKey: 'changes.kind.modified',
    iconClass: 'text-git-modified',
    badgeVariant: 'modified',
  },
  deleted: {
    icon: Trash2,
    labelKey: 'changes.kind.deleted',
    iconClass: 'text-git-deleted',
    badgeVariant: 'deleted',
  },
  renamed: {
    icon: ArrowRightLeft,
    labelKey: 'changes.kind.renamed',
    iconClass: 'text-git-renamed',
    badgeVariant: 'renamed',
  },
  conflicted: {
    icon: TriangleAlert,
    labelKey: 'changes.kind.conflicted',
    iconClass: 'text-git-conflict',
    badgeVariant: 'conflict',
  },
  untracked: {
    icon: FileQuestion,
    labelKey: 'changes.kind.untracked',
    iconClass: 'text-git-untracked',
    badgeVariant: 'untracked',
  },
};

/** Splits `src/dir/file.ts` into the subtle dir part and the ink filename. */
export function splitPath(path: string): { dir: string; file: string } {
  const cut = path.lastIndexOf('/');
  return cut === -1
    ? { dir: '', file: path }
    : { dir: path.slice(0, cut + 1), file: path.slice(cut + 1) };
}
