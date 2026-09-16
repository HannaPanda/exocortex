import { Inject, Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  type OnGatewayConnection,
  type OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { type Server, type Socket } from 'socket.io';

import { canSubscribeToWorkspaceRoom, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv } from '@exocortex/config';
import {
  type ApplicationEvent,
  type AuthorizationRevocation,
  REALTIME_EVENT_NAME,
  REALTIME_REVOCATION_EVENT_NAME,
  REALTIME_SOCKET_PATH,
  subscribeWorkspaceMessageSchema,
  type SubscriptionResult,
  userRoom,
  workspaceRoom,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import { RedisEventBus, RedisRevocationBus } from '@exocortex/queue';

import { AuthService } from '../auth/auth.service';
import { API_ENV, LOGGER } from '../common/logger.provider';

interface SocketData {
  userId?: string;
  /**
   * Resolves once `handleConnection` has finished deciding who this socket is.
   *
   * Socket.IO does not wait for an asynchronous connection handler before it
   * delivers the first message, so a `workspace.subscribe` that arrives while
   * the session is still being verified used to find `userId` unset and be
   * answered `unauthenticated`. The socket stayed open and connected, the
   * client had no reason to try again, and that browser was deaf to every
   * workspace event until the tab was reloaded: a page created from MCP never
   * appeared in the tree, a rename never arrived. The window is small and opens
   * whenever session verification is slow, which is exactly when the server is
   * busy.
   */
  authenticated?: Promise<void>;
  subscribedWorkspaces: Set<string>;
}

function socketData(client: Socket): SocketData {
  const existing = client.data as Partial<SocketData>;
  if (existing.subscribedWorkspaces === undefined) {
    existing.subscribedWorkspaces = new Set<string>();
  }
  return existing as SocketData;
}

/**
 * How often every open socket's subscriptions are checked against the database.
 *
 * The revocation channel is the fast path and normally the only one that does
 * anything; this sweep is the net under it, for the second when a process was
 * starting up and missed a message, or when Redis dropped one. A minute is
 * short enough that a stale subscription is a curiosity rather than a hole, and
 * long enough that the queries do not matter: one per subscribed workspace.
 */
const SUBSCRIPTION_RECHECK_INTERVAL_MS = 60_000;

/**
 * Application realtime channel.
 *
 * Deliberately separate from the Yjs/Hocuspocus protocol (ADR-008): domain events
 * never travel over the collaboration socket and vice versa.
 *
 * Security model:
 *  * the handshake is authenticated with the session cookie; unauthenticated
 *    sockets are disconnected immediately
 *  * clients never send raw room names, only a `workspaceId`
 *  * every subscription re-checks workspace membership on the server
 */
@Injectable()
@WebSocketGateway({
  path: REALTIME_SOCKET_PATH,
  serveClient: false,
  transports: ['websocket', 'polling'],
  cors: { origin: true, credentials: true },
})
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect, OnModuleInit, OnModuleDestroy
{
  @WebSocketServer()
  private server!: Server;

  private readonly bus: RedisEventBus;

  private readonly revocations: RedisRevocationBus;

  /**
   * Local sockets per user, so a revocation does not have to walk every socket
   * on the instance. Maintained by `handleConnection` and `handleDisconnect`;
   * sockets that never authenticated never appear here.
   */
  private readonly socketsByUser = new Map<string, Set<Socket>>();

  private recheckTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly authService: AuthService,
    private readonly access: WorkspaceAccessService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
    this.revocations = new RedisRevocationBus({ redisUrl: env.REDIS_URL, logger });
  }

  async onModuleInit(): Promise<void> {
    // Events published by the worker or by another API instance are forwarded to
    // the sockets connected to *this* instance.
    await this.bus.subscribe((event) => {
      this.broadcastLocally(event);
    });
    // Authorization that was withdrawn elsewhere -- in this process, in another
    // API instance, in the admin area -- reaches the sockets held here.
    await this.revocations.subscribe((revocation) => {
      this.applyRevocation(revocation);
    });
    this.recheckTimer = setInterval(() => {
      void this.recheckSubscriptions();
    }, SUBSCRIPTION_RECHECK_INTERVAL_MS);
    this.recheckTimer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.recheckTimer !== null) {
      clearInterval(this.recheckTimer);
      this.recheckTimer = null;
    }
    await this.bus.close();
    await this.revocations.close();
  }

  /** Publishes a revocation to every API and collaboration instance. */
  async publishRevocation(revocation: AuthorizationRevocation): Promise<void> {
    await this.revocations.publish(revocation);
  }

  /** Publishes an event to every API instance. */
  async publish(event: ApplicationEvent): Promise<void> {
    await this.bus.publish(event);
  }

  private broadcastLocally(event: ApplicationEvent): void {
    this.server?.to(workspaceRoom(event.workspaceId)).emit(REALTIME_EVENT_NAME, event);
  }

  async handleConnection(client: Socket): Promise<void> {
    // Published *before* the first await, so a message that arrives during
    // verification has something to wait for. See `SocketData.authenticated`.
    const data = socketData(client);
    const verification = this.authService.verifySession(
      client.handshake.headers as Record<string, string | string[] | undefined>,
    );
    // Never a rejected promise: a waiting subscription must fall through to the
    // `userId === undefined` check below, not blow up in the message handler.
    data.authenticated = verification.then(
      () => undefined,
      () => undefined,
    );

    const session = await verification;

    if (session === null) {
      this.logger.warn('Rejected unauthenticated realtime connection', { socketId: client.id });
      client.emit(REALTIME_EVENT_NAME, {
        type: 'connection.rejected',
        reason: 'unauthenticated',
      });
      client.disconnect(true);
      return;
    }

    data.userId = session.userId;
    this.track(session.userId, client);
    await client.join(userRoom(session.userId));
    // `info`, not `debug`: this line and its counterpart in `handleDisconnect`
    // are the only server-side record of a socket's lifetime, and a deployment
    // runs at `info`. Without them an outage looks identical to a browser that
    // never called -- the nginx access log shows a 101 either way, because it
    // logs a websocket only once it has already closed. (2026-09-08)
    this.logger.info('Realtime connection established', {
      socketId: client.id,
      userId: session.userId,
    });
  }

  handleDisconnect(client: Socket): void {
    const { userId } = socketData(client);
    if (userId !== undefined) this.forget(userId, client);
    this.logger.info('Realtime connection closed', {
      socketId: client.id,
      userId,
    });
  }

  private track(userId: string, client: Socket): void {
    const existing = this.socketsByUser.get(userId);
    if (existing === undefined) {
      this.socketsByUser.set(userId, new Set([client]));
      return;
    }
    existing.add(client);
  }

  private forget(userId: string, client: Socket): void {
    const existing = this.socketsByUser.get(userId);
    if (existing === undefined) return;
    existing.delete(client);
    if (existing.size === 0) this.socketsByUser.delete(userId);
  }

  /**
   * Withdraws what a user's open sockets were allowed to receive (issue #62).
   *
   * A workspace-scoped revocation takes the socket out of that room and says so,
   * which is the whole fix for "a removed member keeps receiving events": the
   * socket survives, because the other workspaces on it are none of this
   * change's business. The browser answers by subscribing again, and that
   * subscription is authorized from scratch -- so a promotion lands through the
   * front door rather than leaking into a connection that predates it.
   *
   * An account-scoped one disconnects instead. There is nothing left for that
   * socket to be right about, and its session row is already gone.
   */
  private applyRevocation(revocation: AuthorizationRevocation): void {
    const sockets = this.socketsByUser.get(revocation.userId);
    if (sockets === undefined) return;

    for (const socket of [...sockets]) {
      if (revocation.workspaceId === null) {
        this.logger.info('Disconnecting a realtime socket after an account change', {
          socketId: socket.id,
          userId: revocation.userId,
          reason: revocation.reason,
        });
        socket.emit(REALTIME_EVENT_NAME, {
          type: 'connection.rejected',
          reason: revocation.reason,
        });
        socket.disconnect(true);
        continue;
      }

      this.dropSubscription(socket, revocation.workspaceId, revocation.reason);
    }
  }

  private dropSubscription(socket: Socket, workspaceId: string, reason: string): void {
    const data = socketData(socket);
    if (!data.subscribedWorkspaces.has(workspaceId)) return;

    data.subscribedWorkspaces.delete(workspaceId);
    void socket.leave(workspaceRoom(workspaceId));
    socket.emit(REALTIME_REVOCATION_EVENT_NAME, { workspaceId, reason });
    this.logger.info('Dropped a realtime subscription after an authorization change', {
      socketId: socket.id,
      userId: data.userId,
      workspaceId,
      reason,
    });
  }

  /**
   * Second line of defence: re-checks every open subscription against the
   * database, and disconnects sockets whose account was switched off.
   *
   * Runs on a timer rather than on an event, so a revocation that was published
   * while this process was not listening still takes effect, just later.
   */
  private async recheckSubscriptions(): Promise<void> {
    if (this.socketsByUser.size === 0) return;

    try {
      const disabled = await this.access.findDisabledUserIds([...this.socketsByUser.keys()]);

      for (const [userId, sockets] of [...this.socketsByUser]) {
        if (disabled.has(userId)) {
          this.applyRevocation({
            userId,
            workspaceId: null,
            reason: 'account_disabled',
            emittedAt: new Date().toISOString(),
            correlationId: 'realtime-recheck',
          });
          continue;
        }

        for (const socket of [...sockets]) {
          await this.recheckSocket(socket, userId);
        }
      }
    } catch (error) {
      // A failed sweep is a missed net, not a reason to take the gateway down.
      this.logger.error('Realtime subscription re-check failed', error);
    }
  }

  /** One socket's subscriptions, checked against the membership behind them. */
  private async recheckSocket(socket: Socket, userId: string): Promise<void> {
    for (const workspaceId of [...socketData(socket).subscribedWorkspaces]) {
      const role = await this.access.findRole(workspaceId, userId);
      if (canSubscribeToWorkspaceRoom(role).allowed) continue;
      this.dropSubscription(socket, workspaceId, 'workspace_membership_removed');
    }
  }

  @SubscribeMessage('workspace.subscribe')
  async subscribeWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<SubscriptionResult> {
    const parsed = subscribeWorkspaceMessageSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, code: 'validation_failed', message: 'Invalid subscription payload' };
    }

    const data = socketData(client);
    // A subscription that overtook the handshake waits for it rather than being
    // turned away; only a socket that really carries no session is refused.
    await data.authenticated;
    if (data.userId === undefined) {
      return { ok: false, code: 'unauthenticated', message: 'Socket is not authenticated' };
    }

    const role = await this.access.findRole(parsed.data.workspaceId, data.userId);
    const decision = canSubscribeToWorkspaceRoom(role);
    if (!decision.allowed) {
      this.logger.warn('Rejected realtime room subscription', {
        socketId: client.id,
        userId: data.userId,
        workspaceId: parsed.data.workspaceId,
        code: decision.code,
      });
      return { ok: false, code: decision.code, message: decision.reason };
    }

    const room = workspaceRoom(parsed.data.workspaceId);
    await client.join(room);
    data.subscribedWorkspaces.add(parsed.data.workspaceId);
    return { ok: true, room };
  }

  @SubscribeMessage('workspace.unsubscribe')
  async unsubscribeWorkspace(
    @ConnectedSocket() client: Socket,
    @MessageBody() body: unknown,
  ): Promise<SubscriptionResult> {
    const parsed = subscribeWorkspaceMessageSchema.safeParse(body);
    if (!parsed.success) {
      return { ok: false, code: 'validation_failed', message: 'Invalid subscription payload' };
    }
    const room = workspaceRoom(parsed.data.workspaceId);
    await client.leave(room);
    socketData(client).subscribedWorkspaces.delete(parsed.data.workspaceId);
    return { ok: true, room };
  }
}
