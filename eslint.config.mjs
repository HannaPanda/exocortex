/**
 * The remainder of the lint policy: what oxlint cannot express.
 *
 * Since issue #84 the primary linter is oxlint, configured by `.oxlintrc.json`
 * (generated -- the policy behind it is `scripts/generate-oxlint-config.mjs`).
 * It carries the recommended sets, the size policy, the React and Next.js
 * rules and the package boundaries, and it walks the whole repository in a
 * fifth of a second.
 *
 * What is left here is the short list it has no equivalent for. Each entry
 * below says why it is still here, because "still here" is the interesting
 * part: the moment oxlint grows the rule, the entry and its plugin go.
 *
 *   1. `no-restricted-syntax` -- AST selectors. The two NestJS parameter
 *      limits, which have to be able to tell a constructor from a function.
 *      oxlint has no selector language.
 *
 *      A third selector used to live here, forbidding empty catch blocks, and
 *      the migration is what found out that it had never matched anything:
 *      esquery reads `:has(*)` as true for a block with no children, so
 *      `:not(:has(*))` was false everywhere. What has actually been enforcing
 *      that policy all along is `no-empty`, which is now oxlint's and named in
 *      `scripts/generate-oxlint-config.mjs` for this reason. Nine catch blocks
 *      in this repository hold a comment and nothing else, which `no-empty`
 *      allows on purpose: a reason written down is the point.
 *   2. `simple-import-sort` -- oxlint's import rules can order imports but not
 *      in these groups, and the grouping is the point (`node:`, third party,
 *      `@exocortex/*`, aliases, relative).
 *   3. `react/no-deprecated` and
 *      `@next/next/no-location-assign-relative-destination` -- two plugin rules
 *      with no oxlint port yet.
 *
 * There are no formatting rules left, so `eslint-config-prettier` is gone with
 * them: nothing here can disagree with Prettier any more.
 */
import parser from '@babel/eslint-parser';
import nextPlugin from '@next/eslint-plugin-next';
import reactPlugin from 'eslint-plugin-react';
import simpleImportSort from 'eslint-plugin-simple-import-sort';

/**
 * The parser options, spelled out here rather than in a Babel config file.
 *
 * `requireConfigFile: false` is what keeps this inline: a `babel.config.json`
 * at the root of the repository would be found by Next.js as well, and finding
 * one is how Next decides to compile `apps/web` with Babel instead of SWC. The
 * lint run must not be able to change how the application is built.
 *
 * `@babel/preset-typescript` reads the file name, so `.ts` and `.tsx` each get
 * the right dialect without `allExtensions`, and angle-bracket assertions stay
 * legal in `.ts`. The decorator syntax is the legacy form because that is what
 * `experimentalDecorators` in `apps/api/tsconfig.json` compiles.
 */
const babelOptions = {
  requireConfigFile: false,
  babelOptions: {
    babelrc: false,
    configFile: false,
    presets: ['@babel/preset-typescript'],
    plugins: [['@babel/plugin-syntax-decorators', { legacy: true }]],
  },
};

/**
 * `max-params`, minus the constructors.
 *
 * NestJS resolves a constructor's parameters itself, so nobody ever writes that
 * argument list out and the usual reason for the limit (call sites become
 * unreadable and order-dependent) does not apply. What a long injection list
 * does mean is a class with too many collaborators, and that deserves its own
 * threshold rather than being folded into the same number. `.oxlintrc.json`
 * switches the plain `max-params` off for `apps/api` for exactly this reason.
 */
const TOO_MANY_PARAMETERS = {
  selector: [
    'FunctionDeclaration[params.length>5]',
    'ArrowFunctionExpression[params.length>5]',
    'MethodDefinition[kind!="constructor"] > FunctionExpression[params.length>5]',
    'Property > FunctionExpression[params.length>5]',
  ].join(', '),
  message:
    'Too many parameters (maximum 5). Pass a single options object instead, so call sites name what they pass.',
};

/**
 * The ceiling for constructor injection: ten is what the widest class has today
 * (`DocumentsController`), so this forbids getting worse without demanding a
 * rewrite first. Lower it whenever a class is split up.
 */
const TOO_MANY_INJECTED_DEPENDENCIES = {
  selector: 'MethodDefinition[kind="constructor"] > FunctionExpression[params.length>10]',
  message:
    'More than 10 injected dependencies: this class has too many collaborators. Split it before adding another.',
};

export default [
  {
    ignores: [
      '**/node_modules/**',
      // Agent worktrees are full checkouts of this repository living inside it.
      // Git ignores them, ESLint does not: without this line every run lints
      // four extra copies of the whole tree and reports the same finding once
      // per copy.
      '.claude/worktrees/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
      '**/*.generated.ts',
      'packages/contracts/src/lucide-icon-names.ts',
      '**/playwright-report/**',
      '**/test-results/**',
      'packages/database/prisma/migrations/**',
    ],
  },

  {
    files: ['**/*.{js,mjs,cjs,ts,tsx,mts,cts}'],
    languageOptions: {
      // Babel's parser, not `@typescript-eslint/parser`. Nothing here needs
      // type information, and nothing here needs `typescript-eslint`'s rule set
      // any more -- oxlint has it since issue #84. What was left was a parser
      // that loads the `typescript` package for its compiler API, and
      // TypeScript 7 does not ship one (issue #85): its main export is the
      // version string beside a native binary. Babel parses TypeScript by
      // itself and so has no opinion about which compiler is installed.
      parser,
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true }, ...babelOptions },
    },
    plugins: { 'simple-import-sort': simpleImportSort },
    rules: {
      'simple-import-sort/imports': [
        'error',
        {
          groups: [
            ['^node:'],
            ['^@?\\w'],
            ['^@exocortex/'],
            ['^~/', '^@/'],
            ['^\\.\\.'],
            ['^\\.'],
            ['^.+\\.s?css$'],
          ],
        },
      ],
      'simple-import-sort/exports': 'error',
    },
  },

  // --------------------------------------------------------------- NestJS DI
  {
    files: ['apps/api/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', TOO_MANY_PARAMETERS, TOO_MANY_INJECTED_DEPENDENCIES],
    },
  },

  // ------------------------------------------------------------------- react
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: { react: reactPlugin, '@next/next': nextPlugin },
    settings: { react: { version: 'detect' } },
    // The Next.js rule below only fires on an identifier that resolves to a
    // declared global, and a flat config declares none unless it is asked to.
    // Without these five names `location.assign('/x')` is an unresolved
    // reference, the rule returns early, and it has never reported anything --
    // the same shape of dead rule that issue #84 found in the selector list.
    languageOptions: {
      globals: {
        document: 'readonly',
        globalThis: 'readonly',
        location: 'readonly',
        self: 'readonly',
        window: 'readonly',
      },
    },
    rules: {
      // The legacy class API. It cannot fire while this codebase has no class
      // components, and that is the point: it is what says so.
      'react/no-deprecated': 'error',
      '@next/next/no-location-assign-relative-destination': 'error',
    },
  },
];
