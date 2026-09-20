import { createHmac, randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { type AiProvider } from '@exocortex/ai';
import { encryptCredential } from '@exocortex/auth';
import {
  AUTOMATION_SIGNATURE_HEADER,
  AUTOMATION_TIMESTAMP_HEADER,
  type AutomationJob,
  type QUEUE_NAMES,
  resolveSettings,
  type Settings,
} from '@exocortex/contracts';
import { type PrismaClient } from '@exocortex/database';
import { createLogger } from '@exocortex/logger';
import { type ExocortexApiClient } from '@exocortex/mcp-tools';
import { type JobContext, type QueueRegistry } from '@exocortex/queue';

import { createAutomationProcessor } from './automation';
import { type WebhookRequestInput, type WebhookResult } from './automation/webhook-request';

const logger = createLogger({ name: 'worker-test', level: 'silent' });
const encryptionKey = randomBytes(32);
const SECRET = 'exoa_test-signing-secret';

function settingsWith(rows: { key: string; value: unknown }[]): Settings {
  return resolveSettings({ rows, env: {} }).settings;
}

const DEFAULT_SETTINGS = settingsWith([
  { key: 'automations.enabled', value: true },
  { key: 'automations.webhookAllowedHosts', value: 'hooks.example.org' },
]);

interface StoredRule {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  action: 'WEBHOOK' | 'AI_RUN' | 'EMAIL_SELF';
  output: 'COMMENT' | 'CHILD_PAGE';
  webhookUrl: string | null;
  prompt: string | null;
  modelSlug: string | null;
  mailSubject: string | null;
  createdById: string | null;
  consecutiveFailures: number;
  disabledReason: string | null;
}

/** The owning account, as the mail action reads it back. */
interface StoredOwner {
  email: string;
  emailVerified: boolean;
  disabledAt: Date | null;
}

const OWNER: StoredOwner = {
  email: 'johanna@example.org',
  emailVerified: true,
  disabledAt: null,
};

function webhookRule(overrides: Partial<StoredRule> = {}): StoredRule {
  return {
    id: 'rule-1',
    workspaceId: 'workspace-1',
    name: 'Hermes benachrichtigen',
    enabled: true,
    action: 'WEBHOOK',
    output: 'COMMENT',
    webhookUrl: 'https://hooks.example.org/exocortex',
    prompt: null,
    modelSlug: null,
    mailSubject: null,
    createdById: 'user-1',
    consecutiveFailures: 0,
    disabledReason: null,
    ...overrides,
  };
}

/**
 * The processor with a fake database, a fake network and a fake model.
 *
 * The run rows and the rule are plain objects, because what these tests are
 * about is the outcome recorded against a firing, not how Prisma stores it.
 */
function harness(input: {
  rule: StoredRule;
  settings?: Settings;
  respond?: (request: WebhookRequestInput) => WebhookResult | Promise<WebhookResult>;
  answer?: string | Error;
  /** The owning account, or null for one that has been deleted. */
  owner?: StoredOwner | null;
  /** What the page's Markdown export answers with. */
  markdown?: string;
}) {
  const runs: Record<string, unknown>[] = [];
  const mails: { payload: Record<string, unknown>; options?: { jobId?: string } }[] = [];
  const requests: { path: string; body: unknown }[] = [];
  const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
  const rule = { ...input.rule };

  const encrypted = encryptCredential({
    key: encryptionKey,
    purpose: 'automation-webhook',
    plaintext: SECRET,
  });

  const prisma = {
    automationRule: {
      findUnique: async () =>
        rule.action === 'WEBHOOK'
          ? {
              ...rule,
              secretCiphertext: encrypted.ciphertext,
              secretIv: encrypted.iv,
              secretAuthTag: encrypted.authTag,
              secretKeyVersion: encrypted.keyVersion,
            }
          : {
              ...rule,
              secretCiphertext: null,
              secretIv: null,
              secretAuthTag: null,
              secretKeyVersion: null,
            },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.enabled === false) {
          rule.enabled = false;
          rule.disabledReason = String(data.disabledReason);
        }
        if (typeof data.consecutiveFailures === 'object' && data.consecutiveFailures !== null) {
          rule.consecutiveFailures += 1;
        }
        return { consecutiveFailures: rule.consecutiveFailures };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.consecutiveFailures === 0) rule.consecutiveFailures = 0;
        return { count: 1 };
      },
    },
    automationRun: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        runs.push({ ...data, id: 'run-1' });
        return { id: 'run-1' };
      },
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        runs.push(data);
        return { count: 1 };
      },
    },
    document: {
      findUnique: async () => ({
        id: 'page-1',
        title: 'Technik',
        type: 'PAGE',
        parentId: null,
      }),
    },
    user: {
      findUnique: async () => (input.owner === undefined ? OWNER : input.owner),
    },
  } as unknown as PrismaClient;

  const queues = {
    enqueue: async (
      _queue: string,
      payload: Record<string, unknown>,
      options?: { jobId?: string },
    ) => {
      mails.push({ payload, options });
    },
  } as unknown as QueueRegistry;

  const provider = {
    generate: async () => {
      if (input.answer instanceof Error) throw input.answer;
      return { text: input.answer ?? 'Alles in Ordnung.', usage: {}, finishReason: 'stop' };
    },
  } as unknown as AiProvider;

  const client = {
    request: async ({ path, body }: { path: string; body?: unknown }) => {
      requests.push({ path, body });
      if (path.endsWith('/export/markdown')) {
        return {
          documentId: 'page-1',
          filename: 'technik.md',
          markdown: input.markdown ?? '# Technik',
          path: [],
          children: [],
        };
      }
      if (path.endsWith('/comments')) return { comment: { id: 'comment-1' } };
      return { document: { id: 'page-2' }, warnings: [] };
    },
  } as unknown as ExocortexApiClient;

  const headersSeen: Record<string, string>[] = [];
  const processor = createAutomationProcessor({
    prisma,
    provider,
    apiClientFor: (_userId, headers) => {
      headersSeen.push({ ...headers });
      return client;
    },
    settings: async () => input.settings ?? DEFAULT_SETTINGS,
    defaultModel: 'test/model',
    credentialKey: encryptionKey,
    queues,
    appUrl: 'https://exocortex.example/',
    sendWebhook: async (request) => {
      sent.push({
        url: request.url,
        headers: { ...request.headers },
        body: request.body,
      });
      return (await input.respond?.(request)) ?? { status: 204 };
    },
  });

  return { processor, runs, requests, sent, rule, headersSeen, mails };
}

