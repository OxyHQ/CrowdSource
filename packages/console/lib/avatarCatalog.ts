import { createVectorAssetLoader } from '@oxy.so/bloom/agent-avatar/catalog';

/**
 * The agent-avatar assets this app ships: none. Reviewers and operators are people, and no screen
 * draws a bot character, so Bloom's 70-asset default catalog is resolved out of the bundle in
 * `metro.config.js`. To draw a character, list its assets here (`@oxy.so/bloom/agent-avatar/catalog/<kind>-<id>`).
 */
export const avatarCatalog = createVectorAssetLoader({});
