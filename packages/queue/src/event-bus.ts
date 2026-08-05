import { type ApplicationEvent, applicationEventSchema } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { createRedisConnection, type Redis } from './connection';

export const EVENT_BUS_CHANNEL = 'exocortex:events';

export interface EventBusOptions {
  redisUrl: string;
  logger: Logger;
  channel?: string;
}

export type ApplicationEventHandler = (event: ApplicationEvent) => void | Promise<void>;

/**
 * Redis pub/sub bridge for application events.
 *
 * This is the horizontal-scaling boundary of the realtime layer (ADR-008):
 *
 *   worker / API instance  --publish-->  Redis channel  --subscribe-->  every
 *   API instance  --emit-->  its local Socket.IO rooms
 *
 * Events are validated on both ends, so a malformed publisher cannot inject
 * arbitrary payloads into connected browsers.
 */
export class RedisEventBus {
  private readonly publisher: Redis;
  private subscriber: Redis | null = null;
  private readonly logger: Logger;
  private readonly channel: string;

  constructor(options: EventBusOptions) {
    this.channel = options.channel ?? EVENT_BUS_CHANNEL;
    this.logger = options.logger.child({ component: 'event-bus' });
    this.publisher = createRedisConnection(options.redisUrl);
  }

  async publish(event: ApplicationEvent): Promise<void> {
    const parsed = applicationEventSchema.safeParse(event);
    if (!parsed.success) {
      // Never publish an unvalidated payload; fail loudly instead.
      throw new Error(
        `Refusing to publish invalid application event "${event.type}": ` +
          parsed.error.issues.map((issue) => issue.message).join('; '),
      );
    }
    await this.publisher.publish(this.channel, JSON.stringify(parsed.data));
  }

  /** Subscribes with a dedicated connection, as Redis requires. */
  async subscribe(handler: ApplicationEventHandler): Promise<void> {
    if (this.subscriber !== null) {
      throw new Error('Event bus is already subscribed');
    }
    this.subscriber = this.publisher.duplicate();
    await this.subscriber.subscribe(this.channel);
    this.subscriber.on('message', (_channel, payload) => {
      const parsed = applicationEventSchema.safeParse(JSON.parse(payload) as unknown);
      if (!parsed.success) {
        this.logger.warn('Dropping malformed application event from the bus', {
          reason: parsed.error.issues.map((issue) => issue.message).join('; '),
        });
        return;
      }
      void Promise.resolve(handler(parsed.data)).catch((error: unknown) => {
        this.logger.error('Application event handler failed', error, { type: parsed.data.type });
      });
    });
    this.logger.info('Subscribed to the application event bus', { channel: this.channel });
  }

  async close(): Promise<void> {
    if (this.subscriber !== null) {
      await this.subscriber.quit();
      this.subscriber = null;
    }
    await this.publisher.quit();
  }
}
