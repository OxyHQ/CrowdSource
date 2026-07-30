/**
 * The whole integration, in one test.
 *
 * A user reports a post → the application delivers it with the real client →
 * CrowdSource opens a case → a decision is published → a signed webhook reaches
 * the application → the application enforces it. Every piece is the real one
 * except the service, which is the sandbox.
 *
 * This is the test an integrator should copy. It is also the only place the
 * three packages meet, so it is where a change to any of them that breaks the
 * others shows up: the client composes the envelope, the sandbox applies the
 * ingestion rules, the simulator signs the delivery, and the middleware verifies
 * it. Nothing between them is stubbed, so nothing between them can drift
 * silently.
 */

import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

import { CrowdSource } from '@oxyhq/crowdsource';
import { createCrowdSourceSandbox } from '@oxyhq/crowdsource-testing';
import express from 'express';
import { afterEach, describe, expect, it } from 'vitest';

import { crowdsourceWebhooks } from '../middleware.js';

const closers: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe('report in, decision out', () => {
  it('carries a report to a decision and back to the application that filed it', async () => {
    const sandbox = createCrowdSourceSandbox();

    // --- The application's own moderation side effects, recorded not performed.
    const enforced: { caseId: string; action: string }[] = [];

    const app = express();
    // A JSON body parser, mounted globally, exactly as a real application has
    // one. The webhook route survives it because the middleware reads the raw
    // request itself — and refuses rather than guessing if it cannot.
    app.post(
      '/webhooks/crowdsource',
      crowdsourceWebhooks({
        secret: sandbox.webhookSecret,
        on: {
          'case.decided': (event) => {
            for (const recommended of event.data.decision.recommendedActions) {
              enforced.push({ caseId: event.data.caseId, action: recommended.action });
            }
          },
        },
      }),
    );
    app.use(express.json());

    const server = app.listen(0);
    await once(server, 'listening');
    closers.push(
      () =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    );
    const { port } = server.address() as AddressInfo;
    const webhookUrl = `http://127.0.0.1:${port}/webhooks/crowdsource`;

    // --- 1. The application delivers the report from its own outbox.
    const crowdsource = new CrowdSource({
      serviceKey: sandbox.serviceKey,
      baseUrl: sandbox.baseUrl,
      fetch: sandbox.fetch,
    });

    const accepted = await crowdsource.reports.create({
      externalReportId: 'mention_report_123',
      reportedBy: { oxyUserId: 'oxy_reporter' },
      subject: {
        externalId: 'post_987',
        type: 'social.post',
        author: { oxyUserId: 'oxy_author' },
        permalink: 'https://mention.earth/@someone/post_987',
      },
      content: { type: 'text', data: { text: 'Texto exacto reportado' }, language: 'es' },
      allegations: ['harassment.targeted_abuse'],
    });

    expect(accepted.status).toBe('received');

    // --- 2. A jury would sit here. The sandbox stands in for one.
    const decision = sandbox.decide(accepted.caseId, { outcome: 'violation' });

    // --- 3. CrowdSource delivers the decision, signed.
    const event = sandbox.eventFor(decision);
    const delivery = await sandbox.deliver(webhookUrl, event);

    expect(delivery.status).toBe(200);
    expect(delivery.body).toMatchObject({ received: true, handled: true, duplicate: false });

    // --- 4. The application enforced exactly once, against the right case.
    expect(enforced).toEqual([{ caseId: accepted.caseId, action: 'remove_or_restrict' }]);

    /**
     * 5. §10.9 will redeliver the SAME event — a lost 2xx looks identical to a
     * failure from the sender's side. One penalty per incident means the second
     * delivery must be acknowledged and must not enforce again.
     */
    const redelivery = await sandbox.deliver(webhookUrl, event);

    expect(redelivery.status).toBe(200);
    expect(redelivery.body).toMatchObject({ duplicate: true });
    expect(enforced).toHaveLength(1);
  });
});
