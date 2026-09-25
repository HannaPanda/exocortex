import { type FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiToken, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { currentPageScopeRestriction, runWithRequestContext } from '../common/correlation';
import { type OutboxService } from '../common/outbox.service';

import { AttachmentsService } from './attachments.service';
import { type TicketMinter, UploadTicketsService } from './upload-tickets.service';

/**
 * Upload tickets (ADR-064) against the real database, with the real
 * `AttachmentsService` behind them -- only the object store is a stand-in. That
 * is the point of running it this way: the properties that matter are the
 * access check and the page confinement the upload applies *after* the ticket
 * has been claimed, and a stubbed upload would test neither.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const MAX_UPLOAD_BYTES = 1024 * 1024;

let prisma: PrismaClient;
let tickets: UploadTicketsService;
let workspaceId: string;
let ownerId: string;
let strangerId: string;
let pageId: string;
let otherPageId: string;
const createdTokenIds: string[] = [];

/** A multipart request as `readUploadedFile` reads one, carrying `body` as a text file. */
function multipartRequest(body: string, filename = 'notiz.txt'): FastifyRequest {
  return {
    isMultipart: () => true,
    file: async () => ({
      filename,
      mimetype: 'text/plain',
      toBuffer: async () => Buffer.from(body, 'utf8'),
      fields: {},
    }),
  } as unknown as FastifyRequest;
}

function inRequest<T>(operation: () => Promise<T>, pageScopes?: unknown): Promise<T> {
  return runWithRequestContext(
    {
      correlationId: `upload-ticket-test-${Math.random().toString(36).slice(2)}`,
      ...(pageScopes === undefined ? {} : { pageScopes }),
    } as Parameters<typeof runWithRequestContext>[0],
    operation,
  );
}

async function createToken(input: {
  scopes?: string[];
  expiresAt?: Date | null;
  pageScopedTo?: string | null;
}): Promise<{ id: string; restriction: unknown }> {
  const generated = generateApiToken();
  const token = await prisma.apiToken.create({
    data: {
      userId: ownerId,
      name: 'ticket test',
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      scopes: input.scopes ?? ['write'],
      expiresAt: input.expiresAt ?? null,
      pageScoped: input.pageScopedTo !== undefined && input.pageScopedTo !== null,
      ...(input.pageScopedTo === undefined || input.pageScopedTo === null
        ? {}
        : { pageScopes: { create: [{ documentId: input.pageScopedTo, scope: 'SUBTREE' }] } }),
    },
    include: { pageScopes: { select: { documentId: true, scope: true } } },
  });
  createdTokenIds.push(token.id);
  return {
    id: token.id,
    restriction: token.pageScoped
      ? { tokenId: token.id, declared: true, scopes: token.pageScopes }
      : undefined,
  };
}

function minterFor(tokenId: string | undefined, expiresAt = new Date('2999-01-01')): TicketMinter {
  return {
    userId: ownerId,
    credential: tokenId === undefined ? 'session' : 'api_token',
    apiTokenId: tokenId,
    credentialExpiresAt: expiresAt,
  };
}

/** The secret is the last path segment of the address a mint hands out. */
function secretOf(uploadUrl: string): string {
  return decodeURIComponent(uploadUrl.slice(uploadUrl.lastIndexOf('/') + 1));
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma, { current: currentPageScopeRestriction });
  const env = { MAX_UPLOAD_BYTES, APP_URL: 'https://exocortex.test' } as ApiEnv;
  const storage = {
    putObject: async () => undefined,
    createDownloadUrl: async () => 'https://storage.test/object',
  };
  const attachments = new AttachmentsService(
    prisma,
    storage as unknown as ConstructorParameters<typeof AttachmentsService>[1],
    env,
    logger,
    // A plain-text file has no text engine, so neither the queue nor the
    // settings are reached by these uploads.
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[4],
    access,
    {} as unknown as OutboxService,
    { getKey: async () => false } as unknown as ConstructorParameters<typeof AttachmentsService>[7],
  );
  tickets = new UploadTicketsService(prisma, env, logger, access, attachments);

  const suffix = Date.now().toString(36);
  const [owner, stranger] = await Promise.all([
    prisma.user.create({
      data: { email: `ticket-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: {
        email: `ticket-stranger-${suffix}@exocortex.test`,
        name: 'Stranger',
        emailVerified: true,
      },
    }),
  ]);
  ownerId = owner.id;
  strangerId = stranger.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Tickets ${suffix}`,
      slug: `tickets-${suffix}`,
      members: { create: [{ userId: ownerId, role: 'MEMBER' }] },
    },
  });
  workspaceId = workspace.id;
  const [page, otherPage] = await Promise.all([
    prisma.document.create({
      data: {
        workspaceId,
        title: 'Ziel',
        orderKey: 'a0',
        createdById: ownerId,
        updatedById: ownerId,
      },
    }),
    prisma.document.create({
      data: {
        workspaceId,
        title: 'Woanders',
        orderKey: 'a1',
        createdById: ownerId,
        updatedById: ownerId,
      },
    }),
  ]);
  pageId = page.id;
  otherPageId = otherPage.id;
});

afterAll(async () => {
  await prisma.apiToken.deleteMany({ where: { id: { in: createdTokenIds } } });
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  await prisma.$disconnect();
});

describe('minting and redeeming', () => {
  it('uploads the file onto the page, as the owner, exactly once', async () => {
    const token = await createToken({});
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(token.id),
        request: { documentId: pageId, filename: null },
      }),
    );
    expect(minted.ticket.state).toBe('open');
    expect(minted.uploadUrl.startsWith('https://exocortex.test/api/attachments/upload/')).toBe(
      true,
    );

    const secret = secretOf(minted.uploadUrl);
    const uploaded = await inRequest(() => tickets.redeem(secret, multipartRequest('Hallo')));
    expect(uploaded.attachment.documentId).toBe(pageId);
    expect(uploaded.embedUrl).toBe(`/api/attachments/${uploaded.attachment.id}/download`);
    const row = await prisma.attachment.findUniqueOrThrow({
      where: { id: uploaded.attachment.id },
    });
    expect(row.createdById).toBe(ownerId);

    const status = await inRequest(() => tickets.get(minted.ticket.id, ownerId));
    expect(status.ticket.state).toBe('used');
    expect(status.ticket.embedUrl).toBe(uploaded.embedUrl);

    await expect(
      inRequest(() => tickets.redeem(secret, multipartRequest('noch einmal'))),
    ).rejects.toMatchObject({ code: 'upload_ticket_invalid' });
  });

  it('takes the filename from the ticket when it names one', async () => {
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(undefined),
        request: { documentId: pageId, filename: 'bericht' },
      }),
    );
    const uploaded = await inRequest(() =>
      tickets.redeem(secretOf(minted.uploadUrl), multipartRequest('Inhalt', 'irgendwas.txt')),
    );
    expect(uploaded.attachment.filename.startsWith('bericht')).toBe(true);
  });

  it('refuses an expired ticket and a secret that was never issued', async () => {
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(undefined),
        request: { documentId: pageId, filename: null },
      }),
    );
    await prisma.attachmentUploadTicket.update({
      where: { id: minted.ticket.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.uploadUrl), multipartRequest('zu spät'))),
    ).rejects.toMatchObject({ code: 'upload_ticket_invalid' });
    await expect(
      inRequest(() => tickets.redeem('A'.repeat(43), multipartRequest('geraten'))),
    ).rejects.toMatchObject({ code: 'upload_ticket_invalid' });
    await expect(
      inRequest(() => tickets.redeem('kein-ticket', multipartRequest('Unsinn'))),
    ).rejects.toMatchObject({ code: 'upload_ticket_invalid' });
  });

  it('gives the ticket back when the upload fails, so the next try can use it', async () => {
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(undefined),
        request: { documentId: pageId, filename: null },
      }),
    );
    const secret = secretOf(minted.uploadUrl);
    await expect(
      inRequest(() => tickets.redeem(secret, multipartRequest(''))),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    const afterFailure = await inRequest(() => tickets.get(minted.ticket.id, ownerId));
    expect(afterFailure.ticket.state).toBe('open');

    const uploaded = await inRequest(() => tickets.redeem(secret, multipartRequest('jetzt aber')));
    expect(uploaded.attachment.documentId).toBe(pageId);
  });
});

