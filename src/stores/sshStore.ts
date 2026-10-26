import { create } from 'zustand';
import {
  formatIpcError,
  generateSshKey,
  getSshCredentialsOverview,
  probeSshHostKey,
  readSshPublicKey,
  testGithubSsh,
  trustSshHostKey,
  type EgErrorLike,
  type HumanizedError,
  type SshCredentialsOverview,
  type SshPublicKey,
} from '../lib/ipc/commands';

/** A pending host-key confirmation, resolved by `SshHostKeyDialog`. */
export interface HostKeyPrompt {
  id: number;
  host: string;
  port: number;
  changed: boolean;
  fingerprint: string | null;
  keyType: string | null;
  loading: boolean;
  error: string | null;
  resolve: (trusted: boolean) => void;
}

interface SshState {
  overview: SshCredentialsOverview | null;
  overviewLoading: boolean;
  setupOpen: boolean;
  hostKeyPrompt: HostKeyPrompt | null;
  githubError: HumanizedError | null;
  githubUser: string | null;

  setSetupOpen: (open: boolean) => void;
  refreshOverview: () => Promise<void>;
  /** Shows the confirmation dialog and resolves true only after known_hosts
   *  was written successfully. Concurrent callers share one prompt. */
  requestHostKey: (host: string, port: number, changed: boolean) => Promise<boolean>;
  confirmHostKey: () => Promise<void>;
  cancelHostKey: () => void;
  generateKey: () => Promise<SshPublicKey | null>;
  copyPublicKey: (path: string) => Promise<boolean>;
  testGithub: () => Promise<string | null>;
  clearGithubError: () => void;
}

let nextPromptId = 1;
let pendingPrompt: Promise<boolean> | null = null;

export const useSshStore = create<SshState>()((set, get) => ({
  overview: null,
  overviewLoading: false,
  setupOpen: false,
  hostKeyPrompt: null,
  githubError: null,
  githubUser: null,

  setSetupOpen: (open) => set({ setupOpen: open }),

  refreshOverview: async () => {
    set({ overviewLoading: true });
    try {
      set({ overview: await getSshCredentialsOverview(), overviewLoading: false });
    } catch {
      set({ overviewLoading: false });
    }
  },

  requestHostKey: (host, port, changed) => {
    if (pendingPrompt) return pendingPrompt;
    const id = nextPromptId;
    nextPromptId += 1;
    let resolvePrompt: (trusted: boolean) => void = () => undefined;
    pendingPrompt = new Promise<boolean>((resolve) => {
      resolvePrompt = resolve;
    });
    const prompt: HostKeyPrompt = {
      id,
      host,
      port,
      changed,
      fingerprint: null,
      keyType: null,
      loading: true,
      error: null,
      resolve: (trusted) => {
        pendingPrompt = null;
        resolvePrompt(trusted);
      },
    };
    set({ hostKeyPrompt: prompt });
    // Probe outside the render path: the dialog opens immediately with a
    // loading state and fills the fingerprint when ssh-keyscan answers.
    void probeSshHostKey(host, port).then(
      (info) => {
        const current = get().hostKeyPrompt;
        if (!current || current.id !== id) return;
        set({ hostKeyPrompt: { ...current, ...info, loading: false } });
      },
      (error) => {
        const current = get().hostKeyPrompt;
        if (!current || current.id !== id) return;
        const humanized = formatIpcError(error as EgErrorLike);
        set({
          hostKeyPrompt: {
            ...current,
            loading: false,
            error: humanized.reason ?? humanized.detail,
          },
        });
      },
    );
    return pendingPrompt;
  },

  confirmHostKey: async () => {
    const prompt = get().hostKeyPrompt;
    if (!prompt || !prompt.fingerprint) return;
    set({ hostKeyPrompt: { ...prompt, loading: true, error: null } });
    try {
      await trustSshHostKey(prompt.host, prompt.port, prompt.fingerprint);
      prompt.resolve(true);
      set({ hostKeyPrompt: null });
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      set({
        hostKeyPrompt: {
          ...prompt,
          loading: false,
          error: humanized.reason ?? humanized.detail,
        },
      });
    }
  },

  cancelHostKey: () => {
    const prompt = get().hostKeyPrompt;
    prompt?.resolve(false);
    set({ hostKeyPrompt: null });
  },

  generateKey: async () => {
    try {
      const key = await generateSshKey({ name: 'id_ed25519', comment: 'EasyGit' });
      await get().refreshOverview();
      return key;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      set({ githubError: humanized });
      return null;
    }
  },

  copyPublicKey: async (path) => {
    try {
      const text = await readSshPublicKey(path);
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text.trim());
      } else {
        const area = document.createElement('textarea');
        area.value = text.trim();
        document.body.appendChild(area);
        area.select();
        document.execCommand('copy');
        document.body.removeChild(area);
      }
      return true;
    } catch (error) {
      const humanized = formatIpcError(error as EgErrorLike);
      set({ githubError: humanized });
      return false;
    }
  },

  testGithub: async () => {
    set({ githubError: null, githubUser: null });
    try {
      const username = await withHostKeyTrust(() => testGithubSsh());
      set({ githubUser: username });
      return username;
    } catch (error) {
      set({ githubError: formatIpcError(error as EgErrorLike) });
      return null;
    }
  },

  clearGithubError: () => set({ githubError: null }),
}));

/**
 * Runs an operation; when it fails with `ssh_host_key`, shows the fingerprint
 * dialog and retries exactly once after the user trusts the host. Cancelling
 * rethrows the original error so the caller's normal failure path runs.
 */
export async function withHostKeyTrust<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    const raw = error as EgErrorLike;
    if (raw?.code !== 'ssh_host_key') throw error;
    const host = String(raw.host ?? '');
    const port = Number(raw.port ?? 22);
    const trusted = await useSshStore.getState().requestHostKey(host, port, Boolean(raw.changed));
    if (!trusted) throw error;
    return action();
  }
}

/** Test seam for store tests (drops pending prompt state). */
export function resetSshStoreForTests(): void {
  pendingPrompt = null;
  useSshStore.setState({
    overview: null,
    overviewLoading: false,
    setupOpen: false,
    hostKeyPrompt: null,
    githubError: null,
    githubUser: null,
  });
}
