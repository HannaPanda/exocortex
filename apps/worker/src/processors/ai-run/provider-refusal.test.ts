import { describe, expect, it } from 'vitest';

import { type RunExecutionInput } from './execution-types';
import { explainProviderRefusal, OwnKeyPayer, ownKeyPays } from './provider-refusal';

describe('ownKeyPays', () => {
  it('lets the workspace key pay only for what OpenRouter serves', () => {
    expect(ownKeyPays('openrouter', true)).toBe(true);
    // A subscription run resolves the workspace key for its fallback, and
    // still the plan pays for it: this was recorded as the workspace's.
    expect(ownKeyPays('cline', true)).toBe(false);
    expect(ownKeyPays('openrouter', false)).toBe(false);
  });
});

describe('OwnKeyPayer', () => {
  function payer(provider: string) {
    const updates: unknown[] = [];
    const prisma = {
      aiRun: {
        update: (args: unknown) => {
          updates.push(args);
          return Promise.resolve({});
        },
      },
    } as unknown as RunExecutionInput['prisma'];
    const logger = { warn: () => undefined } as unknown as RunExecutionInput['logger'];
    const run = { id: 'run-1', provider } as RunExecutionInput['run'];
    return { updates, payer: new OwnKeyPayer({ prisma, run, logger, workspaceKey: true }) };
  }

  it('flags a subscription run once, when a turn falls back to OpenRouter', async () => {
    const { payer: cline, updates } = payer('cline');
    expect(cline.paid).toBe(false);

    await cline.note('cline');
    expect(updates).toHaveLength(0);

    await cline.note('openrouter');
    await cline.note('openrouter');
    expect(cline.paid).toBe(true);
    expect(updates).toEqual([{ where: { id: 'run-1' }, data: { usedOwnKey: true } }]);
  });

  it('writes nothing for an OpenRouter run, which markRunning already flagged', async () => {
    const { payer: openRouter, updates } = payer('openrouter');
    await openRouter.note('openrouter');
    expect(openRouter.paid).toBe(true);
    expect(updates).toHaveLength(0);
  });
});

describe('explainProviderRefusal', () => {
  const model = 'deepseek/deepseek-v4.1-flash';

  it('names the account when the provider said its settings refused the model', () => {
    const failure = explainProviderRefusal(
      {
        code: 'ai_no_eligible_provider',
        message:
          'OpenRouter responded with 404: 0 endpoints out of 37 requested are available matching your guardrail restrictions and data policy.',
      },
      model,
      true,
    );
    expect(failure.diagnosis).toEqual({
      key: 'noEligibleProvider',
      args: { cause: 'account', model, ownKey: true },
    });
  });

  it('does not guess the account when the provider named no reason', () => {
    const failure = explainProviderRefusal(
      { code: 'ai_no_eligible_provider', message: 'OpenRouter responded with 404' },
      model,
      true,
    );
    expect(failure.diagnosis?.args).toMatchObject({ cause: 'unknown' });
  });

  it('leaves every other failure, and one already explained, as it was', () => {
    const outage = { code: 'ai_provider_unavailable', message: 'guardrail' };
    expect(explainProviderRefusal(outage, model, true)).toBe(outage);

    const explained = {
      code: 'ai_no_eligible_provider',
      message: 'too large',
      diagnosis: {
        key: 'noEligibleProvider' as const,
        args: { cause: 'size' as const, model: 'm', ownKey: false },
      },
    };
    expect(explainProviderRefusal(explained, model, true)).toBe(explained);
  });
});
