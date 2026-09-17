import { Inject, Injectable } from '@nestjs/common';

import {
  type ConnectedApp,
  type ConnectedAppListResponse,
  type DisconnectAppResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

interface ClientRow {
  clientId: string;
  name: string | null;
  redirectUris: string[];
  disabled: boolean | null;
  createdAt: Date | null;
}

interface GrantRow {
  clientId: string;
  createdAt: Date;
  rotatedAt: Date | null;
  expiresAt: Date;
  revoked: Date | null;
}

/**
 * The OAuth clients one account has connected, and how it disconnects them.
 *
 * This exists because consent was previously a one-way door: `/verbinden` let a
 * person say yes to a remote connector, and nothing in the product let them take
 * it back -- the only "off" switch was an UPDATE against the client table.
 *
 * Everything here is scoped to the calling user through `OauthConsent` and
 * `OauthRefreshToken`, both of which carry a `userId`. `OauthClient` does not: a
 * dynamically registered client belongs to nobody in particular, so it is only
 * ever reached through one of those two, never queried by user directly.
 *
 * The refresh token is what stands for a live connection now. Since better-auth
 * 1.7 an access token is a signed JWT the server keeps no copy of, so there is
 * no row to count and no row to delete; what a person can still take away is the
 * client's ability to mint the next one, plus the client row itself.
 */
@Injectable()
export class ConnectionsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<ConnectedAppListResponse> {
    const clientSelect = {
      clientId: true,
      name: true,
      redirectUris: true,
      disabled: true,
      createdAt: true,
    } as const;

    const [consents, grants] = await Promise.all([
      this.prisma.oauthConsent.findMany({
        where: { userId },
        select: { clientId: true, createdAt: true, client: { select: clientSelect } },
      }),
      this.prisma.oauthRefreshToken.findMany({
        where: { userId },
        select: {
          clientId: true,
          createdAt: true,
          rotatedAt: true,
          expiresAt: true,
          revoked: true,
          client: { select: clientSelect },
        },
      }),
    ]);

    // A grant without a consent row is not a contradiction: consent can be
    // withdrawn or predate the record, and a client that can still renew is
    // exactly the one a person needs to see. So both sources feed the list, and
    // the earliest of the two dates is what "connected since" means.
    const clients = new Map<string, ClientRow>();
    const connectedAt = new Map<string, Date>();
    const grantsByClient = new Map<string, GrantRow[]>();

    function remember(client: ClientRow, since: Date): void {
      clients.set(client.clientId, client);
      const known = connectedAt.get(client.clientId);
      if (known === undefined || since < known) connectedAt.set(client.clientId, since);
    }

    for (const consent of consents) {
      remember(consent.client, consent.createdAt);
    }
    for (const grant of grants) {
      remember(grant.client, grant.createdAt);
      const list = grantsByClient.get(grant.clientId) ?? [];
      list.push(grant);
      grantsByClient.set(grant.clientId, list);
    }

    const now = new Date();
    const result: ConnectedApp[] = [...clients.values()].map((client) => {
      const clientGrants = grantsByClient.get(client.clientId) ?? [];
      const lastAuthorizedAt = clientGrants.reduce<Date | null>((latest, grant) => {
        // A rotation is the connector coming back for a new access token, which
        // is the most recent moment the authorization server can honestly name.
        const touched = grant.rotatedAt ?? grant.createdAt;
        return latest === null || touched > latest ? touched : latest;
      }, null);
      return {
        clientId: client.clientId,
        name: client.name ?? client.clientId,
        redirectUrls: client.redirectUris,
        connectedAt: (connectedAt.get(client.clientId) ?? client.createdAt ?? now).toISOString(),
        lastAuthorizedAt: lastAuthorizedAt === null ? null : lastAuthorizedAt.toISOString(),
        activeGrantCount: clientGrants.filter(
          (grant) => grant.revoked === null && grant.expiresAt > now,
        ).length,
        disabled: client.disabled ?? false,
      };
    });

    result.sort((a, b) => b.connectedAt.localeCompare(a.connectedAt));
    return { applications: result };
  }

  /**
   * Cuts one client off from this account.
   *
   * Three things happen, in this order, and all three are needed:
   *
   * 1. The account's refresh grants for the client are deleted, which ends the
   *    client's ability to renew silently. The access token it may be holding
   *    right now is a JWT and cannot be deleted; it dies of old age within the
   *    hour, or immediately with step 3.
   * 2. The account's consent is deleted, so a fresh authorization has to pass
   *    the `/verbinden` page again instead of being waved through.
   * 3. The client row is switched off when no other account still consents to
   *    it -- the normal case, since a dynamically registered connector belongs
   *    to the one person who set it up. `disabled` is checked on every use of a
   *    token, so an access token that is still within its hour dies with it.
   *    When someone else is still using the same registration, the row stays
   *    on: revoking one person's access must not break another's.
   *
   * Idempotent, like token revocation: disconnecting an already-disconnected
   * client succeeds instead of erroring, so a double click is harmless.
   */
  async disconnect(userId: string, clientId: string): Promise<DisconnectAppResponse> {
    const client = await this.prisma.oauthClient.findUnique({
      where: { clientId },
      select: { clientId: true },
    });
    if (client === null) throw AppError.notFound('The connected application');

    await this.prisma.$transaction([
      // Opaque access tokens belong to grants without a resource audience,
      // which this deployment never issues. Cleared anyway: leaving a row
      // behind that nothing here writes is how a stale credential survives.
      this.prisma.oauthAccessToken.deleteMany({ where: { clientId, userId } }),
      this.prisma.oauthRefreshToken.deleteMany({ where: { clientId, userId } }),
      this.prisma.oauthConsent.deleteMany({ where: { clientId, userId } }),
    ]);

    const otherConsents = await this.prisma.oauthConsent.count({ where: { clientId } });
    const otherGrants = await this.prisma.oauthRefreshToken.count({ where: { clientId } });
    const clientDisabled = otherConsents === 0 && otherGrants === 0;
    if (clientDisabled) {
      await this.prisma.oauthClient.update({ where: { clientId }, data: { disabled: true } });
    }

    return { disconnected: true, clientDisabled };
  }
}
