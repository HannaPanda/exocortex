import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { createLogger, type Logger } from '@exocortex/logger';

import { createToolRunner, type CreateToolRunnerInput, type ToolRunner } from './tool-runner';

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
    taskText: 'Schreib etwas auf eine Seite.',
    requiredDomains: [],
    toolCallTimeoutMs: 1_000,
    agentSession: { externalId: 'ai-run-test', label: 'eXocortex KI' },
    logger,
    ...overrides,
  });
}

/** A task whose words open the `web` domain (issue #121). */
const WEB_TASK = 'Recherchier im Internet, was das kostet.';

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
    // A task that asks for the web, so the domain is offered and the budget
    // is the only thing that can take the tool away (issue #121).
    const names = runnerWith({ webFetchesPerRun: 0, taskText: WEB_TASK }).definitions.map(
      (definition) => definition.name,
    );
    expect(names).not.toContain('exo_web_fetch');
    // Searching stays: it costs nothing on this host and finding an address is
    // still useful when reading the page behind it is switched off.
    expect(names).toContain('exo_web_search');
  });

  it('offers the fetch tool while the budget is positive', () => {
    const names = runnerWith({ taskText: WEB_TASK }).definitions.map(
      (definition) => definition.name,
    );
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

/**
 * The duplicate guard (issue #118, ADR-059).
 *
 * This one does need a server, and that is the point: what is under test is
 * the comparison between one answer and the next, so both answers have to
 * exist. A stub client would prove the ledger works, which
 * `tool-ledger.test.ts` already does, and nothing about the runner.
 */
describe('the tool runner as a duplicate guard', () => {
  function workspaceBody(name: string): string {
    return JSON.stringify({
      workspaces: [
        {
          id: 'ws12345678',
          name,
          slug: 'testbereich',
          createdAt: '2026-09-21T10:00:00.000Z',
          updatedAt: '2026-09-21T10:00:00.000Z',
          role: 'OWNER',
          memberCount: 1,
          isMemory: false,
        },
      ],
    });
  }

  /** A server answering the bodies in order, so a test can make it change its mind. */
  async function servingRunner(bodies: readonly string[]): Promise<ToolRunner> {
    let served = 0;
    const server = createServer((_request, response) => {
      const body = bodies[served] ?? bodies[bodies.length - 1] ?? '{}';
      served += 1;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    servers.push(server);
    const { port } = server.address() as AddressInfo;
    return runnerWith({ apiUrl: `http://127.0.0.1:${String(port)}` });
  }

  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(
      servers.splice(0).map(
        (server) =>
          new Promise<void>((resolve, reject) => {
            server.close((error) => (error === undefined ? resolve() : reject(error)));
          }),
      ),
    );
  });

  const A_LIST = {
    name: 'exo_list_workspaces',
    argumentsJson: '{}',
    correlationId: 'corr-1',
  };

  it('answers a repeated call with a hint instead of the same text again', async () => {
    const runner = await servingRunner([workspaceBody('Testbereich')]);

    const first = await runner.run(A_LIST);
    const second = await runner.run(A_LIST);

    expect(first.text).toContain('Testbereich');
    expect(second.text).not.toContain('Testbereich');
    expect(second.text).toContain('Aufruf 1');
    expect(second.text).toContain('exo_page_block_read');
    // Not an error: nothing failed, and calling it one would invite exactly
    // the retry this replaces.
    expect(second.isError).toBe(false);
    expect(second.refused).toBe(false);
  });

  it('hands a changed answer through, so a run waiting for something still works', async () => {
    const runner = await servingRunner([
      workspaceBody('Vorher'),
      workspaceBody('Nachher'),
      workspaceBody('Nachher'),
    ]);

    const first = await runner.run(A_LIST);
    const second = await runner.run(A_LIST);
    const third = await runner.run(A_LIST);

    expect(first.text).toContain('Vorher');
    expect(second.text).toContain('Nachher');
    expect(third.text).toContain('Aufruf 2');
  });

  it('reports what the run spent its calls on', async () => {
    const runner = await servingRunner([workspaceBody('Testbereich')]);
    await runner.run(A_LIST);
    await runner.run(A_LIST);

    const tallies = runner.tallies();
    expect(tallies).toHaveLength(1);
    expect(tallies[0]?.name).toBe('exo_list_workspaces');
    expect(tallies[0]?.calls).toBe(2);
    expect(tallies[0]?.repeats).toBe(1);
    expect(tallies[0]?.chars).toBeGreaterThan(0);
  });
});

/**
 * Which part of the catalogue a run is told about (issue #121, ADR-060).
 *
 * The line this suite has to hold is the one the design rests on: the offer is
 * an efficiency, never a permission. A tool that was not offered must still
 * run when the model names it anyway, or "tool selection is not a security
 * mechanism" is a sentence in a document and nothing else.
 */
describe('the tool runner as a tool-context budget', () => {
  it('offers a fraction of the catalogue, and still a whole agent', () => {
    const runner = runnerWith({
      taskText: 'Verschiebe den Abschnitt „Standort Halle 4“ auf eine eigene Unterseite.',
    });
    const names = runner.definitions.map((definition) => definition.name);

    expect(names).toContain('exo_page_read');
    expect(names).toContain('exo_page_extract_section');
    expect(names).toContain('exo_toolbox');
    // The specialisms the task never mentioned stay out of the request.
    expect(names).not.toContain('exo_project_build');
    expect(names).not.toContain('exo_database_query');

    const context = runner.toolContext();
    expect(context.domains).toEqual(['core', 'pages']);
    expect(context.offered).toBe(names.length);
    expect(context.schemaChars).toBeGreaterThan(0);
  });

  it('takes the domain a task names', () => {
    const runner = runnerWith({ taskText: 'Leg in der Datenbank ToDos eine Zeile an.' });
    expect(runner.definitions.map((definition) => definition.name)).toContain('exo_database_query');
    expect(runner.toolContext().domains).toContain('databases');
  });

  it('takes a domain the caller knows about although the words do not', () => {
    const runner = runnerWith({ taskText: 'Was steht hier drin?', requiredDomains: ['databases'] });
    expect(runner.toolContext().domains).toContain('databases');
  });

  it('runs a tool it never offered, because the offer is not the authorization', async () => {
    const runner = runnerWith({ taskText: 'Schreib einen Satz auf die Seite.' });
    expect(runner.definitions.map((definition) => definition.name)).not.toContain(
      'exo_database_query',
    );

    const result = await runner.run({
      name: 'exo_database_query',
      argumentsJson: JSON.stringify({ documentId: 'doc-1' }),
      correlationId: 'corr-1',
    });

    // Nothing listens on port 1, so it fails at the network -- which is the
    // proof: it was executed rather than refused or reported unknown.
    expect(result.refused).toBe(false);
    expect(result.text).not.toContain('Unbekanntes Werkzeug');
  });

  it('opens a domain when the run asks for one, and the next turn carries it', async () => {
    const runner = runnerWith({ taskText: 'Schreib einen Satz auf die Seite.' });
    const before = runner.definitions.length;
    expect(runner.definitions.map((definition) => definition.name)).not.toContain(
      'exo_render_start',
    );

    const result = await runner.run({
      name: 'exo_toolbox',
      argumentsJson: JSON.stringify({ domain: 'render' }),
      correlationId: 'corr-1',
    });

    expect(result.isError).toBe(false);
    expect(runner.definitions.length).toBeGreaterThan(before);
    expect(runner.definitions.map((definition) => definition.name)).toContain('exo_render_start');
    expect(runner.toolContext().domains).toContain('render');
  });

  it('counts the calls it made, whatever they were', async () => {
    const runner = runnerWith({ taskText: 'Schreib einen Satz auf die Seite.' });
    expect(runner.callCount()).toBe(0);
    await runner.run({ name: 'exo_toolbox', argumentsJson: '{}', correlationId: 'corr-1' });
    expect(runner.callCount()).toBe(1);
  });
});
