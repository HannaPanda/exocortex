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

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/.next/**',
      '**/.turbo/**',
      '**/coverage/**',
      '**/generated/**',
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
      'no-restricted-syntax': [
        'error',
        {
          selector: "CatchClause > BlockStatement:not(:has(*))",
          message:
            'Empty catch blocks are forbidden: log the error or rethrow it (see docs/security.md).',
        },
      ],
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
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
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
    },
  },

  // -------------------------------------------------- command line utilities
  {
    // Seeding and maintenance scripts are CLIs: printing to stdout is their
    // interface, not a forgotten debug statement. `**/scripts/**` (rather than
    // just the root-level `scripts/**`) also covers per-app operator scripts
    // such as `apps/api/scripts/import-obsidian.ts`.
    files: ['**/prisma/seed.ts', '**/scripts/**/*.{mjs,ts}'],
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
