/**
 * Closing the forward-compatibility catchall, at the type level only.
 *
 * The outbound schemas in this package are deliberately loose — see the note in
 * `index.ts`. A decision, a webhook envelope and an event payload all pass
 * unknown fields through, so a newer CrowdSource never breaks an older client
 * and a receiver that persists `event.data` keeps all of it. That runtime
 * behaviour is a requirement (§10.11) and nothing here changes it.
 *
 * What it costs, unmodified, is every field-name check the compiler could have
 * given an integrator. `z.infer` of a loose object carries an index signature,
 * and an index signature makes ANY property access legal:
 *
 *     receipt.externalReportId   // compiles clean. `undefined` at runtime.
 *     decision.decisionId        // compiles clean. The field is `id`.
 *     decision.policyVersion     // compiles clean. The field is `policyVersions`.
 *
 * That is not a rough edge. It silently produces wrong code in the integrator's
 * repository, with no error anywhere, and it is the same shape of defect as a
 * duplicated dependency: the compiler reports success and the failure surfaces
 * later as a value that is mysteriously absent.
 *
 * So the schema stays loose and the exported TYPE is closed. `Closed<T>` strips
 * index signatures from `T` and from everything nested inside it, leaving the
 * fields the contract actually declares — with their optionality, their
 * `readonly` modifiers, and any discriminated union intact. A parse still
 * accepts and preserves unknown fields; naming one you invented no longer
 * compiles. Reaching a field the contract does not declare, deliberately, is
 * what an index-signature access on the parsed value is for.
 */

/** `T` without the index signatures a loose object contributes. */
type StripIndex<T> = {
  [K in keyof T as string extends K
    ? never
    : number extends K
      ? never
      : symbol extends K
        ? never
        : K]: T[K];
};

/**
 * `T` with every index signature removed, recursively.
 *
 * Functions and `Date` are returned untouched — mapping over their members would
 * replace them with a structurally similar object that is no longer callable or
 * no longer a `Date`. Arrays are rebuilt so their element type is closed too,
 * preserving whether the array was readonly. Unions distribute, which is what
 * keeps `KnownWebhookEvent` a discriminated union that still narrows on `type`.
 */
export type Closed<T> = T extends (...args: never[]) => unknown
  ? T
  : T extends readonly (infer E)[]
    ? T extends unknown[]
      ? Closed<E>[]
      : readonly Closed<E>[]
    : T extends Date
      ? T
      : T extends object
        ? { [K in keyof StripIndex<T>]: Closed<StripIndex<T>[K]> }
        : T;
