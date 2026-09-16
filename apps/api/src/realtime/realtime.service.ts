import { Inject, Injectable } from '@nestjs/common';

import {
  type ApplicationEvent,
  type ApplicationEventOf,
  type ApplicationEventType,
  type AuthorizationRevocationReason,
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

  /**
   * Tells every process holding long-lived connections that a user's access
   * changed (issue #62).
   *
   * `workspaceId: null` means the account itself: every connection it holds,
   * in every workspace, is affected.
   *
   * Like `emit`, a failure is logged rather than thrown: the membership change
   * that caused it is already committed, and refusing the HTTP response would
   * only make the caller believe it did not happen. The periodic re-checks in
   * the gateway and in the collaboration server are what makes that survivable.
   */
  async revoke(input: {
    userId: string;
    workspaceId: string | null;
    reason: AuthorizationRevocationReason;
    correlationId: string;
  }): Promise<void> {
    try {
      await this.gateway.publishRevocation({
        userId: input.userId,
        workspaceId: input.workspaceId,
        reason: input.reason,
        emittedAt: new Date().toISOString(),
        correlationId: input.correlationId,
      });
    } catch (error) {
      this.logger.error('Failed to publish an authorization revocation', error, {
        userId: input.userId,
        scope: input.workspaceId ?? 'account',
        reason: input.reason,
      });
    }
  }
}
