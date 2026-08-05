import { Inject, Injectable } from '@nestjs/common';

import {
  type ApplicationEvent,
  type ApplicationEventOf,
  type ApplicationEventType,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';

import { LOGGER } from '../common/logger.provider';

import { RealtimeGateway } from './realtime.gateway';

/**
 * Thin façade domain services use to emit application events.
 *
 * Keeping this out of the gateway means services never touch Socket.IO APIs and
 * the gateway stays a transport adapter.
 */
@Injectable()
export class RealtimeService {
  constructor(
    private readonly gateway: RealtimeGateway,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {}

  /** Builds and publishes an event. Failures are logged, never thrown at callers. */
  async emit<TType extends ApplicationEventType>(
    type: TType,
    workspaceId: string,
    correlationId: string,
    payload: ApplicationEventOf<TType>['payload'],
  ): Promise<void> {
    const event = {
      type,
      workspaceId,
      correlationId,
      emittedAt: new Date().toISOString(),
      payload,
    } as ApplicationEvent;

    try {
      await this.gateway.publish(event);
    } catch (error) {
      // A realtime delivery failure must not fail the request that caused it;
      // reliable follow-up work goes through the transactional outbox instead.
      this.logger.error('Failed to publish application event', error, {
        type,
        workspaceId,
        correlationId,
      });
    }
  }
}
