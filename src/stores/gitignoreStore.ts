import { create } from 'zustand';

/**
 * Pending 通用 .gitignore 提醒 (F-06): repoStore offers the dialog when a
 * freshly opened repository has no `.gitignore`; the dialog in the feature
 * layer consumes the target. Not persisted — each fresh open asks once.
 */
interface GitignorePromptState {
  target: { repoId: string; name: string } | null;
  offer: (repoId: string, name: string) => void;
  close: () => void;
}

export const useGitignorePrompt = create<GitignorePromptState>()((set) => ({
  target: null,
  offer: (repoId, name) => set({ target: { repoId, name } }),
  close: () => set({ target: null }),
}));
