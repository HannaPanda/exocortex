import { type PrismaClient } from '@exocortex/database';
import { type Logger } from '@exocortex/logger';

export interface BuildSystemPromptInput {
  prisma: PrismaClient;
  workspaceId: string;
  basePrompt: string;
  /** Hard cap on the characters ALWAYS rules may contribute. */
  maxRuleChars: number;
  logger: Logger;
}

export interface SystemPromptResult {
  prompt: string;
  alwaysRuleCount: number;
  onDemandRuleCount: number;
  truncated: boolean;
}

/**
 * Builds the system prompt for a run: the admin-configured base prompt, then the
 * workspace's ALWAYS rule pages in priority order, then a catalogue of ON_DEMAND
 * rules with their triggers only.
 *
 * ON_DEMAND rules are the reason the context stays small: the model sees one line
 * per rule and calls `exo_rules_load` for the body when the trigger matches.
 */
export async function buildSystemPrompt(input: BuildSystemPromptInput): Promise<SystemPromptResult> {
  const { prisma, workspaceId, basePrompt, maxRuleChars, logger } = input;

  const [alwaysRules, onDemandRules] = await Promise.all([
    prisma.document.findMany({
      where: { workspaceId, archivedAt: null, aiRuleMode: 'ALWAYS' },
      orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
      select: { id: true, title: true, content: { select: { markdown: true, plainText: true } } },
    }),
    prisma.document.findMany({
      where: { workspaceId, archivedAt: null, aiRuleMode: 'ON_DEMAND' },
      orderBy: [{ aiRulePriority: 'asc' }, { title: 'asc' }],
      select: { id: true, aiRuleTrigger: true },
    }),
  ]);

  const sections: string[] = [basePrompt];
  let truncated = false;
  let alwaysRuleCount = 0;
  let remainingBudget = maxRuleChars;

  if (alwaysRules.length > 0) {
    const alwaysSectionParts: string[] = ['## Regeln aus dem Arbeitsbereich'];
    for (const rule of alwaysRules) {
      const body = rule.content?.markdown ?? rule.content?.plainText ?? null;
      if (body === null || body.trim().length === 0) {
        logger.info('Skipping an ALWAYS rule page that has never been materialized', {
          documentId: rule.id,
          workspaceId,
        });
        continue;
      }
      if (body.length > remainingBudget) {
        truncated = true;
        break;
      }
      remainingBudget -= body.length;
      alwaysSectionParts.push(`### ${rule.title}\n${body}`);
      alwaysRuleCount += 1;
    }
    if (truncated) {
      alwaysSectionParts.push('_Weitere Regelseiten wurden wegen ihrer Länge nicht eingefügt._');
    }
    if (alwaysRuleCount > 0 || truncated) {
      sections.push(alwaysSectionParts.join('\n\n'));
    }
  }

  let onDemandRuleCount = 0;
  const onDemandLines = onDemandRules
    .filter((rule) => rule.aiRuleTrigger !== null && rule.aiRuleTrigger.trim().length > 0)
    .map((rule) => `- ${rule.aiRuleTrigger} (documentId: ${rule.id})`);
  if (onDemandLines.length > 0) {
    onDemandRuleCount = onDemandLines.length;
    sections.push(
      [
        '## Regeln auf Anfrage',
        'Wenn eine der folgenden Situationen zutrifft, lade die ausführlichen Anweisungen',
        'mit dem Werkzeug `exo_rules_load` und der genannten documentId, bevor du handelst:',
        ...onDemandLines,
      ].join('\n'),
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  sections.push(`Aktueller Arbeitsbereich: ${workspaceId}. Heutiges Datum: ${today}.`);

  return {
    prompt: sections.join('\n\n'),
    alwaysRuleCount,
    onDemandRuleCount,
    truncated,
  };
}
