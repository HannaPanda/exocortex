/**
 * Writes `.oxlintrc.json`.
 *
 * oxlint reads JSON, and the package boundaries are a list in
 * `dependency-graph.mjs` -- so either the boundaries get copied into a JSON
 * file by hand and drift from the graph the day someone widens it, or the JSON
 * file is generated from the graph. This is the second. `.oxlintrc.json` is
 * therefore a build product like `docs/capability-matrix.md`: read it, do not
 * edit it. The policy it expresses lives here, in JavaScript, where it can
 * carry the reasons.
 *
 *   node scripts/generate-oxlint-config.mjs            write the file
 *   node scripts/generate-oxlint-config.mjs --check    fail if it is stale
 *
 * `check-dependency-boundaries.mjs` runs the `--check` half as part of the
 * boundary gate, because a stale file here means the import-site half of that
 * gate is asking an old question.
 *
 * What is *not* here is the short list oxlint cannot express, which stays in
 * `eslint.config.mjs`: `no-restricted-syntax` (AST selectors), the import
 * order, and two plugin rules with no oxlint equivalent. The two files
 * together are the lint policy; neither is it on its own.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ALLOWED_INTERNAL_DEPENDENCIES, INTERNAL_SCOPE } from './dependency-graph.mjs';

const repositoryRoot = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const configPath = join(repositoryRoot, '.oxlintrc.json');

const ALL_INTERNAL_PACKAGES = Object.keys(ALLOWED_INTERNAL_DEPENDENCIES);

/**
 * The directory a workspace package lives in. Apps are composition roots,
 * `e2e` sits at the root, everything else is a package.
 *
 * @param {string} packageName
 * @returns {string}
 */
function directoryOf(packageName) {
  const shortName = packageName.slice(INTERNAL_SCOPE.length);
  if (['web', 'api', 'collaboration', 'worker', 'mcp'].includes(shortName))
    return `apps/${shortName}`;
  if (shortName === 'e2e') return 'e2e';
  return `packages/${shortName}`;
}

/**
 * The styleguide's experiments are not a product contract (DESIGN.md §7,
 * issue #128): an undecided variant must not become a reference by being
 * imported. Only the page that lists them, and the experiments themselves,
 * may reach into the directory.
 */
const EXPERIMENTS_DIRECTORY = 'apps/web/src/components/design-system/experiments';
const EXPERIMENT_IMPORTS = {
  group: ['**/experiments', '**/experiments/*'],
  message:
    'An experiment is not a product contract: nothing outside the styleguide page imports from design-system/experiments. Decide the variant and move it into its canonical place first (DESIGN.md §7).',
};

/**
 * Forbids every internal package the given one is not allowed to import, plus
 * reaching into another package by relative path.
 *
 * @param {string} packageName
 * @param {readonly Record<string, unknown>[]} [extraPatterns]
 * @returns {Record<string, unknown>}
 */
function boundaryRules(packageName, extraPatterns = []) {
  const allowed = ALLOWED_INTERNAL_DEPENDENCIES[packageName] ?? [];
  const forbidden = ALL_INTERNAL_PACKAGES.filter(
    (name) => name !== packageName && !allowed.includes(name),
  );
  return {
    'no-restricted-imports': [
      'error',
      {
        patterns: [
          ...forbidden.map((name) => ({
            group: [name, `${name}/*`],
            message: `Architectural boundary: ${packageName} must not import ${name}. See scripts/dependency-graph.mjs.`,
          })),
          {
            group: ['../../*/src/*', '../../../*'],
            message:
              'Do not reach into another workspace package by relative path. Import its public entry point instead.',
          },
          ...extraPatterns,
        ],
      },
    ],
  };
}

/**
 * The rules from `eslint:recommended` and `typescript-eslint`'s recommended set
 * that oxlint knows but does not switch on by itself, because its `correctness`
 * category is narrower than "recommended". Listing them is what keeps the
 * migration a move rather than a relaxation.
 */
const RECOMMENDED_NOT_ON_BY_DEFAULT = {
  'no-array-constructor': 'error',
  'no-case-declarations': 'error',
  // Also the whole of the empty-catch policy: `allowEmptyCatch` is false by
  // default, so `catch {}` is refused and `catch { /* already gone */ }` is
  // allowed. `eslint.config.mjs` used to carry a syntax selector for this that
  // never matched anything; see the note there.
  'no-empty': 'error',
  'no-fallthrough': 'error',
  'no-prototype-builtins': 'error',
  'no-regex-spaces': 'error',
  'no-var': 'error',
  'prefer-const': 'error',
  'prefer-rest-params': 'error',
  'prefer-spread': 'error',
  'typescript/ban-ts-comment': 'error',
  'typescript/no-namespace': 'error',
  'typescript/no-require-imports': 'error',
  'typescript/no-unnecessary-type-constraint': 'error',
  'typescript/no-unsafe-function-type': 'error',
};

