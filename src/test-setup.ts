import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

// vitest globals are off, so RTL cannot auto-register cleanup itself.
afterEach(cleanup);

// jsdom does not implement matchMedia; the theme store needs it.
// Flip `mockSystemPrefersDark` from tests to simulate the OS setting.
export let mockSystemPrefersDark = false;
export function setSystemPrefersDark(prefersDark: boolean) {
  mockSystemPrefersDark = prefersDark;
}

if (!window.matchMedia) {
  window.matchMedia = ((query: string) => {
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const mediaQuery = {
      get matches() {
        return mockSystemPrefersDark;
      },
      media: query,
      onchange: null,
      addEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeEventListener: (_: 'change', listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      addListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.add(listener);
      },
      removeListener: (listener: (event: MediaQueryListEvent) => void) => {
        listeners.delete(listener);
      },
      dispatchEvent: () => false,
    };
    return mediaQuery as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
}
