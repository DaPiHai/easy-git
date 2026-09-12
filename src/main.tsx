import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useHistoryStore } from './stores/historyStore';
import { useLensStore } from './stores/lensStore';
import { useRefStore } from './stores/refsStore';
import { useDiffStore } from './stores/diffStore';
import { useRepoStore } from './stores/repoStore';
import { useUiStore } from './stores/uiStore';
import { useToastStore } from './stores/toastStore';
import { useMergeStore } from './stores/mergeStore';
import { useSyncStore } from './stores/syncStore';
import { installGlobalErrorLogging } from './lib/logger';
import './theme/theme.css';

// Uncaught frontend errors share the Rust file sink (TDD §1).
installGlobalErrorLogging();

// Dev-only handle for the snapshot/E2E harness (scripts/snapshot-ui.py).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__eg = {
    repoStore: useRepoStore,
    uiStore: useUiStore,
    toastStore: useToastStore,
    lensStore: useLensStore,
    historyStore: useHistoryStore,
    diffStore: useDiffStore,
    refsStore: useRefStore,
    mergeStore: useMergeStore,
    syncStore: useSyncStore,
  };
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
