import { observeEdgeRequest } from '@oxy.so/telemetry/edge';

const assetWorker = { fetch(request, env) { return env.ASSETS.fetch(request); } };

export default {
  fetch(request, env, ctx) {
    return observeEdgeRequest({ service: 'crowdsource', request, env, ctx, next: () => assetWorker.fetch(request, env, ctx) });
  },
};
