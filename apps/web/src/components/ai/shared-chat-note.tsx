'use client';

import { useTranslations } from 'next-intl';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@exocortex/ui';

/**
 * Where a chat on a shared page runs, said where the chat is (issue #234).
 *
 * The page belongs to somebody else's workspace, the conversation and the bill
 * to one of the reader's own. That split is not something a reader would
 * guess, so it is stated once above the transcript, and with more than one
 * workspace of their own the reader picks which one carries it.
 */
export function SharedChatNote({
  workspaceId,
  workspaceName,
  choices,
  onChoose,
}: {
  workspaceId: string;
  workspaceName: string;
  choices: readonly { id: string; name: string }[];
  onChoose: (workspaceId: string) => void;
}) {
  const t = useTranslations('ai.panel');
  return (
    <div
      className="flex flex-col gap-1.5 border-b border-border px-2 py-1.5 text-xs text-muted-foreground"
      data-testid="ai-shared-note"
    >
      <p>{t('sharedRunsIn', { workspace: workspaceName })}</p>
      {choices.length > 1 ? (
        <Select value={workspaceId} onValueChange={(next) => next !== null && onChoose(next)}>
          <SelectTrigger
            size="sm"
            className="min-w-0 max-w-full"
            aria-label={t('sharedWorkspaceLabel')}
            data-testid="ai-shared-workspace"
          >
            <SelectValue>{() => workspaceName}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {choices.map((choice) => (
              <SelectItem key={choice.id} value={choice.id}>
                {choice.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </div>
  );
}
