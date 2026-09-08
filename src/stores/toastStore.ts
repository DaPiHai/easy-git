import { create } from 'zustand';

export type ToastKind = 'success' | 'error' | 'info';

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
  detail?: string;
  action?: ToastAction;
  /** Auto-dismiss delay in ms; undo toasts live a little longer. */
  duration: number;
}

interface ToastState {
  toasts: ToastItem[];
  push: (toast: Omit<ToastItem, 'id' | 'duration'> & { duration?: number }) => number;
  dismiss: (id: number) => void;
}

let nextId = 1;

export const useToastStore = create<ToastState>()((set, get) => ({
  toasts: [],
  push: (toast) => {
    const id = nextId++;
    const item: ToastItem = { id, duration: 4000, ...toast };
    set((s) => ({ toasts: [...s.toasts, item] }));
    window.setTimeout(() => get().dismiss(id), item.duration);
    return id;
  },
  dismiss: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
}));

/** Convenience one-liners used across features. */
export const toast = {
  success: (message: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'success', message, detail }),
  error: (message: string, detail?: string) =>
    useToastStore.getState().push({ kind: 'error', message, detail }),
  info: (message: string, action?: ToastAction, duration = 8000) =>
    useToastStore.getState().push({ kind: 'info', message, action, duration }),
};
