import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { verifyServiceToken } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type CollaborationApplyRequest } from '@exocortex/contracts';
import { createLogger } from '@exocortex/logger';

import { CollaborationBridgeService } from './collaboration-bridge.service';

/**
 * The wire between the API and the collaboration server: what is actually sent,
 * and what is made of the answer. The applying itself lives in the other
 * process and is covered by `apps/collaboration`.
 */

const SECRET = 'c'.repeat(64);

const logger = createLogger({ name: 'bridge-test', level: 'silent' });

interface Received {
  method: string;
  url: string;
  authorization: string | undefined;
  body: CollaborationApplyRequest;
}

let server: Server | undefined;

/** Starts a stand-in for the collaboration server on an ephemeral port. */
async function startStub(
  reply: (received: Received) => { status: number; body: unknown },
): Promise<{ baseUrl: string; received: Received[] }> {
  const received: Received[] = [];
  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const entry: Received = {
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as CollaborationApplyRequest,
      };
      received.push(entry);
      const { status, body } = reply(entry);
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(body));
    });
  });
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, received };
}

function createService(baseUrl: string): CollaborationBridgeService {
  return new CollaborationBridgeService(
    {
      COLLABORATION_INTERNAL_URL: baseUrl,
      COLLABORATION_TICKET_SECRET: SECRET,
    } as unknown as ApiEnv,
    logger,
  );
}

const document = { type: 'doc' as const, content: [{ type: 'paragraph' }] };

afterEach(async () => {
  const running = server;
  server = undefined;
  if (running !== undefined) await new Promise<void>((resolve) => running.close(() => resolve()));
});

describe('CollaborationBridgeService', () => {
  it('posts the change with a token minted for this purpose only', async () => {
    const { baseUrl, received } = await startStub(() => ({
      status: 200,
      body: { applied: true, clientsCount: 3, yjsUpdatedAt: '2026-08-06T10:00:00.000Z' },
    }));

    const result = await createService(baseUrl).applyToLiveSession({
      documentId: 'doc12345678',
      userId: 'user1234',
      mode: 'append',
      proseMirrorJson: document,
      correlationId: 'corr-1',
    });

    expect(received).toHaveLength(1);
    const call = received[0] as Received;
    expect(call.method).toBe('POST');
    expect(call.url).toBe('/internal/documents/doc12345678/content');
    expect(call.body).toMatchObject({ mode: 'append', correlationId: 'corr-1' });

    const token = (call.authorization ?? '').replace(/^Bearer\s+/, '');
    // A token that also opened the API's own service routes would widen this
    // loopback endpoint into a second way in.
    expect(
      verifyServiceToken({ secret: SECRET, token, expectedPurpose: 'ai-tools' }),
    ).toMatchObject({ valid: false, reason: 'wrong_purpose' });
    const verified = verifyServiceToken({
      secret: SECRET,
      token,
      expectedPurpose: 'collaboration-write',
    });
    expect(verified.valid && verified.claims.userId).toBe('user1234');

    expect(result).toEqual({
      applied: true,
      clientsCount: 3,
      yjsUpdatedAt: '2026-08-06T10:00:00.000Z',
      reachable: true,
    });
  });

  it('reports "not reachable" instead of throwing when nothing answers', async () => {
    // Port 1 on loopback: nothing listens there, and the connection is refused
    // at once rather than hanging.
    const result = await createService('http://127.0.0.1:1').applyToLiveSession({
      documentId: 'doc12345678',
      userId: 'user1234',
      mode: 'replace',
      proseMirrorJson: document,
      correlationId: 'corr-2',
    });

    expect(result).toEqual({
      applied: false,
      clientsCount: 0,
      yjsUpdatedAt: null,
      reachable: false,
    });
  });

  it('treats a refusal from the collaboration server as not reachable', async () => {
    const { baseUrl } = await startStub(() => ({ status: 403, body: { error: 'denied' } }));

    const result = await createService(baseUrl).applyToLiveSession({
      documentId: 'doc12345678',
      userId: 'user1234',
      mode: 'replace',
      proseMirrorJson: document,
      correlationId: 'corr-3',
    });

    // The write itself has already been committed; the caller only needs to
    // learn that open sessions were not updated.
    expect(result.applied).toBe(false);
    expect(result.reachable).toBe(false);
  });
});
