'use client';

import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@exocortex/ui';

import { useCreateWorkspace, useWorkspaces } from '@/lib/api/queries';

export function WorkspaceSwitcher({ activeWorkspaceId }: { activeWorkspaceId: string | null }) {
  const router = useRouter();
  const workspaces = useWorkspaces();
  const createWorkspace = useCreateWorkspace();
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');

  const active = workspaces.data?.find((workspace) => workspace.id === activeWorkspaceId);

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const workspace = await createWorkspace.mutateAsync(trimmed);
    setCreating(false);
    setName('');
    router.push(`/arbeitsbereich/${workspace.id}`);
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className="max-w-52 justify-between gap-1"
            data-testid="workspace-switcher"
          >
            <span className="truncate">{active?.name ?? 'Arbeitsbereich wählen'}</span>
            <ChevronsUpDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
          </Button>
        }
      />
      <DropdownMenuContent className="min-w-60">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Arbeitsbereiche</DropdownMenuLabel>
          {(workspaces.data ?? []).map((workspace) => (
            <DropdownMenuItem
              key={workspace.id}
              onClick={() => router.push(`/arbeitsbereich/${workspace.id}`)}
              data-testid={`workspace-option-${workspace.id}`}
            >
              <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
              <span className="text-xs text-muted-foreground">{workspace.role}</span>
              {workspace.id === activeWorkspaceId ? <CheckIcon /> : null}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        {creating ? (
          <div className="flex flex-col gap-2 p-2">
            <input
              autoFocus
              value={name}
              placeholder="Name des Arbeitsbereichs"
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create();
                if (event.key === 'Escape') setCreating(false);
              }}
              className="h-8 rounded-md border border-input bg-transparent px-2 text-sm outline-none"
              data-testid="workspace-name-input"
            />
            <Button size="sm" onClick={() => void create()} data-testid="workspace-create-submit">
              Anlegen
            </Button>
          </div>
        ) : (
          <DropdownMenuItem
            onClick={(event) => {
              event.preventDefault();
              setCreating(true);
            }}
            data-testid="workspace-create"
          >
            <PlusIcon /> Neuer Arbeitsbereich
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
