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

  it('goes red when .oxlintrc.json no longer matches the graph', () => {
    // The import-site half of the boundary rule is generated into
    // `.oxlintrc.json`. A hand-edited or simply forgotten file would leave
    // oxlint enforcing yesterday's graph while this gate reported success.
    editFile('.oxlintrc.json', (source) => source.replace('"correctness"', '"suspicious"'));
    const result = gate('check-dependency-boundaries.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('.oxlintrc.json');
  });
});

describe('the lint policy still has teeth', () => {
  /** Runs oxlint over one path with the repository's own configuration. */
  function oxlint(relativePath: string): GateResult {
    return run('pnpm', ['exec', 'oxlint', relativePath]);
  }

  /** Runs the ESLint remainder over one path. */
  function eslint(relativePath: string): GateResult {
    return run('pnpm', ['exec', 'eslint', relativePath]);
  }

  it('is green on the repository as it stands', () => {
    expect(oxlint('.').status).toBe(0);
    expect(eslint('.').status).toBe(0);
  });

  // oxlint's half. These four stand for the four groups the migration in issue
  // #84 moved across: the architectural boundary, the TypeScript rules, the
  // size policy, and the per-directory overrides.
  it('oxlint refuses an import across a package boundary', () => {
    writeProbe(
      'apps/web/src/__lint_probe__.ts',
      "import { x } from '@exocortex/database';\nexport const y = x;\n",
    );
    const result = oxlint('apps/web/src/__lint_probe__.ts');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('no-restricted-imports');
  });

  it('oxlint refuses `any`', () => {
    writeProbe('packages/ai/src/__lint_probe__.ts', 'export const f = (a: any) => a;\n');
    const result = oxlint('packages/ai/src/__lint_probe__.ts');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('no-explicit-any');
  });

  it('oxlint refuses a function with too many parameters', () => {
    writeProbe(
      'packages/ai/src/__lint_probe__.ts',
      'export const f = (a: number, b: number, c: number, d: number, e: number, g: number) =>\n' +
        '  a + b + c + d + e + g;\n',
    );
    const result = oxlint('packages/ai/src/__lint_probe__.ts');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('max-params');
  });

  it('oxlint lets a NestJS constructor have more parameters than a function may', () => {
    // The override that makes constructor injection possible. If it stopped
    // matching, every provider in apps/api would go red at once, which is the
    // kind of failure that gets fixed by weakening the rule.
    writeProbe(
      'apps/api/src/__lint_probe__.service.ts',
      'export class Probe {\n' +
        '  constructor(\n' +
        '    private readonly a: string,\n' +
        '    private readonly b: string,\n' +
        '    private readonly c: string,\n' +
        '    private readonly d: string,\n' +
        '    private readonly e: string,\n' +
        '    private readonly f: string,\n' +
        '  ) {}\n' +
        '}\n',
    );
    expect(oxlint('apps/api/src/__lint_probe__.service.ts').status).toBe(0);
  });

  it('oxlint refuses an empty catch block but allows one that says why', () => {
    writeProbe(
      'packages/ai/src/__lint_probe__.ts',
      'export function f(): void {\n  try {\n    JSON.parse("{}");\n  } catch {}\n}\n',
    );
    const empty = oxlint('packages/ai/src/__lint_probe__.ts');
    expect(empty.status).not.toBe(0);
    expect(empty.output).toContain('no-empty');

    writeProbe(
      'packages/ai/src/__lint_probe__.ts',
      'export function f(): void {\n  try {\n    JSON.parse("{}");\n  } catch {\n    // Malformed input is the expected case here.\n  }\n}\n',
    );
    expect(oxlint('packages/ai/src/__lint_probe__.ts').status).toBe(0);
  });

  it('oxlint keeps the styleguide experiments out of product code', () => {
    // DESIGN.md §7: an undecided variant must not become a reference by being
    // imported. The page that lists the experiments is the one exception.
    writeProbe(
      'apps/web/src/components/__lint_probe__.ts',
      "import { ExperimentsSection } from './design-system/experiments/experiments';\n" +
        'export const y = ExperimentsSection;\n',
    );
    const result = oxlint('apps/web/src/components/__lint_probe__.ts');
    expect(result.status).not.toBe(0);
    // The rule name, not the message: in CI oxlint reports in GitHub's
    // annotation format, which shortens the help text. The probe imports
    // nothing but a relative path, so no other pattern of the rule can match.
    expect(result.output).toContain('no-restricted-imports');
    expect(oxlint('apps/web/src/components/design-system/design-system-page.tsx').status).toBe(0);
  });

  // The ESLint remainder. Both of these are exactly what oxlint cannot express,
  // which is the only reason ESLint is still installed.
  it('ESLint refuses unsorted imports', () => {
    writeProbe(
      'packages/ai/src/__lint_probe__.ts',
      "import { z } from 'zod';\nimport { join } from 'node:path';\n\nexport const x = [z, join];\n",
    );
    const result = eslint('packages/ai/src/__lint_probe__.ts');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('simple-import-sort');
  });

  it('ESLint refuses a native date field in the interface', () => {
    writeProbe(
      'apps/web/src/components/__lint_probe__.tsx',
      'export const Probe = () => <input type="date" />;\n',
    );
    const result = eslint('apps/web/src/components/__lint_probe__.tsx');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('DatePicker');
  });

  it('ESLint refuses a NestJS class with too many injected dependencies', () => {
    writeProbe(
      'apps/api/src/__lint_probe__.service.ts',
      'export class Probe {\n' +
        '  constructor(\n' +
        Array.from({ length: 11 }, (_, index) => `    private readonly d${index}: string,\n`).join(
          '',
        ) +
        '  ) {}\n' +
        '}\n',
    );
    const result = eslint('apps/api/src/__lint_probe__.service.ts');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('too many collaborators');
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

describe('semantic colours (check-semantic-colours.mjs)', () => {
  it('is green on the repository as it stands', () => {
    expect(gate('check-semantic-colours.mjs').status).toBe(0);
  });

  it.each([
    ['an arbitrary hex class', "export const c = 'bg-[#1a2b3c]';\n"],
    ['a colour function in a style', "export const s = { color: 'oklch(0.8 0.1 72)' };\n"],
    ['a Tailwind palette class', "export const c = 'hover:text-red-500';\n"],
    ['white from the default palette', "export const c = 'bg-white/10';\n"],
  ])('goes red for %s', (_name, source) => {
    writeProbe('apps/web/src/__gate_probe__.ts', source);
    const result = gate('check-semantic-colours.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('__gate_probe__.ts:1');
  });

  it('goes red for a literal in a stylesheet', () => {
    writeProbe('packages/ui/src/__gate_probe__.css', '.probe {\n  color: #fff;\n}\n');
    expect(gate('check-semantic-colours.mjs').status).not.toBe(0);
  });

  it('stays green for an issue number, a comment and a token utility', () => {
    // German UI text names issues with a hash, and the content colours are
    // tokens whose names happen to end in a palette word.
    writeProbe(
      'apps/web/src/__gate_probe__.ts',
      '// #fff in a comment is prose.\n' +
        "export const text = 'Entschieden in Issue #129';\n" +
        "export const c = 'bg-content-bg-gray text-primary';\n" +
        "export const m = 'color-mix(in oklab, var(--primary) 35%, transparent)';\n",
    );
    expect(gate('check-semantic-colours.mjs').status).toBe(0);
  });

  it('goes red when an exemption no longer matches anything', () => {
    editFile('apps/web/src/app/layout.tsx', (source) =>
      source.replace(/themeColor: '#[0-9a-fA-F]+'/, "themeColor: 'var(--background)'"),
    );
    const result = gate('check-semantic-colours.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('no longer match');
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
   * The same question for the multipart wrapper: a route the browser uploads to
   * is a route the browser reaches, and the scanner has to see it through
   * `uploadRequest` as it does through `apiRequest` (issue #96).
   */
  it('goes red for an upload screen the agents cannot reach', () => {
    writeProbe(
      'apps/api/src/__gate_probe__.controller.ts',
      [
        "import { Controller, Post } from '@nestjs/common';",
        '',
        "@Controller('api/gate-probe')",
        'export class GateProbeController {',
        "  @Post('upload')",
        "  upload(): string { return 'probe'; }",
        '}',
        '',
      ].join('\n'),
    );
    writeProbe(
      'apps/web/src/lib/api/__gate_probe__.ts',
      [
        "import { uploadRequest } from './client';",
        '',
        'export async function probeUpload(form: FormData): Promise<unknown> {',
        '  return uploadRequest<unknown>(`/api/gate-probe/upload`, form);',
        '}',
        '',
      ].join('\n'),
    );
    writeProbe(
      'apps/web/src/components/__gate_probe__.tsx',
      [
        "import { probeUpload } from '@/lib/api/__gate_probe__';",
        '',
        'export function GateProbe() {',
        '  void probeUpload;',
        '  return null;',
        '}',
        '',
      ].join('\n'),
    );
    const result = gate('check-capability-parity.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('POST /api/gate-probe/upload');
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

describe('test split (check-test-split.mjs)', () => {
  it('is green: every workspace with tests is reachable and none of the default set needs a database', () => {
    expect(gate('check-test-split.mjs').status).toBe(0);
  });

  /**
   * The failure that started issue #93, reproduced: a test that opens a real
   * Postgres connection, in a file the default set runs. On this host that
   * connection is the live database, so the gate is not only about CI.
   */
  it('goes red when a unit test constructs a real database client', () => {
    writeProbe(
      'apps/worker/src/__gate_probe__.test.ts',
      [
        "import { createPrismaClient } from '@exocortex/database';",
        '',
        'export const probe = createPrismaClient();',
        '',
      ].join('\n'),
    );
    const result = gate('check-test-split.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('__gate_probe__.test.ts');
    expect(result.output).toContain('PostgreSQL');
  });

  it('is content with the same test once its name says it needs infrastructure', () => {
    writeProbe(
      'apps/worker/src/__gate_probe__.integration.test.ts',
      [
        "import { createPrismaClient } from '@exocortex/database';",
        '',
        'export const probe = createPrismaClient();',
        '',
      ].join('\n'),
    );
    expect(gate('check-test-split.mjs').status).toBe(0);
  });

  /**
   * The other half, and the one that makes a green build lie: a workspace with
   * tests that `turbo run test:unit` walks past, because its manifest never
   * names the task. That is how four apps stayed out of CI.
   */
  it('goes red when a workspace with tests loses the script that runs them', () => {
    editFile('apps/worker/package.json', (source) => {
      const manifest = JSON.parse(source) as { scripts: Record<string, string> };
      delete manifest.scripts['test:unit'];
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
    const result = gate('check-test-split.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('apps/worker/package.json');
    expect(result.output).toContain('test:unit');
  });

  it('goes red when the script stops filtering the way the split assumes', () => {
    editFile('apps/worker/package.json', (source) => {
      const manifest = JSON.parse(source) as { scripts: Record<string, string> };
      manifest.scripts['test:unit'] = 'vitest run';
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
    const result = gate('check-test-split.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('canonical command');
  });

  /**
   * Issue #94: the guard is what stands between an integration test and the
   * live database, and it is loaded by one line in a vitest config. A
   * workspace that loses that line still passes every other check here, and
   * its tests would connect to whatever `.env` points at.
   */
  it('goes red when a workspace with integration tests stops loading the guard', () => {
    editFile('apps/worker/vitest.config.mts', (source) =>
      source.replace(/\s*setupFiles: \[[^\]]*\],/, ''),
    );
    const result = gate('check-test-split.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('vitest.setup.integration.ts');
  });
});

describe('typecheck coverage (check-typecheck-coverage.mjs)', () => {
  it('is green: every TypeScript file is inside a project that runs', () => {
    expect(gate('check-typecheck-coverage.mjs').status).toBe(0);
  });

  /**
   * Issue #99: the tests used to be a named exception here, and a test that
   * only compiles because nobody looked at it usually checks something other
   * than what it claims. A test file is an ordinary source file to this gate
   * now, so one outside every project is a finding like any other.
   */
  it('goes red when a test file sits outside every project', () => {
    writeProbe('tools/__gate_probe__/probe.test.ts', 'export const probe: number = 1;\n');
    const result = gate('check-typecheck-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('tools/__gate_probe__/probe.test.ts');
  });

  /**
   * And the other half of the same issue, which no gate can answer: that the
   * typecheck actually reads the file. One small workspace stands in for all
   * of them, because what changed is the shape every `tsconfig.json` has.
   */
  it('makes a type error inside a test file fail the workspace typecheck', () => {
    writeProbe(
      'packages/config/src/__gate_probe__.test.ts',
      "import { expect, it } from 'vitest';\n\nit('probe', () => {\n  const value: number = 'not a number';\n  expect(value).toBe(1);\n});\n",
    );
    const result = run('node', [
      'node_modules/typescript/bin/tsc',
      '-p',
      'packages/config/tsconfig.json',
      '--noEmit',
    ]);
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('__gate_probe__.test.ts');
  });

  /**
   * The shape of issue #95: a source file in a directory no `tsconfig` covers.
   * It compiles nowhere, so nothing ever reads its types -- which is how
   * `import-obsidian/verify.ts` lost every one of its imports without a single
   * red build.
   */
  it('goes red when a source file sits outside every project', () => {
    writeProbe('tools/__gate_probe__/probe.ts', 'export const probe: number = 1;\n');
    const result = gate('check-typecheck-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('tools/__gate_probe__/probe.ts');
  });

  /**
   * The same hole one step later: the project file is there, so the directory
   * looks covered, but no `typecheck` script ever hands it to `tsc`.
   */
  it('goes red when a project file exists that no typecheck script runs', () => {
    writeProbe(
      'tsconfig.__gate_probe__.json',
      `${JSON.stringify({ extends: './tsconfig.node.json', include: [] }, null, 2)}\n`,
    );
    const result = gate('check-typecheck-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('tsconfig.__gate_probe__.json');
  });

  /**
   * And the reverse: a workspace that stops naming the project its operator
   * scripts are checked by. The files are still there and still compile; only
   * the command that would notice is gone.
   */
  it('goes red when a workspace stops running the project its scripts are checked by', () => {
    editFile('apps/api/package.json', (source) => {
      const manifest = JSON.parse(source) as { scripts: Record<string, string> };
      manifest.scripts.typecheck = 'tsc -p tsconfig.json --noEmit';
      return `${JSON.stringify(manifest, null, 2)}\n`;
    });
    const result = gate('check-typecheck-coverage.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('apps/api/scripts/');
    expect(result.output).toContain('apps/api/tsconfig.scripts.json');
  });
});

describe('message catalogues (check-i18n.mjs)', () => {
  const english = 'packages/i18n/src/messages/en/settings.json';
  const german = 'packages/i18n/src/messages/de/settings.json';

  function editJson(path: string, edit: (value: Record<string, Record<string, string>>) => void) {
    editFile(path, (source) => {
      const value = JSON.parse(source) as Record<string, Record<string, string>>;
      edit(value);
      return `${JSON.stringify(value, null, 2)}\n`;
    });
  }

  it('is green on the repository as it stands', () => {
    expect(gate('check-i18n.mjs').status).toBe(0);
  });

  it('goes red when a locale lacks a key German has', () => {
    editJson(english, (value) => {
      delete value.language?.title;
    });
    const result = gate('check-i18n.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('en/settings.json language.title: missing');
  });

  it('goes red when a translation drops an ICU argument', () => {
    editJson(english, (value) => {
      if (value.language !== undefined) value.language.followBrowserHint = 'Follows your browser.';
    });
    const result = gate('check-i18n.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('missing argument browser: simple');
  });

  it('goes red when the German changed and nobody translated again', () => {
    editJson(german, (value) => {
      if (value.language !== undefined) value.language.title = 'Sprache der Oberfläche';
    });
    const result = gate('check-i18n.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('translated from an older German text');
  });

  it('goes red when a translation was edited by hand and the German moved on', () => {
    editJson(english, (value) => {
      if (value.language !== undefined) value.language.title = 'Interface language';
    });
    editJson(german, (value) => {
      if (value.language !== undefined) value.language.title = 'Sprache der Oberfläche';
    });
    const result = gate('check-i18n.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('hand-written, and not confirmed');
  });

  it('goes red when the generated catalogue no longer matches the files', () => {
    editFile('packages/i18n/src/catalog.generated.ts', (source) => `${source}// drift\n`);
    const result = gate('check-i18n.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('catalog.generated.ts: out of date');
  });
});

describe('the ICU reader behind the catalogue gate (lib/icu.mjs)', () => {
  it('finds a plural category the target language needs', async () => {
    const { compareIcu } = (await import('./lib/icu.mjs')) as {
      compareIcu: (source: string, translation: string, locale: string) => string[];
    };
    const source = '{count, plural, one {# Datei} other {# Dateien}}';
    expect(compareIcu(source, '{count, plural, one {# plik} other {# plików}}', 'pl')).toEqual([
      '{count, plural} lacks "few" for pl',
      '{count, plural} lacks "many" for pl',
    ]);
    expect(
      compareIcu(
        source,
        '{count, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}',
        'pl',
      ),
    ).toEqual([]);
  });

  it('refuses a changed select option, a lost tag and a broken brace', async () => {
    const { compareIcu } = (await import('./lib/icu.mjs')) as {
      compareIcu: (source: string, translation: string, locale: string) => string[];
    };
    const select = '{role, select, admin {Verwaltung} other {Lesen}}';
    expect(compareIcu(select, '{role, select, administrator {Admin} other {Read}}', 'en')).toEqual([
      'missing select role: admin|other',
      'unexpected select role: administrator|other',
    ]);
    expect(compareIcu('Öffne <link>{title}</link>', 'Open {title}', 'en')).toEqual([
      'missing tag <link>',
    ]);
    expect(compareIcu('Hallo {name}', 'Hello {name', 'en')[0]).toMatch(/^does not parse/);
  });

  it('reads apostrophes the way use-intl does', async () => {
    const { parseIcu, icuSignature } = (await import('./lib/icu.mjs')) as {
      parseIcu: (message: string) => unknown[];
      icuSignature: (nodes: unknown[]) => string[];
    };
    expect(icuSignature(parseIcu("l'état de {name}"))).toEqual(['argument name: simple']);
    expect(icuSignature(parseIcu("'{literal}' and {real}"))).toEqual(['argument real: simple']);
  });
});

describe('the translation state the tool and the gate share (lib/i18n-catalog.mjs)', () => {
  it('tells current, missing, stale and hand-written apart', async () => {
    const { hashText, keyStatus } = (await import('./lib/i18n-catalog.mjs')) as {
      hashText: (text: string) => string;
      keyStatus: (source: string, target: string | undefined, entry?: object) => string;
    };
    const machine = { source: hashText('Alt'), output: hashText('Old') };
    expect(keyStatus('Neu', undefined, undefined)).toBe('missing');
    expect(keyStatus('Alt', 'Old', machine)).toBe('current');
    expect(keyStatus('Neu', 'Old', machine)).toBe('stale');
    // Somebody corrected the machine's "Old" to "Former": never overwritten.
    expect(keyStatus('Neu', 'Former', machine)).toBe('review');
    // An accepted hand-written translation has no output hash.
    expect(keyStatus('Neu', 'New', { source: hashText('Neu') })).toBe('current');
  });
});

describe('inline text ratchet (check-i18n-literals.mjs)', () => {
  const screen = 'apps/web/src/components/settings/language-page.tsx';

  it('is green on the repository as it stands', () => {
    expect(gate('check-i18n-literals.mjs').status).toBe(0);
  });

  it('goes red when a file gains inline German', () => {
    editFile(screen, (source) => `${source}\nexport const probe = 'Das ist neu';\n`);
    const result = gate('check-i18n-literals.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(screen);
  });

  it('counts a label that starts with a capitalised small word', () => {
    editFile(screen, (source) => `${source}\nexport const probe = 'Kein Zugriff';\n`);
    const result = gate('check-i18n-literals.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain(screen);
  });

  it('does not count German in a comment', () => {
    editFile(screen, (source) => `${source}\n// Das ist ein deutscher Kommentar für dich.\n`);
    expect(gate('check-i18n-literals.mjs').status).toBe(0);
  });

  it('goes red when a file lost German and the baseline was not lowered', () => {
    editFile('apps/web/src/app/(app)/error.tsx', () => 'export {};\n');
    const result = gate('check-i18n-literals.mjs');
    expect(result.status).not.toBe(0);
    expect(result.output).toContain('--update');
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
