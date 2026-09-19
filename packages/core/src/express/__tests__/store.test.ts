import { afterEach, describe, expect, it, vi } from 'vitest';

import { memoryProcessedEventStore } from '../store.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('memoryProcessedEventStore', () => {
  it('lets the first caller claim an event and refuses the second', () => {
    const store = memoryProcessedEventStore();

    expect(store.claim('evt_1')).toBe(true);
    expect(store.claim('evt_1')).toBe(false);
  });

  it('releases a claim so a failed handler can be retried', () => {
    const store = memoryProcessedEventStore();

    store.claim('evt_1');
    store.release('evt_1');

    expect(store.claim('evt_1')).toBe(true);
  });

  it('forgets a claim once its ttl has passed', () => {
    vi.useFakeTimers();
    const store = memoryProcessedEventStore({ ttlMs: 1_000 });

    expect(store.claim('evt_1')).toBe(true);
    vi.advanceTimersByTime(999);
    expect(store.claim('evt_1')).toBe(false);
    vi.advanceTimersByTime(2);
    expect(store.claim('evt_1')).toBe(true);
  });

  it('drops the oldest claims rather than growing without bound', () => {
    const store = memoryProcessedEventStore({ maxEntries: 3 });

    expect(store.claim('evt_1')).toBe(true);
    expect(store.claim('evt_2')).toBe(true);
    expect(store.claim('evt_3')).toBe(true);
    expect(store.claim('evt_4')).toBe(true);

    // `evt_1` was evicted to make room, so it is claimable again — a bounded
    // store trades a very old duplicate for never exhausting memory, and the
    // §10.9 retry window is what makes that trade safe.
    expect(store.claim('evt_1')).toBe(true);
    expect(store.claim('evt_4')).toBe(false);
  });

  /**
   * A library that schedules its own interval keeps a consumer's process alive.
   * Expiry here is evaluated on read and pruned on insert precisely so there is
   * no timer to leak; this asserts that nothing was quietly added.
   */
  it('schedules no timer of its own', () => {
    vi.useFakeTimers();
    const store = memoryProcessedEventStore();

    store.claim('evt_1');
    store.release('evt_1');

    expect(vi.getTimerCount()).toBe(0);
  });
});