describe('acting as the credential that minted it', () => {
  it('refuses once the token has been revoked', async () => {
    const token = await createToken({});
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(token.id),
        request: { documentId: pageId, filename: null },
      }),
    );
    await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.uploadUrl), multipartRequest('widerrufen'))),
    ).rejects.toMatchObject({ code: 'api_token_invalid' });
  });

  it('refuses a token that no longer carries write', async () => {
    const token = await createToken({});
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(token.id),
        request: { documentId: pageId, filename: null },
      }),
    );
    await prisma.apiToken.update({ where: { id: token.id }, data: { scopes: ['read'] } });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.uploadUrl), multipartRequest('nur lesen'))),
    ).rejects.toMatchObject({ code: 'api_token_insufficient_scope' });
  });

  it('keeps a page-confined token inside its branch, when minting and when redeeming', async () => {
    const token = await createToken({ pageScopedTo: pageId });

    await expect(
      inRequest(
        () =>
          tickets.mint({
            workspaceId,
            minter: minterFor(token.id),
            request: { documentId: otherPageId, filename: null },
          }),
        token.restriction,
      ),
    ).rejects.toMatchObject({ code: 'token_scope_exceeded' });

    const minted = await inRequest(
      () =>
        tickets.mint({
          workspaceId,
          minter: minterFor(token.id),
          request: { documentId: pageId, filename: null },
        }),
      token.restriction,
    );
    // The token loses the page it was given between minting and redeeming.
    await prisma.apiTokenPageScope.deleteMany({ where: { apiTokenId: token.id } });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.uploadUrl), multipartRequest('eingesperrt'))),
    ).rejects.toMatchObject({ code: 'token_scope_exceeded' });
  });

  it('refuses when the owner has left the workspace', async () => {
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(undefined),
        request: { documentId: pageId, filename: null },
      }),
    );
    await prisma.workspaceMember.deleteMany({ where: { workspaceId, userId: ownerId } });
    try {
      await expect(
        inRequest(() =>
          tickets.redeem(secretOf(minted.uploadUrl), multipartRequest('ausgetreten')),
        ),
      ).rejects.toMatchObject({ code: 'workspace_access_denied' });
    } finally {
      await prisma.workspaceMember.create({
        data: { workspaceId, userId: ownerId, role: 'MEMBER' },
      });
    }
  });

  it('caps the lifetime at the minting credential', async () => {
    const soon = new Date(Date.now() + 60_000);
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(undefined, soon),
        request: { documentId: pageId, filename: null },
      }),
    );
    expect(new Date(minted.ticket.expiresAt).getTime()).toBe(soon.getTime());
  });
});

