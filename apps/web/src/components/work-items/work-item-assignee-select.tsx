'use client';

import { useTranslations } from 'next-intl';

import { type WorkItemAssigneeInput, type WorkspaceMember } from '@exocortex/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@exocortex/ui';

/**
 * Who does the work, as one choice (issue #138).
 *
 * Every member is offered twice, as a person and as an agent account, because
 * the account does not say which it is: an agent here is an account with a
 * token, and only whoever hands out the work knows whether it is Johanna or
 * the Claude Code running under her name that should pick it up.
 */

const NOBODY = 'nobody';
const ASSISTANT = 'assistant';

function encode(value: WorkItemAssigneeInput | null): string {
  if (value === null) return NOBODY;
  if (value.kind === 'assistant') return ASSISTANT;
  return `${value.kind}:${value.userId}`;
}

function decode(value: string): WorkItemAssigneeInput | null {
  if (value === NOBODY) return null;
  if (value === ASSISTANT) return { kind: 'assistant' };
  const [kind, userId] = value.split(':');
  if ((kind === 'human' || kind === 'agent') && userId !== undefined) return { kind, userId };
  return null;
}

export function WorkItemAssigneeSelect({
  value,
  members,
  onChange,
  disabled,
  id,
}: {
  value: WorkItemAssigneeInput | null;
  members: readonly WorkspaceMember[];
  onChange: (value: WorkItemAssigneeInput | null) => void;
  disabled?: boolean;
  id?: string;
}) {
  const t = useTranslations('workItems.labels');

  const labelOf = (encoded: string): string => {
    const decoded = decode(encoded);
    if (decoded === null) return t('participant.nobody');
    if (decoded.kind === 'assistant') return t('participant.assistant');
    const name =
      members.find((member) => member.userId === decoded.userId)?.name ?? t('participant.unknown');
    return decoded.kind === 'agent' ? t('participant.agent', { name }) : name;
  };

  const options = [
    NOBODY,
    ASSISTANT,
    ...members.map((member) => `human:${member.userId}`),
    ...members.map((member) => `agent:${member.userId}`),
  ];

  return (
    <Select
      value={encode(value)}
      onValueChange={(next) => onChange(decode(String(next)))}
      disabled={disabled}
    >
      <SelectTrigger id={id} data-testid="work-item-assignee">
        <SelectValue>{() => labelOf(encode(value))}</SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labelOf(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
