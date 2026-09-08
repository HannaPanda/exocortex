import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import {
  ENTITY_PROPERTY_NAMES,
  ENTITY_TYPE_LABELS,
  type Settings,
  settingsSchema,
} from '@exocortex/contracts';
import { createPrismaClient, loadEntityRegistry, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';
import { type ObjectStorage } from '@exocortex/storage';

import { OutboxService } from '../common/outbox.service';
import { DatabasePropertiesService } from '../databases/database-properties.service';
import { type DocumentContentService } from '../documents/document-content.service';
import { DocumentMoveService } from '../documents/document-move.service';
import { DocumentTrashService } from '../documents/document-trash.service';
import { DocumentsService } from '../documents/documents.service';
import { type SettingsService } from '../platform/settings.service';
import { type RealtimeService } from '../realtime/realtime.service';

import { EntitiesService } from './entities.service';
import { EntityCandidatesService } from './entity-candidates.service';
import { EntityProfileService } from './entity-profile.service';
import { EntityRegistryService } from './entity-registry.service';

/**
 * The entity layer against the real database (issue #47).
 *
 * The settings service is a stub rather than the real one, and deliberately:
 * the integration suite talks to this host's production database, and
 * `entities.databaseId` is a deployment-wide setting. A test that wrote it
 * would repoint the running deployment at a database it then deletes. So
 * provisioning is exercised only as far as the schema it creates, and the id is
 * handed to the services directly.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });
const noopStorage = {} as unknown as ObjectStorage;
const correlationId = 'entities-test-correlation';

let prisma: PrismaClient;
let queues: QueueRegistry;
let documents: DocumentsService;
let properties: DatabasePropertiesService;
let entities: EntitiesService;
let profiles: EntityProfileService;
let candidates: EntityCandidatesService;
let registry: EntityRegistryService;

let workspaceId: string;
let hiddenWorkspaceId: string;
let ownerId: string;
let outsiderId: string;
let databaseId: string;

/** Mutable so a single test can switch a flag without a settings row. */
let settingsOverride: Partial<Settings> = {};

function currentSettings(): Settings {
  return { ...settingsSchema.parse({}), 'entities.databaseId': databaseId, ...settingsOverride };
}

const settings = {
  get: async () => currentSettings(),
  getKey: async (key: keyof Settings) => currentSettings()[key],
} as unknown as SettingsService;

const realtime = {
  emit: async () => {},
} as unknown as RealtimeService;

/** Content writes are not what this suite is about; plain text is set directly. */
const content = {
  write: async () => ({}),
} as unknown as DocumentContentService;

async function createPage(
  title: string,
  plainText: string,
  targetWorkspaceId = workspaceId,
  authorId = ownerId,
): Promise<string> {
  const page = await documents.create({
    workspaceId: targetWorkspaceId,
    userId: authorId,
    request: { title, type: 'PAGE', parentId: null },
    correlationId,
  });
  await prisma.documentContent.update({
    where: { documentId: page.id },
    data: { plainText, materializedAt: new Date() },
  });
  return page.id;
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-entities'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  documents = new DocumentsService(
    prisma,
    queues,
    logger,
    noopStorage,
    access,
    outbox,
    realtime,
    new DocumentTrashService(prisma, queues, logger, noopStorage, access, outbox, realtime),
    new DocumentMoveService(prisma, queues, logger, access, outbox, realtime),
  );
  properties = new DatabasePropertiesService(prisma, access, outbox, realtime);
  registry = new EntityRegistryService(prisma, settings, access);
  entities = new EntitiesService(
    prisma,
    queues,
    logger,
    settings,
    registry,
    access,
    documents,
    content,
    properties,
  );
  profiles = new EntityProfileService(prisma, registry, settings);
  candidates = new EntityCandidatesService(prisma, logger, settings, registry, entities);

  const suffix = Date.now().toString(36);
  const [owner, outsider] = await Promise.all([
    prisma.user.create({
      data: { email: `ent-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `ent-out-${suffix}@exocortex.test`, name: 'Outsider', emailVerified: true },
    }),
  ]);
  ownerId = owner.id;
  outsiderId = outsider.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Entities ${suffix}`,
      slug: `entities-${suffix}`,
      members: { create: { userId: ownerId, role: 'OWNER' } },
    },
  });
  workspaceId = workspace.id;

  const hidden = await prisma.workspace.create({
    data: {
      name: `Hidden ${suffix}`,
      slug: `entities-hidden-${suffix}`,
      members: { create: { userId: outsiderId, role: 'OWNER' } },
    },
  });
  hiddenWorkspaceId = hidden.id;

  const database = await documents.create({
    workspaceId,
    userId: ownerId,
    request: { title: 'Entitäten', type: 'COLLECTION', parentId: null },
    correlationId,
  });
  databaseId = database.id;

  const typeProperty = await properties.create({
    collectionDocumentId: databaseId,
    userId: ownerId,
    request: { type: 'SELECT', name: ENTITY_PROPERTY_NAMES.type },
    correlationId,
  });
  await properties.createOption({
    propertyId: typeProperty.id,
    userId: ownerId,
    request: { label: ENTITY_TYPE_LABELS.host, color: 'purple' },
    correlationId,
  });
  await properties.createOption({
    propertyId: typeProperty.id,
    userId: ownerId,
    request: { label: ENTITY_TYPE_LABELS.other, color: 'gray' },
    correlationId,
  });
  await properties.create({
    collectionDocumentId: databaseId,
    userId: ownerId,
    request: { type: 'TEXT', name: ENTITY_PROPERTY_NAMES.aliases },
    correlationId,
  });
});

afterAll(async () => {
  await prisma.workspace.deleteMany({
    where: { id: { in: [workspaceId, hiddenWorkspaceId] } },
  });
  await prisma.entityCandidate.deleteMany({ where: { phraseKey: { startsWith: 'testkandidat' } } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, outsiderId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

describe('the entity registry', () => {
  it('reads a row back with its type and its aliases', async () => {
    const created = await entities.create({
      userId: ownerId,
      request: { title: 'fpb2', type: 'host', aliases: ['der Hetzner-Server'], summary: '' },
      correlationId,
    });

    const loaded = await loadEntityRegistry(prisma, databaseId);
    const entity = loaded.find((record) => record.id === created.entity.id);
    expect(entity?.title).toBe('fpb2');
    expect(entity?.type).toBe('host');
    expect(entity?.aliases).toEqual(['der Hetzner-Server']);
  });

  it('refuses a second entity with the same name', async () => {
    await expect(
      entities.create({
        userId: ownerId,
        request: { title: 'FPB2', type: 'host', aliases: [], summary: '' },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'entity_exists' });
  });

  it('does not list entities to somebody who cannot read the database', async () => {
    expect(await registry.loadReadable(outsiderId)).toEqual([]);
  });

  it('answers with nothing at all when no database is configured', async () => {
    settingsOverride = { 'entities.enabled': false };
    try {
      expect(await registry.databaseId()).toBeNull();
      expect(await registry.load()).toEqual([]);
    } finally {
      settingsOverride = {};
    }
  });
});

describe('the entity profile', () => {
  it('lists the pages that talk about the entity and hides the ones it may not', async () => {
    const entity = await entities.create({
      userId: ownerId,
      request: { title: 'Orielle', type: 'other', aliases: [], summary: '' },
      correlationId,
    });
    const visible = await createPage('Betrieb', 'Orielle läuft dort.');
    const hidden = await createPage('Fremd', 'Orielle auch hier.', hiddenWorkspaceId, outsiderId);

    for (const [documentId, wsId] of [
      [visible, workspaceId],
      [hidden, hiddenWorkspaceId],
    ] as const) {
      await prisma.entityMention.create({
        data: {
          entityDocumentId: entity.entity.id,
          documentId,
          workspaceId: wsId,
          alias: 'Orielle',
          aliasKey: 'orielle',
          occurrences: 1,
          context: 'Orielle läuft dort.',
        },
      });
    }

    const profile = await profiles.profile(ownerId, entity.entity.id);
    expect(profile.mentions.map((mention) => mention.documentId)).toEqual([visible]);
    expect(profile.hiddenMentions).toBe(1);
    expect(profile.text).toContain('Orielle');
    expect(profile.entity.mentionCount).toBe(1);
  });

  it('keeps a manual link and reports it as manual', async () => {
    const entity = await entities.create({
      userId: ownerId,
      request: { title: 'Brevo', type: 'other', aliases: [], summary: '' },
      correlationId,
    });
    const page = await createPage('Mailversand', 'Hier steht der Name nicht.');

    const linked = await entities.linkPage({
      userId: ownerId,
      entityId: entity.entity.id,
      request: { documentId: page, note: 'Handelt davon, ohne es zu nennen.' },
    });
    expect(linked.created).toBe(true);

    const profile = await profiles.profile(ownerId, entity.entity.id);
    expect(profile.mentions[0]?.source).toBe('manual');
    expect(profile.mentions[0]?.context).toBe('Handelt davon, ohne es zu nennen.');

    const removed = await entities.unlinkPage({
      userId: ownerId,
      entityId: entity.entity.id,
      documentId: page,
    });
    expect(removed.removed).toBe(true);
    expect((await profiles.profile(ownerId, entity.entity.id)).mentions).toEqual([]);
  });

  it('refuses a profile for an entity the caller cannot read', async () => {
    const entity = await entities.create({
      userId: ownerId,
      request: { title: 'Windmill', type: 'other', aliases: [], summary: '' },
      correlationId,
    });
    await expect(profiles.profile(outsiderId, entity.entity.id)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('entity candidates', () => {
  async function seedCandidate(phrase: string, pages: number): Promise<string> {
    const candidate = await prisma.entityCandidate.create({
      data: { phrase, phraseKey: `testkandidat-${phrase.toLowerCase()}` },
    });
    for (let index = 0; index < pages; index += 1) {
      const documentId = await createPage(`${phrase} ${index}`, `${phrase} kommt hier vor.`);
      await prisma.entityCandidateSighting.create({
        data: {
          candidateId: candidate.id,
          documentId,
          workspaceId,
          occurrences: 2,
          context: `${phrase} kommt hier vor.`,
        },
      });
    }
    return candidate.id;
  }

  it('offers only what crosses the threshold', async () => {
    await seedCandidate('Docling', 2);
    const thin = await candidates.list(ownerId, { limit: 25 });
    expect(thin.threshold).toBe(3);
    expect(thin.candidates.map((entry) => entry.phrase)).not.toContain('Docling');

    await seedCandidate('Mailpit', 3);
    const listed = await candidates.list(ownerId, { limit: 25 });
    const mailpit = listed.candidates.find((entry) => entry.phrase === 'Mailpit');
    expect(mailpit?.documentCount).toBe(3);
    expect(mailpit?.samples.length).toBeGreaterThan(0);
  });

  it('turns a candidate into an entity and adopts its pages', async () => {
    const candidateId = await seedCandidate('Hocuspocus', 3);
    const confirmed = await candidates.confirm({
      userId: ownerId,
      candidateId,
      request: { type: 'service', aliases: [] },
      correlationId,
    });

    expect(confirmed.entity.title).toBe('Hocuspocus');
    expect(confirmed.adoptedMentions).toBe(3);
    const profile = await profiles.profile(ownerId, confirmed.entity.id);
    expect(profile.mentions).toHaveLength(3);
  });

  it('refuses to confirm the same candidate twice', async () => {
    const candidateId = await seedCandidate('Docker', 3);
    await candidates.confirm({
      userId: ownerId,
      candidateId,
      request: { type: 'other', aliases: [] },
      correlationId,
    });
    await expect(
      candidates.confirm({
        userId: ownerId,
        candidateId,
        request: { type: 'other', aliases: [] },
        correlationId,
      }),
    ).rejects.toMatchObject({ code: 'entity_candidate_promoted' });
  });

  it('forgets the evidence when a candidate is dismissed, and stays dismissed', async () => {
    const candidateId = await seedCandidate('Turbo', 3);
    const dismissed = await candidates.dismiss({ userId: ownerId, candidateId });
    expect(dismissed.phrase).toBe('Turbo');

    const listed = await candidates.list(ownerId, { limit: 25 });
    expect(listed.candidates.map((entry) => entry.phrase)).not.toContain('Turbo');
    expect(await prisma.entityCandidateSighting.count({ where: { candidateId } })).toBe(0);
  });
});
