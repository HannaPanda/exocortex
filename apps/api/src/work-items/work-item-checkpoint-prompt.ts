import { type WorkCheckpoint, type WorkCheckpointTrigger } from '@exocortex/contracts';

import { answerLines, type ResumeAnswer } from './work-item-resume-prompt';

/**
 * What a run started from a recorded working state is told (issue #142,
 * ADR-069).
 *
 * Added to the first message of a new run, below the goal and the criteria,
 * so the run knows the task and where it stands without the old transcript.
 * It may be a different model from the one that did the earlier part, so
 * nothing here assumes it remembers anything: every page is named with its id,
 * every decision since is spelled out with who made it, and a page that moved
 * on since is marked, because a finding about its old state may no longer hold.
 */

export interface CheckpointPromptInput {
  checkpoint: WorkCheckpoint;
  /** Decisions settled on this work since the checkpoint, oldest first. */
  answersSince: readonly ResumeAnswer[];
  /** Decisions the work still waits on now. */
  stillOpen: readonly { attentionItemId: string; title: string; kind: string }[];
  /** The budget as it stands now, not as it stood then. */
  spentMicroUsd: number;
  budgetMicroUsd: number | null;
}

const TRIGGER_WORDS: Record<WorkCheckpointTrigger, string> = {
  step: 'Zwischenstand nach einem Arbeitsschritt',
  pause: 'geplante Pause',
  waiting_for_human: 'Rückfrage an einen Menschen',
  external_wait: 'Warten auf etwas außerhalb',
  budget: 'Budget fast verbraucht',
  run_interrupted: 'Lauf wurde unterbrochen',
};

const STEP_MARKS = { done: 'x', in_progress: '~', open: ' ' } as const;

function header(checkpoint: WorkCheckpoint): string {
  const origin = [`Anlass: ${TRIGGER_WORDS[checkpoint.trigger]}`];
  if (checkpoint.model !== null) origin.push(`damals mit ${checkpoint.model}`);
  return (
    `Fortsetzung: Für diesen Auftrag ist ein Arbeitsstand festgehalten (Checkpoint ` +
    `${checkpoint.id} vom ${checkpoint.createdAt.slice(0, 16).replace('T', ' ')} UTC, ` +
    `${origin.join(', ')}). Setz dort an, statt von vorn zu beginnen, und wiederhole keine ` +
    'erledigten Schritte. Der alte Chatverlauf liegt dir nicht vor; was du brauchst, steht hier.'
  );
}

function stateSections(checkpoint: WorkCheckpoint): string[] {
  const sections: string[] = [];
  if (checkpoint.summary.length > 0) sections.push(`Stand:\n${checkpoint.summary}`);
  if (checkpoint.plan.length > 0) {
    const lines = checkpoint.plan.map((step) => `- [${STEP_MARKS[step.status]}] ${step.text}`);
    sections.push(`Plan ([x] erledigt, [~] begonnen, [ ] offen):\n${lines.join('\n')}`);
  }
  if (checkpoint.assumptions.length > 0) {
    sections.push(`Annahmen:\n${checkpoint.assumptions.map((line) => `- ${line}`).join('\n')}`);
  }
  if (checkpoint.findings.length > 0) {
    sections.push(`Erkenntnisse:\n${checkpoint.findings.map((line) => `- ${line}`).join('\n')}`);
  }
  if (checkpoint.lastAction !== null) {
    sections.push(`Letzte abgeschlossene Aktion: ${checkpoint.lastAction}`);
  }
  if (checkpoint.nextStep !== null) sections.push(`Nächster Schritt: ${checkpoint.nextStep}`);
  if (checkpoint.trigger === 'run_interrupted') {
    sections.push(
      `Der vorige Lauf endete, ohne fertig zu werden (${checkpoint.interruptionCode ?? 'unbekannt'}). ` +
        'Prüf beim Weitermachen, ob sein letzter Schritt vollständig angekommen ist.',
    );
  }
  return sections;
}

function refLines(checkpoint: WorkCheckpoint, role: 'artifact' | 'source'): string[] {
  return checkpoint.refs
    .filter((ref) => ref.role === role)
    .map((ref) => {
      const name = `${ref.title ?? '(gelöscht)'} (id: ${ref.documentId})`;
      if (ref.title === null) return `- ${name}: nicht mehr vorhanden`;
      return ref.changedSince ? `- ${name}: seit dem Checkpoint geändert, neu lesen` : `- ${name}`;
    });
}

export function buildCheckpointSection(input: CheckpointPromptInput): string {
  const { checkpoint } = input;
  const sections = [header(checkpoint), ...stateSections(checkpoint)];

  const artifacts = refLines(checkpoint, 'artifact');
  if (artifacts.length > 0) sections.push(`Bisher erzeugte Seiten:\n${artifacts.join('\n')}`);
  const sources = refLines(checkpoint, 'source');
  if (sources.length > 0) sections.push(`Verwendete Quellen:\n${sources.join('\n')}`);

  if (input.answersSince.length > 0) {
    sections.push(
      'Entscheidungen seit dem Checkpoint:',
      ...input.answersSince.map((answer) => answerLines(answer).join('\n')),
    );
  }
  if (input.stillOpen.length > 0) {
    const lines = input.stillOpen.map(
      (item) => `- ${item.title} (${item.kind}, id: ${item.attentionItemId})`,
    );
    sections.push(
      `Noch unbeantwortet (frag nicht noch einmal; exo_attention_get liest den Stand):\n${lines.join('\n')}`,
    );
  }
  if (input.budgetMicroUsd !== null) {
    sections.push(
      `Budget: ${input.spentMicroUsd} von ${input.budgetMicroUsd} Mikro-USD verbraucht.`,
    );
  }
  return sections.join('\n\n');
}
