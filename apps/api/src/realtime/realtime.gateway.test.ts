import { type Socket } from 'socket.io';
import { describe, expect, it, vi } from 'vitest';

import { type WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
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

function createSocket(): Socket {
  return {
    id: 'socket-1',
    data: {},
    handshake: { headers: {} },
    join: vi.fn(async () => undefined),
    leave: vi.fn(async () => undefined),
    emit: vi.fn(),
    disconnect: vi.fn(),
  } as unknown as Socket;
}

function createGateway(verifySession: () => Promise<{ userId: string } | null>): RealtimeGateway {
  const auth = { verifySession } as unknown as AuthService;
  const access = { findRole: async () => 'MEMBER' } as unknown as WorkspaceAccessService;
  const env = { REDIS_URL: 'redis://127.0.0.1:6379' } as ApiEnv;
  return new RealtimeGateway(auth, access, logger, env);
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
});
