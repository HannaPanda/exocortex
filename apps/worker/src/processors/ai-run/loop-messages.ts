/** What the run loop says to the model about itself, rather than on the user's behalf. */

/**
 * How often one run may pick up an answer that hit the output cap.
 *
 * Bounded on purpose: a model that keeps running into the limit is producing
 * something the limit is not the right fix for, and every retry costs a full
 * prompt again.
 */
export const MAX_TRUNCATION_RETRIES = 3;

/**
 * How often one run asks again for a turn that came back with nothing: no
 * text, no tool call, often not even a finish reason. Asking again is safe,
 * because nothing of such a turn was executed or shown; once is enough to get
 * past a dropped connection, and a provider that does it twice in a row is
 * not going to be talked out of it.
 */
export const MAX_EMPTY_TURN_RETRIES = 1;

/** Sent after a text answer was cut off, to pick it up without repeating anything. */
export const TRUNCATION_CONTINUE_PROMPT =
  'Deine vorige Antwort wurde am Ausgabelimit abgeschnitten. Setze genau an der Abbruchstelle fort: ' +
  'keine Einleitung, keine Wiederholung, kein Neuanfang.';

/** Sent after a tool call was cut off mid-arguments, so the retry stays inside the limit. */
export const TRUNCATION_TOOL_RETRY_PROMPT =
  'Dein letzter Werkzeugaufruf wurde am Ausgabelimit abgeschnitten und deshalb nicht ausgeführt. ' +
  'Wiederhole ihn mit deutlich weniger Inhalt pro Aufruf: schreibe lange Inhalte in mehreren Schritten, ' +
  'den ersten mit mode "replace", die weiteren mit mode "append".';

/** What a call the model made after a blocking checkpoint in the same turn answers. */
export const PAUSED_CALL_TEXT =
  'Nicht ausgeführt: der Auftrag wartet auf die Antwort auf deine Rückfrage. Die Antwort setzt ' +
  'die Arbeit in einem neuen Lauf fort.';
