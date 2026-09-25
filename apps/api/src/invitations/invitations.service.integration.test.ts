import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type ApiEnv } from '@exocortex/config';
import { type Locale, type MailMessage } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { type Mailer } from '@exocortex/mail';

import { type AuthService } from '../auth/auth.service';
import { OutboxService } from '../common/outbox.service';

import { InvitationsService } from './invitations.service';

/**
 * Invitation tests against the real database (issue #3).
 *
 * The service is constructed directly, like `workspaces.service.integration.test.ts`: what
 * is under test is who may invite whom and what a token is worth, not HTTP.
 *
 * Two collaborators are faked, both for the same reason -- they leave the
 * process. `password.hash` stands in for Better Auth's scrypt, which is slow by
 * design and would dominate the runtime; the account it writes is checked for
 * existence, never for signing in (that is the e2e suite's job). The mailer is
 * the third: it records what it was asked to send and can be told to fail,
 * which is the only way to exercise the "invitation exists, mail did not go
 * out" path that the whole `emailSent: false` design turns on.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let service: InvitationsService;
let adminId: string;
let ownerId: string;
let ownerEmail: string;
let memberId: string;
let workspaceId: string;
const createdUserIds: string[] = [];

const sentMails: { to: string; workspaceName: string | null; url: string; locale: Locale }[] = [];
let mailShouldFail = false;

const authService = {
  auth: {
    $context: Promise.resolve({
      password: { hash: async (value: string) => `hashed:${value}` },
    }),
  },
} as unknown as AuthService;

const mailer = {
  send: async (input: { to: string; message: MailMessage; locale: Locale }) => {
    if (mailShouldFail) throw new Error('relay unreachable');
    const message = input.message;
    if (message.template !== 'INVITATION')
      throw new Error(`unexpected template ${message.template}`);
    sentMails.push({
      to: input.to,
      workspaceName: message.workspaceName,
      url: message.url,
      locale: input.locale,
    });
    return { messageId: '<test@relay>', accepted: [input.to], rejected: [] };
  },
  close: async () => {},
} satisfies Mailer;

const env = { APP_URL: 'https://exocortex.test' } as unknown as ApiEnv;
const correlationId = 'test-correlation';

/** The address of the invitation the last `issue` produced, for readability. */
function addressFor(suffix: string): string {
  return `invitee-${suffix}-${Math.random().toString(36).slice(2, 8)}@exocortex.test`;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  service = new InvitationsService(
    prisma,
    env,
    logger,
    new WorkspaceAccessService(prisma),
    authService,
    new OutboxService(prisma, logger),
    mailer,
  );

  const suffix = Date.now().toString(36);
  const [admin, owner, member] = await Promise.all([
    prisma.user.create({
      data: {
        email: `inv-admin-${suffix}@exocortex.test`,
        name: 'Admin',
        emailVerified: true,
        role: 'ADMIN',
      },
    }),
    prisma.user.create({
      data: { email: `inv-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `inv-member-${suffix}@exocortex.test`, name: 'Member', emailVerified: true },
    }),
  ]);
  adminId = admin.id;
  ownerId = owner.id;
  ownerEmail = owner.email;
  memberId = member.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Invitations ${suffix}`,
      slug: `invitations-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
});

beforeEach(() => {
  sentMails.length = 0;
  mailShouldFail = false;
});

afterAll(async () => {
  await prisma.invitation.deleteMany({
    where: { invitedById: { in: [adminId, ownerId, memberId] } },
  });
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({
    where: { id: { in: [adminId, ownerId, memberId, ...createdUserIds] } },
  });
  await prisma.$disconnect();
});

describe('issuing an invitation', () => {
  it('sends a mail and returns a link that is only in the response', async () => {
    const email = addressFor('basic');
    const result = await service.createAsAdmin({
      request: {
        email,
        workspaceId,
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });

    expect(result.emailSent).toBe(true);
    expect(result.invitation.status).toBe('pending');
    expect(result.invitation.workspaceRole).toBe('MEMBER');
    // The row was read before the mail went out, so the send timestamp has to be
    // folded back in: otherwise this response says "verschickt" and "nicht
    // angekommen" in the same breath, and the UI reads the second one.
    expect(result.invitation.lastSentAt).not.toBeNull();
    expect(result.url).toContain('https://exocortex.test/einladung/');
    expect(sentMails).toHaveLength(1);
    expect(sentMails[0]?.to).toBe(email);

    // Only the hash is stored: the link in the response must not be recoverable
    // from the database.
    const token = result.url.split('/einladung/')[1] as string;
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: result.invitation.id } });
    expect(row.tokenHash).not.toContain(decodeURIComponent(token));
    expect(row.email).toBe(email.toLowerCase());
  });

  it('keeps the invitation when the mail cannot be sent', async () => {
    mailShouldFail = true;
    const result = await service.createAsAdmin({
      request: {
        email: addressFor('mailfail'),
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });

    expect(result.emailSent).toBe(false);
    expect(result.url).toContain('/einladung/');
    // `lastSentAt` stays null, which is what the UI reads to say "nicht angekommen".
    expect(result.invitation.lastSentAt).toBeNull();
    const row = await prisma.invitation.findUniqueOrThrow({ where: { id: result.invitation.id } });
    expect(row.lastSentAt).toBeNull();
  });

  it('withdraws an earlier open invitation for the same address', async () => {
    const email = addressFor('twice');
    const first = await service.createAsAdmin({
      request: { email, workspaceRole: 'MEMBER', role: 'user', expiresInDays: 7 },
      actorUserId: adminId,
      correlationId,
    });
    const second = await service.createAsAdmin({
      request: { email, workspaceRole: 'MEMBER', role: 'user', expiresInDays: 7 },
      actorUserId: adminId,
      correlationId,
    });

    const firstRow = await prisma.invitation.findUniqueOrThrow({
      where: { id: first.invitation.id },
    });
    expect(firstRow.revokedAt).not.toBeNull();
    expect(second.invitation.status).toBe('pending');

    // And the old link is dead, not merely marked.
    const oldToken = decodeURIComponent(first.url.split('/einladung/')[1] as string);
    await expect(service.preview(oldToken)).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it('refuses an address that already has an account', async () => {
    await expect(
      service.createAsAdmin({
        request: {
          email: ownerEmail,
          workspaceRole: 'MEMBER',
          role: 'user',
          expiresInDays: 7,
        },
        actorUserId: adminId,
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'invitation_email_taken' });
  });
});

describe('who may invite', () => {
  it('lets a workspace OWNER invite into their own workspace', async () => {
    const result = await service.createForWorkspace({
      workspaceId,
      request: {
        email: addressFor('byowner'),
        workspaceRole: 'GUEST',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: ownerId,
      correlationId,
    });
    expect(result.invitation.workspaceRole).toBe('GUEST');
    expect(result.invitation.workspaceId).toBe(workspaceId);
  });

  it('refuses a plain MEMBER', async () => {
    await expect(
      service.createForWorkspace({
        workspaceId,
        request: {
          email: addressFor('bymember'),
          workspaceRole: 'MEMBER',
          role: 'user',
          expiresInDays: 7,
        },
        actorUserId: memberId,
        correlationId,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
  });

  it('refuses a workspace admin trying to mint a global admin', async () => {
    await expect(
      service.createForWorkspace({
        workspaceId,
        request: {
          email: addressFor('escalate'),
          workspaceRole: 'MEMBER',
          role: 'admin',
          expiresInDays: 7,
        },
        actorUserId: ownerId,
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('redeeming an invitation', () => {
  it('creates a verified account and the membership in one step', async () => {
    const email = addressFor('redeem');
    const created = await service.createAsAdmin({
      request: { email, workspaceId, workspaceRole: 'MEMBER', role: 'user', expiresInDays: 7 },
      actorUserId: adminId,
      correlationId,
    });
    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);

    const preview = await service.preview(token);
    expect(preview.email).toBe(email.toLowerCase());
    expect(preview.accountExists).toBe(false);
    expect(preview.workspaceName).toContain('Invitations');

    const accepted = await service.accept({
      token,
      name: 'Neue Person',
      password: 'ein-sehr-langes-passwort',
    });
    expect(accepted).toEqual({
      accepted: true,
      email: email.toLowerCase(),
      workspaceId,
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: email.toLowerCase() },
      include: { accounts: true, memberships: true },
    });
    createdUserIds.push(user.id);

    // The token arrived at that address and came back, so there is nothing left
    // to verify by mail.
    expect(user.emailVerified).toBe(true);
    expect(user.role).toBe('USER');
    expect(user.accounts).toHaveLength(1);
    expect(user.accounts[0]?.providerId).toBe('credential');
    // Better Auth's own convention, not the address.
    expect(user.accounts[0]?.accountId).toBe(user.id);
    expect(user.memberships).toHaveLength(1);
    expect(user.memberships[0]?.role).toBe('MEMBER');
  });

  /**
   * The invited person has no account to ask, so the inviter chooses the
   * language (issue #98): the mail is written in it, and the account that
   * comes out of it starts in it.
   */
  it('speaks the language the inviter chose, in the mail and in the account', async () => {
    const email = addressFor('locale');
    const created = await service.createAsAdmin({
      request: {
        email,
        workspaceId,
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
        locale: 'fr',
      },
      actorUserId: adminId,
      correlationId,
    });
    expect(created.invitation.locale).toBe('fr');
    expect(sentMails.at(-1)?.locale).toBe('fr');

    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);
    // The page the mail opens is told too, so it can speak French before anybody signs in.
    await expect(service.preview(token)).resolves.toMatchObject({ locale: 'fr' });
    await service.accept({ token, name: 'Personne', password: 'ein-sehr-langes-passwort' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    createdUserIds.push(user.id);
    expect(user.locale).toBe('fr');
  });

  it('leaves the account undecided when nobody chose a language', async () => {
    const email = addressFor('nolocale');
    const created = await service.createAsAdmin({
      request: { email, workspaceId, workspaceRole: 'MEMBER', role: 'user', expiresInDays: 7 },
      actorUserId: adminId,
      correlationId,
    });
    expect(created.invitation.locale).toBeNull();
    // The admin never chose a language either, so the mail is German.
    expect(sentMails.at(-1)?.locale).toBe('de');

    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);
    // The page gets no guess either: the visitor's browser knows better than the admin's account.
    await expect(service.preview(token)).resolves.toMatchObject({ locale: null });
    await service.accept({ token, name: 'Neue Person', password: 'ein-sehr-langes-passwort' });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: email.toLowerCase() } });
    createdUserIds.push(user.id);
    expect(user.locale).toBeNull();
  });

  it('refuses the same token a second time', async () => {
    const created = await service.createAsAdmin({
      request: {
        email: addressFor('once'),
        workspaceId,
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });
    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);

    const accepted = await service.accept({
      token,
      name: 'Einmal',
      password: 'ein-sehr-langes-passwort',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: accepted.email } });
    createdUserIds.push(user.id);

    await expect(
      service.accept({ token, name: 'Nochmal', password: 'ein-sehr-langes-passwort' }),
    ).rejects.toMatchObject({ code: 'invitation_already_used' });
  });

  it('grants the global role the invitation carried', async () => {
    const created = await service.createAsAdmin({
      request: {
        email: addressFor('admin'),
        workspaceRole: 'MEMBER',
        role: 'admin',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });
    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);

    const accepted = await service.accept({
      token,
      name: 'Neuer Admin',
      password: 'ein-sehr-langes-passwort',
    });
    const user = await prisma.user.findUniqueOrThrow({ where: { email: accepted.email } });
    createdUserIds.push(user.id);
    expect(user.role).toBe('ADMIN');
    // No workspace was named, so no membership was invented.
    expect(await prisma.workspaceMember.count({ where: { userId: user.id } })).toBe(0);
  });

  it('rejects an expired token with its own error, not a generic one', async () => {
    const created = await service.createAsAdmin({
      request: {
        email: addressFor('expired'),
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });
    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);
    await prisma.invitation.update({
      where: { id: created.invitation.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(service.preview(token)).rejects.toMatchObject({ code: 'invitation_expired' });
  });

  it('rejects anything that is not a token without touching the database', async () => {
    await expect(service.preview('not-a-token')).rejects.toMatchObject({
      code: 'invitation_invalid',
    });
  });
});

describe('resending and withdrawing', () => {
  it('rotates the token, so the old link stops working', async () => {
    const created = await service.createAsAdmin({
      request: {
        email: addressFor('rotate'),
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });
    const oldToken = decodeURIComponent(created.url.split('/einladung/')[1] as string);

    const resent = await service.resend({
      invitationId: created.invitation.id,
      actorUserId: adminId,
    });
    expect(resent.url).not.toBe(created.url);
    expect(resent.invitation.sentCount).toBe(2);

    await expect(service.preview(oldToken)).rejects.toMatchObject({
      code: 'invitation_invalid',
    });
    const newToken = decodeURIComponent(resent.url.split('/einladung/')[1] as string);
    await expect(service.preview(newToken)).resolves.toMatchObject({ accountExists: false });
  });

  it('kills the link immediately on revoke', async () => {
    const created = await service.createAsAdmin({
      request: {
        email: addressFor('revoke'),
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });
    const token = decodeURIComponent(created.url.split('/einladung/')[1] as string);

    await service.revoke({ invitationId: created.invitation.id, actorUserId: adminId });

    await expect(service.preview(token)).rejects.toMatchObject({ code: 'invitation_invalid' });
    await expect(
      service.accept({ token, name: 'Zu spät', password: 'ein-sehr-langes-passwort' }),
    ).rejects.toMatchObject({ code: 'invitation_invalid' });
  });

  it("hides another workspace's invitation from a workspace-scoped call", async () => {
    const created = await service.createAsAdmin({
      request: {
        email: addressFor('scoped'),
        workspaceRole: 'MEMBER',
        role: 'user',
        expiresInDays: 7,
      },
      actorUserId: adminId,
      correlationId,
    });

    // No workspace on the invitation, so a workspace-scoped revoke must not find
    // it -- 404 rather than a permission error, so the route says nothing about
    // what exists elsewhere.
    await expect(
      service.revoke({
        invitationId: created.invitation.id,
        actorUserId: ownerId,
        workspaceId,
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
