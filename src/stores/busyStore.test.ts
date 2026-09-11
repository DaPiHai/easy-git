import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MIN_VISIBLE_MS, SHOW_DELAY_MS, useBusyStore } from './busyStore';

describe('busyStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useBusyStore.getState().reset();
  });

  afterEach(() => {
    useBusyStore.getState().reset();
    vi.useRealTimers();
  });

  it('never shows for an operation shorter than the delay', () => {
    const end = useBusyStore.getState().begin('busy.stage');
    end();
    vi.advanceTimersByTime(SHOW_DELAY_MS * 4);
    expect(useBusyStore.getState().visible).toBe(false);
  });

  it('shows after the delay and respects the minimum visible time', () => {
    const end = useBusyStore.getState().begin('busy.fetch');
    expect(useBusyStore.getState().visible).toBe(false);
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(useBusyStore.getState().visible).toBe(true);

    end();
    vi.advanceTimersByTime(MIN_VISIBLE_MS - 1);
    expect(useBusyStore.getState().visible).toBe(true);
    vi.advanceTimersByTime(1);
    expect(useBusyStore.getState().visible).toBe(false);
  });

  it('stays lit until every overlapping operation ends', () => {
    const endA = useBusyStore.getState().begin('busy.fetch');
    const endB = useBusyStore.getState().begin('busy.commit');
    vi.advanceTimersByTime(SHOW_DELAY_MS);
    expect(useBusyStore.getState().visible).toBe(true);
    expect(useBusyStore.getState().label).toBe('busy.commit');

    endA();
    expect(useBusyStore.getState().visible).toBe(true);

    endB();
    vi.advanceTimersByTime(MIN_VISIBLE_MS);
    expect(useBusyStore.getState().visible).toBe(false);
    expect(useBusyStore.getState().label).toBeNull();
  });

  it('removes the exact entry when finishers arrive out of order', () => {
    const endA = useBusyStore.getState().begin('busy.fetch');
    const endB = useBusyStore.getState().begin('busy.commit');

    endB();
    expect(useBusyStore.getState().stack).toHaveLength(1);
    expect(useBusyStore.getState().label).toBe('busy.fetch');

    endA();
    expect(useBusyStore.getState().stack).toHaveLength(0);
  });

  it('ends idempotently without clearing a newer operation', () => {
    const stale = useBusyStore.getState().begin('busy.fetch');
    stale();
    stale();

    const current = useBusyStore.getState().begin('busy.push');
    stale();
    expect(useBusyStore.getState().stack).toHaveLength(1);
    expect(useBusyStore.getState().label).toBe('busy.push');
    current();
    expect(useBusyStore.getState().stack).toHaveLength(0);
  });
});
