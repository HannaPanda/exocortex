import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { WorkspaceAccessService } from '@exocortex/auth';
import { loadDotEnv } from '@exocortex/config';
import { type Settings, settingsSchema } from '@exocortex/contracts';
import { createPrismaClient, type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';
import { type QueueRegistry } from '@exocortex/queue';

import { type SettingsService } from '../platform/settings.service';

import { RenderJobsService } from './render-jobs.service';
import { RenderTemplatesService } from './render-templates.service';

/**
 * Render templates and builds against the real database (issue #44, ADR-026).
 *
 * Nothing here starts a container: the service's whole job is to decide what a
 * build would be made of, write that down and hand it to a queue. What is worth
 * testing is exactly those decisions -- who may ask, what the cache considers
 * the same build, and when an existing PDF stops being the answer.
 *
 * The settings stub is bound to this suite's own workspace id and throws for any
 * other, because these tests talk to the deployment's database (see
 * `automations.service.integration.test.ts` for the time that mattered).
 */
loadDotEnv();

let prisma: PrismaClient;
let jobs: RenderJobsService;
let templates: RenderTemplatesService;
let adminId: string;
let memberId: string;
let workspaceId: string;
let otherWorkspaceId: string;
let pageId: string;
let childPageId: string;
let templateId: string;
let workspaceSettings: Settings;
const enqueued: { queue: string; payload: unknown }[] = [];

function settingsStubFor(id: () => string): SettingsService {
  return {
    async getForWorkspace(candidate: string): Promise<Settings> {
      if (candidate !== id()) {
        throw new Error(`Settings stub asked about a foreign workspace: ${candidate}`);
      }
      return workspaceSettings;
    },
  } as unknown as SettingsService;
}

const queueStub = {
  async enqueue(queue: string, payload: unknown): Promise<string> {
    enqueued.push({ queue, payload });
    return 'queued';
  },
} as unknown as QueueRegistry;

const loggerStub = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as Logger;

async function writeMarkdown(documentId: string, markdown: string): Promise<void> {
  await prisma.documentContent.upsert({
    where: { documentId },
    create: { documentId, yjsState: Buffer.from([0]), markdown, materializedAt: new Date() },
    update: { markdown, materializedAt: new Date() },
  });
}

beforeAll(async () => {
  prisma = createPrismaClient({ databaseUrl: process.env.DATABASE_URL });
  const access = new WorkspaceAccessService(prisma);
  const settings = settingsStubFor(() => workspaceId);
  jobs = new RenderJobsService(prisma, queueStub, loggerStub, access, settings);
  templates = new RenderTemplatesService(prisma, access, settings);

  const suffix = Date.now().toString(36);
  const [admin, member] = await Promise.all([
    prisma.user.create({
      data: { email: `render-admin-${suffix}@exocortex.test`, name: 'Admin', emailVerified: true },
    }),
    prisma.user.create({
      data: {
        email: `render-member-${suffix}@exocortex.test`,
        name: 'Mitglied',
        emailVerified: true,
      },
    }),
  ]);
  adminId = admin.id;
  memberId = member.id;

  const workspace = await prisma.workspace.create({
    data: {
      name: `Render ${suffix}`,
      slug: `render-${suffix}`,
      members: {
        create: [
          { userId: adminId, role: 'ADMIN' },
          { userId: memberId, role: 'MEMBER' },
        ],
      },
    },
  });
  workspaceId = workspace.id;

  const other = await prisma.workspace.create({
    data: {
      name: `Render other ${suffix}`,
      slug: `render-other-${suffix}`,
      members: { create: [{ userId: adminId, role: 'OWNER' }] },
    },
  });
  otherWorkspaceId = other.id;

  const page = await prisma.document.create({
    data: {
      workspaceId,
      title: 'Technische Dokumentation',
      type: 'PAGE',
      orderKey: 'a0',
      createdById: adminId,
      updatedById: adminId,
    },
  });
  pageId = page.id;
  const child = await prisma.document.create({
    data: {
      workspaceId,
      parentId: pageId,
      title: 'Installation',
      type: 'PAGE',
      orderKey: 'a1',
      createdById: adminId,
      updatedById: adminId,
    },
  });
  childPageId = child.id;

  await writeMarkdown(pageId, '## Abschnitt\n\nEin Absatz.\n');
  await writeMarkdown(childPageId, '# Voraussetzungen\n\nNode und pnpm.\n');
});

beforeEach(async () => {
  enqueued.length = 0;
  await prisma.renderJob.deleteMany({ where: { workspaceId } });
  await prisma.renderTemplate.deleteMany({ where: { workspaceId } });
  workspaceSettings = settingsSchema.parse({ 'render.enabled': true });

  const template = await prisma.renderTemplate.create({
    data: {
      workspaceId,
      name: 'Technische Dokumentation',
      renderer: 'LATEX_PDF',
      source: null,
      variables: [
        {
          name: 'customer',
          label: 'Kunde',
          origin: 'MANUAL',
          property: null,
          required: true,
          defaultValue: null,
        },
        {
          name: 'pfad',
          label: 'Pfad',
          origin: 'PATH',
          property: null,
          required: false,
          defaultValue: null,
        },
      ],
      createdById: adminId,
    },
  });
  templateId = template.id;
});

afterAll(async () => {
  await prisma.workspace.deleteMany({ where: { id: { in: [workspaceId, otherWorkspaceId] } } });
  await prisma.user.deleteMany({ where: { id: { in: [adminId, memberId] } } });
  await prisma.$disconnect();
});

describe('starting a build', () => {
  it('writes a pending job, resolves the variables and queues it', async () => {
    const result = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });

    expect(result.reused).toBe(false);
    expect(result.job.status).toBe('PENDING');
    expect(result.job.variables.customer).toBe('Musterfirma');
    // Resolved here, not in the worker, so the job says what it was built from.
    expect(result.job.variables.pfad).toBe('Technische Dokumentation');
    expect(result.job.inputHash).toHaveLength(64);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]?.queue).toBe('render');
  });

  it('refuses when a required variable is still empty', async () => {
    await expect(
      jobs.start({
        documentId: pageId,
        userId: memberId,
        request: { templateId, source: 'DOCUMENT', variables: {}, force: false },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
    expect(enqueued).toHaveLength(0);
  });

  it('refuses a template from another workspace', async () => {
    const foreign = await prisma.renderTemplate.create({
      data: { workspaceId: otherWorkspaceId, name: 'Fremd', createdById: adminId },
    });

    await expect(
      jobs.start({
        documentId: pageId,
        userId: adminId,
        request: {
          templateId: foreign.id,
          source: 'DOCUMENT',
          variables: { customer: 'x' },
          force: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('refuses while rendering is switched off for the workspace', async () => {
    workspaceSettings = settingsSchema.parse({ 'render.enabled': false });

    await expect(
      jobs.start({
        documentId: pageId,
        userId: memberId,
        request: {
          templateId,
          source: 'DOCUMENT',
          variables: { customer: 'x' },
          force: false,
        },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('gives a subtree a different hash than the page alone', async () => {
    const single = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    const subtree = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'SUBTREE',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });

    expect(subtree.reused).toBe(false);
    expect(subtree.job.inputHash).not.toBe(single.job.inputHash);
  });
});

describe('the build cache', () => {
  async function completeWithArtifact(jobId: string): Promise<string> {
    const attachment = await prisma.attachment.create({
      data: {
        workspaceId,
        documentId: pageId,
        filename: 'dokumentation.pdf',
        mimeType: 'application/pdf',
        byteSize: 1234,
        storageKey: `render-test/${jobId}.pdf`,
        createdById: adminId,
      },
    });
    await prisma.renderJob.update({
      where: { id: jobId },
      data: { status: 'COMPLETED', attachmentId: attachment.id, finishedAt: new Date() },
    });
    return attachment.id;
  }

  it('hands back the finished PDF instead of building the same thing twice', async () => {
    const first = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    const attachmentId = await completeWithArtifact(first.job.id);
    enqueued.length = 0;

    const second = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });

    expect(second.reused).toBe(true);
    expect(second.job.id).toBe(first.job.id);
    expect(second.job.attachmentId).toBe(attachmentId);
    expect(enqueued).toHaveLength(0);
  });

  it('builds again when asked to, even though nothing changed', async () => {
    const first = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    await completeWithArtifact(first.job.id);

    const forced = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: true,
      },
    });

    expect(forced.reused).toBe(false);
    expect(forced.job.id).not.toBe(first.job.id);
  });

  it('calls a finished build stale once the page has moved on', async () => {
    const first = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    await completeWithArtifact(first.job.id);

    expect((await jobs.read(first.job.id, memberId)).stale).toBe(false);

    await writeMarkdown(pageId, '## Abschnitt\n\nEin geänderter Absatz.\n');
    expect((await jobs.read(first.job.id, memberId)).stale).toBe(true);

    // And the cache agrees: the changed page gets a new build, not the old PDF.
    const second = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    expect(second.reused).toBe(false);

    await writeMarkdown(pageId, '## Abschnitt\n\nEin Absatz.\n');
  });

  it('calls a finished build stale once the template has changed', async () => {
    const first = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    await completeWithArtifact(first.job.id);

    await templates.update({
      templateId,
      userId: adminId,
      request: { source: '\\documentclass{article}\\begin{document}$body$\\end{document}' },
    });

    expect((await jobs.read(first.job.id, memberId)).stale).toBe(true);
  });
});

describe('cancelling', () => {
  it('closes a job nobody has picked up yet', async () => {
    const started = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });

    const cancelled = await jobs.cancel(started.job.id, memberId);
    expect(cancelled.status).toBe('CANCELLED');
  });

  it('only asks a running job to stop, and leaves the worker to notice', async () => {
    const started = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    await prisma.renderJob.update({
      where: { id: started.job.id },
      data: { status: 'RUNNING', startedAt: new Date() },
    });

    const cancelled = await jobs.cancel(started.job.id, memberId);
    expect(cancelled.status).toBe('RUNNING');
    const row = await prisma.renderJob.findUniqueOrThrow({ where: { id: started.job.id } });
    expect(row.cancelledAt).not.toBeNull();
  });

  it('refuses to cancel a build that is already over', async () => {
    const started = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });
    await prisma.renderJob.update({
      where: { id: started.job.id },
      data: { status: 'FAILED', finishedAt: new Date() },
    });

    await expect(jobs.cancel(started.job.id, memberId)).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('templates', () => {
  it('lets an admin write one and a member only read it', async () => {
    const created = await templates.create({
      workspaceId,
      userId: adminId,
      request: {
        name: 'Angebot',
        description: '',
        renderer: 'LATEX_PDF',
        source: null,
        variables: [],
      },
    });
    expect(created.source).toBeNull();

    const listed = await templates.list(workspaceId, memberId);
    expect(listed.templates.map((entry) => entry.name)).toContain('Angebot');
    expect(listed.enabledForWorkspace).toBe(true);

    await expect(
      templates.create({
        workspaceId,
        userId: memberId,
        request: {
          name: 'Vom Mitglied',
          description: '',
          renderer: 'LATEX_PDF',
          source: null,
          variables: [],
        },
      }),
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('refuses two variables of the same name', async () => {
    const variable = {
      name: 'kunde',
      label: 'Kunde',
      origin: 'MANUAL' as const,
      property: null,
      required: false,
      defaultValue: null,
    };

    await expect(
      templates.create({
        workspaceId,
        userId: adminId,
        request: {
          name: 'Doppelt',
          description: '',
          renderer: 'LATEX_PDF',
          source: null,
          variables: [variable, { ...variable, label: 'Kundin' }],
        },
      }),
    ).rejects.toMatchObject({ code: 'validation_failed' });
  });

  it('keeps the builds when the template goes, with the name it had', async () => {
    const started = await jobs.start({
      documentId: pageId,
      userId: memberId,
      request: {
        templateId,
        source: 'DOCUMENT',
        variables: { customer: 'Musterfirma' },
        force: false,
      },
    });

    await templates.remove(templateId, adminId);

    const job = await jobs.read(started.job.id, memberId);
    expect(job.templateId).toBeNull();
    expect(job.templateName).toBe('Technische Dokumentation');
  });
});
