import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { useHistoryStore } from './stores/historyStore';
import { useLensStore } from './stores/lensStore';
import { useRepoStore } from './stores/repoStore';
import { useUiStore } from './stores/uiStore';
import { useToastStore } from './stores/toastStore';
import './theme/theme.css';

// Dev-only handle for the snapshot/E2E harness (scripts/snapshot-ui.py).
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__eg = {
    repoStore: useRepoStore,
    uiStore: useUiStore,
    toastStore: useToastStore,
    lensStore: useLensStore,
    historyStore: useHistoryStore,
  };
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
