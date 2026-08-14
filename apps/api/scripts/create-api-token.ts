/**
 * Mints a personal API token headlessly, without a browser.
 *
 * Used to give a script or MCP client (e.g. Hermes) a bearer token for a
 * specific user without going through the `/api/me/api-tokens` REST endpoint
 * from a session.
 *
 * Usage:
 *   pnpm --filter @exocortex/api token:create -- --email <email> --name "<name>" [--days <n>]
 *
 * Prints the raw secret on the last stdout line, so callers can capture it
 * with `tail -1`. The secret is never logged anywhere else.
 */
import { generateApiToken } from '@exocortex/auth';
import { loadApiEnv } from '@exocortex/config';
import { createPrismaClient } from '@exocortex/database';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface ParsedArgs {
  email: string;
  name: string;
  days: number | null;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let email: string | undefined;
  let name: string | undefined;
  let days: number | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--email' && value !== undefined) {
      email = value;
      index += 1;
    } else if (flag === '--name' && value !== undefined) {
      name = value;
      index += 1;
    } else if (flag === '--days' && value !== undefined) {
      const parsed = Number.parseInt(value, 10);
      if (Number.isNaN(parsed) || parsed <= 0) {
        console.error(`Invalid --days value "${value}": must be a positive integer`);
        process.exit(1);
      }
      days = parsed;
      index += 1;
    }
  }

  if (email === undefined || name === undefined) {
    console.error('Usage: token:create -- --email <email> --name "<name>" [--days <n>]');
    process.exit(1);
  }

  return { email, name, days };
}

async function main(): Promise<void> {
  loadApiEnv();
  const args = parseArgs(process.argv.slice(2));

  const prisma = createPrismaClient();
  try {
    const user = await prisma.user.findUnique({
      where: { email: args.email },
      select: { id: true },
    });
    if (user === null) {
      console.error(`No user found with email "${args.email}"`);
      process.exit(1);
      return;
    }

    const generated = generateApiToken();
    const expiresAt =
      args.days === null ? null : new Date(Date.now() + args.days * MILLISECONDS_PER_DAY);

    await prisma.apiToken.create({
      data: {
        userId: user.id,
        name: args.name,
        tokenHash: generated.tokenHash,
        prefix: generated.prefix,
        expiresAt,
      },
    });

    // The only line a caller should parse is the last one: the raw secret.
    console.error(
      `Created API token "${args.name}" for ${args.email} (prefix ${generated.prefix})`,
    );
    console.log(generated.secret);
  } finally {
    await prisma.$disconnect();
  }
}

void main().catch((error: unknown) => {
  console.error('Creating the API token failed:', error);
  process.exit(1);
});
