/**
 * The gold standard of #206 and the domain descriptions every router under
 * test is given, shared by `scripts/tool-routing-eval.mjs` and the local
 * challengers in `evals/tool-routing/local/`, so no two routers are measured
 * against different words.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ROUTING_PRODUCT, ROUTING_QUESTIONS } from '../../packages/mcp-tools/dist/index.js';

const GOLD = join(dirname(fileURLToPath(import.meta.url)), '../../evals/tool-routing/gold.json');

/**
 * What each optional domain is, for a decision engine, and what it is told
 * this product is. Since issue #206 went live these are the product's own
 * words (`packages/mcp-tools/src/tool-routing.ts`), so the gold standard
 * measures exactly the question the worker asks.
 */
export const DOMAIN_QUESTIONS = ROUTING_QUESTIONS;

/** Never routed: offered from the workspace's approvals or not at all (ADR-086). */
export const UNROUTED = new Set(['core', 'pages', 'external']);
export const OPTIONAL_DOMAINS = Object.keys(DOMAIN_QUESTIONS);

export const PRODUCT = ROUTING_PRODUCT;

/** One entry per sentence: a group's meaning, in one language. */
export function loadCases(split) {
  const gold = JSON.parse(readFileSync(GOLD, 'utf8'));
  for (const group of gold.groups) {
    for (const domain of [...group.expected, ...(group.acceptable ?? [])]) {
      if (!OPTIONAL_DOMAINS.includes(domain)) {
        throw new Error(`${group.id} names ${domain}, which is not a routed domain`);
      }
    }
  }
  const cases = [];
  for (const group of gold.groups) {
    if (split !== 'all' && group.split !== split) continue;
    for (const [language, text] of Object.entries(group.texts)) {
      const texts = Array.isArray(text) ? text : [text];
      texts.forEach((entry, index) =>
        cases.push({
          id: `${group.id}/${language}${texts.length > 1 ? `#${index}` : ''}`,
          group: group.id,
          kind: group.kind,
          language,
          text: entry,
          context: group.context ?? {},
          expected: group.expected,
          acceptable: group.acceptable ?? [],
        }),
      );
    }
  }
  return cases;
}
