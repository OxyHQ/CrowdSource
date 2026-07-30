import { useLocalSearchParams } from 'expo-router';

/**
 * One dynamic segment of the current route, as a string, or `null`.
 *
 * Every id in this app arrives from a URL an operator can edit, and
 * `useLocalSearchParams` types a value as `string | string[]` because a repeated
 * query parameter is legal. `null` for both the absent and the repeated case, so a
 * screen has exactly one shape to handle and never renders a table for
 * `"abc,def"` — a request built from that reaches the API as an id that cannot
 * exist and comes back 404, which reads as "not yours" and is a lie.
 *
 * The queries all take `string | null` and stay disabled while it is `null`, so an
 * unusable parameter costs a request rather than an exception.
 */
export function useRouteParam(name: string): string | null {
  const params = useLocalSearchParams();
  const value = params[name];
  return typeof value === 'string' && value !== '' ? value : null;
}
