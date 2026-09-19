import { type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { type Hocuspocus } from '@hocuspocus/server';
import { describe, expect, it } from 'vitest';

import { issueServiceToken, type WorkspaceAccessService } from '@exocortex/auth';
import { type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';

import { createInternalContentHandler } from './internal-content';

/**
 * The refusals of the internal write route (ADR-016), without a database.
 *
 * This app used to have one test file and it was an integration test, so
 * nothing here ran in CI at all (issue #93). Every case below is a decision the
 * handler makes *before* it touches a document: whether the URL is its own,
 * whether the method and the service token are acceptable, whether the body
 * parses, and whether the token's user may write the page. That is the whole
 * security boundary of the route, and none of it needs Postgres, Redis or a
 * loaded Yjs document -- the happy path, which needs all three, stays in
 * `collaboration.integration.test.ts`.
 *
 * `prisma` and the Hocuspocus instance are never reached in these cases and are
 * handed in as empty objects on purpose: a fake with methods would suggest they
 * are part of what is being tested.
 */

const logger = createLogger({ name: 'internal-content-test', level: 'silent' });
const SECRET = 'c'.repeat(32);

/** A request body as a stream, which is all `readBody` needs from it. */
function request(options: {
  url: string;
  method?: string;
  token?: string;
  body?: string;
}): IncomingMessage {
  const stream = Readable.from([Buffer.from(options.body ?? '', 'utf8')]);
  return Object.assign(stream, {
    url: options.url,
    method: options.method ?? 'POST',
    headers: options.token === undefined ? {} : { authorization: `Bearer ${options.token}` },
  }) as unknown as IncomingMessage;
}

/** Records what was written instead of writing it. */
function response(): ServerResponse & { status: number | null; body: unknown } {
  const recorded = {
    status: null as number | null,
    body: undefined as unknown,
    writeHead(status: number) {
      recorded.status = status;
      return recorded;
    },
    end(payload?: string) {
      recorded.body = payload === undefined ? undefined : JSON.parse(payload);
      return recorded;
    },
  };
  return recorded as unknown as ServerResponse & { status: number | null; body: unknown };
}

function handlerWith(access: Partial<WorkspaceAccessService> = {}) {
  return createInternalContentHandler({
    prisma: {} as unknown as PrismaClient,
    access: access as unknown as WorkspaceAccessService,
    logger,
    secret: SECRET,
  });
}

const instance = {} as unknown as Hocuspocus;

function tokenFor(userId: string, purpose: 'collaboration-write' | 'ai-tools'): string {
  return issueServiceToken({ secret: SECRET, userId, purpose, ttlSeconds: 60 }).token;
}

const PATH = '/internal/documents/doc_abc123/content';

describe('the internal content route', () => {
  it('leaves a URL that is not its own to whoever else is listening', async () => {
    const res = response();
    const handled = await handlerWith()(request({ url: '/health' }), res, instance);

    expect(handled).toBe(false);
    expect(res.status).toBeNull();
  });

  it('answers 405 to a method that is not POST, without reading the token', async () => {
    const res = response();
    await handlerWith()(request({ url: PATH, method: 'GET' }), res, instance);

    expect(res.status).toBe(405);
    expect(res.body).toEqual({ error: 'method_not_allowed' });
  });

  it('refuses a request that carries no service token', async () => {
    const res = response();
    await handlerWith()(request({ url: PATH }), res, instance);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'service_token_missing' });
  });

  it('refuses a token minted for another purpose', async () => {
    const res = response();
    await handlerWith()(
      request({ url: PATH, token: tokenFor('user_1', 'ai-tools'), body: '{}' }),
      res,
      instance,
    );

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'service_token_invalid' });
  });

  it('refuses a token signed with a different secret', async () => {
    const foreign = issueServiceToken({
      secret: 'd'.repeat(32),
      userId: 'user_1',
      purpose: 'collaboration-write',
      ttlSeconds: 60,
    }).token;
    const res = response();
    await handlerWith()(request({ url: PATH, token: foreign, body: '{}' }), res, instance);

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'service_token_invalid' });
  });

  it('separates a body that is not JSON from one that is the wrong shape', async () => {
    const token = tokenFor('user_1', 'collaboration-write');

    const broken = response();
    await handlerWith()(request({ url: PATH, token, body: 'not json' }), broken, instance);
    expect(broken.status).toBe(400);
    expect(broken.body).toEqual({ error: 'invalid_json' });

    const wrong = response();
    await handlerWith()(
      request({ url: PATH, token, body: '{"mode":"nonsense"}' }),
      wrong,
      instance,
    );
    expect(wrong.status).toBe(400);
    expect(wrong.body).toEqual({ error: 'invalid_request' });
  });

  /**
   * The point of ADR-016's "a service token is a way in, never a way around":
   * the token verifies, and the answer still depends on what its user may do.
   */
  it('answers 404 when the token holder cannot see the document at all', async () => {
    const res = response();
    await handlerWith({ findDocumentContext: async () => null })(
      request({ url: PATH, token: tokenFor('user_1', 'collaboration-write'), body: body() }),
      res,
      instance,
    );

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'document_not_found' });
  });

  it('answers 403 when the token holder may read the document but not write it', async () => {
    const res = response();
    await handlerWith({
      findDocumentContext: async () => ({
        document: {
          id: 'doc_abc123',
          workspaceId: 'ws_1',
          archivedAt: null,
          parentId: null,
          title: '',
          type: 'PAGE',
        },
        role: 'GUEST',
        workspaceId: 'ws_1',
      }),
    } as unknown as Partial<WorkspaceAccessService>)(
      request({ url: PATH, token: tokenFor('user_1', 'collaboration-write'), body: body() }),
      res,
      instance,
    );

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'document_access_denied' });
  });

  it('answers 403 for an archived page even to an owner', async () => {
    const res = response();
    await handlerWith({
      findDocumentContext: async () => ({
        document: {
          id: 'doc_abc123',
          workspaceId: 'ws_1',
          archivedAt: new Date('2026-09-01T00:00:00.000Z'),
          parentId: null,
          title: '',
          type: 'PAGE',
        },
        role: 'OWNER',
        workspaceId: 'ws_1',
      }),
    } as unknown as Partial<WorkspaceAccessService>)(
      request({ url: PATH, token: tokenFor('user_1', 'collaboration-write'), body: body() }),
      res,
      instance,
    );

    expect(res.status).toBe(403);
  });
});

/** The smallest body the request schema accepts. */
function body(): string {
  return JSON.stringify({
    proseMirrorJson: { type: 'doc', content: [] },
    mode: 'replace',
    correlationId: 'test-correlation',
  });
}
