import { type WorkItemCriterion, type WorkItemRef } from '@exocortex/contracts';

/**
 * The first message of a run started from a work item (issue #138).
 *
 * Written into the conversation as an ordinary user message, so the
 * transcript says exactly what was asked and nothing reached the model that a
 * person cannot read afterwards. German, like the rest of what the built-in AI
 * is told; it names the item's id and the tool that records the outcome,
 * because the run is expected to leave its result on the item rather than
 * only in the chat.
 */
export interface WorkItemPromptInput {
  id: string;
  title: string;
  goal: string;
  criteria: readonly WorkItemCriterion[];
  contextRefs: readonly WorkItemRef[];
  previousResult: string | null;
  instructions: string | null;
}

export function buildWorkItemPrompt(input: WorkItemPromptInput): string {
  const sections = [`Auftrag „${input.title}“ (id: ${input.id})`, `Ziel:\n${input.goal}`];

  if (input.criteria.length > 0) {
    const lines = input.criteria.map(
      (criterion) => `- [${criterion.met ? 'x' : ' '}] ${criterion.text}`,
    );
    sections.push(`Akzeptanzkriterien:\n${lines.join('\n')}`);
  }

  if (input.contextRefs.length > 0) {
    const lines = input.contextRefs.map((ref) => `- ${ref.title} (id: ${ref.documentId})`);
    sections.push(`Kontextseiten (bei Bedarf mit exo_page_read lesen):\n${lines.join('\n')}`);
  }

  if (input.previousResult !== null && input.previousResult.length > 0) {
    sections.push(`Bisheriges Ergebnis aus einem früheren Versuch:\n${input.previousResult}`);
  }

  if (input.instructions !== null && input.instructions.length > 0) {
    sections.push(`Hinweise für diesen Versuch:\n${input.instructions}`);
  }

  sections.push(
    [
      'So hältst du den Auftrag aktuell:',
      `- Wenn du fertig bist, trage das Ergebnis mit exo_work_item_update (workItemId ${input.id}) ein: result, erzeugte Seiten als resultDocumentIds, erfüllte Kriterien mit met: true, und setze status auf review.`,
      `- Brauchst du eine Entscheidung, eine Freigabe oder eine Information von einem Menschen, frag mit exo_attention_request (workItemId ${input.id}): mit options für eine Wahl, ohne für eine Antwort in Worten, bei einer Freigabe mit action und den betroffenen Seiten als subjectPages. Halte in workState fest, was erledigt ist und was danach kommt. Der Auftrag wartet dann, dieser Lauf endet, und die Antwort setzt die Arbeit in diesem Chat fort.`,
      '- Zwischenstände kannst du mit exo_work_item_note festhalten.',
    ].join('\n'),
  );

  return sections.join('\n\n');
}
