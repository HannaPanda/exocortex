import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import { BASIC_AUTH_CREDENTIALS } from '../support/basic-auth';
import { recordWorkspace } from '../support/created-workspaces';
import { apiSignIn, requireSeedCredentials } from '../support/fixtures';
import { storageStatePath } from '../support/global-setup';

/**
 * The workflow editor and run debugger (issue #164), and a draft an agent
 * wrote waiting for a person to publish it (issue #165).
 *
 * The authoring test builds trigger → agent → condition → approval / end
 * with the palette and the configuration panel only, which is the keyboard
 * path too: no node is dragged and no line is drawn with the pointer. It then
 * saves and publishes, and reads the stored graph back over the API.
 *
 * A real run starts agents only when the deployment has workflows switched
 * on (`workflows.enabled`, off by default and in production). The debugger is
 * therefore proven twice: against a fixed run answered by the test, which
 * shows waiting, failed and retried nodes and the path taken, and against a
 * real run of a graph without agents wherever workflows may run.
 */

let api: APIRequestContext;
let origin: string;
let workspaceId: string;

test.use({ storageState: storageStatePath('johanna') });

test.beforeAll(async ({ playwright, baseURL }) => {
  requireSeedCredentials();
  origin = baseURL as string;
  api = await playwright.request.newContext({ httpCredentials: BASIC_AUTH_CREDENTIALS });
  await apiSignIn(api, 'johanna', origin);
  const created = await api.post(`${origin}/api/workspaces`, {
    data: { name: `Workflows ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  workspaceId = ((await created.json()) as { id: string }).id;
  recordWorkspace(workspaceId);
});

test.afterAll(async () => {
  await api.dispose();
});

async function choose(page: Page, testId: string, option: string | RegExp): Promise<void> {
  await page.getByTestId(testId).click();
  await page.getByRole('option', { name: option }).click();
}

async function selectNode(page: Page, nodeId: string): Promise<void> {
  await page.locator(`[data-testid="workflow-node"][data-node-id="${nodeId}"]`).click();
  await expect(page.getByTestId('workflow-node-inspector')).toBeVisible();
}

test('authors trigger, agent, condition, approval and end without drawing a line', async ({
  page,
}) => {
  const name = `Ideen sichten ${Date.now().toString(36)}`;
  await page.goto(`/arbeitsbereich/${workspaceId}/workflows`);
  await page.getByTestId('workflow-new').click();
  await page.getByTestId('workflow-create-name').fill(name);
  await page.getByTestId('workflow-create-submit').click();
  await page.waitForURL(/\/workflows\/[a-z0-9]+$/u, { timeout: 30_000 });
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();

  // The start node is there; an agent added after it is wired in at once,
  // and its missing goal is a problem on the node itself.
  await selectNode(page, 'start');
  await page.getByTestId('workflow-palette-agent').click();
  const agent = page.locator('[data-testid="workflow-node"][data-node-id="agent"]');
  await expect(agent).toBeVisible();
  await expect(agent).toContainText('1');
  await expect(page.getByTestId('workflow-problem').first()).toBeVisible();

  await page
    .getByTestId('workflow-agent-goal')
    .fill('Bewerte meine offenen technischen Ideen und gib die beste mit einer Punktzahl zurück.');
  await page.getByTestId('workflow-agent-field-add').click();
  await page.getByTestId('workflow-agent-field-name').fill('score');
  await page.getByTestId('workflow-agent-field').getByRole('combobox').click();
  await page.getByRole('option', { name: 'Zahl' }).click();
  // The agent proposes by default, and the effective mode is said beside it.
  await expect(page.getByTestId('workflow-agent-effective')).toContainText('Nur vorschlagen');

  await page.getByTestId('workflow-palette-condition').click();
  await choose(page, 'workflow-condition-source', /score/u);
  await choose(page, 'workflow-condition-operator', 'mindestens');
  await page.getByTestId('workflow-condition-value').fill('7');

  await page.getByTestId('workflow-palette-approval').click();
  await page.getByTestId('workflow-approval-title').fill('Plan starten?');
  await page.getByTestId('workflow-approval-question').fill('Soll ich die beste Idee planen?');

  // Back on the condition, its free "nein" handle takes the end node.
  await selectNode(page, 'condition');
  await page.getByTestId('workflow-palette-end').click();

  await page.locator('.react-flow__pane').click({ position: { x: 5, y: 5 } });
  await expect(page.getByTestId('workflow-no-problems')).toBeVisible();

  await page.getByTestId('workflow-save').click();
  await expect(page.getByTestId('workflow-state')).toContainText('Stand 2', { timeout: 30_000 });
  await page.getByTestId('workflow-publish').click();
  await expect(page.getByTestId('workflow-published-version')).toContainText('Version 1', {
    timeout: 30_000,
  });

  const listed = await api.get(`${origin}/api/workspaces/${workspaceId}/workflows`);
  const workflow = (
    (await listed.json()) as { workflows: { id: string; name: string }[] }
  ).workflows.find((entry) => entry.name === name);
  expect(workflow).toBeDefined();
  const read = await api.get(`${origin}/api/workflows/${workflow!.id}`);
  const body = (await read.json()) as {
    draft: { edges: { source: { nodeId: string; handle: string }; target: { nodeId: string } }[] };
    problems: unknown[];
  };
  expect(body.problems).toEqual([]);
  expect(
    body.draft.edges
      .map((edge) => `${edge.source.nodeId}.${edge.source.handle}>${edge.target.nodeId}`)
      .sort(),
  ).toEqual([
    'agent.next>condition',
    'condition.false>end',
    'condition.true>approval',
    'start.next>agent',
  ]);
});

test('shows a draft an agent wrote and leaves publishing it to the person', async ({ page }) => {
  // The browser's own session, but announcing an agent session: how Hermes
  // or Claude Code would arrive (ADR-022), as far as provenance goes.
  const agent = {
    'x-exocortex-agent-session': `e2e-${Date.now().toString(36)}`,
    'x-exocortex-agent-client': 'Hermes',
  };
  const created = await api.post(`${origin}/api/workspaces/${workspaceId}/workflows`, {
    headers: agent,
    data: {
      name: `Von Hermes ${Date.now().toString(36)}`,
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
          { id: 'ende', type: 'end', outcome: 'succeeded', position: { x: 280, y: 0 } },
        ],
        edges: [
          {
            id: 'e1',
            kind: 'flow',
            source: { nodeId: 'start', handle: 'next' },
            target: { nodeId: 'ende' },
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const workflow = ((await created.json()) as { workflow: { id: string; draftAuthor: unknown } })
    .workflow;
  expect(workflow.draftAuthor).toMatchObject({ kind: 'agent', agentLabel: 'Hermes' });

  const refused = await api.post(`${origin}/api/workflows/${workflow.id}/publish`, {
    headers: agent,
    data: { expectedRevision: 1 },
  });
  expect(refused.status()).toBe(403);
  expect(((await refused.json()) as { code: string }).code).toBe('workflow_human_only');

  await page.goto(`/arbeitsbereich/${workspaceId}/workflows/${workflow.id}`);
  await expect(page.getByTestId('workflow-agent-draft')).toContainText('Hermes');
  await page.getByTestId('workflow-publish').click();
  await expect(page.getByTestId('workflow-published-version')).toBeVisible();
  await expect(page.getByTestId('workflow-agent-draft')).toHaveCount(0);
});

test('builds from the canvas: the add key, a way out, undo, tidy and the settings panel', async ({
  page,
}) => {
  // Issue #198. The keyboard path to a new node is `A` and a filter; the
  // pointer path is the `+` beside a way out with nothing behind it yet.
  const created = await api.post(`${origin}/api/workspaces/${workspaceId}/workflows`, {
    data: { name: `Werkbank ${Date.now().toString(36)}` },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { workflow: { id: string } }).workflow.id;
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`/arbeitsbereich/${workspaceId}/workflows/${id}`);
  await expect(page.getByTestId('workflow-canvas')).toBeVisible();
  const node = (nodeId: string) =>
    page.locator(`[data-testid="workflow-node"][data-node-id="${nodeId}"]`);

  // Nothing selected: no panel takes width from the canvas.
  await expect(page.getByTestId('workflow-inspector')).toHaveCount(0);

  await selectNode(page, 'start');
  await page.keyboard.press('a');
  await page.getByTestId('workflow-add-search').fill('Agent');
  await page.keyboard.press('Enter');
  await expect(node('agent')).toBeVisible();
  await expect(page.getByTestId('workflow-node-inspector')).toBeVisible();

  // Selected and unfinished (no goal yet) at once: the halo and the problem
  // mark both show.
  await expect(node('agent')).toHaveAttribute('data-selected', 'true');
  await expect(node('agent')).toHaveAttribute('data-problems', /\d+/u);
  await expect(node('agent').getByTestId('workflow-node-problems')).toBeVisible();

  // Its way out has nothing behind it: the + adds the next step there.
  await node('agent').hover();
  await page.getByTestId('workflow-add-from-agent-next').click();
  await expect(page.getByTestId('workflow-add-trigger.manual')).toHaveCount(0);
  await page.getByTestId('workflow-add-end').click();
  await expect(node('end')).toBeVisible();

  // Undo takes the end node back, redo brings it again.
  await page.getByTestId('workflow-undo').click();
  await expect(node('end')).toHaveCount(0);
  await page.getByTestId('workflow-redo').click();
  await expect(node('end')).toBeVisible();

  await page.getByTestId('workflow-tidy').click();
  await page.keyboard.press('Escape');

  // Workflow-wide settings are a panel on request, and Escape closes it.
  await page.getByTestId('workflow-open-settings').click();
  await expect(page.getByTestId('workflow-settings')).toBeVisible();
  await expect(page.getByTestId('workflow-limit-budget')).toBeInViewport();
  await page.getByTestId('workflow-name').press('Escape');
  await expect(page.getByTestId('workflow-inspector')).toHaveCount(0);
  // From the head as well: Escape is the editor's, not the panel's.
  await page.getByTestId('workflow-open-settings').click();
  await page.getByTestId('workflow-open-settings').press('Escape');
  await expect(page.getByTestId('workflow-inspector')).toHaveCount(0);

  await page.getByTestId('workflow-save').click();
  await expect(page.getByTestId('workflow-state')).toContainText('Stand 2', { timeout: 30_000 });
  const read = await api.get(`${origin}/api/workflows/${id}`);
  const body = (await read.json()) as {
    draft: { edges: { source: { nodeId: string; handle: string }; target: { nodeId: string } }[] };
  };
  expect(
    body.draft.edges
      .map((edge) => `${edge.source.nodeId}.${edge.source.handle}>${edge.target.nodeId}`)
      .sort(),
  ).toEqual(['agent.next>end', 'start.next>agent']);
});

test('asks before leaving a draft with unsaved changes', async ({ page }) => {
  const created = await api.post(`${origin}/api/workspaces/${workspaceId}/workflows`, {
    data: { name: `Ungespeichert ${Date.now().toString(36)}` },
  });
  const id = ((await created.json()) as { workflow: { id: string } }).workflow.id;
  await page.goto(`/arbeitsbereich/${workspaceId}/workflows/${id}`);
  await selectNode(page, 'start');
  await page.getByTestId('workflow-palette-end').click();
  await page.getByTestId('workflow-back').click();
  await expect(page.getByTestId('unsaved-changes-dialog')).toBeVisible();
  await page.getByTestId('unsaved-changes-stay').click();
  await expect(page).toHaveURL(new RegExp(`/workflows/${id}$`, 'u'));
});

/** A small published workflow: start → condition on the run's input → end / stop. */
async function publishedConditionWorkflow(name: string): Promise<string> {
  const created = await api.post(`${origin}/api/workspaces/${workspaceId}/workflows`, {
    data: {
      name,
      graph: {
        schemaVersion: 1,
        nodes: [
          { id: 'start', type: 'trigger.manual', position: { x: 0, y: 0 } },
          {
            id: 'check',
            type: 'condition',
            source: { input: 'go' },
            operator: 'is_true',
            position: { x: 280, y: 0 },
          },
          {
            id: 'done',
            type: 'end',
            outcome: 'succeeded',
            summary: 'Geschafft',
            position: { x: 560, y: -80 },
          },
          { id: 'stop', type: 'end', outcome: 'cancelled', position: { x: 560, y: 80 } },
        ],
        edges: [
          {
            id: 'e1',
            kind: 'flow',
            source: { nodeId: 'start', handle: 'next' },
            target: { nodeId: 'check' },
          },
          {
            id: 'e2',
            kind: 'flow',
            source: { nodeId: 'check', handle: 'true' },
            target: { nodeId: 'done' },
          },
          {
            id: 'e3',
            kind: 'flow',
            source: { nodeId: 'check', handle: 'false' },
            target: { nodeId: 'stop' },
          },
        ],
      },
    },
  });
  expect(created.ok(), await created.text()).toBe(true);
  const id = ((await created.json()) as { workflow: { id: string } }).workflow.id;
  const published = await api.post(`${origin}/api/workflows/${id}/publish`, {
    data: { expectedRevision: 1 },
  });
  expect(published.ok(), await published.text()).toBe(true);
  return id;
}

test('shows waiting, failed and retried nodes and the path a run took', async ({ page }) => {
  const workflowId = await publishedConditionWorkflow(`Fixture ${Date.now().toString(36)}`);
  const version = (await (
    await api.get(`${origin}/api/workflows/${workflowId}/versions`)
  ).json()) as {
    versions: { id: string }[];
  };
  const graph = (
    (await (await api.get(`${origin}/api/workflows/${workflowId}`)).json()) as {
      draft: unknown;
    }
  ).draft;
  const at = '2026-10-11T10:00:00.000Z';
  const attempt = (
    nodeId: string,
    number: number,
    status: string,
    extra: Record<string, unknown> = {},
  ) => ({
    id: `x${nodeId}${String(number)}`,
    nodeId,
    nodeType: 'condition',
    attempt: number,
    status,
    idempotencyKey: `run:${nodeId}:${String(number)}`,
    firedHandles: [],
    input: null,
    output: null,
    waitingOn: null,
    errorClass: null,
    errorCode: null,
    errorMessage: null,
    workItemId: null,
    aiRunId: null,
    queuedAt: at,
    startedAt: at,
    finishedAt: at,
    ...extra,
  });
  const runId = 'fixturerun0000000000000a';
  await page.route(`**/api/workflow-runs/${runId}`, (route) =>
    route.fulfill({
      json: {
        run: {
          id: runId,
          workflowId,
          workspaceId,
          workflowVersionId: version.versions[0]!.id,
          version: 1,
          status: 'waiting',
          origin: 'test',
          triggerNodeId: 'start',
          input: { go: true },
          correlationId: null,
          startedBy: { id: 'u', name: 'Johanna' },
          spentMicroUsd: 120_000,
          nodeExecutionCount: 4,
          limits: {
            maxNodeExecutions: 200,
            maxParallelBranches: 4,
            maxLifetimeSeconds: 86_400,
            budgetMicroUsd: 2_000_000,
          },
          deadlineAt: null,
          chainDepth: 0,
          writeMode: 'propose',
          errorCode: null,
          errorMessage: null,
          summary: null,
          endNodeId: null,
          waitingSince: at,
          createdAt: at,
          startedAt: at,
          finishedAt: null,
        },
        graph,
        nodeExecutions: [
          attempt('start', 1, 'succeeded', { firedHandles: ['next'] }),
          attempt('check', 1, 'failed', {
            errorClass: 'retryable',
            errorCode: 'workflow_node_error',
            errorMessage: 'boom',
          }),
          attempt('check', 2, 'succeeded', { firedHandles: ['true'] }),
          attempt('done', 1, 'waiting', {
            finishedAt: null,
            waitingOn: { kind: 'timer', until: '2026-10-12T10:00:00.000Z' },
          }),
        ],
        events: [
          {
            sequence: 1,
            type: 'run.started',
            nodeId: 'start',
            executionId: null,
            attempt: null,
            detail: null,
            at,
          },
        ],
        progress: { runnable: [], dead: ['stop'], active: ['done'], settled: false },
      },
    }),
  );

  await page.goto(`/arbeitsbereich/${workspaceId}/workflows/${workflowId}/laeufe/${runId}`);
  await expect(page.getByTestId('workflow-run-status')).toHaveText('Wartet');
  const node = (id: string) => page.locator(`[data-testid="workflow-node"][data-node-id="${id}"]`);
  await expect(node('done')).toHaveAttribute('data-node-state', 'waiting');
  await expect(node('done')).toContainText('Wartet');
  await expect(node('check')).toHaveAttribute('data-node-state', 'succeeded');
  await expect(node('check')).toContainText('2 Versuche');
  await expect(node('stop')).toHaveAttribute('data-node-state', 'untouched');
  await expect(page.locator('.react-flow__edge.is-taken')).toHaveCount(2);

  // A node's attempts, the failed one with its class and code.
  await node('check').click();
  await expect(page.getByTestId('workflow-run-attempt')).toHaveCount(2);
  await expect(page.getByTestId('workflow-run-node')).toContainText('workflow_node_error');
  await expect(page.getByTestId('workflow-run-node')).toContainText('Vorübergehender Fehler');
});

test('follows a real run to its end where workflows may run', async ({ page }) => {
  const workflowId = await publishedConditionWorkflow(`Echt ${Date.now().toString(36)}`);
  // Switch workflows on for this workspace; the deployment's own switch is a
  // ceiling, and where it is off nothing may run, not even a test.
  await api.patch(`${origin}/api/workspaces/${workspaceId}/settings`, {
    data: { 'workflows.enabled': true },
  });
  const envelope = (
    (await (await api.get(`${origin}/api/workflows/${workflowId}`)).json()) as {
      envelope: { workflowsEnabled: boolean };
    }
  ).envelope;
  test.skip(!envelope.workflowsEnabled, 'workflows.enabled is off for this deployment');

  await page.goto(`/arbeitsbereich/${workspaceId}/workflows/${workflowId}`);
  await page.getByTestId('workflow-test-run').click();
  await page.locator('#workflow-test-input').fill('{"go": true}');
  await page.getByTestId('workflow-test-start').click();
  await page.waitForURL(/\/laeufe\/[a-z0-9]+$/u, { timeout: 30_000 });
  await expect(page.getByTestId('workflow-run-status')).toHaveText('Erfolgreich', {
    timeout: 60_000,
  });
  await expect(page.getByTestId('workflow-run-end-summary')).toHaveText('Geschafft');
  await expect(page.locator('[data-testid="workflow-node"][data-node-id="done"]')).toHaveAttribute(
    'data-node-state',
    'succeeded',
  );
});
