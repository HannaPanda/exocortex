import { type ExecutionContext } from '@nestjs/common';
import { type Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';

import { type WorkspaceAccessService } from '@exocortex/auth';

import { AdminGuard } from './admin.guard';
import { type AuthService } from './auth.service';
import { SessionGuard } from './session.guard';
import { TokenScopeGuard } from './token-scope.guard';

/**
 * The global guards must not touch a WebSocket message.
 *
 * NestJS 12 started running global guards on `@SubscribeMessage` handlers, and
 * in that context `switchToHttp()` hands back the socket and the payload rather
 * than a request and a reply. `ThrottlerGuard` wrote rate-limit headers onto the
 * socket and threw, which killed every realtime event the page tree depends on.
 * A socket authorizes itself in `RealtimeGateway` (ADR-008), so the right answer
 * here is for these guards to decline the question -- without reading anything
 * off the context, which is what the throwing accessors below prove.
 */
function wsContext(): ExecutionContext {
  const refuse = (): never => {
    throw new Error('a guard read the HTTP context of a WebSocket message');
  };
  return {
    getType: () => 'ws',
    getHandler: () => function handler() {},
    getClass: () => class Gateway {},
    switchToHttp: () => ({ getRequest: refuse, getResponse: refuse }),
    switchToWs: () => ({ getClient: () => ({}), getData: () => ({}) }),
  } as unknown as ExecutionContext;
}

/** Says every handler is `@AdminOnly()`, so the context check is what decides. */
const demandsAdmin = { getAllAndOverride: () => true } as unknown as Reflector;
/** Says no handler is `@Public()`, so the context check is what decides. */
const demandsSession = { getAllAndOverride: () => undefined } as unknown as Reflector;
const refusingAuth = {
  verifySession: (): never => {
    throw new Error('SessionGuard verified a WebSocket message');
  },
} as unknown as AuthService;
const refusingAccess = {
  findGlobalRole: (): never => {
    throw new Error('AdminGuard looked up a role for a WebSocket message');
  },
} as unknown as WorkspaceAccessService;

describe('global guards on a WebSocket message', () => {
  it('TokenScopeGuard passes it through without reading the request', () => {
    expect(new TokenScopeGuard().canActivate(wsContext())).toBe(true);
  });

  it('SessionGuard passes a non-public handler through without verifying anything', async () => {
    const guard = new SessionGuard(
      refusingAuth,
      demandsSession,
      null as never,
      null as never,
      null as never,
    );
    await expect(guard.canActivate(wsContext())).resolves.toBe(true);
  });

  it('AdminGuard passes an admin-only handler through without looking up a role', async () => {
    await expect(
      new AdminGuard(refusingAccess, demandsAdmin).canActivate(wsContext()),
    ).resolves.toBe(true);
  });
});