function job(overrides: Partial<AutomationJob> = {}): JobContext<typeof QUEUE_NAMES.automation> {
  const payload: AutomationJob = {
    correlationId: 'test',
    ruleId: 'rule-1',
    runId: null,
    workspaceId: 'workspace-1',
    documentId: 'page-1',
    trigger: 'DOCUMENT_CONTENT_CHANGED',
    origin: 'EVENT',
    depth: 0,
    ...overrides,
  };
  return { payload, logger } as unknown as JobContext<typeof QUEUE_NAMES.automation>;
}

/** The last thing written about this run. */
function outcome(runs: Record<string, unknown>[]): Record<string, unknown> {
  return runs[runs.length - 1] ?? {};
}

describe('a webhook rule', () => {
  it('posts a signed body and records the status', async () => {
    const { processor, runs, sent } = harness({ rule: webhookRule() });
    await processor(job());

    expect(sent).toHaveLength(1);
    const post = sent[0]!;
    const timestamp = post.headers[AUTOMATION_TIMESTAMP_HEADER]!;
    const expected = createHmac('sha256', SECRET).update(`${timestamp}.${post.body}`).digest('hex');
    expect(post.headers[AUTOMATION_SIGNATURE_HEADER]).toBe(`sha256=${expected}`);

    expect(outcome(runs)).toMatchObject({ status: 'SUCCEEDED', detail: { status: 204 } });
  });

  it('sends metadata about the page and never its text', async () => {
    const { processor, sent } = harness({ rule: webhookRule() });
    await processor(job());
    const body = JSON.parse(sent[0]!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      event: 'automation.triggered',
      rule: { id: 'rule-1' },
      document: { id: 'page-1', title: 'Technik' },
    });
    expect(JSON.stringify(body)).not.toContain('# Technik');
  });

  it('fails the run when the receiver refuses, without throwing at the queue', async () => {
    const { processor, runs } = harness({
      rule: webhookRule(),
      respond: () => ({ status: 500 }),
    });
    await expect(processor(job())).resolves.toBeUndefined();
    expect(outcome(runs)).toMatchObject({ status: 'FAILED' });
    expect(String(outcome(runs).error)).toContain('500');
  });

  it('refuses to fire at a host that has fallen off the allowlist', async () => {
    const { processor, runs, sent } = harness({
      rule: webhookRule(),
      settings: settingsWith([
        { key: 'automations.enabled', value: true },
        { key: 'automations.webhookAllowedHosts', value: '' },
      ]),
    });
    await processor(job());
    expect(sent).toHaveLength(0);
    expect(outcome(runs)).toMatchObject({ status: 'FAILED' });
  });

  it('switches itself off once it has failed enough times in a row', async () => {
    const { processor, rule } = harness({
      rule: webhookRule({ consecutiveFailures: 4 }),
      respond: () => ({ status: 502 }),
      settings: settingsWith([
        { key: 'automations.enabled', value: true },
        { key: 'automations.webhookAllowedHosts', value: 'hooks.example.org' },
        { key: 'automations.maxConsecutiveFailures', value: 5 },
      ]),
    });
    await processor(job());
    expect(rule.enabled).toBe(false);
    expect(rule.disabledReason).toContain('502');
  });
});

