import { loadDotEnv } from '@exocortex/config';

import { Prisma, PrismaClient } from '../generated/client';

export { Prisma, PrismaClient };
export * from '../generated/client';

export interface CreatePrismaClientOptions {
  databaseUrl?: string;
  /** Emit Prisma query events. Only enable in development. */
  logQueries?: boolean;
}

/**
 * Creates a Prisma client. Every process owns exactly one instance; use
 * `getPrismaClient()` unless a test needs an isolated connection.
 */
export function createPrismaClient(options: CreatePrismaClientOptions = {}): PrismaClient {
  loadDotEnv();
  const url = options.databaseUrl ?? process.env.DATABASE_URL;
  if (url === undefined || url.length === 0) {
    throw new Error(
      'DATABASE_URL is not set. Copy .env.example to .env and start the local ' +
        'infrastructure with `pnpm infra:up`.',
    );
  }

  return new PrismaClient({
    datasources: { db: { url } },
    log: options.logQueries
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ]
      : [
          { emit: 'stdout', level: 'warn' },
          { emit: 'stdout', level: 'error' },
        ],
  });
}

const globalForPrisma = globalThis as unknown as { exocortexPrisma?: PrismaClient };

/**
 * Process-wide singleton. Reused across Next.js hot reloads so development does
 * not exhaust the connection pool.
 */
export function getPrismaClient(): PrismaClient {
  if (globalForPrisma.exocortexPrisma === undefined) {
    globalForPrisma.exocortexPrisma = createPrismaClient({
      logQueries: false,
    });
  }
  return globalForPrisma.exocortexPrisma;
}

/** Closes the singleton connection. Used by graceful shutdown handlers. */
export async function disconnectPrismaClient(): Promise<void> {
  if (globalForPrisma.exocortexPrisma !== undefined) {
    await globalForPrisma.exocortexPrisma.$disconnect();
    globalForPrisma.exocortexPrisma = undefined;
  }
}

/** Transaction client type, for services that accept an ambient transaction. */
export type PrismaTransactionClient = Omit<
  PrismaClient,
  '$connect' | '$disconnect' | '$on' | '$transaction' | '$use' | '$extends'
>;
