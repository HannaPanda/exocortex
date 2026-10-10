import { CHILD_RESULTS_TOTAL_CHARS, type WorkItemChildResult } from '@exocortex/contracts';

import { reportingInstructions } from './work-item-prompt';

/**
 * The message that carries a waiting parent on once its children are back
 * (issue #144, ADR-072).
 *
 * Posted into the paused run's own conversation as the next user message,
 * like an answer to a human checkpoint (issue #140). It carries each child's
 * distilled result and nothing of how the child got there: the parent asked
 * for an outcome, and a transcript per child would flood its context. German,
 * like everything the built-in AI is told about its work, and it names the
 * tools, because what happens to each result is the parent's decision.
 */

const STATUS_WORDS: Record<WorkItemChildResult['status'], string> = {
  queued: 'angelegt',
  working: 'in Arbeit',
  blocked: 'blockiert',
  waiting_for_human: 'wartet auf einen Menschen',
  review: 'zur Abnahme',
  done: 'erledigt',
  failed: 'gescheitert',
  cancelled: 'abgebrochen',
};

export function formatChildResult(child: WorkItemChildResult): string {
  const head = [`- „${child.title}“ (id: ${child.id})`, STATUS_WORDS[child.status]];
  if (child.criteriaTotal > 0) head.push(`Kriterien ${child.criteriaMet}/${child.criteriaTotal}`);
  if (child.spentMicroUsd > 0) head.push(`${child.spentMicroUsd} Mikro-USD`);
  const lines = [head.join(' · ')];
  if (child.statusReason !== null) lines.push(`  Grund: ${child.statusReason}`);
  if (child.result !== null && child.result.length > 0) {
    const note = child.resultTruncated ? ' (gekürzt, vollständig mit exo_work_item_get)' : '';
    lines.push(`  Ergebnis${note}:`, ...child.result.split('\n').map((line) => `    ${line}`));
  } else if (child.latestRun?.errorCode != null) {
    lines.push(`  Letzter Lauf: ${child.latestRun.status}, Fehler ${child.latestRun.errorCode}`);
  } else {
    lines.push('  Kein Ergebnis eingetragen.');
  }
  if (child.resultRefs.length > 0) {
    lines.push(
      `  Ergebnisseiten: ${child.resultRefs.map((ref) => `${ref.title} (id: ${ref.documentId})`).join(', ')}`,
    );
  }
  return lines.join('\n');
}

/** How many characters each child's result may take in the message. */
export function perChildChars(count: number, ceiling: number): number {
  if (count <= 0) return ceiling;
  return Math.max(200, Math.min(ceiling, Math.floor(CHILD_RESULTS_TOTAL_CHARS / count)));
}

export function buildChildrenReturnedPrompt(input: {
  workItem: { id: string; title: string };
  children: readonly WorkItemChildResult[];
}): string {
  return [
    `Die Teilaufträge, auf die „${input.workItem.title}“ (id: ${input.workItem.id}) gewartet hat, sind zurück:`,
    input.children.map(formatChildResult).join('\n'),
    [
      'Entscheide für jeden Teilauftrag:',
      '- Brauchbar: mit exo_work_item_update auf done setzen und das Ergebnis weiterverwenden.',
      '- Nachbessern: status working mit statusReason setzen und mit exo_work_item_start_run und instructions neu starten.',
      '- Gescheitert, aber nötig: status queued setzen und mit exo_work_item_start_run neu starten.',
      '- Nicht mehr nötig: status cancelled.',
      'Weitere Teile gibst du mit exo_work_item_delegate ab und wartest mit exo_work_item_await_children. Führe die Ergebnisse dann im Auftrag selbst zusammen.',
    ].join('\n'),
    reportingInstructions(input.workItem.id),
  ].join('\n\n');
}
