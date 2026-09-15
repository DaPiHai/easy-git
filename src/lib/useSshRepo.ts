import { useRepoStore } from '../stores/repoStore';
import { isSshRepoPath } from './ipc/commands';

/** True when the currently active repository lives on an SSH remote host. */
export function useIsSshActive(): boolean {
  return useRepoStore((s) => (s.activeId ? isSshRepoPath(s.repos[s.activeId]?.path ?? '') : false));
}
