/**
 * Cache keys for the reviewer surface.
 *
 * Their own module, with no imports, for two reasons. The identity boundary
 * needs to name the namespace it drops on an account switch but has no business
 * pulling the HTTP client into the provider tree to do it. And keys are the
 * thing most worth testing directly — importing them should not require a
 * runtime that can load the Oxy SDK.
 *
 * Every key carries the viewer it belongs to. The viewer segment sits SECOND,
 * directly under `all`, because `removeQueries({ queryKey: all })` matches by
 * prefix: a key that did not start with `all` would survive the account switch
 * that was supposed to remove it.
 */

export const reviewerQueryKeys = {
  all: ['reviewer'] as const,
  profile: (viewer: string) => ['reviewer', viewer, 'profile'] as const,
  training: (viewer: string) => ['reviewer', viewer, 'training'] as const,
  history: (viewer: string) => ['reviewer', viewer, 'history'] as const,
  /**
   * The viewer's OWN Oxy reputation balance. Under the same `all` prefix as
   * everything else so an account switch drops it with the rest — a figure
   * belonging to the previous account is exactly the kind of thing that would
   * otherwise sit in a corner of the screen, unnoticed, attached to the wrong
   * person.
   */
  reputation: (viewer: string) => ['reviewer', viewer, 'reputation'] as const,
};
