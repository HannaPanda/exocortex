import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { createLogger, type Logger } from '@exocortex/logger';

import { createToolRunner, type CreateToolRunnerInput } from './tool-runner';

/**
 * The trust boundary of the built-in tool loop (issue #56, ADR-030).
 *
 * No database and no API: a refused call is decided before the service token
 * is minted and before the client is built, which is exactly the property
 * worth testing -- a refusal that had to reach the network first would not be
 * a boundary.
 */

const logger: Logger = createLogger({ name: 'tool-runner-test', level: 'silent' });

function runnerWith(overrides: Partial<CreateToolRunnerInput> = {}) {
  return createToolRunner({
    apiUrl: 'http://127.0.0.1:1',
    serviceTokenSecret: randomBytes(32).toString('hex'),
    serviceTokenTtlSeconds: 60,
    userId: 'user-1',
    includeMutating: true,
    mutationPolicy: 'guarded',
    webFetchesPerRun: 8,
    toolCallTimeoutMs: 1_000,
    agentSession: { externalId: 'ai-run-test', label: 'eXocortex KI' },
    logger,
    ...overrides,
  });
}

const A_WRITE = {
  name: 'exo_page_write',
  argumentsJson: JSON.stringify({ documentId: 'doc-1', markdown: 'hallo', mode: 'append' }),
  correlationId: 'corr-1',
};

describe('the tool runner as a trust boundary', () => {
  it('offers the mutating tools while the policy is guarded', () => {
    const names = runnerWith().definitions.map((definition) => definition.name);
    expect(names).toContain('exo_page_write');
  });

  it('never offers a mutating tool to a read-only run', () => {
    const names = runnerWith({ mutationPolicy: 'deny' }).definitions.map(
      (definition) => definition.name,
    );
    expect(names).not.toContain('exo_page_write');
    expect(names).toContain('exo_page_read');
  });

  it('refuses a mutating call in a read-only run even if the model asks anyway', async () => {
    const result = await runnerWith({ mutationPolicy: 'deny' }).run(A_WRITE);
    expect(result.refused).toBe(true);
    expect(result.isError).toBe(true);
  });

  it('refuses a mutating call once the run has read foreign content', async () => {
    const runner = runnerWith();
    runner.noteUntrustedContent('attachment');
    const result = await runner.run(A_WRITE);
    expect(result.refused).toBe(true);
    expect(result.text).toContain('hochgeladenen Dokument');
  });

  it('lets the declared exception write after foreign content', async () => {
    const runner = runnerWith({ mutationPolicy: 'allow' });
    runner.noteUntrustedContent('attachment');
    // Nothing listens on port 1, so the call fails at the network -- which is
    // the point: it got past the boundary and was actually attempted.
    const result = await runner.run(A_WRITE);
    expect(result.refused).toBe(false);
  });

  it('records each origin once, in the order it arrived', () => {
    const runner = runnerWith();
    runner.noteUntrustedContent('attachment');
    runner.noteUntrustedContent('web');
    runner.noteUntrustedContent('attachment');
    expect(runner.untrustedOrigins).toEqual(['attachment', 'web']);
  });

  it('leaves a read-only call alone after foreign content', async () => {
    const runner = runnerWith();
    runner.noteUntrustedContent('attachment');
    const result = await runner.run({
      name: 'exo_page_read',
      argumentsJson: JSON.stringify({ documentId: 'doc-1' }),
      correlationId: 'corr-1',
    });
    expect(result.refused).toBe(false);
  });

  it('reports an unknown tool without calling it a refusal', async () => {
    const result = await runnerWith().run({
      name: 'exo_does_not_exist',
      argumentsJson: '{}',
      correlationId: 'corr-1',
    });
    expect(result.isError).toBe(true);
    expect(result.refused).toBe(false);
  });
});

/**
 * The per-run web budget (issue #26).
 *
 * The same shape as the trust boundary above and tested the same way: the
 * refusal happens before any client is built, so no network is involved and
 * "the budget held" is not a claim about how a request behaved.
 */
describe('the tool runner as a web-research budget', () => {
  const A_FETCH = {
    name: 'exo_web_fetch',
    argumentsJson: JSON.stringify({ workspaceId: 'ws-1', url: 'https://example.com' }),
    correlationId: 'corr-1',
  };

  it('does not offer the fetch tool when the budget is zero', () => {
    const names = runnerWith({ webFetchesPerRun: 0 }).definitions.map(
      (definition) => definition.name,
    );
    expect(names).not.toContain('exo_web_fetch');
    // Searching stays: it costs nothing on this host and finding an address is
    // still useful when reading the page behind it is switched off.
    expect(names).toContain('exo_web_search');
  });

  it('offers the fetch tool while the budget is positive', () => {
    const names = runnerWith().definitions.map((definition) => definition.name);
    expect(names).toContain('exo_web_fetch');
  });

  it('refuses the fetch that would exceed the budget', async () => {
    const runner = runnerWith({ webFetchesPerRun: 1 });
    // The first call is allowed through the budget and then fails at the
    // network, which is the point: the budget is spent on the attempt.
    const first = await runner.run(A_FETCH);
    expect(first.refused).toBe(false);

    const second = await runner.run(A_FETCH);
    expect(second.refused).toBe(true);
    expect(second.text).toContain('Kontingent');
  });
});
