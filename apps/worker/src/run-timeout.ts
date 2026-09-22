import type { AiReasoningOptions } from '@exocortex/ai';

/** What ran out, and what the run had to show for the time it spent. */
export interface RunTimeoutFacts {
  /** `turn` is one model answer (`ai.timeoutMs`), `run` the whole run (`ai.maxRunMs`). */
  limit: 'turn' | 'run';
  limitMs: number;
  model: string;
  /** The thinking level this run asked the provider for. */
  effort: AiReasoningOptions['effort'];
  /** Characters of the answer that had streamed when the limit hit. */
  turnChars: number;
  /** Whether the provider had said it was thinking before it went quiet. */
  sawReasoning: boolean;
  /** Tool rounds the run got through before it ran out. */
  toolIterations: number;
}

/** The picker's own words, so the diagnosis names the control the reader can change. */
const LEVEL_LABELS: Record<AiReasoningOptions['effort'], string> = {
  none: 'keine',
  minimal: 'minimal',
  low: 'niedrig',
  medium: 'mittel',
  high: 'hoch',
  xhigh: 'sehr hoch',
  max: 'maximal',
};

/**
 * Why the run ran out of time, in the words of what it was actually doing.
 *
 * The message this replaces said "Die KI hat zu lange gebraucht." and nothing
 * else, which leaves out the two facts that decide what to do next: which of
 * the two limits ran out, and that the time went into thinking rather than
 * into writing. A run at thinking level `maximal` on a model that answers the
 * same question in 79 seconds at `hoch` is not a run that needs a higher
 * limit, and the panel is where that has to be said, because the level is set
 * beside the model picker and not in the administration.
 */
export function describeRunTimeout(facts: RunTimeoutFacts): string {
  const lines: string[] = [
    facts.limit === 'turn'
      ? `Eine einzelne Antwort des Modells hat die Grenze von ${seconds(facts.limitMs)} gerissen ` +
        '(Einstellung ai.timeoutMs). Der Lauf wurde ohne Antwort beendet.'
      : `Der ganze Lauf hat seine Grenze von ${seconds(facts.limitMs)} erreicht ` +
        '(Einstellung ai.maxRunMs). Er wurde ohne Antwort beendet.',
    `Gelaufen ist ${facts.model} mit Denkstufe „${LEVEL_LABELS[facts.effort]}“` +
      `${rounds(facts.toolIterations)}.`,
  ];

  if (facts.turnChars > 0) {
    lines.push(
      `Von der Antwort ${
        facts.turnChars === 1 ? 'war ein Zeichen' : `waren ${german(facts.turnChars)} Zeichen`
      } angekommen, dann lief die Zeit ab.`,
    );
  } else if (facts.sawReasoning) {
    lines.push(
      'Von der Antwort kam kein einziges Zeichen an: die ganze Zeit ist ins Nachdenken gegangen.',
    );
  } else {
    lines.push('Von der Antwort kam kein einziges Zeichen an; das Modell hat nichts geliefert.');
  }

  lines.push(hint(facts));
  return lines.join('\n');
}

/** What to change, and it is rarely the limit. */
function hint(facts: RunTimeoutFacts): string {
  if (facts.effort !== 'none' && facts.turnChars === 0) {
    return (
      'Eine niedrigere Denkstufe kommt hier weiter als eine höhere Grenze: die Zeit ist vor dem ' +
      'ersten Zeichen vergangen, und genau die ist das Nachdenken. Die Stufe steht im KI-Bereich ' +
      'neben der Modellauswahl, die Grenzen in der Verwaltung unter „KI“.'
    );
  }
  if (facts.limit === 'run') {
    return (
      'Ein kleinerer Schritt kommt hier weiter als eine höhere Grenze: eine Aufgabe, die so viele ' +
      'Werkzeugrunden braucht, wird in zwei Fragen schneller fertig als in einer. Die Grenzen ' +
      'stehen in der Verwaltung unter „KI“.'
    );
  }
  return (
    'Eine kleinere Frage oder ein schnelleres Modell kommt hier weiter als eine höhere Grenze. ' +
    'Die Grenzen stehen in der Verwaltung unter „KI“.'
  );
}

/** How far the run had got, left out entirely when it called no tool at all. */
function rounds(toolIterations: number): string {
  if (toolIterations === 0) return '';
  if (toolIterations === 1) return ' nach einer Werkzeugrunde';
  return ` nach ${german(toolIterations)} Werkzeugrunden`;
}

/** Whole seconds, or whole minutes once that is the honest unit. */
function seconds(limitMs: number): string {
  const total = Math.round(limitMs / 1_000);
  if (total < 120) return count(total, 'Sekunde', 'Sekunden');
  return count(Math.round(total / 60), 'Minute', 'Minuten');
}

function count(value: number, singular: string, plural: string): string {
  return `${german(value)} ${value === 1 ? singular : plural}`;
}

/** Thousands the German way, without a locale: the same number on every host. */
function german(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}
