import { SUPPORTED_LOCALES } from '@exocortex/contracts';
import { FEATURES } from '@exocortex/features';
import { serverTranslator } from '@exocortex/i18n/catalog';

type FeatureTranslator = ReturnType<typeof serverTranslator<'features'>>;
type FeatureKey = Parameters<FeatureTranslator>[0];

/**
 * The words a person would use to ask for each tool, for `exo_tool_search`
 * (issue #265).
 *
 * Not a third list of synonyms: every MCP tool is claimed by an entry of the
 * feature registry (rule 15, `scripts/check-feature-coverage.mjs`), and that
 * entry's title and summary are written in German "in the words somebody would
 * use to ask for it" and translated into every interface language. So the
 * search reads them in all locales, which makes it as multilingual as the help
 * page, and a new tool is findable the day its entry is written.
 *
 * Built once per process: the registry and the catalogue are static.
 */
let cached: ReadonlyMap<string, string> | null = null;

export function toolSearchWords(): ReadonlyMap<string, string> {
  if (cached !== null) return cached;
  const words = new Map<string, string[]>();
  for (const locale of SUPPORTED_LOCALES) {
    const t = serverTranslator(locale, 'features');
    for (const feature of FEATURES) {
      if (feature.access.tools.length === 0) continue;
      // The keys are built from the id, which the catalogue's type cannot
      // follow; the coverage gate guarantees both exist in German, and the
      // translator falls back to German for a locale that is behind.
      const text = `${t(`${feature.id}.title` as FeatureKey)} ${t(`${feature.id}.summary` as FeatureKey)}`;
      for (const tool of feature.access.tools) {
        const list = words.get(tool) ?? [];
        if (!list.includes(text)) list.push(text);
        words.set(tool, list);
      }
    }
  }
  cached = new Map([...words].map(([tool, texts]) => [tool, texts.join(' ')]));
  return cached;
}
