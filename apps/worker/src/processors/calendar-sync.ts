import { DavClient, discoverCalendars } from '@exocortex/calendar';
import {
  type CalendarComponent,
  parseCalendarLinkPropertyMap,
  type QUEUE_NAMES,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext } from '@exocortex/queue';

import { type ReminderNotifier } from '../calendar/notifier';
import {
  createMirrorDatabase,
  ensureMirrorProperties,
  mirrorableCollections,
} from '../calendar/provision';
import { pullLink } from '../calendar/pull';
import { pushLink } from '../calendar/push';
import { sendDueReminders } from '../calendar/reminders';

export interface CalendarSyncDependencies {
  prisma: PrismaClient;
  /**
   * An API client acting as the given user, or `null` when the deployment has no
   * service-token secret. Same seam that disables the AI tool loop: without it
   * there is no way to write a row as a human, and the sync stays off rather
   * than reaching into the database behind the API's back.
   */
  apiClientFor: ((userId: string) => ExocortexApiClient) | null;
  /**
   * Resolves an account's credentials from the environment. Returns null when the
   * referenced key is unset, which is the normal state of a fresh deployment.
   */
  credentialsFor: (account: {
    provider: string;
    username: string;
    credentialRef: string;
    baseUrl: string | null;
  }) => { baseUrl: string; username: string; password: string } | null;
  /**
   * Where a due reminder goes, or null when the deployment configured no sender.
   * Same seam as `apiClientFor`: without it the feature is off rather than
   * half-working.
   */
  notifier: ReminderNotifier | null;
  /** Runtime settings, read per job so an admin's change takes effect at once. */
  settings: (workspaceId?: string) => Promise<Settings>;
  /** Public base URL, so a reminder can link back to the page it came from. */
  appUrl: string;
}

/**
 * Mirrors remote calendars into Exocortex databases, and writes local changes
 * back to the links that ask for it.
 *
 * Reading first, then writing, in that order and never the other way round. The
 * pull settles what the remote side currently says and records it on every state;
 * the push then only has genuinely local changes left to send. Pushing first
 * would mean deciding what changed locally against a picture of the remote side
 * that is one pass old.
 *
 * Writing outward is off unless a link's `direction` says otherwise, and it stays
 * narrow even then (see `pushLink`): a pull that goes wrong puts wrong rows in
 * Exocortex, a push that goes wrong damages the calendar someone's phone depends
 * on.
 *
 * A failure on one link never stops the others. The whole point of a sync is to
 * run unattended, and one calendar with a revoked password must not stop the
 * other two from staying current -- the error is recorded on the row that caused
 * it and the pass continues.
 */
export function createCalendarSyncProcessor(dependencies: CalendarSyncDependencies) {
  const { prisma } = dependencies;

  return async ({
    payload,
    logger,
  }: JobContext<typeof QUEUE_NAMES.calendarSync>): Promise<void> => {
    if (dependencies.apiClientFor === null) {
      logger.info('Calendar sync unavailable: no service-token secret configured');
      return;
    }

    // Reminders touch no calendar server, so they run on their own path: no
    // account loop, no credentials, no DAV client. They also run every minute,
    // and doing a full sync that often would hammer somebody else's server.
    if (payload.mode === 'remind') {
      await runReminders({ ...dependencies, apiClientFor: dependencies.apiClientFor, logger });
      return;
    }

    const accounts = await prisma.calendarAccount.findMany({
      where: {
        enabled: true,
        ...(payload.accountId === null ? {} : { id: payload.accountId }),
      },
    });
    if (accounts.length === 0) {
      logger.debug('Calendar sync: no enabled accounts');
      return;
    }

    for (const account of accounts) {
      const credentials = dependencies.credentialsFor(account);
      if (credentials === null) {
        // Not an error worth retrying: the credential key is simply unset.
        logger.warn('Calendar account has no usable credentials, skipping', {
          accountId: account.id,
          credentialRef: account.credentialRef,
        });
        await prisma.calendarAccount.update({
          where: { id: account.id },
          data: { lastError: `Zugangsdaten fehlen (${account.credentialRef})` },
        });
        continue;
      }

      // A client per account: each one acts as that account's own owner.
      const client = dependencies.apiClientFor(account.userId);
      const dav = new DavClient({ credentials, logger });
      try {
        if (payload.mode === 'discover') {
          await discoverAndProvision({ prisma, client, dav, logger, account });
        }
        await pullAllLinks({ ...dependencies, client, dav, logger, account, full: payload.full });
        await pushAllLinks({ prisma, client, dav, logger, account });
        await prisma.calendarAccount.update({
          where: { id: account.id },
          data: { lastSyncedAt: new Date(), lastError: null },
        });
      } catch (error) {
        const message = describeError(error);
        // `error` as the second argument, `context` as the third: passing the
        // context where the error belongs logs the whole thing as
        // "[object Object]" and loses the only useful part.
        logger.error('Calendar account sync failed', error, { accountId: account.id });
        await prisma.calendarAccount.update({
          where: { id: account.id },
          data: { lastError: message.slice(0, 500) },
        });
      }
    }
  };
}

