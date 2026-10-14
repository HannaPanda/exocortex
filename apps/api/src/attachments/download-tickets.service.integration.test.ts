import { Readable } from 'node:stream';
import { crc32, deflateSync } from 'node:zlib';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateApiToken, WorkspaceAccessService } from '@exocortex/auth';
import { type ApiEnv, loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { currentPageScopeRestriction, runWithRequestContext } from '../common/correlation';
import { type OutboxService } from '../common/outbox.service';

import { AttachmentsService } from './attachments.service';
import { DownloadTicketsService } from './download-tickets.service';
import { type TicketMinter } from './upload-tickets.service';

/**
 * Reading an attachment's content as an agent (issue #204): the image read and
 * the download tickets, against the real database and the real access checks.
 * Only the object store is a map in memory.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let attachments: AttachmentsService;
let tickets: DownloadTicketsService;
let workspaceId: string;
let foreignWorkspaceId: string;
let ownerId: string;
let strangerId: string;
let pageId: string;
let otherPageId: string;
let imageId: string;
let otherImageId: string;
let pdfId: string;
let foreignImageId: string;
let pngBytes: Buffer;
const objects = new Map<string, Buffer>();
const createdTokenIds: string[] = [];

function inRequest<T>(operation: () => Promise<T>, pageScopes?: unknown): Promise<T> {
  return runWithRequestContext(
    {
      correlationId: `download-ticket-test-${Math.random().toString(36).slice(2)}`,
      ...(pageScopes === undefined ? {} : { pageScopes }),
    } as Parameters<typeof runWithRequestContext>[0],
    operation,
  );
}

async function createToken(input: {
  scopes?: string[];
  pageScopedTo?: string;
}): Promise<{ id: string; restriction: unknown }> {
  const generated = generateApiToken();
  const token = await prisma.apiToken.create({
    data: {
      userId: ownerId,
      name: 'download ticket test',
      tokenHash: generated.tokenHash,
      prefix: generated.prefix,
      scopes: input.scopes ?? ['read'],
      pageScoped: input.pageScopedTo !== undefined,
      ...(input.pageScopedTo === undefined
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

function minterFor(tokenId?: string): TicketMinter {
  return {
    userId: ownerId,
    credential: tokenId === undefined ? 'session' : 'api_token',
    apiTokenId: tokenId,
    credentialExpiresAt: new Date('2999-01-01'),
  };
}

/**
 * A flat-coloured RGB PNG, written by hand: the API does not depend on an
 * image library, and a test should not add one just to draw a rectangle.
 */
function solidPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8); // 8 bits, truecolour, no interlace
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(width * 3, 0xc8)]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function secretOf(url: string): string {
  return decodeURIComponent(url.slice(url.lastIndexOf('/') + 1));
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function storeAttachment(input: {
  workspaceId: string;
  documentId: string | null;
  filename: string;
  mimeType: string;
  body: Buffer;
}): Promise<string> {
  const storageKey = `test/${Math.random().toString(36).slice(2)}/${input.filename}`;
  objects.set(storageKey, input.body);
  const row = await prisma.attachment.create({
    data: {
      workspaceId: input.workspaceId,
      documentId: input.documentId,
      filename: input.filename,
      mimeType: input.mimeType,
      byteSize: input.body.byteLength,
      storageKey,
      createdById: ownerId,
    },
  });
  return row.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma, { current: currentPageScopeRestriction });
  const env = { MAX_UPLOAD_BYTES: 1024 * 1024, APP_URL: 'https://exocortex.test' } as ApiEnv;
  const storage = {
    getObject: async ({ key }: { key: string }) => {
      const body = objects.get(key);
      if (body === undefined) throw new Error(`no object ${key}`);
      return Readable.from([body]);
    },
  };
  attachments = new AttachmentsService(
    prisma,
    storage as unknown as ConstructorParameters<typeof AttachmentsService>[1],
    env,
    logger,
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[4],
    access,
    {} as unknown as OutboxService,
    {} as unknown as ConstructorParameters<typeof AttachmentsService>[7],
  );
  tickets = new DownloadTicketsService(prisma, env, logger, access, attachments);

  const suffix = Date.now().toString(36);
  const [owner, stranger] = await Promise.all([
    prisma.user.create({
      data: { email: `dl-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: {
        email: `dl-stranger-${suffix}@exocortex.test`,
        name: 'Stranger',
        emailVerified: true,
      },
    }),
  ]);
  ownerId = owner.id;
  strangerId = stranger.id;
  const [workspace, foreign] = await Promise.all([
    prisma.workspace.create({
      data: {
        name: `Downloads ${suffix}`,
        slug: `downloads-${suffix}`,
        members: { create: [{ userId: ownerId, role: 'MEMBER' }] },
      },
    }),
    prisma.workspace.create({
      data: {
        name: `Fremd ${suffix}`,
        slug: `fremd-${suffix}`,
        members: { create: [{ userId: strangerId, role: 'OWNER' }] },
      },
    }),
  ]);
  workspaceId = workspace.id;
  foreignWorkspaceId = foreign.id;
  const pageData = (title: string, orderKey: string, inWorkspace: string) => ({
    data: { workspaceId: inWorkspace, title, orderKey, createdById: ownerId, updatedById: ownerId },
  });
  const [page, otherPage, foreignPage] = await Promise.all([
    prisma.document.create(pageData('Bilder', 'a0', workspaceId)),
    prisma.document.create(pageData('Woanders', 'a1', workspaceId)),
    prisma.document.create(pageData('Fremd', 'a0', foreignWorkspaceId)),
  ]);
  pageId = page.id;
  otherPageId = otherPage.id;

  pngBytes = solidPng(320, 200);
  imageId = await storeAttachment({
    workspaceId,
    documentId: pageId,
    filename: 'diff.png',
    mimeType: 'image/png',
    body: pngBytes,
  });
  otherImageId = await storeAttachment({
    workspaceId,
    documentId: otherPageId,
    filename: 'nachher.png',
    mimeType: 'image/png',
    body: pngBytes,
  });
  pdfId = await storeAttachment({
    workspaceId,
    documentId: pageId,
    filename: 'bericht.pdf',
    mimeType: 'application/pdf',
    body: Buffer.from('%PDF-1.4 nichts'),
  });
  foreignImageId = await storeAttachment({
    workspaceId: foreignWorkspaceId,
    documentId: foreignPage.id,
    filename: 'fremd.png',
    mimeType: 'image/png',
    body: pngBytes,
  });
});

afterAll(async () => {
  await prisma.apiToken.deleteMany({ where: { id: { in: createdTokenIds } } });
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, foreignWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, strangerId] } } });
  await prisma.$disconnect();
});

describe('reading an image', () => {
  it('hands a small PNG over byte for byte', async () => {
    const image = await inRequest(() => attachments.readImage(imageId, ownerId, 1_568));
    expect(image).toMatchObject({
      attachmentId: imageId,
      documentId: pageId,
      mimeType: 'image/png',
      width: 320,
      height: 200,
      resized: false,
    });
    expect(Buffer.from(image.data, 'base64').equals(pngBytes)).toBe(true);
  });

  it('scales down to the edge it was asked for', async () => {
    const image = await inRequest(() => attachments.readImage(imageId, ownerId, 64));
    expect(image).toMatchObject({ width: 64, height: 40, resized: true, originalWidth: 320 });
  });

  it('refuses a file that is not a raster image', async () => {
    await expect(
      inRequest(() => attachments.readImage(pdfId, ownerId, 1_568)),
    ).rejects.toMatchObject({ code: 'attachment_not_image' });
  });

  it('answers a file in another workspace as if it did not exist', async () => {
    await expect(
      inRequest(() => attachments.readImage(foreignImageId, ownerId, 1_568)),
    ).rejects.toMatchObject({ code: 'attachment_access_denied' });
  });

  it('keeps a page-confined token to the pictures of its branch', async () => {
    const token = await createToken({ pageScopedTo: pageId });
    const own = await inRequest(
      () => attachments.readImage(imageId, ownerId, 1_568),
      token.restriction,
    );
    expect(own.attachmentId).toBe(imageId);
    await expect(
      inRequest(() => attachments.readImage(otherImageId, ownerId, 1_568), token.restriction),
    ).rejects.toMatchObject({ code: 'attachment_access_denied' });
  });
});

describe('download tickets', () => {
  it('hands the file out once, to whoever holds the address', async () => {
    const token = await createToken({});
    const minted = await inRequest(() =>
      tickets.mint({ attachmentId: pdfId, minter: minterFor(token.id) }),
    );
    expect(minted.downloadUrl.startsWith('https://exocortex.test/api/attachments/download/')).toBe(
      true,
    );
    expect(minted.ticket).toMatchObject({
      attachmentId: pdfId,
      filename: 'bericht.pdf',
      mimeType: 'application/pdf',
    });

    const secret = secretOf(minted.downloadUrl);
    const file = await inRequest(() => tickets.redeem(secret));
    expect((await readAll(file.stream)).toString()).toBe('%PDF-1.4 nichts');
    expect(file.filename).toBe('bericht.pdf');

    await expect(inRequest(() => tickets.redeem(secret))).rejects.toMatchObject({
      code: 'download_ticket_invalid',
    });
  });

  it('refuses an expired ticket and a secret that was never issued', async () => {
    const minted = await inRequest(() =>
      tickets.mint({ attachmentId: imageId, minter: minterFor() }),
    );
    await prisma.attachmentDownloadTicket.update({
      where: { id: minted.ticket.id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.downloadUrl))),
    ).rejects.toMatchObject({ code: 'download_ticket_invalid' });
    await expect(inRequest(() => tickets.redeem('A'.repeat(43)))).rejects.toMatchObject({
      code: 'download_ticket_invalid',
    });
  });

  it('mints nothing for a file in another workspace', async () => {
    await expect(
      inRequest(() => tickets.mint({ attachmentId: foreignImageId, minter: minterFor() })),
    ).rejects.toMatchObject({ code: 'attachment_access_denied' });
  });

  it('keeps a page-confined token inside its branch, when minting and when redeeming', async () => {
    const token = await createToken({ pageScopedTo: pageId });
    await expect(
      inRequest(
        () => tickets.mint({ attachmentId: otherImageId, minter: minterFor(token.id) }),
        token.restriction,
      ),
    ).rejects.toMatchObject({ code: 'attachment_access_denied' });

    const minted = await inRequest(
      () => tickets.mint({ attachmentId: imageId, minter: minterFor(token.id) }),
      token.restriction,
    );
    // The token loses the page it was given between minting and redeeming.
    await prisma.apiTokenPageScope.deleteMany({ where: { apiTokenId: token.id } });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.downloadUrl))),
    ).rejects.toMatchObject({ code: 'attachment_access_denied' });
  });

  it('refuses once the minting token has been revoked', async () => {
    const token = await createToken({});
    const minted = await inRequest(() =>
      tickets.mint({ attachmentId: imageId, minter: minterFor(token.id) }),
    );
    await prisma.apiToken.update({ where: { id: token.id }, data: { revokedAt: new Date() } });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.downloadUrl))),
    ).rejects.toMatchObject({ code: 'api_token_invalid' });
  });

  it('refuses a token that carries no scope at all any more', async () => {
    const token = await createToken({});
    const minted = await inRequest(() =>
      tickets.mint({ attachmentId: imageId, minter: minterFor(token.id) }),
    );
    await prisma.apiToken.update({ where: { id: token.id }, data: { scopes: [] } });
    await expect(
      inRequest(() => tickets.redeem(secretOf(minted.downloadUrl))),
    ).rejects.toMatchObject({ code: 'api_token_insufficient_scope' });
  });
});
