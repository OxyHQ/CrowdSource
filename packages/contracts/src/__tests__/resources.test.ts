import { describe, expect, it } from 'vitest';

import {
  RelationSchema,
  ResourceSchema,
  ResourceSchemaRegistrationSchema,
} from '../resources';
import { accepted, rejectionIssues, rejectionPaths } from './support/assertions';
import { DIGEST, imageResourceExample, textResourceExample } from './support/examples';

describe('text resources', () => {
  it('accepts the reference shape', () => {
    const resource = accepted(ResourceSchema, textResourceExample());
    expect(resource.type).toBe('text');
  });

  it('accepts a text resource with no language, because §5.2 says "where applicable"', () => {
    const { language, ...withoutLanguage } = textResourceExample();
    expect(language).toBe('es-ES');
    expect(accepted(ResourceSchema, withoutLanguage).id).toBe('res_post');
  });

  it('requires the digest that pins the exact version reviewed', () => {
    const { sha256, ...withoutDigest } = textResourceExample();
    expect(sha256).toBeDefined();
    expect(rejectionPaths(ResourceSchema, withoutDigest)).toEqual(['sha256']);
  });

  it('rejects an unknown field rather than dropping context a jury would never see', () => {
    // Zod reports an unrecognised key at the object's own path with the key
    // named in the message, so the assertion has to look at the message —
    // asserting on the path alone would pass for any root-level failure.
    const issues = rejectionIssues(ResourceSchema, {
      ...textResourceExample(),
      renderAs: '<b>bold</b>',
    });
    expect(issues).toEqual([{ path: '', message: 'Unrecognized key: "renderAs"' }]);
  });

  it('rejects an unknown formatting, because markdown_subset is a subset on purpose', () => {
    expect(
      rejectionPaths(ResourceSchema, {
        ...textResourceExample(),
        data: { text: 'hi', formatting: 'html' },
      }),
    ).toEqual(['data.formatting']);
  });

  it('rejects an unknown resource type outright', () => {
    expect(rejectionIssues(ResourceSchema, { ...textResourceExample(), type: 'embed' }).length)
      .toBeGreaterThan(0);
  });
});

