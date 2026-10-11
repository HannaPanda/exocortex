import {
  type WorkflowOutputField,
  type WorkItemCriterion,
  type WorkItemRef,
} from '@exocortex/contracts';

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
  /** Where a recorded working state left the work (issue #142), already worded. */
  checkpoint?: string | null;
  instructions: string | null;
  /** The work this is a part of (issue #144), when it was handed on. */
  parent?: { id: string; title: string } | null;
  /** The fields the result has to fill in (issue #162), usually a workflow's. */
  resultFields?: readonly WorkflowOutputField[];
}

export function buildWorkItemPrompt(input: WorkItemPromptInput): string {
  const sections = [`Auftrag „${input.title}“ (id: ${input.id})`, `Ziel:\n${input.goal}`];

  if (input.parent != null) {
    sections.push(
      `Dies ist ein Teilauftrag von „${input.parent.title}“ (id: ${input.parent.id}). ` +
        'Dort kommt nur dein Ergebnis an, nicht dieser Chat: schreib es so in result, dass es ' +
        'ohne Rückfrage weiterverwendet werden kann, knapp und vollständig.',
    );
  }

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

  if (input.resultFields !== undefined && input.resultFields.length > 0) {
    sections.push(resultFieldsSection(input.resultFields));
  }

  if (input.previousResult !== null && input.previousResult.length > 0) {
    sections.push(`Bisheriges Ergebnis aus einem früheren Versuch:\n${input.previousResult}`);
  }

  if (input.checkpoint != null) sections.push(input.checkpoint);

  if (input.instructions !== null && input.instructions.length > 0) {
    sections.push(`Hinweise für diesen Versuch:\n${input.instructions}`);
  }

  sections.push(reportingInstructions(input.id));

  return sections.join('\n\n');
}

/**
 * The structured result the work promises (issue #162). A workflow branches
 * on these values, so the section says what each one is and that the API
 * checks them; an `enum` lists its values, because a near miss is refused.
 */
export function resultFieldsSection(fields: readonly WorkflowOutputField[]): string {
  const lines = fields.map((field) => {
    const type =
      field.type === 'enum' ? `einer von: ${field.values.join(', ')}` : TYPE_WORDS[field.type];
    const required = field.required ? 'Pflicht' : 'optional';
    const description =
      field.description === null || field.description === undefined ? '' : `: ${field.description}`;
    return `- ${field.name} (${type}, ${required})${description}`;
  });
  return [
    'Strukturiertes Ergebnis: Dieser Auftrag verlangt neben dem Ergebnistext diese Felder. Trage sie mit exo_work_item_update als structuredResult ein, ein Objekt mit genau diesen Namen. Andere Namen und falsche Typen werden abgelehnt, und ohne die Pflichtfelder lässt sich der Auftrag nicht abgeben.',
    ...lines,
  ].join('\n');
}

const TYPE_WORDS: Record<Exclude<WorkflowOutputField['type'], 'enum'>, string> = {
  string: 'Text',
  number: 'Zahl',
  boolean: 'true oder false',
};

/**
 * How a run keeps the item current. Shared with the message that carries a
 * paused run on (issue #140), because the resumed run has to be told the same
 * rules the first one was.
 */
export function reportingInstructions(workItemId: string): string {
  return [
    'So hältst du den Auftrag aktuell:',
    `- Wenn du fertig bist, trage das Ergebnis mit exo_work_item_update (workItemId ${workItemId}) ein: result, erzeugte Seiten als resultDocumentIds, erfüllte Kriterien mit met: true, verlangte Felder als structuredResult, und setze status auf review.`,
    `- Brauchst du eine Entscheidung, eine Freigabe oder eine Information von einem Menschen, frag mit exo_attention_request (workItemId ${workItemId}): mit options für eine Wahl, ohne für eine Antwort in Worten, bei einer Freigabe mit action und den betroffenen Seiten als subjectPages. Halte in workState fest, was erledigt ist und was danach kommt. Der Auftrag wartet dann, dieser Lauf endet, und die Antwort setzt die Arbeit in diesem Chat fort.`,
    `- Halte nach jedem größeren Arbeitsschritt und bevor du aufhörst deinen Arbeitsstand mit exo_work_item_checkpoint (workItemId ${workItemId}) fest: summary, plan mit status done/in_progress/open, Annahmen, Erkenntnisse, lastAction, nextStep und die erzeugten Seiten. Weggelassene Felder bleiben wie beim letzten Mal. Ein späterer Lauf, auch mit einem anderen Modell, setzt genau dort an.`,
    '- Kurze Hinweise für Menschen kannst du mit exo_work_item_note in die Historie schreiben.',
    `- Zerfällt die Arbeit in unabhängige Teile, gib sie mit exo_work_item_delegate (workItemId ${workItemId}) als Teilaufträge ab, warte mit exo_work_item_await_children auf sie und lies ihre Ergebnisse mit exo_work_item_child_results. Lesende und vorschlagende Teilaufträge laufen gleichzeitig.`,
  ].join('\n');
}