describe('an AI rule', () => {
  it('writes its answer as a comment and stamps the rule on the write', async () => {
    const { processor, runs, requests, headersSeen } = harness({
      rule: webhookRule({
        action: 'AI_RUN',
        webhookUrl: null,
        prompt: 'Prüfe, ob die Seite veraltet ist.',
      }),
      answer: 'Der Abschnitt zu nginx stimmt nicht mehr.',
    });
    await processor(job({ depth: 1 }));

    expect(requests.map((entry) => entry.path)).toEqual([
      '/api/documents/page-1/export/markdown',
      '/api/documents/page-1/comments',
    ]);
    // Without this header the comment it just wrote could trigger the very
    // rule that wrote it.
    expect(headersSeen[0]?.['x-exocortex-automation']).toBe('rule-1:1');
    expect(outcome(runs)).toMatchObject({
      status: 'SUCCEEDED',
      detail: { output: 'COMMENT', commentId: 'comment-1' },
    });
  });

  it('writes a child page when the rule asks for one', async () => {
    const { processor, requests, runs } = harness({
      rule: webhookRule({
        action: 'AI_RUN',
        webhookUrl: null,
        prompt: 'Fasse zusammen.',
        output: 'CHILD_PAGE',
      }),
    });
    await processor(job());
    expect(requests[1]?.path).toBe('/api/workspaces/workspace-1/import/markdown');
    expect(requests[1]?.body).toMatchObject({ parentId: 'page-1' });
    expect(outcome(runs)).toMatchObject({ detail: { output: 'CHILD_PAGE' } });
  });

  it('records a refusing model as a failed run rather than throwing', async () => {
    const { processor, runs } = harness({
      rule: webhookRule({ action: 'AI_RUN', webhookUrl: null, prompt: 'Prüfe.' }),
      answer: new Error('provider exploded'),
    });
    await expect(processor(job())).resolves.toBeUndefined();
    expect(outcome(runs)).toMatchObject({ status: 'FAILED', error: 'provider exploded' });
  });
});

