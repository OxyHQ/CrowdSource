import { expect, it } from 'bun:test';
import pino from 'pino';
import { REDACTED_LOG_PATHS } from '../utils/logger';
it('redacts workload requester proofs from a whole request diagnostic', () => {
  let output = '';
  const logger = pino(
    { redact: { paths: REDACTED_LOG_PATHS, remove: true } },
    {
      write: (value: string) => {
        output += value;
      },
    },
  );
  logger.info({
    req: {
      accessToken: 'private-access',
      headers: {
        authorization: 'private-bearer',
        'x-oxy-requester-context': 'private-context',
        'x-oxy-requester-token': 'private-session',
        'x-oxy-capability-ticket': 'private-ticket',
        'x-oxy-presented-service-token': 'private-service',
        'x-oxy-mcp-media-token': 'private-media',
      },
      serviceActingAs: { requesterContext: 'private-derived', userId: 'visible-account' },
    },
  });
  expect(output).not.toContain('private-');
  expect(output).toContain('visible-account');
});
