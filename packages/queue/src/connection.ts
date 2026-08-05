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

export type { Redis };
