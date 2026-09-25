#!/usr/bin/env node
/**
 * Writes `packages/i18n/src/catalog.generated.ts` from the message files.
 *
 * Run after adding a namespace or a locale; the translation tool runs it
 * itself. The i18n gate compares the file with what this would write and
 * goes red when they differ.
 */

import { writeFileSync } from 'node:fs';

import {
  generatedCatalogPath,
  generatedCatalogSource,
  namespacesOf,
  SOURCE_LOCALE,
  supportedLocales,
} from '../lib/i18n-catalog.mjs';

const source = generatedCatalogSource(supportedLocales(), namespacesOf(SOURCE_LOCALE));
writeFileSync(generatedCatalogPath, source, 'utf8');
console.log(`Wrote ${generatedCatalogPath}`);
