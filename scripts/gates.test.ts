import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

/**
 * Tests for the gates themselves.
 *
 * Every gate is run twice: once against the repository as it stands, where it
 * must be green, and once with a violation written into the tree, where it must
 * be red. Only the second half is interesting. A gate that is always green --
 * because a regex stopped matching, because a path moved, because the shape of
 * a decorator changed -- is worse than no gate, since it reports success on a
 * question it is no longer asking. Without a CI these are the only thing
 * watching the watchmen, so they matter more here than they would elsewhere.
 *
 * Probe files are removed in `afterEach` whatever happens, including when the
 * expectation fails. Anything written into a file that already exists is
 * restored from the copy taken before.
 *
 * The violations below are assembled from pieces rather than written out. Two
 * of the gates scan `scripts/`, so writing the plain brand spelling or an
 * environment read out in full here would be a real finding in this file, and the
 * only ways out would be to exempt this file -- leaving the tests unchecked --
 * or to weaken the gates to accommodate their own tests.
 */

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

/** See the note above: written out, these would be findings in this file. */
const BRAND = `E${'xocortex'}`;
const ENV_READ = `process.${'env'}.`;

interface GateResult {
  readonly status: number | null;
  readonly output: string;
}

function run(command: string, args: readonly string[]): GateResult {
  const result = spawnSync(command, [...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    // Colour codes would make the assertions on the output brittle.
    env: { ...process.env, NO_COLOR: '1' },
  });
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` };
}

function gate(script: string): GateResult {
  return script.endsWith('.sh')
    ? run('bash', [join('scripts', script)])
    : run('node', [join('scripts', script)]);
}

const probes = new Set<string>();
const probeDirectories = new Set<string>();
const restore = new Map<string, string>();

/**
 * Writes a file that does not exist yet and remembers to delete it.
 *
 * Missing directories are created and remembered too, because one probe is a
 * `page.tsx`: the app router derives a screen's address from its folder, so a
 * probe screen cannot be a file dropped next to an existing one.
 */
function writeProbe(relativePath: string, content: string): void {
  const absolute = join(repoRoot, relativePath);
  const directory = dirname(absolute);
  if (!existsSync(directory)) {
    mkdirSync(directory, { recursive: true });
    probeDirectories.add(directory);
  }
  probes.add(absolute);
  writeFileSync(absolute, content, 'utf8');
}

/** Edits a file that does exist and remembers its previous contents. */
function editFile(relativePath: string, edit: (source: string) => string): void {
  const absolute = join(repoRoot, relativePath);
  const before = readFileSync(absolute, 'utf8');
  if (!restore.has(absolute)) restore.set(absolute, before);
  writeFileSync(absolute, edit(before), 'utf8');
}

afterEach(() => {
  for (const absolute of probes) rmSync(absolute, { force: true });
  probes.clear();
  for (const directory of probeDirectories) rmSync(directory, { force: true, recursive: true });
  probeDirectories.clear();
  for (const [absolute, content] of restore) writeFileSync(absolute, content, 'utf8');
  restore.clear();
});

describe('package boundaries (check-dependency-boundaries.mjs)', () => {
  it('is green on the repository as it stands', () => {
    expect(gate('check-dependency-boundaries.mjs').status).toBe(0);
  });

  it('goes red when a package declares a dependency the graph forbids', () => {
    editFile('apps/web/package.json', (source) => {
      const manifest = JSON.parse(source) as {
        dependencies: Record<string, string>;
      };
      // Rule 4: the browser bundle must never reach the database package.
      manifest.dependencies['@exocortex/database'] = 'workspace:*';
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
    const result = gate('check-dependency-boundaries.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('@exocortex/database');
  });
});

describe('configuration example sync (check-env-example.mjs)', () => {
  it('is green on the repository as it stands', () => {
    expect(gate('check-env-example.mjs').status).toBe(0);
  });

  it('goes red for a variable the code reads and the example does not document', () => {
    writeProbe(
      'packages/config/src/__gate_probe__.ts',
      `export const value = ${ENV_READ}UNDOCUMENTED_PROBE_VARIABLE;\n`,
    );
    const result = gate('check-env-example.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('UNDOCUMENTED_PROBE_VARIABLE');
  });

  it('goes red for a documented variable nothing reads', () => {
    editFile('.env.example', (source) => `${source}\nORPHANED_PROBE_VARIABLE=x\n`);
    const result = gate('check-env-example.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('ORPHANED_PROBE_VARIABLE');
  });
});

describe('brand spelling (check-brand-spelling.mjs)', () => {
  it('is green on the repository as it stands', () => {
    expect(gate('check-brand-spelling.mjs').status).toBe(0);
  });

  it('goes red for the plain spelling in a string a human reads', () => {
    writeProbe(
      'packages/ui/src/__gate_probe__.ts',
      `export const label = 'Willkommen bei ${BRAND}';\n`,
    );
    expect(gate('check-brand-spelling.mjs').status).not.toBe(0);
  });

  it('goes red for the plain spelling after a newline escape, mid-literal', () => {
    // The lookbehind has to treat `\n` as a word boundary. Without that, the
    // most common case of all -- a heading followed by a paragraph inside one
    // string -- would pass.
    writeProbe(
      'packages/ui/src/__gate_probe__.ts',
      `export const page = '# Titel\\n${BRAND} ist da.';\n`,
    );
    expect(gate('check-brand-spelling.mjs').status).not.toBe(0);
  });

  it('stays green for a comment and for an identifier that merely contains the name', () => {
    writeProbe(
      'packages/ui/src/__gate_probe__.ts',
      `// ${BRAND} in a comment is developer prose, not product text.\n` +
        `export class ${BRAND}ProbeClient {}\nexport const id = '@exocortex/ui';\n`,
    );
    expect(gate('check-brand-spelling.mjs').status).toBe(0);
  });
});

