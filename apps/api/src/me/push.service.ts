import { Inject, Injectable } from '@nestjs/common';

import { type ApiEnv } from '@exocortex/config';
import {
  DEFAULT_PUSH_KINDS,
  type PushDevice,
  type PushDeviceListResponse,
  type PushNotificationKind,
  QUEUE_NAMES,
  type RegisterPushDeviceRequest,
  type SendPushRequest,
  type SendPushResponse,
  type UpdatePushDeviceRequest,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type QueueRegistry } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { API_ENV } from '../common/logger.provider';
import { PRISMA, QUEUES } from '../platform/platform-tokens';

/**
 * A person's notifiable devices (issue #30, ADR-048).
 *
 * Everything here is scoped to one user and nothing here sends: the API knows
 * which devices exist and what they want to hear, the worker owns the private
 * key and does the sending. That split is not ceremony -- the API answers
 * requests from the public internet, and the one process that must never be
 * talked into signing something is the one holding the signing key.
 */
@Injectable()
export class PushService {
  constructor(
    @Inject(PRISMA) private readonly prisma: PrismaClient,
    @Inject(QUEUES) private readonly queues: QueueRegistry,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * A person cannot register an unbounded number of browsers. Each row is an
   * address somebody can be reached at, and a list that only grows is a list
   * of devices nobody has used for a year.
   */
  private static readonly MAX_DEVICES_PER_USER = 20;

  /** Whether this deployment has a key pair at all. */
  private get publicKey(): string | null {
    const key = this.env.VAPID_PUBLIC_KEY?.trim();
    const secret = this.env.VAPID_PRIVATE_KEY?.trim();
    if (key === undefined || key === '') return null;
    // The public half alone would let a browser subscribe to a deployment that
    // can never send it anything, which is worse than saying no.
    if (secret === undefined || secret === '') return null;
    return key;
  }

  async list(userId: string, currentEndpoint?: string): Promise<PushDeviceListResponse> {
    const devices = await this.prisma.pushSubscription.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
    });

    return {
      configured: this.publicKey !== null,
      publicKey: this.publicKey,
      devices: devices.map((row) => toDevice(row, currentEndpoint)),
    };
  }

  /**
   * Registers a device, or refreshes the one that is already there.
   *
   * The browser calls this on every start, because a push service may replace
   * an endpoint at any time and the only way to notice is to compare. An
   * upsert is therefore the normal path, not the edge case -- and it must not
   * reset what the person chose, which is why `kinds` is only written when the
   * caller actually names it.
   */
  async register(userId: string, request: RegisterPushDeviceRequest): Promise<PushDevice> {
    if (this.publicKey === null) {
      throw AppError.conflict(
        'This deployment sends no push notifications: no VAPID key pair is configured',
      );
    }

    const existing = await this.prisma.pushSubscription.findUnique({
      where: { endpoint: request.endpoint },
    });

    if (existing !== null) {
      const row = await this.prisma.pushSubscription.update({
        where: { id: existing.id },
        data: {
          // The device may now belong to somebody else: one browser profile
          // mints one endpoint for this application, and whoever just
          // subscribed is who is sitting in front of it.
          userId,
          p256dh: request.keys.p256dh,
          auth: request.keys.auth,
          label: request.label,
          ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
          lastSeenAt: new Date(),
          failureCount: 0,
          lastError: null,
        },
      });
      return toDevice(row, request.endpoint);
    }

    const count = await this.prisma.pushSubscription.count({ where: { userId } });
    if (count >= PushService.MAX_DEVICES_PER_USER) {
      throw AppError.conflict(
        `A person may register at most ${PushService.MAX_DEVICES_PER_USER} devices; remove one that is no longer used`,
      );
    }

    const row = await this.prisma.pushSubscription.create({
      data: {
        userId,
        endpoint: request.endpoint,
        p256dh: request.keys.p256dh,
        auth: request.keys.auth,
        label: request.label,
        kinds: [...(request.kinds ?? DEFAULT_PUSH_KINDS)],
      },
    });
    return toDevice(row, request.endpoint);
  }

  async update(
    userId: string,
    deviceId: string,
    request: UpdatePushDeviceRequest,
  ): Promise<PushDevice> {
    await this.own(userId, deviceId);
    const row = await this.prisma.pushSubscription.update({
      where: { id: deviceId },
      data: {
        ...(request.label === undefined ? {} : { label: request.label }),
        ...(request.kinds === undefined ? {} : { kinds: request.kinds }),
      },
    });
    return toDevice(row);
  }

  async remove(userId: string, deviceId: string): Promise<void> {
    await this.own(userId, deviceId);
    await this.prisma.pushSubscription.delete({ where: { id: deviceId } });
  }

  /**
   * Sends a notification to one's own devices.
   *
   * Only to one's own, on purpose: an account that could push to somebody
   * else's phone would be a way to make a stranger's pocket buzz, and no
   * feature here needs that. Agents notify the person whose account they run
   * as, which on this deployment is the whole point -- it is how Hermes or a
   * Claude Code session reaches a phone.
   */
  async send(userId: string, request: SendPushRequest): Promise<SendPushResponse> {
    const devices = await this.prisma.pushSubscription.count({
      where: { userId, kinds: { has: 'AGENT' satisfies PushNotificationKind } },
    });
    if (devices === 0) return { devices: 0 };

    await this.queues.enqueue(QUEUE_NAMES.push, {
      correlationId: crypto.randomUUID(),
      userId,
      kind: 'AGENT',
      notification: {
        title: request.title,
        body: request.body,
        url: this.absoluteUrl(request.url),
        tag: request.tag ?? null,
      },
    });
    return { devices };
  }

  /**
   * Resolves the target of a notification against this deployment.
   *
   * A notification is tapped without being read, so the address behind it may
   * only ever be this application. An absolute address elsewhere is refused
   * rather than quietly dropped: a caller that meant to link somewhere should
   * hear that it cannot.
   */
  private absoluteUrl(url: string | undefined): string | null {
    if (url === undefined || url.trim() === '') return null;
    const base = this.env.APP_URL.replace(/\/$/, '');
    let resolved: URL;
    try {
      resolved = new URL(url, `${base}/`);
    } catch {
      throw AppError.validation('The notification target is not a URL');
    }
    if (resolved.origin !== new URL(base).origin) {
      throw AppError.validation('A notification may only point at this installation');
    }
    return resolved.toString();
  }

  private async own(userId: string, deviceId: string): Promise<void> {
    const row = await this.prisma.pushSubscription.findUnique({
      where: { id: deviceId },
      select: { userId: true },
    });
    // Not found and not yours are the same answer, so the route cannot be used
    // to find out whether an id exists.
    if (row === null || row.userId !== userId) {
      throw AppError.notFound('The device');
    }
  }
}

interface PushSubscriptionRow {
  id: string;
  endpoint: string;
  label: string;
  kinds: string[];
  createdAt: Date;
  lastSeenAt: Date;
  lastDeliveredAt: Date | null;
  failureCount: number;
}

function toDevice(row: PushSubscriptionRow, currentEndpoint?: string): PushDevice {
  return {
    id: row.id,
    label: row.label,
    kinds: row.kinds as PushNotificationKind[],
    service: hostOf(row.endpoint),
    createdAt: row.createdAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
    lastDeliveredAt: row.lastDeliveredAt?.toISOString() ?? null,
    failureCount: row.failureCount,
    current: currentEndpoint !== undefined && currentEndpoint === row.endpoint,
  };
}

/** The push service's host, never the path: the path is the device's address. */
function hostOf(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return 'unbekannt';
  }
}
