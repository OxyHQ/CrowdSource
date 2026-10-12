import { expect, test } from 'bun:test';

const entries = ['../packages/reviewer/worker/index.js', '../packages/console/worker/index.js'];
for (const entry of entries) {
  test(`${entry}: returns the asset response unchanged`, async () => {
    const worker = (await import(entry)).default;
    const response = new Response('asset', {
      headers: {
        'Content-Type': 'image/png',
        'Cache-Control': 'public,max-age=31536000,immutable',
      },
    });
    const result = await worker.fetch(new Request('https://example.com/private-image.png'), {
      ASSETS: { fetch: async () => response },
    });
    expect(result.status).toBe(200);
    expect(result.headers.get('Cache-Control')).toContain('immutable');
    expect(await result.text()).toBe('asset');
  });
  test(`${entry}: asset failures preserve the original error`, async () => {
    const worker = (await import(entry)).default;
    const error = new Error('asset failure');
    await expect(
      worker.fetch(new Request('https://example.com/file.png'), {
        ASSETS: {
          fetch: async () => {
            throw error;
          },
        },
      }),
    ).rejects.toBe(error);
  });
}
