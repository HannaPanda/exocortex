import { type Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import { type WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type AuthorizationRevocation } from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';

import { type AuthService } from '../auth/auth.service';

import { RealtimeGateway } from './realtime.gateway';

/**
 * The handshake and the first message race each other.
 *
 * Socket.IO delivers messages without waiting for an asynchronous
 * `handleConnection`, so a `workspace.subscribe` can arrive while the session
 * is still being verified. It used to be answered `unauthenticated` on a socket
 * that then stayed open and connected: nothing retried, and that browser
 * received no workspace event again until it was reloaded.
 */

const logger = createLogger({ name: 'realtime-gateway-test', level: 'silent' });

/** A promise plus the handles to settle it later. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function createSocket(id = 'socket-1'): Socket {
  return {
    id,
    data: {},
    handshake: { headers: {} },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as Socket;
}

function createGateway(
  verifySession: () => Promise<{ userId: string } | null>,
  access: Partial<WorkspaceAccessService> = {},
): RealtimeGateway {
  const auth = { verifySession } as unknown as AuthService;
  const accessService = {
    findRole: async () => 'MEMBER',
    findDisabledUserIds: async () => new Set<string>(),
    ...access,
  } as unknown as WorkspaceAccessService;
  const env = { REDIS_URL: 'redis://127.0.0.1:6379' } as ApiEnv;
  return new RealtimeGateway(auth, accessService, logger, env);
}

/** Reaches the private handler the Redis subscription calls. */
function revoke(gateway: RealtimeGateway, revocation: AuthorizationRevocation): void {
  (
    gateway as unknown as { applyRevocation: (input: AuthorizationRevocation) => void }
  ).applyRevocation(revocation);
}

function revocation(overrides: Partial<AuthorizationRevocation>): AuthorizationRevocation {
  return {
    userId: 'user-1',
    workspaceId: 'workspace-1',
    reason: 'workspace_membership_removed',
    emittedAt: new Date().toISOString(),
    correlationId: 'test',
    ...overrides,
  };
}

describe('RealtimeGateway', () => {
  it('lets a subscription that overtook the handshake wait for it', async () => {
    const session = deferred<{ userId: string } | null>();
    const gateway = createGateway(() => session.promise);
    const client = createSocket();

    // The connection handler is still verifying when the message arrives.
    const connection = gateway.handleConnection(client);
    const subscription = gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' });

    session.resolve({ userId: 'user-1' });
    await connection;

    expect(await subscription).toEqual({ ok: true, room: 'workspace:workspace-1' });
  });

  it('still refuses a socket that carries no session', async () => {
    const gateway = createGateway(async () => null);
    const client = createSocket();

    await gateway.handleConnection(client);

    expect(await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' })).toEqual({
      ok: false,
      code: 'unauthenticated',
      message: 'Socket is not authenticated',
    });
  });

  it('refuses rather than throws when session verification fails', async () => {
    const gateway = createGateway(async () => {
      throw new Error('database unreachable');
    });
    const client = createSocket();

    await expect(gateway.handleConnection(client)).rejects.toThrow('database unreachable');

    expect(await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' })).toEqual({
      ok: false,
      code: 'unauthenticated',
      message: 'Socket is not authenticated',
    });
  });

  /**
   * Issue #62: a workspace room used to outlive the membership behind it.
   *
   * The socket itself survives -- the other workspaces on it have nothing to do
   * with this change -- and the browser is told, so it can ask again and be
   * authorized from scratch.
   */
  it('takes a revoked socket out of the workspace room and says so', async () => {
    const gateway = createGateway(async () => ({ userId: 'user-1' }));
    const client = createSocket();
    await gateway.handleConnection(client);
    await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' });

    revoke(gateway, revocation({ userId: 'user-1', workspaceId: 'workspace-1' }));

    expect(client.leave).toHaveBeenCalledWith('workspace:workspace-1');
    expect(client.emit).toHaveBeenCalledWith('exocortex.subscription.revoked', {
      workspaceId: 'workspace-1',
      reason: 'workspace_membership_removed',
    });
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  it('leaves the other workspaces on the same socket alone', async () => {
    const gateway = createGateway(async () => ({ userId: 'user-1' }));
    const client = createSocket();
    await gateway.handleConnection(client);
    await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' });
    await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-2' });

    revoke(gateway, revocation({ workspaceId: 'workspace-2' }));

    expect(client.leave).toHaveBeenCalledTimes(1);
    expect(client.leave).toHaveBeenCalledWith('workspace:workspace-2');
  });

  it('disconnects every socket of an account that was switched off', async () => {
    const gateway = createGateway(async () => ({ userId: 'user-1' }));
    const first = createSocket('socket-1');
    const second = createSocket('socket-2');
    await gateway.handleConnection(first);
    await gateway.handleConnection(second);

    revoke(gateway, revocation({ workspaceId: null, reason: 'account_disabled' }));

    expect(first.disconnect).toHaveBeenCalledWith(true);
    expect(second.disconnect).toHaveBeenCalledWith(true);
  });

  it('touches nobody else', async () => {
    const gateway = createGateway(async () => ({ userId: 'user-1' }));
    const client = createSocket();
    await gateway.handleConnection(client);
    await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' });

    revoke(gateway, revocation({ userId: 'somebody-else' }));

    expect(client.leave).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  });

  /**
   * The net under the channel: a revocation published while this instance was
   * not listening is caught by the sweep instead of lasting until the tab is
   * closed.
   */
  it('drops a subscription the database no longer backs, without any event', async () => {
    const gateway = createGateway(async () => ({ userId: 'user-1' }));
    const client = createSocket();
    await gateway.handleConnection(client);
    await gateway.subscribeWorkspace(client, { workspaceId: 'workspace-1' });

    // The membership is gone by the time the sweep runs.
    const sweepable = gateway as unknown as {
      access: { findRole: () => Promise<string | null> };
      recheckSubscriptions: () => Promise<void>;
    };
    sweepable.access.findRole = async () => null;
    await sweepable.recheckSubscriptions();

    expect(client.leave).toHaveBeenCalledWith('workspace:workspace-1');
  });

  it('disconnects a disabled account during the sweep', async () => {
    const gateway = createGateway(async () => ({ userId: 'user-1' }), {
      findDisabledUserIds: async () => new Set(['user-1']),
    });
    const client = createSocket();
    await gateway.handleConnection(client);

    await (
      gateway as unknown as { recheckSubscriptions: () => Promise<void> }
    ).recheckSubscriptions();

    expect(client.disconnect).toHaveBeenCalledWith(true);
  });
});
