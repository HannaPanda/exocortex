'use client';

import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type Workspace, type WorkspaceDetail } from '@exocortex/contracts';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@exocortex/ui';

import { useWorkspaceDetail, useWorkspaces } from '@/lib/api/workspace-queries';

/**
 * Which workspace the dialog's "Arbeitsbereich" groups are about.
 *
 * The one the page underneath belongs to, because that is the one somebody
 * reading it means; on a page outside every workspace (the help, the
 * administration) the first one they belong to. A pick in the dialog wins
 * over both and lasts as long as the dialog is open: it is a question asked
 * inside the settings, not a step of the history, so it is not in the
 * address.
 */
export function useSettingsWorkspace(): {
  workspaces: readonly Workspace[];
  workspaceId: string | null;
  pick: (workspaceId: string) => void;
  /** The workspace, once loaded; `null` while it loads or for none. */
  workspace: WorkspaceDetail | null;
  /** Whether the workspace groups are still on their way. */
  pending: boolean;
} {
  const params = useParams<{ workspaceId?: string }>();
  const list = useWorkspaces();
  const [picked, setPicked] = React.useState<string | null>(null);
  const workspaces = list.data ?? [];
  const fromPage = workspaces.some((workspace) => workspace.id === params.workspaceId)
    ? (params.workspaceId ?? null)
    : null;
  const workspaceId = picked ?? fromPage ?? workspaces[0]?.id ?? null;
  const detail = useWorkspaceDetail(workspaceId ?? undefined);
  return {
    workspaces,
    workspaceId,
    pick: setPicked,
    workspace: detail.data ?? null,
    pending: list.isPending || (workspaceId !== null && detail.isPending),
  };
}

/**
 * The workspace the groups below it are about, and the choice of another
 * one when there is more than one. A plain name otherwise: a select with
 * one option is a question with no answer to give.
 */
export function SettingsWorkspacePicker({
  workspaces,
  workspaceId,
  onPick,
}: {
  workspaces: readonly Workspace[];
  workspaceId: string | null;
  onPick: (workspaceId: string) => void;
}) {
  const t = useTranslations('settings.dialog');
  const current = workspaces.find((workspace) => workspace.id === workspaceId);
  if (current === undefined) return null;
  if (workspaces.length < 2) {
    return (
      <p
        className="truncate px-2 pb-1 text-xs text-muted-foreground"
        data-testid="settings-workspace"
      >
        {current.name}
      </p>
    );
  }
  return (
    <div className="px-1 pb-1">
      <Select
        value={current.id}
        onValueChange={(next) => {
          if (typeof next === 'string') onPick(next);
        }}
      >
        <SelectTrigger
          size="sm"
          className="w-full max-md:min-h-11"
          aria-label={t('workspacePicker')}
          data-testid="settings-workspace-picker"
        >
          <SelectValue>{() => current.name}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {workspaces.map((workspace) => (
            <SelectItem key={workspace.id} value={workspace.id}>
              {workspace.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}
