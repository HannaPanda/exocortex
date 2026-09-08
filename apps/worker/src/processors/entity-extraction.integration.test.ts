import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { loadWorkerEnv } from '@exocortex/config';
import {
  ENTITY_PROPERTY_NAMES,
  ENTITY_TYPE_LABELS,
  type Settings,
  settingsSchema,
} from '@exocortex/contracts';
import { createPrismaClient, generateOrderKey, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';

import { extractEntities, invalidateEntityRegistryCache } from './entity-extraction';

/**
 * The extraction half of the entity layer (issue #47), against the real
 * database.
 *
 * What is worth testing here is not the matcher -- `entity-matching.test.ts`
 * covers that without a database -- but the three things only a database can
 * get wrong: that a re-run replaces rather than accumulates, that a manual edge
 * survives it, and that the entity rows do not match themselves.
 */
const logger: Logger = createLogger({ name: 'worker-test', level: 'silent' });

let prisma: PrismaClient;
let workspaceId: string;
let userId: string;
let databaseId: string;
let hostId: string;
let serviceId: string;

function settingsWith(overrides: Partial<Settings> = {}): Settings {
  return {
    ...settingsSchema.parse({}),
    'entities.databaseId': databaseId,
    ...overrides,
  } as Settings;
}

async function createDocument(input: {
  title: string;
  parentId: string | null;
  type?: 'PAGE' | 'COLLECTION';
  plainText?: string;
}): Promise<string> {
  const document = await prisma.document.create({
    data: {
      workspaceId,
      parentId: input.parentId,
      type: input.type ?? 'PAGE',
      title: input.title,
      orderKey: generateOrderKey(null, null),
      createdById: userId,
      updatedById: userId,
      content: {
        create: {
          yjsState: Buffer.from([]),
          plainText: input.plainText ?? '',
          materializedAt: new Date(),
        },
      },
    },
  });
  return document.id;
}

async function setAliases(rowId: string, aliases: string): Promise<void> {
  const property = await prisma.databaseProperty.findFirstOrThrow({
    where: { documentId: databaseId, name: ENTITY_PROPERTY_NAMES.aliases },
    select: { id: true },
  });
  await prisma.documentPropertyValue.upsert({
    where: { documentId_propertyId: { documentId: rowId, propertyId: property.id } },
    create: { documentId: rowId, propertyId: property.id, textValue: aliases },
    update: { textValue: aliases },
  });
}

beforeAll(async () => {
  const env = loadWorkerEnv();
  prisma = createPrismaClient({ databaseUrl: env.DATABASE_URL });

  const suffix = Date.now().toString(36);
  const user = await prisma.user.create({
    data: { email: `ent-worker-${suffix}@exocortex.test`, name: 'Worker', emailVerified: true },
  });
  userId = user.id;
  const workspace = await prisma.workspace.create({
    data: {
      name: `Entity extraction ${suffix}`,
      slug: `entity-extraction-${suffix}`,
      members: { create: { userId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  databaseId = await createDocument({ title: 'Entitäten', parentId: null, type: 'COLLECTION' });
  const typeProperty = await prisma.databaseProperty.create({
    data: {
      documentId: databaseId,
      type: 'SELECT',
      name: ENTITY_PROPERTY_NAMES.type,
      orderKey: generateOrderKey(null, null),
      options: {
        create: {
          label: ENTITY_TYPE_LABELS.host,
          color: 'purple',
          orderKey: generateOrderKey(null, null),
        },
      },
    },
    include: { options: true },
  });
  await prisma.databaseProperty.create({
    data: {
      documentId: databaseId,
      type: 'TEXT',
      name: ENTITY_PROPERTY_NAMES.aliases,
      orderKey: generateOrderKey(typeProperty.orderKey, null),
    },
  });

  hostId = await createDocument({ title: 'fpb2', parentId: databaseId });
  serviceId = await createDocument({ title: 'Orielle', parentId: databaseId });
  await setAliases(hostId, 'der Hetzner-Server');
  await prisma.documentPropertyValue.create({
    data: {
      documentId: hostId,
      propertyId: typeProperty.id,
      textValue: typeProperty.options[0]?.id ?? '',
    },
  });
});

afterAll(async () => {
  await prisma.workspace.delete({ where: { id: workspaceId } });
  await prisma.user.delete({ where: { id: userId } });
  await prisma.$disconnect();
});

beforeEach(() => {
  // The registry is cached for half a minute inside the pass; a suite that
  // changes aliases between cases would otherwise match against the last one.
  invalidateEntityRegistryCache();
});

describe('extractEntities', () => {
  it('links a page to every entity it names, once each', async () => {
    const page = await createDocument({ title: 'Betrieb', parentId: null });
    const result = await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: 'Orielle läuft auf fpb2. Auf fpb2 liegt auch der Key.',
      settings: settingsWith(),
      logger,
    });

    expect(result.mentions).toBe(2);
    const mentions = await prisma.entityMention.findMany({
      where: { documentId: page },
      select: { entityDocumentId: true, occurrences: true },
    });
    expect(mentions).toHaveLength(2);
    expect(mentions.find((m) => m.entityDocumentId === hostId)?.occurrences).toBe(2);
  });

  it('replaces the previous answer instead of adding to it', async () => {
    const page = await createDocument({ title: 'Wechsel', parentId: null });
    await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: 'Orielle und fpb2.',
      settings: settingsWith(),
      logger,
    });
    await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: 'Nur noch Orielle.',
      settings: settingsWith(),
      logger,
    });

    const remaining = await prisma.entityMention.findMany({
      where: { documentId: page },
      select: { entityDocumentId: true },
    });
    expect(remaining.map((mention) => mention.entityDocumentId)).toEqual([serviceId]);
  });

  it('leaves a manual edge alone when the name is gone from the page', async () => {
    const page = await createDocument({ title: 'Von Hand', parentId: null });
    await prisma.entityMention.create({
      data: {
        entityDocumentId: hostId,
        documentId: page,
        workspaceId,
        alias: 'fpb2',
        aliasKey: 'fpb2',
        occurrences: 1,
        context: 'Handelt davon, ohne es zu nennen.',
        source: 'MANUAL',
      },
    });

    await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: 'Hier steht kein einziger bekannter Name.',
      settings: settingsWith(),
      logger,
    });

    const survivor = await prisma.entityMention.findFirst({
      where: { documentId: page },
      select: { source: true, context: true },
    });
    expect(survivor?.source).toBe('MANUAL');
    expect(survivor?.context).toBe('Handelt davon, ohne es zu nennen.');
  });

  it('does not let an entity row mention itself', async () => {
    await extractEntities(prisma, {
      documentId: hostId,
      workspaceId,
      plainText: 'fpb2 ist ein Host. fpb2 steht in Falkenstein.',
      settings: settingsWith(),
      logger,
    });
    expect(await prisma.entityMention.count({ where: { documentId: hostId } })).toBe(0);
  });

  it('does nothing at all when no database is configured', async () => {
    const page = await createDocument({ title: 'Aus', parentId: null });
    const result = await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: 'Orielle läuft auf fpb2.',
      settings: settingsWith({ 'entities.databaseId': null }),
      logger,
    });
    expect(result).toEqual({ mentions: 0, candidates: 0 });
    expect(await prisma.entityMention.count({ where: { documentId: page } })).toBe(0);
  });

  it('collects a repeated unknown name as a candidate, with one sighting per page', async () => {
    const page = await createDocument({ title: 'Vorschlag', parentId: null });
    const text = 'Mailpit fängt die Mails. Mailpit läuft im Container.';
    await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: text,
      settings: settingsWith(),
      logger,
    });
    // Twice, to prove a re-save does not look like a second page.
    await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: text,
      settings: settingsWith(),
      logger,
    });

    const candidate = await prisma.entityCandidate.findUnique({
      where: { phraseKey: 'mailpit' },
      include: { sightings: true },
    });
    expect(candidate?.sightings).toHaveLength(1);

    await prisma.entityCandidate.delete({ where: { id: candidate?.id ?? '' } });
  });

  it('proposes nothing when candidates are switched off', async () => {
    const page = await createDocument({ title: 'Ohne Vorschläge', parentId: null });
    const result = await extractEntities(prisma, {
      documentId: page,
      workspaceId,
      plainText: 'Hocuspocus hier. Hocuspocus dort.',
      settings: settingsWith({ 'entities.candidatesEnabled': false }),
      logger,
    });
    expect(result.candidates).toBe(0);
    expect(
      await prisma.entityCandidate.findUnique({ where: { phraseKey: 'hocuspocus' } }),
    ).toBeNull();
  });
});
