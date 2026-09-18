import { closePostgresDatabase, pingPostgres } from '../db/postgres/database';
import { bootstrapFirstParty, parseArguments } from './bootstrapFirstParty';

/**
 * The entrypoint for the first-party bootstrap, and nothing else.
 *
 * Separate from the module that does the work because that module is imported
 * by tests, and a module that acts on import acts in every one of them.
 *
 * Run as a one-off ECS task from inside the VPC:
 *   bun src/scripts/runBootstrapFirstParty.ts --name Mention --oxy-application-id <id>
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
