import {
  AUTHORIZATION_REVOCATION_CHANNEL,
  type AuthorizationRevocation,
  authorizationRevocationSchema,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { createRedisConnection, type Redis } from './connection';

export interface RevocationBusOptions {
  redisUrl: string;
  logger: Logger;
  channel?: string;
}

export type AuthorizationRevocationHandler = (
  revocation: AuthorizationRevocation,
) => void | Promise<void>;

/**
 * Redis pub/sub bridge for authorization revocations (issue #62).
 *
 *   API instance  --publish-->  Redis channel  --subscribe-->  every API and
 *   collaboration instance  --close-->  the connections that lost their rights
 *
 * Separate from `RedisEventBus` because the audiences are different: an
 * application event is broadcast into a workspace room, a revocation is matched
 * against the connections one process happens to hold. Sharing a channel would
 * mean publishing "this user just lost access" to every browser in the room.
 *
 * Delivery is best effort, as Redis pub/sub is: a process that is starting up
 * misses what was published a second earlier. That is why both consumers also
 * re-check their open connections periodically instead of trusting the channel
 * as their only source of truth.
 */
export class RedisRevocationBus {
  private readonly publisher: Redis;
  private subscriber: Redis | null = null;
  private readonly logger: Logger;
  private readonly channel: string;

  constructor(options: RevocationBusOptions) {
    this.channel = options.channel ?? AUTHORIZATION_REVOCATION_CHANNEL;
    this.logger = options.logger.child({ component: 'revocation-bus' });
    this.publisher = createRedisConnection(options.redisUrl);
  }

  async publish(revocation: AuthorizationRevocation): Promise<void> {
    const parsed = authorizationRevocationSchema.safeParse(revocation);
    if (!parsed.success) {
      throw new Error(
        `Refusing to publish an invalid authorization revocation: ` +
          parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    await this.publisher.publish(this.channel, JSON.stringify(parsed.data));
  }

  /** Subscribes with a dedicated connection, as Redis requires. */
  async subscribe(handler: AuthorizationRevocationHandler): Promise<void> {
    if (this.subscriber !== null) {
      throw new Error('Revocation bus is already subscribed');
    }
    this.subscriber = this.publisher.duplicate();
    await this.subscriber.subscribe(this.channel);
    this.subscriber.on('message', (_channel, payload) => {
      const parsed = authorizationRevocationSchema.safeParse(JSON.parse(payload) as unknown);
      if (!parsed.success) {
        this.logger.warn('Dropping a malformed revocation from the bus', {
          reason: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
        return;
      }
      void Promise.resolve(handler(parsed.data)).catch((error: unknown) => {
        this.logger.error('Revocation handler failed', error, { reason: parsed.data.reason });
      });
    });
    this.logger.info('Subscribed to the authorization revocation channel', {
      channel: this.channel,
    });
  }

  async close(): Promise<void> {
    if (this.subscriber !== null) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    await this.publisher.quit();
  }
}
