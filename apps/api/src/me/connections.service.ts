import { Inject, Injectable } from '@nestjs/common';

import {
  type ConnectedApp,
  type ConnectedAppListResponse,
  type DisconnectAppResponse,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';

import { AppError } from '../common/app-error';
import { PRISMA } from '../platform/platform-tokens';

interface ApplicationRow {
  clientId: string;
  name: string;
  redirectUrls: string;
  disabled: boolean | null;
  createdAt: Date;
}

interface TokenRow {
  clientId: string;
  createdAt: Date;
  updatedAt: Date;
  accessTokenExpiresAt: Date;
}

/**
 * The OAuth clients one account has connected, and how it disconnects them.
 *
 * This exists because consent was previously a one-way door: `/verbinden` let a
 * person say yes to a remote connector, and nothing in the product let them take
 * it back -- the only "off" switch was an UPDATE against `oauth_application`.
 *
 * Everything here is scoped to the calling user through `OauthConsent` and
 * `OauthAccessToken`, both of which carry a `userId`. `OauthApplication` does
 * not: a dynamically registered client belongs to nobody in particular, so it is
 * only ever reached through one of those two, never queried by user directly.
 */
@Injectable()
export class ConnectionsService {
  constructor(@Inject(PRISMA) private readonly prisma: PrismaClient) {}

  async list(userId: string): Promise<ConnectedAppListResponse> {
    const [consents, tokens] = await Promise.all([
      this.prisma.oauthConsent.findMany({
        where: { userId, consentGiven: true },
        select: {
          clientId: true,
          createdAt: true,
          application: {
            select: {
              clientId: true,
              name: true,
              redirectUrls: true,
              disabled: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.oauthAccessToken.findMany({
        where: { userId },
        select: {
          clientId: true,
          createdAt: true,
          updatedAt: true,
          accessTokenExpiresAt: true,
          application: {
            select: {
              clientId: true,
              name: true,
              redirectUrls: true,
              disabled: true,
              createdAt: true,
            },
          },
        },
      }),
    ]);

    // A token without a consent row is not a contradiction: consent can be
    // withdrawn or predate the record, and a client that still holds a live
    // token is exactly the one a person needs to see. So both sources feed the
    // list, and the earliest of the two dates is what "connected since" means.
    const applications = new Map<string, ApplicationRow>();
    const connectedAt = new Map<string, Date>();
    const tokensByClient = new Map<string, TokenRow[]>();

    function remember(application: ApplicationRow, since: Date): void {
      applications.set(application.clientId, application);
      const known = connectedAt.get(application.clientId);
      if (known === undefined || since < known) connectedAt.set(application.clientId, since);
    }

    for (const consent of consents) {
      remember(consent.application, consent.createdAt);
    }
    for (const token of tokens) {
      remember(token.application, token.createdAt);
      const list = tokensByClient.get(token.clientId) ?? [];
      list.push(token);
      tokensByClient.set(token.clientId, list);
    }

    const now = new Date();
    const result: ConnectedApp[] = [...applications.values()].map((application) => {
      const clientTokens = tokensByClient.get(application.clientId) ?? [];
      const lastAuthorizedAt = clientTokens.reduce<Date | null>(
        (latest, token) => (latest === null || token.updatedAt > latest ? token.updatedAt : latest),
        null,
      );
      return {
        clientId: application.clientId,
        name: application.name,
        redirectUrls: application.redirectUrls.split(',').filter((url) => url !== ''),
        connectedAt: (connectedAt.get(application.clientId) ?? application.createdAt).toISOString(),
        lastAuthorizedAt: lastAuthorizedAt === null ? null : lastAuthorizedAt.toISOString(),
        activeTokenCount: clientTokens.filter((token) => token.accessTokenExpiresAt > now).length,
        disabled: application.disabled ?? false,
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
   * 1. The account's access tokens for the client are deleted. Each row holds
   *    both the access and the refresh token, so deleting it ends the current
   *    session *and* the client's ability to renew it silently.
   * 2. The account's consent is deleted, so a fresh authorization has to pass
   *    the `/verbinden` page again instead of being waved through.
   * 3. The client row is switched off when no other account still consents to
   *    it -- the normal case, since a dynamically registered connector belongs
   *    to the one person who set it up. `disabled` is checked on every use, so
   *    any token elsewhere dies with it. When someone else is still using the
   *    same registration, the row stays on: revoking one person's access must
   *    not break another's.
   *
   * Idempotent, like token revocation: disconnecting an already-disconnected
   * client succeeds instead of erroring, so a double click is harmless.
   */
  async disconnect(userId: string, clientId: string): Promise<DisconnectAppResponse> {
    const application = await this.prisma.oauthApplication.findUnique({
      where: { clientId },
      select: { clientId: true },
    });
    if (application === null) throw AppError.notFound('The connected application');

    await this.prisma.$transaction([
      this.prisma.oauthAccessToken.deleteMany({ where: { clientId, userId } }),
      this.prisma.oauthConsent.deleteMany({ where: { clientId, userId } }),
    ]);

    const otherConsents = await this.prisma.oauthConsent.count({
      where: { clientId, consentGiven: true },
    });
    const otherTokens = await this.prisma.oauthAccessToken.count({ where: { clientId } });
    const clientDisabled = otherConsents === 0 && otherTokens === 0;
    if (clientDisabled) {
      await this.prisma.oauthApplication.update({ where: { clientId }, data: { disabled: true } });
    }

    return { disconnected: true, clientDisabled };
  }
}
