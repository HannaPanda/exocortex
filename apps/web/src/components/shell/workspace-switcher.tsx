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
  const [open, setOpen] = React.useState(false);
  const [creating, setCreating] = React.useState(false);
  const [name, setName] = React.useState('');

  const active = workspaces.data?.find((workspace) => workspace.id === activeWorkspaceId);

  const create = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    const workspace = await createWorkspace.mutateAsync(trimmed);
    setCreating(false);
    setName('');
    setOpen(false);
    router.push(`/arbeitsbereich/${workspace.id}`);
  };

  return (
    // Controlled, so creating a workspace can close the menu itself and so a
    // half-typed name never survives into the next time it is opened.
    <DropdownMenu
      open={open}
      onOpenChange={(next: boolean) => {
        setOpen(next);
        if (!next) {
          setCreating(false);
          setName('');
        }
      }}
    >
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
      <DropdownMenuContent className="flex min-w-60 flex-col overflow-hidden">
        {/*
          Only the list scrolls. "Neuer Arbeitsbereich" below it has to stay
          reachable no matter how many workspaces someone is a member of — with
          a hundred of them, a menu that scrolls as a whole hides the one entry
          that is not a workspace.
        */}
        <DropdownMenuGroup className="min-h-0 flex-1 overflow-y-auto">
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
            // Without this the menu closes on the click, taking the form this
            // very item opens down with it: `preventDefault` does not stop it,
            // because Base UI closes on activation and not on the DOM default.
            closeOnClick={false}
            onClick={() => setCreating(true)}
            data-testid="workspace-create"
          >
            <PlusIcon /> Neuer Arbeitsbereich
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
