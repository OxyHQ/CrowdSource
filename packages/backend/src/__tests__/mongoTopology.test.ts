import type { Connection } from 'mongoose';
import { describe, expect, it, vi } from 'vitest';

import { assertTransactionalTopology, supportsTransactions } from '../utils/mongoTopology';

/** A connection whose `hello` command answers with the given description. */
function connectionAnswering(hello: Record<string, unknown>): Connection {
  return {
    db: { admin: () => ({ command: vi.fn().mockResolvedValue(hello) }) },
  } as unknown as Connection;
}

describe('supportsTransactions', () => {
  it('accepts a replica set', () => {
    expect(supportsTransactions({ setName: 'rs0' })).toBe(true);
  });

  it('accepts a sharded cluster', () => {
    expect(supportsTransactions({ msg: 'isdbgrid' })).toBe(true);
  });

  it('rejects a standalone deployment', () => {
    expect(supportsTransactions({})).toBe(false);
  });

  it('rejects an empty replica set name rather than treating it as present', () => {
    expect(supportsTransactions({ setName: '' })).toBe(false);
  });
});

describe('assertTransactionalTopology', () => {
  it('passes on a replica set', async () => {
    await expect(
      assertTransactionalTopology(connectionAnswering({ setName: 'rs0' })),
    ).resolves.toBeUndefined();
  });

  it('refuses a standalone deployment and says how to check', async () => {
    await expect(assertTransactionalTopology(connectionAnswering({}))).rejects.toThrow(
      /standalone deployment.*rs\.status/s,
    );
  });

  it('refuses to guess before a connection is open', async () => {
    await expect(
      assertTransactionalTopology({ db: undefined } as unknown as Connection),
    ).rejects.toThrow(/before a connection is open/);
  });
});