/**
 * One reminder sweep, if the deployment wants reminders at all.
 *
 * Three ways this ends up doing nothing, and each of them is a legitimate state
 * rather than a failure: the setting is off, no sender is configured, or nothing is
 * due. Only the first two are worth a log line, and only once per pass -- a job
 * that runs every minute must not narrate itself.
 */
async function runReminders(input: {
  prisma: PrismaClient;
  apiClientFor: (userId: string) => ExocortexApiClient;
  notifier: ReminderNotifier | null;
  settings: (workspaceId?: string) => Promise<Settings>;
  appUrl: string;
  logger: Logger;
}): Promise<void> {
  if (input.notifier === null) {
    input.logger.debug('Calendar reminders need a sender, and none is configured');
    return;
  }

  // No deployment-wide gate here any more (issue #52). `calendar.remindersEnabled`
  // is workspace-scoped and defaults to off, so a global check would have
  // silenced exactly the workspace that switched it on. The decision moves into
  // the resolver, one appointment at a time; the sweep itself is one bounded
  // query over a window and costs nothing when nothing is due.
  const result = await sendDueReminders({
    prisma: input.prisma,
    apiClientFor: input.apiClientFor,
    notifier: input.notifier,
    logger: input.logger,
    scheduleFor: async (workspaceId) => {
      const settings = await input.settings(workspaceId);
      if (!settings['calendar.remindersEnabled']) return null;
      return {
        leadMinutes: settings['calendar.reminderLeadMinutes'],
        allDayHour: settings['calendar.reminderAllDayHour'],
        timeZone: settings['calendar.timeZone'],
      };
    },
    appUrl: input.appUrl,
    now: new Date(),
  });

  if (result.sent + result.failed > 0) {
    input.logger.info('Calendar reminders sent', {
      sent: result.sent,
      failed: result.failed,
      pending: result.pending,
    });
  }
}

/**
 * Refreshes the collection list and creates what is missing.
 *
 * Never deletes a link whose collection has disappeared: a calendar can vanish
 * from a listing because the server hiccupped, and dropping the link would drop
 * every row's mapping with it. Such a link is disabled instead, which is
 * reversible.
 */
async function discoverAndProvision(input: {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  dav: DavClient;
  logger: Logger;
  account: {
    id: string;
    workspaceId: string;
    username: string;
  };
}): Promise<void> {
  const { prisma, client, logger, account } = input;
  const collections = await discoverCalendars(input.dav);
  const mirrorable = mirrorableCollections(collections);
  logger.info('Calendar discovery finished', {
    accountId: account.id,
    found: collections.length,
    mirrorable: mirrorable.length,
  });

  const seen = new Set<string>();
  for (const { collection, component } of mirrorable) {
    seen.add(`${collection.href}::${component}`);
    const existing = await prisma.calendarLink.findUnique({
      where: {
        accountId_remoteHref_component: {
          accountId: account.id,
          remoteHref: collection.href,
          component,
        },
      },
    });

    // The link is written *before* the columns, with an empty mapping, and only
    // then are the columns provisioned. Ordering, not style: a run that created
    // the document and then failed on a column left an orphan database behind,
    // and the next run, finding no link, created a second one next to it. With
    // the link in place first, a failure here is simply retried on the next pass.
    const link =
      existing ??
      (await prisma.calendarLink.create({
        data: {
          accountId: account.id,
          remoteHref: collection.href,
          remoteDisplayName: collection.displayName,
          component,
          documentId: await createMirrorDatabase({
            client,
            workspaceId: account.workspaceId,
            parentId: null,
            collection: {
              ...collection,
              displayName: mirrorTitle(collection.displayName, component),
            },
          }),
          propertyMap: {},
          direction: 'PULL',
          supportsSyncCollection: collection.supportsSyncCollection,
          ctag: collection.ctag,
        },
      }));

    if (existing === null) {
      logger.info('Calendar mirror created', {
        accountId: account.id,
        collection: collection.displayName,
        component,
        documentId: link.documentId,
      });
    }

    // Idempotent and by name, so this is safe to repeat: an existing column is
    // adopted rather than duplicated. The display name and the sync capability
    // are the server's to change, the mapping is ours.
    const propertyMap = await ensureMirrorProperties({
      client,
      documentId: link.documentId,
      component,
      // The zone the mirror was authored in is unknown per event here; the
      // per-event TZID is what actually matters and travels in the ICS.
      timeZone: null,
      logger,
    });
    await prisma.calendarLink.update({
      where: { id: link.id },
      data: {
        remoteDisplayName: collection.displayName,
        supportsSyncCollection: collection.supportsSyncCollection,
        ctag: collection.ctag,
        propertyMap,
        // A previously vanished collection that is back becomes active again.
        enabled: true,
        lastError: null,
      },
    });
  }

  const orphans = await prisma.calendarLink.findMany({
    where: { accountId: account.id, enabled: true },
  });
  for (const link of orphans) {
    if (seen.has(`${link.remoteHref}::${link.component}`)) continue;
    logger.warn('Calendar collection no longer offered by the server, disabling its link', {
      linkId: link.id,
      remoteHref: link.remoteHref,
    });
    await prisma.calendarLink.update({
      where: { id: link.id },
      data: { enabled: false, lastError: 'Der Server bietet diese Sammlung nicht mehr an.' },
    });
  }
}

