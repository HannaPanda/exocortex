import { Redis, type RedisOptions } from 'ioredis';

/**
 * Creates a Redis connection configured for BullMQ.
 *
 * BullMQ requires `maxRetriesPerRequest: null` on connections used by workers,
 * otherwise blocking commands fail during a reconnect.
 */
export function createRedisConnection(url: string, overrides: RedisOptions = {}): Redis {
  return new Redis(url, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    lazyConnect: false,
    ...overrides,
  });
}

/**
 * Closes a connection without opening one first.
 *
 * `quit()` is itself a command, so on a `lazyConnect` client that was never
 * used it does not close anything -- it dials Redis in order to say goodbye.
 * A bus that was constructed and never published to would therefore connect
 * during shutdown, which is precisely what `lazyConnect` was chosen to avoid.
 *
 * `wait` is ioredis' status for "lazy and not connected yet", `end` for
 * "already closed"; in both cases `disconnect()` tears down the client without
 * sending anything.
 */
export async function closeConnection(connection: Redis): Promise<void> {
  if (connection.status === 'wait' || connection.status === 'end') {
    connection.disconnect();
    return;
  }
  await connection.quit();
}

export type { Redis };
