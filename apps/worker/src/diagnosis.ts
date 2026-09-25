import { type AiRunDiagnosis, DEFAULT_LOCALE } from '@exocortex/contracts';
import { renderAiRunDiagnosis } from '@exocortex/i18n';
import { serverTranslator } from '@exocortex/i18n/catalog';

const german = serverTranslator(DEFAULT_LOCALE, 'diagnostics');

/**
 * The German rendering the worker still writes to `AiRun.errorDetail` beside
 * the key and its arguments (issue #98, ADR-059): the text for a reader that
 * predates the columns or does not know the key. Every other reader renders
 * the key itself, in its own reader's language.
 */
export function germanDiagnosis(diagnosis: AiRunDiagnosis): string {
  return renderAiRunDiagnosis(german, diagnosis);
}
