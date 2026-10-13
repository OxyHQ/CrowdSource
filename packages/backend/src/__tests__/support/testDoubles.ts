/**
 * The vitest helpers `bun:test` has no equivalent for, kept to vitest's
 * semantics so the suites that used them read the same.
 *
 * - `mocked(fn)` is a type assertion and nothing else: it tells the compiler a
 *   function that a `mock.module` factory replaced is a `Mock`.
 * - `stubEnv` / `unstubAllEnvs` set (or, with `undefined`, delete) a variable
 *   and put back exactly what was there before, including its absence.
 * - `resetModules()` forgets every module of THIS package that has been
 *   loaded, so the next `import()` evaluates it again against the current
 *   environment and the current `mock.module` registrations. Like vitest's, it
 *   leaves `node_modules` (and the test files themselves) alone, and it does
 *   not undo a mock.
 * - `waitFor(callback)` re-runs the callback every 50 ms until it stops
 *   throwing or 1 s has passed (vitest's defaults), and rethrows the last
 *   failure when time runs out.
 * - `spyOnGetter(object, key)` is vitest's `spyOn(object, key, 'get')`, which
 *   `bun:test` implements but does not type.
 */
import { resolve } from 'node:path';

import { type Mock, spyOn } from 'bun:test';

// biome-ignore lint/suspicious/noExplicitAny: mirrors the constraint on bun:test's own `Mock<T>`.
export function mocked<T extends (...args: any[]) => any>(fn: T): Mock<T> {
  return fn as unknown as Mock<T>;
}

const originalEnv = new Map<string, string | undefined>();

export function stubEnv(name: string, value: string | undefined): void {
  if (!originalEnv.has(name)) originalEnv.set(name, process.env[name]);
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

export function unstubAllEnvs(): void {
  for (const [name, value] of originalEnv) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  originalEnv.clear();
}

/** `packages/backend/src`, whatever directory the runner was started from. */
const packageSource = resolve(import.meta.dir, '../..');

export function resetModules(): void {
  for (const id of Object.keys(require.cache)) {
    if (
      id.startsWith(packageSource) &&
      !id.includes('/node_modules/') &&
      !id.endsWith('.test.ts')
    ) {
      delete require.cache[id];
    }
  }
}

export async function waitFor<T>(
  callback: () => T | Promise<T>,
  { timeout = 1_000, interval = 50 }: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const deadline = Date.now() + timeout;
  for (;;) {
    try {
      return await callback();
    } catch (error) {
      if (Date.now() >= deadline) throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
  }
}

export function spyOnGetter<T extends object, K extends keyof T>(
  object: T,
  key: K,
): Mock<() => T[K]> {
  return (spyOn as unknown as (target: T, property: K, access: 'get') => Mock<() => T[K]>)(
    object,
    key,
    'get',
  );
}