describe('asset-backed resources', () => {
  it('accepts an image whose digest lives on the asset, as Appendix A writes it', () => {
    expect(accepted(ResourceSchema, imageResourceExample()).id).toBe('res_image');
  });

  it('rejects a media type that disagrees with the resource type', () => {
    /**
     * An `image` declaring `text/html` is type confusion: anything that trusts
     * the declared media type to pick a renderer has just been handed a
     * document to render.
     */
    expect(
      rejectionPaths(ResourceSchema, {
        ...imageResourceExample(),
        asset: { fileId: 'oxyfile_01HZ', mimeType: 'text/html', sha256: DIGEST.image },
      }),
    ).toEqual(['asset.mimeType']);
  });

  it('accepts a fileId alongside a url, because they answer different questions', () => {
    /**
     * `fileId` is where the bytes are; `url` is where they came from. The old
     * contract made these mutually exclusive, which is exactly what left an
     * integrator with no safe way to attach an image — the upload branch needed a
     * route nobody built, and the url branch put the reporting application's own
     * host in front of a reviewer. A federated post's image genuinely has both a
     * provenance URL and pinned bytes.
     */
    expect(
      accepted(ResourceSchema, {
        ...imageResourceExample(),
        asset: {
          fileId: 'oxyfile_01HZ',
          url: 'https://cdn.test/a.jpg',
          mimeType: 'image/jpeg',
          sha256: DIGEST.image,
        },
      }).id,
    ).toBe(imageResourceExample().id);
  });

  it('rejects a url-only asset, which is the shape that leaked', () => {
    /**
     * The shape that used to be legal and is the whole point of this change: a
     * url-only asset has no pinned bytes, so the only way to show it to a jury is
     * for the reviewer's client to fetch it — telling that host when its content
     * is under review, and delivering live bytes instead of the version §5.6
     * requires the case to pin.
     */
    expect(
      rejectionPaths(ResourceSchema, {
        ...imageResourceExample(),
        asset: { url: 'https://cdn.test/a.jpg', mimeType: 'image/jpeg', sha256: DIGEST.image },
      }),
    ).toEqual(['asset.fileId']);
  });

  it('rejects an upload id, so the superseded presigned path cannot come back', () => {
    /**
     * `.strict()` is what makes this fail rather than ignoring the field. An
     * envelope still naming `uploadId` was built against the abandoned mechanism,
     * and accepting it would store an asset whose bytes nothing can resolve.
     */
    expect(
      rejectionPaths(ResourceSchema, {
        ...imageResourceExample(),
        asset: {
          uploadId: 'upload_01HZ',
          fileId: 'oxyfile_01HZ',
          mimeType: 'image/jpeg',
          sha256: DIGEST.image,
        },
      }),
    ).toEqual(['asset']);
  });

  it('rejects a fileId that could smuggle a path or a scheme into a resolver', () => {
    for (const hostile of ['../../etc/passwd', 'https://evil.test/x', 'a/b', 'a:b']) {
      expect(
        rejectionPaths(ResourceSchema, {
          ...imageResourceExample(),
          asset: { fileId: hostile, mimeType: 'image/jpeg', sha256: DIGEST.image },
        }),
      ).toEqual(['asset.fileId']);
    }
  });

  it('rejects an asset that names no bytes at all', () => {
    expect(
      rejectionPaths(ResourceSchema, {
        ...imageResourceExample(),
        asset: { mimeType: 'image/jpeg', sha256: DIGEST.image },
      }),
    ).toEqual(['asset.fileId']);
  });

  it('rejects an asset with no digest, which is what survives the original being deleted', () => {
    expect(
      rejectionPaths(ResourceSchema, {
        ...imageResourceExample(),
        asset: { fileId: 'oxyfile_01HZ', mimeType: 'image/jpeg' },
      }),
    ).toEqual(['asset.sha256']);
  });

  it('requires a duration on video and audio, as §5.3 does', () => {
    const video = {
      id: 'res_video',
      type: 'video',
      role: 'subject',
      asset: { fileId: 'oxyfile_v', mimeType: 'video/mp4', sha256: DIGEST.image },
    };
    expect(rejectionPaths(ResourceSchema, video)).toEqual(['asset.durationSeconds']);
    expect(
      accepted(ResourceSchema, {
        ...video,
        asset: { ...video.asset, durationSeconds: 12.5 },
      }).id,
    ).toBe('res_video');
  });

  it('rejects a video time range that ends before it starts', () => {
    expect(
      rejectionPaths(ResourceSchema, {
        id: 'res_video',
        type: 'video',
        role: 'subject',
        asset: {
          fileId: 'oxyfile_v',
          mimeType: 'video/mp4',
          sha256: DIGEST.image,
          durationSeconds: 30,
        },
        data: { timeRange: { startSeconds: 20, endSeconds: 10 } },
      }),
    ).toEqual(['data.timeRange.endSeconds']);
  });

  it('rejects a document whose media type is an image', () => {
    expect(
      rejectionPaths(ResourceSchema, {
        id: 'res_doc',
        type: 'document',
        role: 'evidence',
        asset: { fileId: 'oxyfile_d', mimeType: 'image/png', sha256: DIGEST.image },
        data: { title: 'Contract' },
      }),
    ).toEqual(['asset.mimeType']);
  });
});

describe('link resources', () => {
  const link = (url: string): Record<string, unknown> => ({
    id: 'res_link',
    type: 'link',
    role: 'context',
    sha256: DIGEST.post,
    data: { url },
  });

  it('accepts an http(s) destination', () => {
    expect(accepted(ResourceSchema, link('https://example.test/promo')).id).toBe('res_link');
  });

  it('rejects a dangerous scheme (§7.2.7)', () => {
    for (const url of ['javascript:alert(1)', 'data:text/html,<script>', 'file:///etc/passwd']) {
      expect(rejectionPaths(ResourceSchema, link(url))).toEqual(['data.url']);
    }
  });
});

describe('location resources', () => {
  const location = (data: Record<string, unknown>): Record<string, unknown> => ({
    id: 'res_place',
    type: 'location',
    role: 'context',
    sha256: DIGEST.post,
    data,
  });

  it('accepts a place label alone', () => {
    expect(accepted(ResourceSchema, location({ label: 'Barcelona' })).id).toBe('res_place');
  });

  it('accepts coarse coordinates', () => {
    expect(accepted(ResourceSchema, location({ latitude: 41.39, longitude: 2.16 })).id).toBe(
      'res_place',
    );
  });

  it('rejects coordinates precise enough to locate a person (§5.3, §13.5)', () => {
    expect(rejectionPaths(ResourceSchema, location({ latitude: 41.38765, longitude: 2.16 }))).toEqual(
      ['data.latitude'],
    );
  });

  it('rejects half a coordinate pair, and a location that says nothing at all', () => {
    expect(rejectionPaths(ResourceSchema, location({ latitude: 41.39 }))).toEqual([
      'data.longitude',
    ]);
    expect(rejectionPaths(ResourceSchema, location({}))).toEqual(['data']);
  });
});

