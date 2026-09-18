import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { type FastifyReply } from 'fastify';

import { canSubscribeToWorkspaceRoom, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import { type ApplicationEvent, type AuthorizationRevocation } from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import {
  LATEST_PROTOCOL_VERSION,
  ResourceSubscriptions,
  resourceUpdatedNotification,
  resourceUrisForEvent,
} from '@exocortex/mcp-tools';
import { RedisEventBus, RedisRevocationBus } from '@exocortex/queue';

import { API_ENV, LOGGER } from '../common/logger.provider';

/**
 * The server-initiated half of MCP over HTTP (issue #48, ADR-035).
 *
 * Everything else in this module answers a request and forgets it. A
 * subscription cannot work that way: the client asks once and the answer
 * arrives minutes later, so something has to stay open. Two kinds of stream do
 * that here, and they differ only in what they write:
 *
 *  * **A session stream** (`GET /api/mcp`) is the Streamable HTTP channel of
 *    one MCP connection. It carries JSON-RPC notifications and only for the
 *    URIs that connection subscribed to.
 *  * **A change feed** (`GET /api/mcp/changes`) serves the stdio bin, which is
 *    an MCP *server* elsewhere and only needs to hear what changed. It carries
 *    plain URIs and the subprocess filters them against its own subscriptions.
 *
 * What both share is the part that matters: every message is authorized at the
 * moment it is written, by asking the database whether this user may read the
 * workspace the event came from. There is no cached room membership to go
 * stale, which is why these streams need no periodic re-authorization sweep
 * the way the Socket.IO gateway does (ADR-029) -- only a check for an account
 * that was switched off, since a disabled account keeps its memberships.
 */

/**
 * Seconds between heartbeat comments.
 *
 * Under every idle timeout between a client and this process: nginx closes an
 * idle upstream response after 300 s, and whatever proxy a remote client sits
 * behind will be less patient than that. A comment line rather than an event,
 * so a client that parses strictly still sees nothing but silence.
 */
const HEARTBEAT_SECONDS = 25;

/** How often disabled accounts are swept off their streams. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * How long a subscription set survives with no stream behind it.
 *
 * A client may subscribe before it opens its stream, and it may reconnect the
 * stream without repeating its subscriptions, so the set cannot die with the
 * socket. It must not live forever either: a client that never comes back
 * would leave its URIs in memory until this process restarts.
 */
const IDLE_SESSION_TTL_MS = 30 * 60_000;

/** Streams one account may hold at once, over both endpoints together. */
const MAX_STREAMS_PER_USER = 8;

/** A connection this process is holding open. */
interface Sink {
  readonly userId: string;
  /**
   * The MCP connection behind a session stream, or `null` for a change feed,
   * which does its own filtering in the subprocess.
   */
  readonly subscriptions: ResourceSubscriptions | null;
  write(payload: unknown): void;
  comment(): void;
  close(): void;
}

/** One MCP connection's state, which outlives any single request. */
interface Session {
  readonly userId: string;
  readonly subscriptions: ResourceSubscriptions;
  lastSeenAt: number;
  sink: Sink | null;
}

@Injectable()
export class McpStreamsService implements OnModuleInit, OnModuleDestroy {
  private readonly bus: RedisEventBus;

  private readonly revocations: RedisRevocationBus;

  /**
   * Keyed by user *and* session id, never by session id alone: the id comes
   * out of a client-supplied header, so two accounts are free to send the
   * same one, and a map keyed on it would hand one account the other's
   * subscriptions.
   */
  private readonly sessions = new Map<string, Session>();

  /** Every open stream, including the change feeds, which have no session. */
  private readonly sinks = new Set<Sink>();

  private heartbeatTimer: NodeJS.Timeout | null = null;

  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly access: WorkspaceAccessService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
    this.revocations = new RedisRevocationBus({ redisUrl: env.REDIS_URL, logger });
  }

  async onModuleInit(): Promise<void> {
    await this.bus.subscribe((event) => {
      void this.deliver(event);
    });
    await this.revocations.subscribe((revocation) => {
      this.applyRevocation(revocation);
    });

    this.heartbeatTimer = setInterval(() => {
      for (const sink of this.sinks) sink.comment();
    }, HEARTBEAT_SECONDS * 1000);
    this.heartbeatTimer.unref();

    this.sweepTimer = setInterval(() => {
      void this.sweep();
    }, SWEEP_INTERVAL_MS);
    this.sweepTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.heartbeatTimer !== null) clearInterval(this.heartbeatTimer);
    if (this.sweepTimer !== null) clearInterval(this.sweepTimer);
    for (const sink of [...this.sinks]) sink.close();
    await this.bus.close();
    await this.revocations.close();
  }

  /**
   * The subscription set a POST on this connection writes into.
   *
   * Created on demand, because the order is the client's to choose: some
   * subscribe first and open the stream afterwards, some the other way round,
   * and both are correct. What must not happen is that one of the two orders
   * silently loses the subscriptions.
   */
  private session(userId: string, sessionId: string): Session {
    const key = sessionKey(userId, sessionId);
    const existing = this.sessions.get(key);
    if (existing !== undefined) {
      existing.lastSeenAt = Date.now();
      return existing;
    }
    const created: Session = {
      userId,
      subscriptions: new ResourceSubscriptions(),
      lastSeenAt: Date.now(),
      sink: null,
    };
    this.sessions.set(key, created);
    return created;
  }

  /** See `session`. What `McpService.createHandler` hands the dispatcher. */
  subscriptionsFor(userId: string, sessionId: string): ResourceSubscriptions {
    return this.session(userId, sessionId).subscriptions;
  }

  /**
   * Opens the Streamable HTTP channel of one MCP connection.
   *
   * Returns `false` when this account already holds too many streams, which
   * the controller turns into a refusal rather than a silent extra socket.
   */
  openSessionStream(input: { userId: string; sessionId: string; reply: FastifyReply }): boolean {
    if (this.countFor(input.userId) >= MAX_STREAMS_PER_USER) return false;

    // Reuses the set a POST may already have filled: a client that subscribes
    // and then opens its stream is doing nothing wrong, and losing those
    // subscriptions would break it in a way it cannot see.
    const session = this.session(input.userId, input.sessionId);

    // One stream per connection. A second one means the client reconnected
    // and the old socket is a corpse this process has not noticed yet.
    session.sink?.close();

    const sink = this.attach({
      userId: input.userId,
      reply: input.reply,
      subscriptions: session.subscriptions,
      headers: { 'mcp-session-id': input.sessionId },
      onClose: () => {
        if (session.sink === sink) session.sink = null;
      },
    });
    session.sink = sink;
    session.lastSeenAt = Date.now();

    this.logger.info('MCP session stream opened', {
      userId: input.userId,
      sessionId: input.sessionId,
      subscriptions: session.subscriptions.size,
    });
    return true;
  }

  /**
   * Opens the raw change feed for a stdio MCP server.
   *
   * No session and no subscription set: the subprocess holds those, because it
   * is the one that answered `resources/subscribe`. What it gets here is every
   * resource URI it may see, which is more than it asked for and never more
   * than it may read.
   */
  openChangeFeed(input: { userId: string; reply: FastifyReply }): boolean {
    if (this.countFor(input.userId) >= MAX_STREAMS_PER_USER) return false;

    this.attach({
      userId: input.userId,
      reply: input.reply,
      subscriptions: null,
      headers: {},
      ready: { ready: true, heartbeatSeconds: HEARTBEAT_SECONDS },
      onClose: () => undefined,
    });
    this.logger.info('MCP change feed opened', { userId: input.userId });
    return true;
  }

  /** Turns a Fastify reply into an SSE sink and registers it. */
  private attach(input: {
    userId: string;
    reply: FastifyReply;
    subscriptions: ResourceSubscriptions | null;
    headers: Record<string, string>;
    ready?: unknown;
    onClose: () => void;
  }): Sink {
    const { raw } = input.reply;
    // Fastify must stop managing this response: what follows is written by
    // hand over minutes, not serialized and sent in one piece.
    input.reply.hijack();
    raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      // Belt and braces next to nginx's `proxy_buffering off`: a proxy that
      // buffers an event stream turns every notification into a message that
      // arrives when the connection finally closes.
      'x-accel-buffering': 'no',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      ...input.headers,
    });

    let open = true;
    const sink: Sink = {
      userId: input.userId,
      subscriptions: input.subscriptions,
      write: (payload: unknown): void => {
        if (!open) return;
        raw.write(`data: ${JSON.stringify(payload)}\n\n`);
      },
      comment: (): void => {
        if (!open) return;
        raw.write(': ping\n\n');
      },
      close: (): void => {
        if (!open) return;
        open = false;
        this.sinks.delete(sink);
        input.onClose();
        raw.end();
      },
    };

    this.sinks.add(sink);
    raw.on('close', () => {
      open = false;
      this.sinks.delete(sink);
      input.onClose();
    });

    if (input.ready !== undefined) sink.write(input.ready);
    return sink;
  }

  /**
   * One application event, to everyone holding a stream who may see it.
   *
   * The authorization question is asked once per interested account rather
   * than once per stream, and it is asked now rather than remembered from when
   * the stream opened. That is the whole security model of this file: a
   * membership that was withdrawn a second ago cannot deliver a message, with
   * or without the revocation channel below arriving in time.
   */
  async deliver(event: ApplicationEvent): Promise<void> {
    if (this.sinks.size === 0) return;
    const uris = resourceUrisForEvent(event);
    if (uris.length === 0) return;

    const interested = new Map<string, { sink: Sink; uris: string[] }[]>();
    for (const sink of this.sinks) {
      const wanted = sink.subscriptions === null ? uris : sink.subscriptions.matching(uris);
      if (wanted.length === 0) continue;
      const forUser = interested.get(sink.userId) ?? [];
      forUser.push({ sink, uris: wanted });
      interested.set(sink.userId, forUser);
    }
    if (interested.size === 0) return;

    const changedAt = new Date().toISOString();
    for (const [userId, entries] of interested) {
      try {
        const role = await this.access.findRole(event.workspaceId, userId);
        if (!canSubscribeToWorkspaceRoom(role).allowed) continue;
        for (const entry of entries) {
          if (entry.sink.subscriptions === null) {
            entry.sink.write({ uris: entry.uris, changedAt });
            continue;
          }
          for (const uri of entry.uris) {
            entry.sink.write(resourceUpdatedNotification(uri));
          }
        }
      } catch (error) {
        // One account's check failing must not silence the others, and a
        // notification that was not sent is a missed refresh, not a defect
        // the caller of the write should hear about.
        this.logger.error('MCP stream delivery failed for one account', error, {
          userId,
          workspaceId: event.workspaceId,
          eventType: event.type,
        });
      }
    }
  }

  /**
   * Authorization was withdrawn somewhere (ADR-029).
   *
   * The stream is closed rather than filtered, and the subscriptions behind it
   * are dropped with it. MCP has no way to say "you are no longer allowed to
   * watch that page", so a stream that stayed open with a quietly shortened
   * list would be a client that believes it is still watching. A closed stream
   * is something every client already knows how to answer: it reconnects, and
   * what it subscribes to then is authorized from scratch.
   */
  applyRevocation(revocation: AuthorizationRevocation): void {
    for (const sink of [...this.sinks]) {
      if (sink.userId !== revocation.userId) continue;
      this.logger.info('Closing an MCP stream after an authorization change', {
        userId: revocation.userId,
        scope: revocation.workspaceId ?? 'account',
        reason: revocation.reason,
      });
      sink.close();
    }
    for (const [key, session] of [...this.sessions]) {
      if (session.userId !== revocation.userId) continue;
      session.subscriptions.clear();
      this.sessions.delete(key);
    }
  }

  /**
   * The net under the revocation channel, and the only sweep these streams
   * need: an account that was switched off keeps its memberships, so the
   * per-event check above would go on saying yes.
   */
  private async sweep(): Promise<void> {
    const cutoff = Date.now() - IDLE_SESSION_TTL_MS;
    for (const [key, session] of [...this.sessions]) {
      if (session.sink === null && session.lastSeenAt < cutoff) {
        this.sessions.delete(key);
      }
    }

    const userIds = [...new Set([...this.sinks].map((sink) => sink.userId))];
    if (userIds.length === 0) return;
    try {
      const disabled = await this.access.findDisabledUserIds(userIds);
      for (const userId of disabled) {
        this.applyRevocation({
          userId,
          workspaceId: null,
          reason: 'account_disabled',
          emittedAt: new Date().toISOString(),
          correlationId: 'mcp-stream-sweep',
        });
      }
    } catch (error) {
      this.logger.error('MCP stream sweep failed', error);
    }
  }

  private countFor(userId: string): number {
    let count = 0;
    for (const sink of this.sinks) {
      if (sink.userId === userId) count += 1;
    }
    return count;
  }
}

function sessionKey(userId: string, sessionId: string): string {
  return `${userId} ${sessionId}`;
}
