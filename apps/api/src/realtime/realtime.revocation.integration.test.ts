import { type Socket } from 'socket.io';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { type WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { loadDotEnv } from '@exocortex/config';
import { createLogger } from '@exocortex/logger';
import { RedisRevocationBus } from '@exocortex/queue';

import { type AuthService } from '../auth/auth.service';

import { RealtimeGateway } from './realtime.gateway';

/**
 * The revocation channel against real Redis (issue #62, ADR-029).
 *
 * `realtime.gateway.test.ts` proves what the gateway does with a revocation;
 * this proves that one published by *another process* arrives at all, which is
 * the half that a mock cannot show and the half the acceptance criterion about
 * several API instances rests on.
 *
 * The channel is the deployment's own -- the gateway subscribes to the default
 * one, and pointing the test somewhere else would test a different channel. The
 * user id is therefore a random one nothing is connected as, so the live units
 * receive the message, find no socket for it, and do nothing.
 */
loadDotEnv();

const logger = createLogger({ name: 'realtime-revocation-test', level: 'silent' });
const redisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const userId = `test-user-${Date.now().toString(36)}`;
const workspaceId = `test-workspace-${Date.now().toString(36)}`;

let gateway: RealtimeGateway;
let publisher: RedisRevocationBus;

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

/** Waits until `predicate` holds or the timeout elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Timed out waiting for the revocation to arrive');
}

beforeAll(async () => {
  const auth = {
    verifySession: async () => ({ userId }),
  } as unknown as AuthService;
  const access = {
    findRole: async () => 'MEMBER',
    findDisabledUserIds: async () => new Set<string>(),
  } as unknown as WorkspaceAccessService;
  gateway = new RealtimeGateway(auth, access, logger, { REDIS_URL: redisUrl } as ApiEnv);
  await gateway.onModuleInit();
  publisher = new RedisRevocationBus({ redisUrl, logger });
}, 30_000);

afterAll(async () => {
  await publisher.close();
  await gateway.onModuleDestroy();
});

describe('revocations across processes', () => {
  it('drops a subscription when another process publishes the revocation', async () => {
    const client = createSocket();
    await gateway.handleConnection(client);
    await gateway.subscribeWorkspace(client, { workspaceId });

    await publisher.publish({
      userId,
      workspaceId,
      reason: 'workspace_membership_removed',
      emittedAt: new Date().toISOString(),
      correlationId: 'integration-test',
    });

    await waitFor(() => vi.mocked(client.leave).mock.calls.length > 0);
    expect(client.leave).toHaveBeenCalledWith(`workspace:${workspaceId}`);
    expect(client.disconnect).not.toHaveBeenCalled();
  }, 30_000);

  it('disconnects the socket when the account itself is revoked', async () => {
    const client = createSocket();
    await gateway.handleConnection(client);

    await publisher.publish({
      userId,
      workspaceId: null,
      reason: 'account_disabled',
      emittedAt: new Date().toISOString(),
      correlationId: 'integration-test',
    });

    await waitFor(() => vi.mocked(client.disconnect).mock.calls.length > 0);
    expect(client.disconnect).toHaveBeenCalledWith(true);
  }, 30_000);
});
