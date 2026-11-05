import { handleWellKnown } from './appAssociation.js';

/**
 * `/.well-known/*` is answered here (the App Links document, a JSON 404 for
 * anything else) and never reaches the assets binding, whose
 * single-page-application fallback would answer it with `index.html` and 200.
 * Every other request goes to the assets binding untouched.
 */
export default {
  fetch(request, env) {
    return handleWellKnown(request) ?? env.ASSETS.fetch(request);
  },
};