/**
 * The size policy from issue #40. The numbers are ratchets sitting just above
 * the worst file in the repository, not targets; lower one whenever its worst
 * offender is split up. `.tsx` gets a looser function limit below, because
 * markup costs two or three lines where TypeScript costs one.
 */
const SIZE_POLICY = {
  'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
  'max-lines-per-function': ['error', { max: 200, skipBlankLines: true, skipComments: true }],
  complexity: ['error', 20],
  'max-depth': ['error', 4],
  'max-params': ['error', 5],
  'max-nested-callbacks': ['error', 3],
};

/**
 * Two rules out of oxlint's `correctness` category that are wrong about this
 * repository. Both are switched off with the reason rather than suppressed at
 * the site, because in each case the pattern is deliberate everywhere it
 * appears and would come back the next time somebody writes the same loop.
 */
const CORRECTNESS_RULES_THAT_ARE_WRONG_HERE = {
  // `for (const socket of [...sockets])` is not a wasted copy: the body
  // disconnects the socket, which removes it from the very set being walked.
  // Iterating the live set would skip entries. Every occurrence in
  // `realtime.gateway.ts` and `mcp-streams.service.ts` is of that shape.
  'unicorn/no-useless-spread': 'off',
  // `new Array<number>(n).fill(-1)` is the fastest way to get a filled array
  // of a known length, and the explicit type argument removes the ambiguity
  // the rule is worried about.
  'unicorn/no-new-array': 'off',
};

/**
 * Every plugin is enabled repository-wide, not only over `apps/web`.
 *
 * This is not the shape `eslint.config.mjs` had, and the reason is mechanical:
 * `categories` is resolved against the base plugin list, so a plugin that first
 * appears in an override contributes its explicitly named rules and none of its
 * category ones -- `nextjs/no-img-element` silently stopped firing when this was
 * written the other way round. Enabling them everywhere costs nothing, because a
 * React rule needs JSX or a hook call to have anything to say and the server
 * half of the repository has neither.
 */
const PLUGINS = ['typescript', 'unicorn', 'oxc', 'react', 'nextjs'];

/**
 * React rules that `eslint-plugin-react`'s and `eslint-plugin-react-hooks`'
 * recommended sets switch on and oxlint does not. `react/exhaustive-deps` and
 * the rest of the hook checks are already in `correctness` and need no line.
 */
const REACT_RECOMMENDED_NOT_ON_BY_DEFAULT = {
  'react/display-name': 'error',
  'react/jsx-no-comment-textnodes': 'error',
  'react/jsx-no-target-blank': 'error',
  'react/no-unescaped-entities': 'error',
  'react/require-render-return': 'error',
  'react/rules-of-hooks': 'error',
  'react/unsupported-syntax': 'error',
  // `ignore` is how the ESLint rule spells it; cmdk sets this attribute itself.
  'react/no-unknown-property': ['error', { ignore: ['cmdk-input-wrapper'] }],
};