describe('a mail rule', () => {
  function mailRule(overrides: Partial<StoredRule> = {}): StoredRule {
    return webhookRule({
      action: 'EMAIL_SELF',
      webhookUrl: null,
      name: 'Morgenübersicht',
      ...overrides,
    });
  }

  it('queues the page to its owner, once per run', async () => {
    const { processor, runs, mails } = harness({ rule: mailRule() });
    await processor(job());

    expect(mails).toHaveLength(1);
    expect(mails[0]?.payload).toMatchObject({
      recipient: 'johanna@example.org',
      mail: {
        template: 'AUTOMATION_PAGE',
        ruleName: 'Morgenübersicht',
        // No subject on the rule, so the rule's name serves as one.
        subject: 'Morgenübersicht',
        documentTitle: 'Technik',
        url: 'https://exocortex.example/arbeitsbereich/workspace-1/seite/page-1',
        body: '# Technik',
        truncated: false,
      },
    });
    // One run, one letter: a retried job reaching this line again must not
    // post a second copy of the same morning.
    expect(mails[0]?.options?.jobId).toBe('automation-mail-run-1');
    // "queued" and never "sent": the relay has not been asked yet.
    expect(outcome(runs)).toMatchObject({
      status: 'SUCCEEDED',
      detail: { action: 'EMAIL_SELF', queued: true, recipientDomain: 'example.org' },
    });
  });

  it('uses the subject the rule carries when there is one', async () => {
    const { processor, mails } = harness({ rule: mailRule({ mailSubject: 'Dein Tag' }) });
    await processor(job());
    expect(mails[0]?.payload).toMatchObject({ mail: { subject: 'Dein Tag' } });
  });

  it('cuts a long page and says so rather than mailing all of it', async () => {
    const line = `${'x'.repeat(99)}\n`;
    const { processor, mails } = harness({ rule: mailRule(), markdown: line.repeat(200) });
    await processor(job());

    const queued = mails[0];
    expect(queued).toBeDefined();
    const mail = (queued?.payload as { mail: { body: string; truncated: boolean } } | undefined)
      ?.mail;
    expect(mail?.truncated).toBe(true);
    expect(mail?.body.length ?? 0).toBeLessThanOrEqual(10_000);
  });

  it('fails the run rather than writing to an unconfirmed address', async () => {
    const { processor, runs, mails } = harness({
      rule: mailRule(),
      owner: { ...OWNER, emailVerified: false },
    });
    await processor(job());

    expect(mails).toHaveLength(0);
    expect(outcome(runs)).toMatchObject({ status: 'FAILED' });
    expect(String(outcome(runs).error)).toContain('confirmed');
  });

  it('writes nothing to an account somebody switched off', async () => {
    const { processor, runs, mails } = harness({
      rule: mailRule(),
      owner: { ...OWNER, disabledAt: new Date() },
    });
    await processor(job());

    expect(mails).toHaveLength(0);
    expect(String(outcome(runs).error)).toContain('switched off');
  });
});

describe('refusing to act', () => {
  it('skips a rule somebody switched off inside the debounce window', async () => {
    const { processor, runs, sent } = harness({ rule: webhookRule({ enabled: false }) });
    await processor(job());
    expect(sent).toHaveLength(0);
    expect(outcome(runs)).toMatchObject({ status: 'SKIPPED' });
  });

  it('skips everything once the deployment pulls the emergency stop', async () => {
    const { processor, runs, sent } = harness({
      rule: webhookRule(),
      settings: settingsWith([{ key: 'automations.enabled', value: false }]),
    });
    await processor(job());
    expect(sent).toHaveLength(0);
    expect(outcome(runs)).toMatchObject({ status: 'SKIPPED' });
  });

  it('skips a rule whose owner is gone: there is no authority left to act with', async () => {
    const { processor, runs, sent } = harness({ rule: webhookRule({ createdById: null }) });
    await processor(job());
    expect(sent).toHaveLength(0);
    expect(String(outcome(runs).error)).toContain('owner');
  });
});