describe('MCP catalogue completeness (check-mcp-catalog.mjs)', () => {
  it('is green on the repository as it stands', () => {
    expect(gate('check-mcp-catalog.mjs').status).toBe(0);
  });

  it('goes red for a REST route with no tool behind it', () => {
    writeProbe(
      'apps/api/src/__gate_probe__.controller.ts',
      [
        "import { Controller, Get } from '@nestjs/common';",
        '',
        "@Controller('api/gate-probe')",
        'export class GateProbeController {',
        "  @Get('thing')",
        "  thing(): string { return 'probe'; }",
        '}',
        '',
      ].join('\n'),
    );
    const result = gate('check-mcp-catalog.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('GET /api/gate-probe/thing');
  });

  it('goes red for a tool calling a route that does not exist', () => {
    writeProbe(
      'packages/mcp-tools/src/tools/__gate_probe__.ts',
      [
        'export async function probe(client: { request: (input: unknown) => Promise<unknown> }) {',
        "  return client.request({ method: 'GET', path: `/api/gate-probe-missing`, responseSchema: null });",
        '}',
        '',
      ].join('\n'),
    );
    const result = gate('check-mcp-catalog.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('/api/gate-probe-missing');
  });

  it('goes red for an exemption that no longer matches any route', () => {
    editFile('scripts/check-mcp-catalog.mjs', (source) =>
      source.replace(
        'const EXEMPT = [',
        "const EXEMPT = [\n  { route: 'GET /api/gate-probe-stale', reason: 'probe' },",
      ),
    );
    const result = gate('check-mcp-catalog.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('/api/gate-probe-stale');
  });
});

describe('capability parity (check-capability-parity.mjs)', () => {
  it('is green on the repository as it stands', () => {
    expect(gate('check-capability-parity.mjs').status).toBe(0);
  });

  it('goes red for a tool the built-in AI does not get', () => {
    editFile('packages/mcp-tools/src/tools/search.ts', (source) =>
      source.replace("surfaces: ['mcp', 'ai']", "surfaces: ['mcp']"),
    );
    const result = gate('check-capability-parity.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('exo_search');
  });

  it('goes red for a screen the agents cannot reach', () => {
    writeProbe(
      'apps/api/src/__gate_probe__.controller.ts',
      [
        "import { Controller, Post } from '@nestjs/common';",
        '',
        "@Controller('api/gate-probe')",
        'export class GateProbeController {',
        "  @Post('thing')",
        "  thing(): string { return 'probe'; }",
        '}',
        '',
      ].join('\n'),
    );
    writeProbe(
      'apps/web/src/lib/api/__gate_probe__.ts',
      [
        "import { apiRequest } from './client';",
        '',
        'export async function probe(): Promise<unknown> {',
        "  return apiRequest<unknown>(`/api/gate-probe/thing`, { method: 'POST' });",
        '}',
        '',
      ].join('\n'),
    );
    // Imported by a probe screen, or the hook would be unreachable and this
    // would go red for the other reason -- which is the next test.
    writeProbe(
      'apps/web/src/components/__gate_probe__.tsx',
      [
        "import { probe } from '@/lib/api/__gate_probe__';",
        '',
        'export function GateProbe() {',
        '  void probe;',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    );
    const result = gate('check-capability-parity.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('POST /api/gate-probe/thing');
  });

  /**
   * The failure the matrix used to hide: a hook that calls the API and that no
   * screen imports counted as browser coverage, so a build history and two
   * reorder routes could sit in `lib/api` with nothing rendering them.
   */
  it('goes red for a client hook no screen reaches', () => {
    writeProbe(
      'apps/web/src/lib/api/__gate_probe__.ts',
      [
        "import { apiRequest } from './client';",
        '',
        'export async function probeNobodyCalls(): Promise<unknown> {',
        "  return apiRequest<unknown>(`/api/documents/probe`, { method: 'GET' });",
        '}',
        '',
      ].join('\n'),
    );
    const result = gate('check-capability-parity.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('probeNobodyCalls');
  });

  it('goes red for a surface exemption that no longer explains anything', () => {
    editFile('scripts/check-capability-parity.mjs', (source) =>
      source.replace(
        'const SURFACE_EXEMPT = [',
        "const SURFACE_EXEMPT = [\n  { tool: 'exo_gate_probe_stale', reason: 'probe' },",
      ),
    );
    const result = gate('check-capability-parity.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('exo_gate_probe_stale');
  });

  it('goes red when the committed matrix no longer matches the code', () => {
    editFile('docs/capability-matrix.md', (source) => `${source}\n<!-- probe -->\n`);
    const result = gate('check-capability-parity.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('capability-matrix.md is out of date');
  });

  /**
   * The scanner in `lib/api-surface.mjs` reads paths out of source, and the way
   * it failed before was not by missing a route but by producing a mangled one:
   * a character class shared across the three quote styles ends
   * `/api/x/${id ?? ''}/y` at the wrong quote. A wrong route matches nothing and
   * reports a gap that is not there, so the shapes that used to break it are
   * asserted directly rather than through a gate's exit code.
   */
  it('reads paths through interpolations that contain quotes and nested templates', async () => {
    const surface: {
      normalizePath: (path: string) => string;
      readStringLiteral: (source: string, open: number) => { text: string } | null;
    } = await import('./lib/api-surface.mjs');
    const read = (literal: string): string =>
      surface.normalizePath(surface.readStringLiteral(literal, 0)?.text ?? '');

    expect(read("`/api/workspaces/${workspaceId ?? ''}/settings`")).toBe(
      '/api/workspaces/:x/settings',
    );
    expect(read("`/api/workspaces/${id}/automations/runs${x ? `?r=${r}` : ''}`")).toBe(
      '/api/workspaces/:x/automations/runs',
    );
    expect(read("'/api/admin/settings'")).toBe('/api/admin/settings');
  });
});

describe('migration history (check-migrations-reproducible.sh)', () => {
  it('is green: a fresh database built from migrations equals schema.prisma', () => {
    expect(gate('check-migrations-reproducible.sh').status).toBe(0);
  });

  it('goes red when schema.prisma has something no migration creates', () => {
    editFile(
      'packages/database/prisma/schema.prisma',
      (source) => `${source}\nmodel GateProbe {\n  id String @id\n}\n`,
    );
    const result = gate('check-migrations-reproducible.sh');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('GateProbe');
  });

  it('goes red when an allow-list entry stops matching', () => {
    // The list of objects Prisma cannot model is the one place this gate looks
    // away on purpose, so an entry that matches nothing is a hole rather than
    // dead weight.
    editFile('scripts/check-migrations-reproducible.sh', (source) =>
      source.replace('UNMODELLABLE=(', 'UNMODELLABLE=(\n  \'DROP INDEX "gate_probe_idx";\''),
    );
    const result = gate('check-migrations-reproducible.sh');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('gate_probe_idx');
  });
});

describe('feature registry coverage (check-feature-coverage.mjs)', () => {
  it('is green: every capability is described in packages/features', () => {
    expect(gate('check-feature-coverage.mjs').status).toBe(0);
  });

  it('goes red for a tool no feature describes', () => {
    writeProbe(
      'packages/mcp-tools/src/tools/__gate_probe__.ts',
      [
        "import { z } from 'zod';",
        '',
        "import { type AnyToolDefinition, defineTool } from '../tool.js';",
        '',
        'export const gateProbeTool: AnyToolDefinition = defineTool({',
        "  name: 'exo_gate_probe',",
        "  description: 'Probe.',",
        '  inputSchema: z.object({}),',
        "  surfaces: ['mcp', 'ai'],",
        '  mutating: false,',
        '  async execute() {',
        "    return { text: 'probe' };",
        '  },',
        '});',
        '',
      ].join('\n'),
    );
    const result = gate('check-feature-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('exo_gate_probe');
  });

  it('goes red for a screen no feature describes', () => {
    writeProbe(
      'apps/web/src/app/(app)/__gate_probe__/page.tsx',
      ['export default function GateProbePage() {', '  return null;', '}', ''].join('\n'),
    );
    const result = gate('check-feature-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('/__gate_probe__');
  });

  /**
   * The other direction, and the one a rename produces: the entry still names
   * a tool that has gone, so it describes a capability that no longer works
   * the way it says.
   */
  it('goes red for a claim that matches nothing any more', () => {
    editFile('packages/features/src/features/pages.ts', (source) =>
      source.replace("'exo_search'", "'exo_search_renamed_away'"),
    );
    const result = gate('check-feature-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('exo_search_renamed_away');
  });

  it('goes red for an automation trigger nobody describes', () => {
    editFile('packages/contracts/src/automations.ts', (source) =>
      source.replace("  'SCHEDULE',\n]", "  'SCHEDULE',\n  'GATE_PROBE',\n]"),
    );
    const result = gate('check-feature-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('GATE_PROBE');
  });
});

describe('documentation currency (check-docs-current.mjs)', () => {
  it('is green: the central documents name every moving part', () => {
    expect(gate('check-docs-current.mjs').status).toBe(0);
  });

  it('goes red when a new queue reaches the contract and no document mentions it', () => {
    // The strongest of the four: the inventory is read out of the source, so a
    // queue nobody wrote down is caught without anyone maintaining a list here.
    editFile('packages/contracts/src/jobs.ts', (source) =>
      source.replace("  render: 'render',", "  render: 'render',\n  gateProbe: 'gate-probe',"),
    );
    const result = gate('check-docs-current.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('gate-probe');
    expect(result.output).toContain('docs/background-jobs.md');
  });

  it('goes red when a document stops naming something that exists', () => {
    editFile('docs/background-jobs.md', (source) =>
      source.replaceAll('project-build', 'something-else'),
    );
    const result = gate('check-docs-current.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('project-build');
  });

  it('goes red on a claim the tree disproves', () => {
    editFile('README.md', (source) => `${source}\nNo embeddings are generated yet.\n`);
    const result = gate('check-docs-current.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('semantic-search.ts');
  });

  it('stops forbidding a claim once the file that disproved it is gone', () => {
    // The pairing is what keeps this half from rotting into a list of phrases
    // nobody may write any more. Simulated by pointing one entry at a path that
    // does not exist, which is what removing the feature would do.
    editFile('README.md', (source) => `${source}\nNo embeddings are generated yet.\n`);
    editFile('scripts/check-docs-current.mjs', (source) =>
      source.replace(
        "evidence: 'packages/database/src/semantic-search.ts'",
        "evidence: 'packages/database/src/removed-feature.ts'",
      ),
    );
    expect(gate('check-docs-current.mjs').status).toBe(0);
  });
});

describe('build.sh', () => {
  it('refuses to run on a dirty working tree, before touching anything', () => {
    writeProbe('__gate_probe__.txt', 'untracked\n');
    const result = run('bash', ['scripts/build.sh']);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('Working tree not clean');
    // The refusal has to come first. Reaching the install step would mean the
    // gate is decoration rather than a precondition.
    expect(result.output).not.toContain('Step 2');
  });
});
