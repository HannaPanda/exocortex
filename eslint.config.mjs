import js from '@eslint/js';
import nextPlugin from '@next/eslint-plugin-next';
import prettierConfig from 'eslint-config-prettier';
import reactPlugin from 'eslint-plugin-react';
import reactHooksPlugin from 'eslint-plugin-react-hooks';
import simpleImportSort from 'eslint-plugin-simple-import-sort';
import globals from 'globals';
import tseslint from 'typescript-eslint';

import { ALLOWED_INTERNAL_DEPENDENCIES, INTERNAL_SCOPE } from './scripts/dependency-graph.mjs';

const ALL_INTERNAL_PACKAGES = Object.keys(ALLOWED_INTERNAL_DEPENDENCIES);

/**
 * Builds a `no-restricted-imports` configuration that forbids importing any
 * internal package that is not in the allow list of the given package.
 *
 * @param {string} packageName
 * @returns {import('eslint').Linter.Config['rules']}
 */
function boundaryRules(packageName) {
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
        ],
      },
    ],
  };
}

/**
 * Empty catch blocks are forbidden everywhere. Kept as a constant because
 * `no-restricted-syntax` is not merged across configuration objects: the
 * NestJS override below re-declares the rule and would otherwise drop this.
 */
const NO_EMPTY_CATCH = {
  selector: 'CatchClause > BlockStatement:not(:has(*))',
  message: 'Empty catch blocks are forbidden: log the error or rethrow it (see docs/security.md).',
};

/**
 * `max-params`, minus the constructors.
 *
 * NestJS resolves a constructor's parameters itself, so nobody ever writes that
 * argument list out and the usual reason for the limit (call sites become
 * unreadable and order-dependent) does not apply. What a long injection list
 * does mean is a class with too many collaborators, and that deserves its own
 * threshold rather than being folded into the same number.
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

export default tseslint.config(
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

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    plugins: { 'simple-import-sort': simpleImportSort },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
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
      'no-console': ['error', { allow: ['warn', 'error'] }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-syntax': ['error', NO_EMPTY_CATCH],
      // ------------------------------------------------------------ size policy
      // Nothing in this configuration used to keep anything small, which is how
      // a 626-line function with 81 independent paths got written without a
      // single warning (issue #40).
      //
      // 600 lines and 20 paths are not aesthetic numbers: they are roughly the
      // point past which a file stops being one idea and a function stops
      // fitting in a reader's head. Every violation was removed by splitting
      // along a seam the code already had, never by moving lines somewhere else
      // to get under a number.
      'max-lines': ['error', { max: 600, skipBlankLines: true, skipComments: true }],
      'complexity': ['error', 20],
      'max-depth': ['error', 4],
      'max-params': ['error', 5],
      'max-nested-callbacks': ['error', 3],
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-empty-object-type': 'off',
    },
  },

  // ---------------------------------------------------------------- packages
  ...Object.keys(ALLOWED_INTERNAL_DEPENDENCIES)
    .filter((name) => name.startsWith(INTERNAL_SCOPE))
    .map((name) => {
      const shortName = name.slice(INTERNAL_SCOPE.length);
      const group = ['web', 'api', 'collaboration', 'worker'].includes(shortName)
        ? 'apps'
        : shortName === 'e2e'
          ? 'e2e-root'
          : 'packages';
      const base = group === 'e2e-root' ? 'e2e' : `${group}/${shortName}`;
      return {
        files: [`${base}/**/*.{ts,tsx,mts,cts}`],
        rules: boundaryRules(name),
      };
    }),

  // ------------------------------------------------------------------- react
  {
    files: ['apps/web/**/*.{ts,tsx}', 'packages/ui/**/*.{ts,tsx}'],
    plugins: {
      react: reactPlugin,
      'react-hooks': reactHooksPlugin,
      '@next/next': nextPlugin,
    },
    languageOptions: {
      globals: { ...globals.browser },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    settings: { react: { version: 'detect' } },
    rules: {
      ...reactPlugin.configs.flat.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...nextPlugin.configs.recommended.rules,
      'react/react-in-jsx-scope': 'off',
      'react/prop-types': 'off',
      'react/no-unknown-property': ['error', { ignore: ['cmdk-input-wrapper'] }],
    },
  },

  // --------------------------------------------------------------- NestJS DI
  {
    // Nest resolves constructor dependencies from `emitDecoratorMetadata`, which
    // only exists for *value* imports. Rewriting an injected class to a type-only
    // import silently breaks dependency injection at runtime.
    files: ['apps/api/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': 'off',
      // Constructor injection inflates the parameter count of every provider in
      // this app, so the plain rule is replaced by the same limit expressed as
      // syntax selectors, which can tell a constructor from a function.
      'max-params': 'off',
      'no-restricted-syntax': [
        'error',
        NO_EMPTY_CATCH,
        TOO_MANY_PARAMETERS,
        TOO_MANY_INJECTED_DEPENDENCIES,
      ],
    },
  },

  // -------------------------------------------------------------- test files
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
      '@typescript-eslint/no-non-null-assertion': 'off',
      // A test file is nested callbacks by construction: `describe` inside
      // `describe` inside `it` inside a `waitFor` is the shape the runners ask
      // for, and counting it says nothing about the code under test.
      'max-nested-callbacks': 'off',
      // And it is long by construction too. A suite is a list of independent
      // cases, not one idea that outgrew its file: splitting
      // `processors.integration.test.ts` at 600 lines would produce five files
      // that share a fixture and answer the same question. `complexity` stays
      // on, because a test with twenty branches is testing the wrong thing.
      'max-lines': 'off',
    },
  },

  // ---------------------------------------------------------- service worker
  {
    // A service worker runs in neither the window nor Node: its global object is
    // `ServiceWorkerGlobalScope`, so `self`, `clients` and `caches` are only
    // undeclared from the point of view of the two environments configured above.
    files: ['apps/web/public/sw.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },

  // -------------------------------------------------- command line utilities
  {
    // Seeding and maintenance scripts are CLIs: printing to stdout is their
    // interface, not a forgotten debug statement. `seed*.ts` covers the
    // additional registry seeds next to the main seed (`seed-ai-models.ts`),
    // and `**/scripts/**` (rather than just the root-level `scripts/**`) also
    // covers per-app operator scripts such as
    // `apps/api/scripts/import-obsidian.ts`.
    files: ['**/prisma/seed*.ts', '**/scripts/**/*.{mjs,ts}'],
    rules: { 'no-console': 'off' },
  },

  // ------------------------------------------------------------------ config
  {
    files: ['**/*.config.{ts,mts,js,mjs,cjs}', 'scripts/**/*.mjs', '**/*.cjs'],
    rules: {
      'no-console': 'off',
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  prettierConfig,
);
