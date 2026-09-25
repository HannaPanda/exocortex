import { describe, expect, it } from 'vitest';

import { type AiRunDiagnosis } from '@exocortex/contracts';

import { serverTranslator } from './catalog.js';
import { aiRunDiagnosisText, renderAiRunDiagnosis } from './diagnosis.js';

const toolLoop: AiRunDiagnosis = {
  key: 'toolLoop',
  args: {
    limit: 8,
    tallies: [
      { name: 'exo_search', calls: 14, repeats: 9, chars: 128_400 },
      { name: 'exo_page_read', calls: 4, repeats: 0, chars: 120_000 },
    ],
  },
};

describe('renderAiRunDiagnosis', () => {
  it('reads the tally out in German, thousands grouped by the locale', () => {
    const text = renderAiRunDiagnosis(serverTranslator('de', 'diagnostics'), toolLoop);
    expect(text.split('\n')).toEqual([
      'Die Grenze von 8 Werkzeugrunden ist erreicht, der Lauf wurde ohne Antwort beendet.',
      'Gemacht hat dieser Lauf 18 Aufrufe mit zusammen 248.400 Zeichen Antwort:',
      '- exo_search: 14 Aufrufe, 128.400 Zeichen, davon 9 ohne neuen Inhalt',
      '- exo_page_read: 4 Aufrufe, 120.000 Zeichen',
      expect.stringContaining('9 Aufrufe haben genau das geliefert'),
      expect.stringContaining('exo_page_block_read'),
    ]);
  });

  it('formats the numbers for the reader’s locale, not the writer’s', () => {
    const text = renderAiRunDiagnosis(serverTranslator('en', 'diagnostics'), toolLoop);
    expect(text).toContain('128,400');
    expect(text).not.toContain('128.400');
  });

  it('names the limit, the level and the hint of a timeout', () => {
    const text = renderAiRunDiagnosis(serverTranslator('de', 'diagnostics'), {
      key: 'runTimeout',
      args: {
        limit: 'turn',
        limitMs: 180_000,
        model: 'deepseek/deepseek-v4.1-flash',
        effort: 'max',
        turnChars: 0,
        sawReasoning: true,
        toolIterations: 1,
      },
    });
    expect(text.split('\n').slice(0, 3)).toEqual([
      'Eine einzelne Antwort des Modells hat die Grenze von 3 Minuten gerissen (Einstellung ai.timeoutMs). Der Lauf wurde ohne Antwort beendet.',
      'Gelaufen ist deepseek/deepseek-v4.1-flash mit Denkstufe „maximal“ nach einer Werkzeugrunde.',
      'Von der Antwort kam kein einziges Zeichen an: die ganze Zeit ist ins Nachdenken gegangen.',
    ]);
  });
});

describe('aiRunDiagnosisText', () => {
  const t = serverTranslator('de', 'diagnostics');

  it('renders the key when it knows it', () => {
    const text = aiRunDiagnosisText(t, {
      errorDetail: 'stored',
      errorDetailKey: toolLoop.key,
      errorDetailArgs: toolLoop.args,
    });
    expect(text).toContain('Die Grenze von 8 Werkzeugrunden');
  });

  it('falls back to the stored text for an old row or a key it does not know', () => {
    expect(
      aiRunDiagnosisText(t, { errorDetail: 'stored', errorDetailKey: null, errorDetailArgs: null }),
    ).toBe('stored');
    expect(
      aiRunDiagnosisText(t, {
        errorDetail: 'stored',
        errorDetailKey: 'somethingNewer',
        errorDetailArgs: {},
      }),
    ).toBe('stored');
    expect(
      aiRunDiagnosisText(t, {
        errorDetail: 'stored',
        errorDetailKey: 'toolLoop',
        errorDetailArgs: { limit: 'eight' },
      }),
    ).toBe('stored');
  });
});
