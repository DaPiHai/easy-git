import { beforeEach, describe, expect, it } from 'vitest';
import { useLensStore } from './lensStore';

beforeEach(() => {
  useLensStore.setState({ entries: [] });
});

describe('lensStore (F-13 命令透视)', () => {
  it('records commands in order', () => {
    useLensStore.getState().record('git add -- "a.txt"');
    useLensStore.getState().record('git commit -m "first"');
    expect(useLensStore.getState().entries).toEqual([
      'git add -- "a.txt"',
      'git commit -m "first"',
    ]);
  });

  it('does not duplicate the immediately preceding command', () => {
    useLensStore.getState().record('git status');
    useLensStore.getState().record('git status');
    expect(useLensStore.getState().entries).toEqual(['git status']);
  });

  it('caps the history at 100 entries', () => {
    for (let i = 0; i < 105; i += 1) useLensStore.getState().record(`git cmd-${i}`);
    const entries = useLensStore.getState().entries;
    expect(entries).toHaveLength(100);
    expect(entries[0]).toBe('git cmd-5');
    expect(entries[99]).toBe('git cmd-104');
  });

  it('clears all entries', () => {
    useLensStore.getState().record('git add -- "a.txt"');
    useLensStore.getState().clear();
    expect(useLensStore.getState().entries).toEqual([]);
  });
});
