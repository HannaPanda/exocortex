import { type FastifyReply } from 'fastify';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type ApplicationEvent, type DocumentSummary } from '@exocortex/contracts';
import { createLogger, type Logger } from '@exocortex/logger';

import { McpStreamsService } from './mcp-streams.service';

/**
 * Unit tests, with no Redis and no database behind them.
 *
 * `onModuleInit` is what subscribes to Redis; everything worth proving here is
 * what happens *after* an event arrives, so the two entry points are driven
 * directly. What matters is the authorization: a stream must hear about a
 * workspace exactly while its account may read it, and not one message longer.
 */

const logger: Logger = createLogger({ name: 'mcp-streams-test', level: 'silent' });
const env = { REDIS_URL: 'redis://127.0.0.1:6380' } as ApiEnv;

const WORKSPACE_ID = 'ws_1';
const PAGE_URI = 'exocortex://page/doc_1';

/** Membership this test controls, in place of the database. */
class FakeAccess {
  readonly members = new Set<string>();

  disabled = new Set<string>();

  async findRole(workspaceId: string, userId: string): Promise<'MEMBER' | null> {
    return workspaceId === WORKSPACE_ID && this.members.has(userId) ? 'MEMBER' : null;
  }

  async findDisabledUserIds(userIds: string[]): Promise<Set<string>> {
    return new Set(userIds.filter((userId) => this.disabled.has(userId)));
  }
}

interface FakeReply {
  reply: FastifyReply;
  frames: string[];
  ended: boolean;
  fireClose: () => void;
}

function fakeReply(): FakeReply {
  const frames: string[] = [];
  const state = { ended: false };
  let onClose: (() => void) | null = null;

  const raw = {
    writeHead: () => raw,
    write: (chunk: string) => {
      frames.push(chunk);
      return true;
    },
    end: () => {
      state.ended = true;
    },
    on: (event: string, listener: () => void) => {
      if (event === 'close') onClose = listener;
      return raw;
    },
  };

  return {
    reply: { raw, hijack: () => undefined } as unknown as FastifyReply,
    frames,
    get ended(): boolean {
      return state.ended;
    },
    fireClose: () => onClose?.(),
  };
}

function summary(): DocumentSummary {
  return {
    id: 'doc_1',
    workspaceId: WORKSPACE_ID,
    parentId: null,
    type: 'PAGE',
    title: 'Eine Seite',
    icon: null,
    iconColor: null,
    layout: 'narrow',
    overviewMode: 'off',
    coverAttachmentId: null,
    coverPosition: 50,
    orderKey: 'a0',
    createdById: 'user_1',
    updatedById: 'user_1',
    createdAt: '2026-09-18T10:00:00.000Z',
    updatedAt: '2026-09-18T10:00:00.000Z',
    archivedAt: null,
  };
}

const pageChanged: ApplicationEvent = {
  type: 'document.updated',
  workspaceId: WORKSPACE_ID,
  correlationId: 'test',
  emittedAt: '2026-09-18T10:00:00.000Z',
  payload: { document: summary() },
};

/** The payloads of every `data:` frame written to a fake reply. */
function payloads(reply: FakeReply): unknown[] {
  return reply.frames
    .filter((frame) => frame.startsWith('data: '))
    .map((frame) => JSON.parse(frame.slice('data: '.length)) as unknown);
}

let access: FakeAccess;
let streams: McpStreamsService;

beforeEach(() => {
  access = new FakeAccess();
  streams = new McpStreamsService(access as unknown as WorkspaceAccessService, logger, env);
});

afterEach(async () => {
  await streams.onModuleDestroy();
});

