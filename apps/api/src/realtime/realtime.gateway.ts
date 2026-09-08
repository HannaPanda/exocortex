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
  REALTIME_EVENT_NAME,
  REALTIME_SOCKET_PATH,
  subscribeWorkspaceMessageSchema,
  type SubscriptionResult,
  userRoom,
  workspaceRoom,
} from '@exocortex/contracts';
import { type Logger } from '@exocortex/logger';
import { RedisEventBus } from '@exocortex/queue';

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

  constructor(
    private readonly authService: AuthService,
    private readonly access: WorkspaceAccessService,
    @Inject(LOGGER) private readonly logger: Logger,
    @Inject(API_ENV) env: ApiEnv,
  ) {
    this.bus = new RedisEventBus({ redisUrl: env.REDIS_URL, logger });
  }

  async onModuleInit(): Promise<void> {
    // Events published by the worker or by another API instance are forwarded to
    // the sockets connected to *this* instance.
    await this.bus.subscribe((event) => {
      this.broadcastLocally(event);
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.bus.close();
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
    await client.join(userRoom(session.userId));
    this.logger.debug('Realtime connection established', {
      socketId: client.id,
      userId: session.userId,
    });
  }

  handleDisconnect(client: Socket): void {
    this.logger.debug('Realtime connection closed', { socketId: client.id });
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