describe('listing resources', () => {
  const listing = (data: Record<string, unknown>): Record<string, unknown> => ({
    id: 'res_listing',
    type: 'listing',
    role: 'subject',
    sha256: DIGEST.post,
    data,
  });

  it('accepts a listing with a price and its currency', () => {
    expect(
      accepted(ResourceSchema, listing({ title: 'Bike', price: 120, currency: 'EUR' })).id,
    ).toBe('res_listing');
  });

  it('rejects a price with no currency, and a currency with no price', () => {
    expect(rejectionPaths(ResourceSchema, listing({ title: 'Bike', price: 120 }))).toEqual([
      'data.currency',
    ]);
    expect(rejectionPaths(ResourceSchema, listing({ title: 'Bike', currency: 'EUR' }))).toEqual([
      'data.price',
    ]);
  });

  it('rejects a currency that is not an ISO 4217 alphabetic code', () => {
    expect(rejectionPaths(ResourceSchema, listing({ title: 'Bike', price: 1, currency: 'eur' })))
      .toEqual(['data.currency']);
  });
});

describe('conversation and metadata resources', () => {
  it('requires a conversation to name at least one message', () => {
    expect(
      rejectionPaths(ResourceSchema, {
        id: 'res_thread',
        type: 'conversation',
        role: 'context',
        sha256: DIGEST.post,
        data: { messageResourceIds: [] },
      }),
    ).toEqual(['data.messageResourceIds']);
  });

  it('rejects a metadata resource that carries a nested structure', () => {
    expect(
      rejectionIssues(ResourceSchema, {
        id: 'res_meta',
        type: 'metadata',
        role: 'metadata',
        sha256: DIGEST.post,
        data: { audience: { size: 3 } },
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('custom resources (§5.7)', () => {
  const custom = (payload: unknown): Record<string, unknown> => ({
    id: 'res_custom',
    type: 'custom',
    role: 'subject',
    sha256: DIGEST.post,
    schemaId: 'mercaria.offer_v1',
    payload,
  });

  it('accepts a validated data payload', () => {
    expect(accepted(ResourceSchema, custom({ offerCode: 'X1', quantity: 4 })).id).toBe('res_custom');
  });

  it('rejects a payload that carries a reference mechanism', () => {
    expect(rejectionIssues(ResourceSchema, custom({ $ref: 'https://evil.test/x' })).length)
      .toBeGreaterThan(0);
  });

  it('rejects a payload that is an array rather than an object', () => {
    expect(rejectionIssues(ResourceSchema, custom(['a', 'b'])).length).toBeGreaterThan(0);
  });
});

describe('registered resource schemas (§5.7)', () => {
  const registration = (jsonSchema: unknown): Record<string, unknown> => ({
    schemaId: 'mercaria.offer_v1',
    version: '2026.07',
    title: 'Mercaria offer',
    jsonSchema,
  });

  it('accepts a flat, self-contained schema', () => {
    expect(
      accepted(
        ResourceSchemaRegistrationSchema,
        registration({
          type: 'object',
          properties: { offerCode: { type: 'string', maxLength: 32 } },
          required: ['offerCode'],
        }),
      ).schemaId,
    ).toBe('mercaria.offer_v1');
  });

  it('rejects a schema that points at a document CrowdSource would have to fetch', () => {
    /**
     * A remote `$ref` is §5.7's "remote component" and an SSRF with the tenant
     * holding the pen. Excluding `$`-prefixed keys removes every reference
     * keyword at once instead of blocklisting them one at a time.
     */
    expect(
      rejectionIssues(
        ResourceSchemaRegistrationSchema,
        registration({ $ref: 'https://evil.test/schema.json' }),
      ).length,
    ).toBeGreaterThan(0);
    expect(
      rejectionIssues(
        ResourceSchemaRegistrationSchema,
        registration({ properties: { a: { $dynamicRef: '#meta' } } }),
      ).length,
    ).toBeGreaterThan(0);
  });
});

describe('relations', () => {
  it('accepts the shape §5.5 defines', () => {
    expect(
      accepted(RelationSchema, { from: 'res_post', type: 'has_attachment', to: 'res_image' }).type,
    ).toBe('has_attachment');
  });

  it('rejects a relation type outside §5.5', () => {
    expect(
      rejectionPaths(RelationSchema, { from: 'res_post', type: 'embeds', to: 'res_image' }),
    ).toEqual(['type']);
  });
});
