'use client';

import { useTranslations } from 'next-intl';

import { type AgentProfile, type AiWriteMode } from '@exocortex/contracts';

/**
 * The words a profile is shown in (issue #143), shared by the list, the
 * detail and the work item. The write mode keeps the settings' wording, so a
 * profile and the workspace setting it narrows say the same thing.
 */
export function useAgentProfileWording() {
  const tLabels = useTranslations('agentProfiles.labels');
  const tWrite = useTranslations('settings.row.choices.writeMode');
  const tReasoning = useTranslations('ai.models.reasoningLevels');
  return {
    writeMode: (mode: AiWriteMode): string => tWrite(mode),
    approval: (policy: AgentProfile['approvalPolicy']): string => tLabels(`approval.${policy}`),
    domain: (domain: string): string => tLabels(`domains.${domain}` as 'domains.core'),
    reasoning: (level: NonNullable<AgentProfile['reasoningLevel']>): string => tReasoning(level),
  };
}

/** A whole number from a field, or null when it is empty or not one. */
export function wholeNumberOf(text: string): number | null {
  const value = Number(text.trim());
  return text.trim().length > 0 && Number.isInteger(value) && value > 0 ? value : null;
}