describe('reading a ticket', () => {
  it('shows a ticket to the person who minted it and to nobody else', async () => {
    const minted = await inRequest(() =>
      tickets.mint({
        workspaceId,
        minter: minterFor(undefined),
        request: { documentId: null, filename: null },
      }),
    );
    const own = await inRequest(() => tickets.get(minted.ticket.id, ownerId));
    expect(own.ticket.state).toBe('open');
    expect(own.ticket.embedUrl).toBeNull();
    await expect(inRequest(() => tickets.get(minted.ticket.id, strangerId))).rejects.toMatchObject({
      code: 'not_found',
    });
  });

  it('refuses a page in another workspace before any script runs', async () => {
    const elsewhere = await prisma.workspace.create({
      data: { name: 'Anderswo', slug: `anderswo-${Date.now().toString(36)}` },
    });
    try {
      const foreign = await prisma.document.create({
        data: {
          workspaceId: elsewhere.id,
          title: 'Fremd',
          orderKey: 'a0',
          createdById: ownerId,
          updatedById: ownerId,
        },
      });
      await expect(
        inRequest(() =>
          tickets.mint({
            workspaceId,
            minter: minterFor(undefined),
            request: { documentId: foreign.id, filename: null },
          }),
        ),
      ).rejects.toMatchObject({ code: 'document_cross_workspace' });
    } finally {
      await prisma.workspace.delete({ where: { id: elsewhere.id } });
    }
  });
});