describe('McpStreamsService', () => {
  it('notifies a session only about the URIs it subscribed to', async () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'session_1').subscribe(PAGE_URI);
    const reply = fakeReply();
    expect(
      streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: reply.reply }),
    ).toBe(true);

    await streams.deliver(pageChanged);

    expect(payloads(reply)).toEqual([
      { jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri: PAGE_URI } },
    ]);
  });

  it('says nothing at all to a session that subscribed to something else', async () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'session_1').subscribe('exocortex://page/other');
    const reply = fakeReply();
    streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: reply.reply });

    await streams.deliver(pageChanged);

    expect(payloads(reply)).toEqual([]);
  });

  it('checks membership when the message is written, not when the stream opened', async () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'session_1').subscribe(PAGE_URI);
    const reply = fakeReply();
    streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: reply.reply });

    // The membership goes away without any revocation being published: a
    // dropped Redis message must not be the difference between a private page
    // staying private and not.
    access.members.delete('user_1');
    await streams.deliver(pageChanged);

    expect(payloads(reply)).toEqual([]);
  });

  it('keeps two accounts that chose the same session id apart', async () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'shared-id').subscribe(PAGE_URI);
    const foreign = streams.subscriptionsFor('user_2', 'shared-id');

    // The header is the client's to choose, so a collision is not an attack,
    // it is Tuesday. It must still not share anything.
    expect(foreign.list()).toEqual([]);
  });

  it('hands a change feed every URI it may see and lets the subprocess filter', async () => {
    access.members.add('user_1');
    const reply = fakeReply();
    expect(streams.openChangeFeed({ userId: 'user_1', reply: reply.reply })).toBe(true);

    await streams.deliver(pageChanged);

    const [ready, change] = payloads(reply) as [{ ready: boolean }, { uris: string[] }];
    expect(ready.ready).toBe(true);
    expect(change.uris).toContain(PAGE_URI);
    expect(change.uris).toContain(`exocortex://workspace/${WORKSPACE_ID}/tree`);
  });

  it('says nothing to a change feed whose account is not a member', async () => {
    const reply = fakeReply();
    streams.openChangeFeed({ userId: 'stranger', reply: reply.reply });

    await streams.deliver(pageChanged);

    // Only the handshake frame, never a URI: the listing must not even reveal
    // that a page in a foreign workspace exists.
    expect(payloads(reply)).toHaveLength(1);
  });

  it('closes the stream and drops the subscriptions when access is withdrawn', () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'session_1').subscribe(PAGE_URI);
    const reply = fakeReply();
    streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: reply.reply });

    streams.applyRevocation({
      userId: 'user_1',
      workspaceId: WORKSPACE_ID,
      reason: 'workspace_membership_removed',
      emittedAt: '2026-09-18T10:00:00.000Z',
      correlationId: 'test',
    });

    expect(reply.ended).toBe(true);
    // A reconnecting client starts from nothing, so whatever it watches next
    // was authorized after the change rather than before it (ADR-029).
    expect(streams.subscriptionsFor('user_1', 'session_1').list()).toEqual([]);
  });

  it('replaces a second stream on the same session rather than writing to both', async () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'session_1').subscribe(PAGE_URI);
    const first = fakeReply();
    const second = fakeReply();
    streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: first.reply });
    streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: second.reply });

    await streams.deliver(pageChanged);

    expect(first.ended).toBe(true);
    expect(payloads(first)).toEqual([]);
    expect(payloads(second)).toHaveLength(1);
  });

  it('forgets a stream the client hung up on', async () => {
    access.members.add('user_1');
    streams.subscriptionsFor('user_1', 'session_1').subscribe(PAGE_URI);
    const reply = fakeReply();
    streams.openSessionStream({ userId: 'user_1', sessionId: 'session_1', reply: reply.reply });
    reply.fireClose();

    await streams.deliver(pageChanged);

    expect(payloads(reply)).toEqual([]);
  });

  it('refuses to hold more streams for one account than the limit', () => {
    const opened: boolean[] = [];
    for (let index = 0; index < 10; index += 1) {
      opened.push(streams.openChangeFeed({ userId: 'user_1', reply: fakeReply().reply }));
    }

    expect(opened.filter(Boolean)).toHaveLength(8);
    expect(opened.at(-1)).toBe(false);
  });
});
