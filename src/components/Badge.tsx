import type { ReactNode } from 'react';

export type BadgeVariant =
  'neutral' | 'count' | 'added' | 'modified' | 'deleted' | 'renamed' | 'conflict' | 'untracked';

const semanticClasses: Partial<Record<BadgeVariant, string>> = {
  added: 'text-git-added bg-git-added-bg',
  modified: 'text-git-modified bg-git-modified-bg',
  deleted: 'text-git-deleted bg-git-deleted-bg',
  renamed: 'text-git-renamed bg-git-renamed-bg',
  conflict: 'text-git-conflict bg-git-conflict-bg',
  untracked: 'text-git-untracked bg-git-untracked-bg',
};

export interface BadgeProps {
  /** 'count' renders the primary-filled counter badge; semantic variants tint text + 10% bg. */
  variant?: BadgeVariant;
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = 'neutral', children, className = '' }: BadgeProps) {
  const classes =
    variant === 'neutral'
      ? 'bg-surface-2 text-ink-muted'
      : variant === 'count'
        ? 'bg-primary text-on-primary'
        : semanticClasses[variant];
  return (
    <span
      className={`inline-flex items-center rounded-pill px-2 py-0.5 text-caption leading-none ${classes} ${className}`}
    >
      {children}
    </span>
  );
}