const config = {
  $schema: './node_modules/oxlint/configuration_schema.json',
  plugins: PLUGINS,
  categories: { correctness: 'error' },
  env: { builtin: true, node: true },
  ignorePatterns: [
    '**/node_modules/**',
    // Agent worktrees are full checkouts of this repository living inside it.
    // Git ignores them, a linter does not: without this line every run walks
    // four extra copies of the whole tree.
    '.claude/worktrees/**',
    '**/dist/**',
    '**/.next/**',
    '**/.next-releases/**',
    '**/.next-live/**',
    '**/.turbo/**',
    '**/coverage/**',
    '**/generated/**',
    '**/*.generated.ts',
    'packages/contracts/src/lucide-icon-names.ts',
    '**/playwright-report/**',
    '**/test-results/**',
    'packages/database/prisma/migrations/**',
  ],
  rules: {
    ...RECOMMENDED_NOT_ON_BY_DEFAULT,
    ...CORRECTNESS_RULES_THAT_ARE_WRONG_HERE,
    ...SIZE_POLICY,
    'no-console': ['error', { allow: ['warn', 'error'] }],
    eqeqeq: ['error', 'always', { null: 'ignore' }],
    'no-unused-vars': [
      'error',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
    ],
    'typescript/no-explicit-any': 'error',
    'typescript/consistent-type-imports': [
      'error',
      { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
    ],
  },
  overrides: [
    // ------------------------------------------------------------- packages
    ...ALL_INTERNAL_PACKAGES.filter((name) => name.startsWith(INTERNAL_SCOPE)).map((name) => ({
      files: [`${directoryOf(name)}/**/*.{ts,tsx,mts,cts}`],
      rules: boundaryRules(name, name === `${INTERNAL_SCOPE}web` ? [EXPERIMENT_IMPORTS] : []),
    })),
    {
      // Later overrides win, so this puts the plain boundary back for the two
      // places allowed to reach the experiments.
      files: [
        'apps/web/src/components/design-system/design-system-page.tsx',
        `${EXPERIMENTS_DIRECTORY}/**/*.{ts,tsx}`,
      ],
      rules: boundaryRules(`${INTERNAL_SCOPE}web`),
    },

    // ---------------------------------------------------------------- react
    {
      files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
      env: { builtin: true, browser: true, node: true },
      rules: REACT_RECOMMENDED_NOT_ON_BY_DEFAULT,
    },

    // -------------------------------------------------------- plain JavaScript
    {
      // `no-undef` is off for TypeScript, where the compiler already answers
      // the question and answers it better. It is on for the handful of plain
      // JavaScript files -- the generator scripts, the service worker, the
      // Prettier and PostCSS configs -- which nothing else checks.
      files: ['**/*.{js,mjs,cjs}'],
      rules: { 'no-undef': 'error' },
    },

    // ------------------------------------------------------------------ JSX
    {
      // A component's markup is not the same kind of line as a statement, so
      // the same idea costs two or three times as many lines here. The looser
      // limit is that difference, not permission to write a bigger component.
      files: ['**/*.tsx'],
      rules: {
        'max-lines-per-function': ['error', { max: 300, skipBlankLines: true, skipComments: true }],
      },
    },

    // ------------------------------------------------------------- NestJS DI
    {
      // Nest resolves constructor dependencies from `emitDecoratorMetadata`,
      // which only exists for *value* imports: rewriting an injected class to a
      // type-only import silently breaks dependency injection at runtime.
      //
      // `max-params` is off here for the same reason and replaced by the two
      // syntax selectors in `eslint.config.mjs`, which can tell a constructor
      // from a function -- the one thing oxlint has no way to express.
      files: ['apps/api/**/*.ts'],
      rules: {
        'typescript/consistent-type-imports': 'off',
        'max-params': 'off',
      },
    },

    // ------------------------------------------------------------ test files
    {
      files: [
        '**/*.test.ts',
        '**/*.test.tsx',
        '**/*.spec.ts',
        '**/tests/**/*.ts',
        '**/test/**/*.ts',
        'e2e/**/*.ts',
      ],
      rules: {
        'no-console': 'off',
        'typescript/no-non-null-assertion': 'off',
        // A test file is nested callbacks by construction, and long by
        // construction: a suite is a list of independent cases, not one idea
        // that outgrew its file. `complexity` stays on, because a test with
        // twenty branches is testing the wrong thing.
        'max-nested-callbacks': 'off',
        'max-lines': 'off',
        'max-lines-per-function': 'off',
      },
    },

    // ---------------------------------------------------------- service worker
    {
      // A service worker runs in neither the window nor Node: its global object
      // is `ServiceWorkerGlobalScope`.
      files: ['apps/web/public/sw.js'],
      env: { builtin: true, serviceworker: true },
      rules: { 'no-undef': 'error' },
    },

    // -------------------------------------------------- command line utilities
    {
      // Seeding and maintenance scripts are CLIs: printing to stdout is their
      // interface, not a forgotten debug statement.
      files: ['**/prisma/seed*.ts', '**/scripts/**/*.{mjs,ts}'],
      rules: {
        'no-console': 'off',
        // A Next.js rule about the bundler's `module` binding, which has
        // nothing to say about a build script that names a local `const module`
        // after what it just imported. The plugin is on repository-wide (see
        // above), so this is where that costs something.
        'nextjs/no-assign-module-variable': 'off',
      },
    },

    // ----------------------------------------------------------------- config
    {
      files: ['**/*.config.{ts,mts,js,mjs,cjs}', 'scripts/**/*.mjs', '**/*.cjs'],
      rules: {
        'no-console': 'off',
        'typescript/no-require-imports': 'off',
      },
    },
  ],
};

const rendered = `${JSON.stringify(config, null, 2)}\n`;

if (process.argv.includes('--check')) {
  let current = '';
  try {
    current = readFileSync(configPath, 'utf8');
  } catch {
    current = '';
  }
  if (current !== rendered) {
    console.error(
      '.oxlintrc.json is out of date. It is generated from scripts/dependency-graph.mjs and\n' +
        'scripts/generate-oxlint-config.mjs -- run `node scripts/generate-oxlint-config.mjs` and\n' +
        'commit the result. Editing the JSON by hand does not work: it is overwritten.',
    );
    process.exit(1);
  }
} else {
  writeFileSync(configPath, rendered, 'utf8');
  console.log('.oxlintrc.json written.');
}
