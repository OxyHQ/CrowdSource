import { createApplication, createOrganization } from './provisioning.service';
import { applications, organizations } from './tenancy.collections';

/**
 * Onboards one of Oxy's own applications, so it can authenticate with an Oxy
 * service token and no credential (`oxyApplicationAuth.ts`).
 *
 * ## Why a script and not a console click
 *
 * The console is the right place to onboard a THIRD PARTY: a human decides an
 * organization exists, who owns it, and what it may do. A first-party Oxy
 * service is not that decision — it is Oxy's own code being deployed, and the
 * organization is always the same one. Asking a person to click through the
 * console for each of thirty services is asking them to re-state something the
 * platform already knows, which is the whole reason the credential went away.
 *
 * ## What it does NOT do
 *
 * It issues no credential. There is nothing here to copy into a parameter store,
 * and that absence is the point: the application's identity is the Oxy
 * application it is bound to, and Oxy proves that on every call.
 *
 * ## Idempotent on purpose
 *
 * A deploy that runs this twice must not create a second organization or a
 * second application — so it reuses the organization by slug, reuses an existing
 * binding, and refuses only when the SAME Oxy application is already bound to a
 * DIFFERENT CrowdSource application. That last one is a genuine conflict and
 * silently repointing it would move a tenant's data out from under it.
 *
 * This module only DEFINES the work; `scripts/bootstrapFirstParty.ts` is what
 * runs it. A module that acts when imported acts in every test that imports it —
 * importing the first version once exited the test worker with code 1, which is
 * how that split came about.
 */

export interface Arguments {
  name: string;
  oxyApplicationId: string;
  organizationSlug: string;
  organizationName: string;
}

/** The one organization every first-party Oxy service belongs to. */
const DEFAULT_ORGANIZATION_SLUG = 'oxy';
const DEFAULT_ORGANIZATION_NAME = 'Oxy';

export function parseArguments(argv: readonly string[]): Arguments {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith('--') || value === undefined) {
      throw new Error(`Unrecognised argument near '${flag ?? ''}'. Every flag takes a value.`);
    }
    values.set(flag.slice(2), value);
  }

  const name = values.get('name')?.trim();
  const oxyApplicationId = values.get('oxy-application-id')?.trim();
  if (!name) throw new Error('--name is required.');
  if (!oxyApplicationId) throw new Error('--oxy-application-id is required.');

  return {
    name,
    oxyApplicationId,
    organizationSlug: values.get('organization-slug')?.trim() || DEFAULT_ORGANIZATION_SLUG,
    organizationName: values.get('organization-name')?.trim() || DEFAULT_ORGANIZATION_NAME,
  };
}

async function organizationFor(args: Arguments): Promise<string> {
  const existing = await organizations.findOne({ slug: args.organizationSlug });
  if (existing) return existing.organizationId;
  const created = await createOrganization({ name: args.organizationName, slug: args.organizationSlug });
  return created.organizationId;
}

export async function bootstrapFirstParty(args: Arguments): Promise<string> {
  const bound = await applications.findOne({ oxyApplicationId: args.oxyApplicationId });
  if (bound) {
    // Already onboarded. Say which application it is and change nothing.
    return bound.applicationId;
  }

  const organizationId = await organizationFor(args);
  const existingByName = await applications.findOne({ organizationId, name: args.name });
  const application = existingByName ?? (await createApplication({ organizationId, name: args.name }));

  if (existingByName?.oxyApplicationId && existingByName.oxyApplicationId !== args.oxyApplicationId) {
    throw new Error(
      `Application '${args.name}' is already bound to a different Oxy application. ` +
        'Repointing it would move its data out from under the service that owns it.',
    );
  }

  await applications.updateOne(
    { applicationId: application.applicationId },
    { oxyApplicationId: args.oxyApplicationId },
  );
  return application.applicationId;
}
