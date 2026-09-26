import { type AttentionKind, type AttentionSubject } from '@exocortex/contracts';

import { reportingInstructions } from './work-item-prompt';

/**
 * The message that carries a paused run on (issue #140, ADR-068).
 *
 * Posted into the conversation of the run that asked, as an ordinary user
 * message, so the transcript says exactly what the resumed run was told and
 * the model reads it with everything it did before still in context. German,
 * like every other message the built-in AI is given. It hands back the
 * working state verbatim, names each answer with who gave it, and says what
 * an approval covers: the action it named and the revisions it is bound to,
 * which the run is told to send as `expectedYjsUpdatedAt`, so a page changed
 * after the answer refuses the write rather than receiving it.
 */

export interface ResumeAnswer {
  attentionItemId: string;
  kind: AttentionKind;
  title: string;
  /** `obsolete` when an approval went stale before it was answered. */
  status: 'resolved' | 'obsolete';
  optionId: string | null;
  optionLabel: string | null;
  note: string | null;
  obsoleteReason: string | null;
  answeredBy: string | null;
  action: string | null;
  subject: AttentionSubject | null;
  subjectTitles: ReadonlyMap<string, string>;
}

export interface ResumePromptInput {
  workItem: { id: string; title: string };
  answers: readonly ResumeAnswer[];
  /** The newest working state any of the answered checkpoints carried. */
  workState: string | null;
}

/** Words for the options a state raises, whose labels live in the catalogue. */
const SYSTEM_OPTION_WORDS: Record<string, string> = {
  accept: 'abgenommen',
  return: 'zurückgegeben',
  answer: 'beantwortet',
  unblock: 'Hindernis beseitigt',
};

export function answerLines(answer: ResumeAnswer): string[] {
  const lines = [`Rückfrage „${answer.title}“ (${answer.kind}, id: ${answer.attentionItemId})`];
  if (answer.status === 'obsolete' && answer.obsoleteReason === 'subject_changed') {
    lines.push(
      'Nicht freigegeben: eine der Seiten, an die die Freigabe gebunden war, hat sich seit ' +
        'deiner Frage geändert. Lies sie neu und frag noch einmal, wenn die Aktion dann noch ' +
        'nötig ist.',
    );
    return lines;
  }
  if (answer.optionId !== null) {
    const words = answer.optionLabel ?? SYSTEM_OPTION_WORDS[answer.optionId] ?? answer.optionId;
    lines.push(`Gewählt: ${words} (${answer.optionId})`);
  }
  if (answer.note !== null) lines.push(`Antwort: ${answer.note}`);
  if (answer.answeredBy !== null) lines.push(`Beantwortet von ${answer.answeredBy}.`);
  if (answer.kind === 'approval' && answer.action !== null) {
    lines.push(`Die Antwort gilt genau für diese Aktion: ${answer.action}`);
  }
  if (answer.subject?.kind === 'pages') {
    const pages = answer.subject.pages.map(
      (page) =>
        `- ${answer.subjectTitles.get(page.documentId) ?? page.documentId} ` +
        `(id: ${page.documentId}, expectedYjsUpdatedAt: ${page.revision})`,
    );
    lines.push(
      'Sie ist an diese Seiten in genau diesem Stand gebunden. Schreib sie mit dieser Revision ' +
        'als expectedYjsUpdatedAt; lehnt ein Schreibvorgang ab, weil sich die Seite geändert ' +
        `hat, gilt die Freigabe nicht mehr, dann frag neu:\n${pages.join('\n')}`,
    );
  }
  return lines;
}

export function buildResumePrompt(input: ResumePromptInput): string {
  const sections = [
    `Antwort auf deine Rückfrage zum Auftrag „${input.workItem.title}“ ` +
      `(id: ${input.workItem.id}). Der Auftrag läuft weiter.`,
    ...input.answers.map((answer) => answerLines(answer).join('\n')),
  ];
  if (input.workState !== null) {
    sections.push(`Dein festgehaltener Arbeitsstand:\n${input.workState}`);
  }
  sections.push('Mach an dieser Stelle weiter.');
  sections.push(reportingInstructions(input.workItem.id));
  return sections.join('\n\n');
}
