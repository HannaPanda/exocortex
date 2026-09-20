'use client';

import { CheckIcon, ChevronsUpDownIcon, PlusIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import * as React from 'react';

import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Input,
} from '@exocortex/ui';

import { useCreateWorkspace, useWorkspaces } from '@/lib/api/workspace-queries';

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
    <>
      {/*
      Controlled, so selecting a workspace can close the menu itself.
    */}
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="sm"
              // The one element of the topbar that gives way: on a phone it is
              // what the icons to its right take their room from, and its name
              // is the only thing there that can be shortened and still be
              // understood (issue #100).
              className="min-w-0 max-w-52 shrink justify-between gap-1"
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
          <DropdownMenuItem onClick={() => setCreating(true)} data-testid="workspace-create">
            <PlusIcon /> Neuer Arbeitsbereich
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/*
      The name is typed in a dialog and not inside the menu: an open Base UI
      menu consumes every character key for its typeahead navigation, so an
      input rendered in the popup never receives a single keystroke.
    */}
      <Dialog
        open={creating}
        onOpenChange={(next: boolean) => {
          setCreating(next);
          if (!next) setName('');
        }}
      >
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Neuer Arbeitsbereich</DialogTitle>
          </DialogHeader>
          <label htmlFor="workspace-create-name" className="sr-only">
            Name des Arbeitsbereichs
          </label>
          <Input
            id="workspace-create-name"
            autoFocus
            value={name}
            placeholder="Name des Arbeitsbereichs"
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return;
              event.preventDefault();
              void create();
            }}
            data-testid="workspace-name-input"
          />
          <DialogFooter>
            <Button variant="ghost" onClick={() => setCreating(false)}>
              Abbrechen
            </Button>
            <Button
              onClick={() => void create()}
              disabled={name.trim().length === 0 || createWorkspace.isPending}
              data-testid="workspace-create-submit"
            >
              Anlegen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
