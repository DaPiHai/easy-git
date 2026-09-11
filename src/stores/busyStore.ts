import { create } from 'zustand';
import type { MessageKey } from '../lib/i18n';

/**
 * Global "an operation is running" state for user-initiated git operations.
 * Only write/network commands feed it (see `src/lib/ipc/commands.ts`) — read
 * paths stay silent so the rc.2 decision holds: background fs-watch refreshes
 * must not make anything flicker (docs/easy-git-tdd.md, W10 item ③).
 *
 * A stack rather than a boolean because operations overlap: `begin` hands back
 * its own `end`, which removes exactly that entry, so an early finisher can
 * never clear a still-running operation.
 *
 * The indicator is also time-gated: it only lights up after `SHOW_DELAY_MS` so
 * instant operations (staging, branch switch) do not flash at all, and once
 * lit it stays for at least `MIN_VISIBLE_MS` so a fast tail cannot produce a
 * one-frame blink.
 */
export const SHOW_DELAY_MS = 150;
export const MIN_VISIBLE_MS = 300;

interface BusyEntry {
  id: number;
  label: MessageKey;
}

interface BusyState {
  /** Running operations, oldest first; the newest one owns the label. */
  stack: BusyEntry[];
  /** True once the oldest running operation outlived SHOW_DELAY_MS. */
  visible: boolean;
  /** Label of the most recently started operation, for the bottom-bar hint. */
  label: MessageKey | null;
  /** Marks an operation as running; call the returned `end` exactly once. */
  begin: (label: MessageKey) => () => void;
  /** Drops all state (tests / teardown). */
  reset: () => void;
}

let seq = 0;
let showTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;
let visibleSince = 0;

function cancelShow(): void {
  if (showTimer !== null) {
    clearTimeout(showTimer);
    showTimer = null;
  }
}

export const useBusyStore = create<BusyState>()((set, get) => ({
  stack: [],
  visible: false,
  label: null,

  begin: (label) => {
    const id = ++seq;
    // A new operation during the fade-out keeps the indicator lit.
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    const stack = [...get().stack, { id, label }];
    set({ stack, label });
    if (!get().visible && showTimer === null) {
      showTimer = setTimeout(() => {
        showTimer = null;
        if (get().stack.length > 0) {
          visibleSince = Date.now();
          set({ visible: true });
        }
      }, SHOW_DELAY_MS);
    }

    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const next = get().stack.filter((entry) => entry.id !== id);
      set({ stack: next, label: next.length > 0 ? next[next.length - 1].label : null });
      if (next.length > 0) return;
      // Nothing left: honor the minimum visible time before hiding.
      cancelShow();
      const remaining = Math.max(0, MIN_VISIBLE_MS - (Date.now() - visibleSince));
      if (hideTimer !== null) clearTimeout(hideTimer);
      hideTimer = setTimeout(() => {
        hideTimer = null;
        if (get().stack.length === 0) set({ visible: false });
      }, remaining);
    };
  },

  reset: () => {
    cancelShow();
    if (hideTimer !== null) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
    visibleSince = 0;
    set({ stack: [], visible: false, label: null });
  },
}));