async function pullAllLinks(input: {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  dav: DavClient;
  logger: Logger;
  account: { id: string; username: string };
  full: boolean;
}): Promise<void> {
  const { prisma, logger, account } = input;
  const links = await prisma.calendarLink.findMany({
    where: { accountId: account.id, enabled: true, direction: { in: ['PULL', 'BOTH'] } },
  });

  for (const link of links) {
    try {
      const result = await pullLink({
        prisma,
        client: input.client,
        dav: input.dav,
        logger,
        link: {
          id: link.id,
          remoteHref: link.remoteHref,
          component: link.component,
          documentId: link.documentId,
          syncToken: link.syncToken,
          supportsSyncCollection: link.supportsSyncCollection,
          propertyMap: parseCalendarLinkPropertyMap(
            link.propertyMap as Record<string, unknown> | null,
          ),
        },
        selfAddresses: [account.username],
        full: input.full,
        canPush: link.direction === 'BOTH' || link.direction === 'PUSH',
      });

      await prisma.calendarLink.update({
        where: { id: link.id },
        data: { syncToken: result.syncToken, lastSyncedAt: new Date(), lastError: null },
      });
      logger.info('Calendar link synced', {
        linkId: link.id,
        collection: link.remoteDisplayName,
        created: result.created,
        updated: result.updated,
        unchanged: result.unchanged,
        archived: result.archived,
        refreshed: result.refreshed,
        overrides: result.overrides,
        pendingDelete: result.pendingDelete,
        fullRead: result.wasFullRead,
      });
    } catch (error) {
      const message = describeError(error);
      logger.error('Calendar link sync failed', error, { linkId: link.id });
      await prisma.calendarLink.update({
        where: { id: link.id },
        data: { lastError: message.slice(0, 500) },
      });
    }
  }
}

/**
 * Writes local changes back, for the links that are allowed to.
 *
 * A link is `PULL` until somebody says otherwise, so an untouched deployment
 * finds nothing to do here and makes no request at all. Same failure isolation as
 * the pull: a link that cannot be written to records why and the others continue.
 */
async function pushAllLinks(input: {
  prisma: PrismaClient;
  client: ExocortexApiClient;
  dav: DavClient;
  logger: Logger;
  account: { id: string };
}): Promise<void> {
  const { prisma, logger, account } = input;
  const links = await prisma.calendarLink.findMany({
    where: { accountId: account.id, enabled: true, direction: { in: ['PUSH', 'BOTH'] } },
  });

  for (const link of links) {
    try {
      const result = await pushLink({
        prisma,
        client: input.client,
        dav: input.dav,
        logger,
        link: {
          id: link.id,
          remoteHref: link.remoteHref,
          component: link.component,
          documentId: link.documentId,
          propertyMap: parseCalendarLinkPropertyMap(
            link.propertyMap as Record<string, unknown> | null,
          ),
        },
        now: new Date(),
      });

      // Only worth a line when something actually went out. A calendar nobody
      // edited would otherwise log a row of zeros every five minutes.
      if (result.created + result.updated + result.deleted + result.conflicts > 0) {
        logger.info('Calendar link pushed', {
          linkId: link.id,
          collection: link.remoteDisplayName,
          created: result.created,
          updated: result.updated,
          deleted: result.deleted,
          skipped: result.skipped,
          conflicts: result.conflicts,
        });
      }
      await prisma.calendarLink.update({
        where: { id: link.id },
        data: { lastError: null },
      });
    } catch (error) {
      const message = describeError(error);
      logger.error('Calendar link push failed', error, { linkId: link.id });
      await prisma.calendarLink.update({
        where: { id: link.id },
        data: { lastError: message.slice(0, 500) },
      });
    }
  }
}

/**
 * Two links on one collection would otherwise create two databases with the same
 * name, and a sidebar with two entries called "Aufgaben" is unreadable.
 */
function mirrorTitle(displayName: string, component: CalendarComponent): string {
  return component === 'VTODO' && !/aufgab/i.test(displayName)
    ? `${displayName} (Aufgaben)`
    : displayName;
}

/**
 * A message worth storing on the row that failed.
 *
 * `String(error)` on a plain object yields "[object Object]", which is exactly
 * the failure that hid the first real error here. An API error carries its code
 * and message on named fields, so those are read explicitly.
 */
function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'object' && error !== null) {
    const record = error as { code?: unknown; message?: unknown };
    const code = typeof record.code === 'string' ? record.code : null;
    const message = typeof record.message === 'string' ? record.message : null;
    if (code !== null || message !== null) {
      return [code, message].filter((part) => part !== null).join(': ');
    }
    try {
      return JSON.stringify(error).slice(0, 500);
    } catch {
      return 'Unbekannter Fehler';
    }
  }
  return String(error);
}
