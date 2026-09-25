import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MockAiProvider } from '@exocortex/ai';
import { AuthorizationError, WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { createLogger, type Logger } from '@exocortex/logger';
import { QueueRegistry, testQueuePrefix } from '@exocortex/queue';

import { AppError } from '../common/app-error';
import { OutboxService } from '../common/outbox.service';
import { SettingsService } from '../platform/settings.service';

import { AiService } from './ai.service';
import { AiModelResolverService } from './ai-model-resolver.service';
import { ConversationsService } from './conversations.service';

/**
 * Cancelling and inspecting a run, against the real database.
 *
 * Issue #6: the panel finally has an "Abbrechen" button, and the catalogue an
 * `exo_ai_run_cancel` next to it. Both reach the same service method, so the
 * authorization it performs is the only thing standing between a workspace's
 * runs and anybody who knows a run id.
 */
loadDotEnv();

const logger: Logger = createLogger({ name: 'api-test', level: 'silent' });

let prisma: PrismaClient;
let queues: QueueRegistry;
let service: AiService;
let workspaceId: string;
let ownerId: string;
let memberId: string;
let outsiderId: string;

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  queues = new QueueRegistry({
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
    logger,
    prefix: testQueuePrefix('api-ai-runs'),
  });
  const access = new WorkspaceAccessService(prisma);
  const outbox = new OutboxService(prisma, logger);
  const settings = new SettingsService(prisma, logger, outbox);
  const provider = new MockAiProvider();
  const envDefaultModel = process.env.OPENROUTER_DEFAULT_MODEL ?? 'anthropic/claude-sonnet-4.5';
  const modelResolver = new AiModelResolverService(prisma, envDefaultModel, settings);
  const conversations = new ConversationsService(
    prisma,
    queues,
    logger,
    access,
    modelResolver,
    settings,
  );
  service = new AiService(prisma, queues, provider, logger, access, modelResolver, conversations);

  const suffix = Date.now().toString(36);
  const [owner, member, outsider] = await Promise.all([
    prisma.user.create({
      data: { email: `run-owner-${suffix}@exocortex.test`, name: 'Owner', emailVerified: true },
    }),
    prisma.user.create({
      data: { email: `run-member-${suffix}@exocortex.test`, name: 'Member', emailVerified: true },
    }),
    prisma.user.create({
      data: {
        email: `run-outsider-${suffix}@exocortex.test`,
        name: 'Outsider',
        emailVerified: true,
      },
    }),
  ]);
  ownerId = owner.id;
  memberId = member.id;
  outsiderId = outsider.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `AI runs ${suffix}`,
      slug: `ai-runs-${suffix}`,
      members: {
        create: [
          { userId: ownerId, role: 'OWNER' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;
}, 60_000);

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: workspaceId } });
  await prisma.user.deleteMany({ where: { id: { in: [ownerId, memberId, outsiderId] } } });
  await queues.obliterateAll();
  await queues.close();
  await prisma.$disconnect();
});

async function createRun(input: {
  status: 'PENDING' | 'RUNNING' | 'COMPLETED';
  resultText?: string;
}): Promise<string> {
  const run = await prisma.aiRun.create({
    data: {
      workspaceId,
      createdById: ownerId,
      status: input.status,
      provider: 'mock',
      model: 'mock-model',
      messages: [{ role: 'user', content: 'Bau die Seite um' }],
      resultText: input.resultText ?? null,
      startedAt: input.status === 'PENDING' ? null : new Date(),
      heartbeatAt: input.status === 'RUNNING' ? new Date() : null,
    },
  });
  return run.id;
}

describe('AiService.cancelRun', () => {
  it('cancels a running run and stamps the time it happened', async () => {
    const runId = await createRun({ status: 'RUNNING' });

    const cancelled = await service.cancelRun(runId, ownerId);

    expect(cancelled.status).toBe('cancelled');
    expect(cancelled.finishedAt).not.toBeNull();
    const row = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('CANCELLED');
    expect(row.cancelledAt).not.toBeNull();
  });

  it('cancels a run that was never picked up by a worker', async () => {
    const runId = await createRun({ status: 'PENDING' });
    const cancelled = await service.cancelRun(runId, ownerId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('lets any member of the workspace cancel, not only the run owner', async () => {
    // The button sits next to a shared conversation; a member watching a run
    // hang must be able to stop it.
    const runId = await createRun({ status: 'RUNNING' });
    const cancelled = await service.cancelRun(runId, memberId);
    expect(cancelled.status).toBe('cancelled');
  });

  it('refuses somebody who is not in the workspace', async () => {
    const runId = await createRun({ status: 'RUNNING' });

    await expect(service.cancelRun(runId, outsiderId)).rejects.toBeInstanceOf(AuthorizationError);

    const row = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('RUNNING');
  });

  it('refuses a run that has already finished instead of resurrecting it', async () => {
    const runId = await createRun({ status: 'COMPLETED' });

    await expect(service.cancelRun(runId, ownerId)).rejects.toMatchObject({ code: 'conflict' });

    const row = await prisma.aiRun.findUniqueOrThrow({ where: { id: runId } });
    expect(row.status).toBe('COMPLETED');
  });

  it('reports a run id that does not exist as not found', async () => {
    await expect(service.cancelRun('run_does_not_exist', ownerId)).rejects.toBeInstanceOf(AppError);
  });
});

describe('AiService.getRun', () => {
  it('reports the partial answer a still-running run has produced so far (issue #6)', async () => {
    // This is what the panel reloads when it notices a gap in the deltas, and
    // what exo_ai_run_get shows somebody looking from outside the browser.
    const runId = await createRun({ status: 'RUNNING', resultText: 'Ich schreibe jetzt' });

    const run = await service.getRun(runId, ownerId, {});

    expect(run.status).toBe('running');
    expect(run.resultText).toBe('Ich schreibe jetzt');
    expect(run.heartbeatAt).not.toBeNull();
  });

  it('refuses somebody who is not in the workspace', async () => {
    const runId = await createRun({ status: 'RUNNING' });
    await expect(service.getRun(runId, outsiderId, {})).rejects.toBeInstanceOf(AuthorizationError);
  });
});
