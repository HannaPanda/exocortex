/**
 * Mints a personal API token headlessly, without a browser.
 *
 * Used to give a script or MCP client (e.g. Hermes) a bearer token for a
 * specific user without going through the `/api/me/api-tokens` REST endpoint
 * from a session.
 *
 * Usage:
 *   pnpm --filter @exocortex/api token:create -- --email <email> --name "<name>" \
 *     [--days <n>] [--scopes read,write]
 *
 * Prints the raw secret on the last stdout line, so callers can capture it
 * with `tail -1`. The secret is never logged anywhere else.
 */
import { generateApiToken } from '@exocortex/auth';
import { loadApiEnv } from '@exocortex/config';
import { API_TOKEN_SCOPES, type ApiTokenScope } from '@exocortex/contracts';
import { createPrismaClient } from '@exocortex/database';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

interface ParsedArgs {
  email: string;
  name: string;
  days: number | null;
  scopes: ApiTokenScope[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  let email: string | undefined;
  let name: string | undefined;
  let days: number | null = null;
  // The column's own default, so omitting the flag keeps what this script has
  // always minted: a token that can look but not touch.
  let scopes: ApiTokenScope[] = ['read'];

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === '--email' && value !== undefined) {
      email = value;
      index += 1;
    } else if (flag === '--name' && value !== undefined) {
      name = value;
      index += 1;
    } else if (flag === '--scopes' && value !== undefined) {
      scopes = parseScopes(value);
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

  return { email, name, days, scopes };
}

/**
 * Reads `read,write` into the scopes of a token.
 *
 * Refuses an unknown word rather than dropping it. A typo that silently
 * narrowed a token would show up much later, as a call that fails with no
 * explanation anybody connects to this line.
 */
function parseScopes(raw: string): ApiTokenScope[] {
  const requested = raw
    .split(',')
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);

  const unknown = requested.filter(
    (scope) => !(API_TOKEN_SCOPES as readonly string[]).includes(scope),
  );
  if (unknown.length > 0) {
    console.error(`Unknown scope(s): ${unknown.join(', ')}. Known: ${API_TOKEN_SCOPES.join(', ')}`);
    process.exit(1);
  }
  if (requested.length === 0) {
    console.error('--scopes was empty; a token with no scopes may do nothing at all');
    process.exit(1);
  }
  return requested as ApiTokenScope[];
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
        scopes: args.scopes,
        expiresAt,
      },
    });

    // The only line a caller should parse is the last one: the raw secret.
    console.error(
      `Created API token "${args.name}" for ${args.email} ` +
        `(prefix ${generated.prefix}, scopes ${args.scopes.join(', ')})`,
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
