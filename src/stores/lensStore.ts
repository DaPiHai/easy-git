import { create } from 'zustand';

const MAX_ENTRIES = 100;

/**
 * Command lens (m1-plan F-13): every store action appends the equivalent git
 * command, so 学习模式的用户 can see what EasyGit did under the hood.
 * Entries are plain command strings, most recent last.
 */
interface LensState {
  entries: string[];
  record: (command: string) => void;
  clear: () => void;
}

export const useLensStore = create<LensState>()((set) => ({
  entries: [],
  record: (command) =>
    set((s) => {
      if (s.entries[s.entries.length - 1] === command) return s;
      const entries = [...s.entries, command];
      return { entries: entries.length > MAX_ENTRIES ? entries.slice(-MAX_ENTRIES) : entries };
    }),
  clear: () => set({ entries: [] }),
}));

/** Best-effort clipboard write with the textarea fallback for old webviews. */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const area = document.createElement('textarea');
      area.value = text;
      area.style.position = 'fixed';
      area.style.opacity = '0';
      document.body.appendChild(area);
      area.select();
      const ok = document.execCommand('copy');
      area.remove();
      return ok;
    } catch {
      return false;
    }
  }
}
