import { closePostgresDatabase, pingPostgres } from '../src/db/postgres/database';
import { bootstrapFirstParty, parseArguments } from '../src/modules/tenancy/bootstrapFirstParty';

/**
 * The first-party bootstrap entrypoint — a process around
 * `bootstrapFirstParty`, and nothing else.
 *
 * It lives beside `migrate.ts` rather than under `src/` for the reason given
 * there: `rootDir: "./"` maps this file to `dist/scripts/bootstrapFirstParty.js`,
 * which is what a one-off ECS task can name. Everything worth asserting is in
 * `src/modules/tenancy/bootstrapFirstParty.ts`, which the tests import; what is
 * left here is the argv, the exit code and one line of output, none of which a
 * unit test can meaningfully hold — and measuring it as if it could is what
 * dropped the coverage gate below its floor when this file first landed under
 * `src/`.
 *
 * Run from inside the VPC, where the database is reachable:
 *   node dist/scripts/bootstrapFirstParty.js --name Mention --oxy-application-id <id>
 */
async function main(): Promise<void> {
  const args = parseArguments(process.argv.slice(2));
  await pingPostgres();
  try {
    const applicationId = await bootstrapFirstParty(args);
    // Not a secret — it travels in every report envelope — and the operator
    // needs it to confirm the binding landed.
    process.stdout.write(`${args.name} is application ${applicationId}\n`);
  } finally {
    await closePostgresDatabase();
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
