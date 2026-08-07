'use client';

import { useRouter } from 'next/navigation';
import * as React from 'react';

import { Alert, AlertDescription, AppPage, Button, Input, Label, LoadingState } from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useUpdateWorkspace, useWorkspaceDetail } from '@/lib/api/queries';

const WORKSPACE_ADMIN_ROLES = new Set(['OWNER', 'ADMIN']);

/**
 * Workspace settings: rename and, separately, change the slug.
 *
 * The two fields are deliberately independent, each with its own draft state
 * and its own save button: renaming never touches the slug (`findFreeSlug()`
 * only runs once, at creation), and the slug carries its own warning because
 * it is the one thing already-shared links depend on.
 */
export function WorkspaceSettings({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const detail = useWorkspaceDetail(workspaceId);
  const updateWorkspace = useUpdateWorkspace();

  const [name, setName] = React.useState<string | null>(null);
  const [slug, setSlug] = React.useState<string | null>(null);
  const [slugConfirming, setSlugConfirming] = React.useState(false);
  const [nameSaved, setNameSaved] = React.useState(false);
  const [slugSaved, setSlugSaved] = React.useState(false);

  // Initialise the drafts once the query resolves (see SettingsForm for why
  // this runs during render rather than in an effect).
  if (name === null && detail.data !== undefined) setName(detail.data.name);
  if (slug === null && detail.data !== undefined) setSlug(detail.data.slug);

  if (detail.isPending || detail.data === undefined || name === null || slug === null) {
    return <LoadingState label="Arbeitsbereich wird geladen …" />;
  }

  const original = detail.data;
  const canEdit = WORKSPACE_ADMIN_ROLES.has(original.role);
  const nameDirty = name.trim().length > 0 && name.trim() !== original.name;
  const slugDirty = slug.trim().length > 0 && slug.trim() !== original.slug;

  const errorCode = updateWorkspace.error instanceof ApiError ? updateWorkspace.error.code : undefined;

  const saveName = (): void => {
    if (!nameDirty) return;
    updateWorkspace.mutate(
      { workspaceId, request: { name: name.trim() } },
      { onSuccess: () => setNameSaved(true) },
    );
    setSlugSaved(false);
  };

  const saveSlug = (): void => {
    if (!slugDirty) return;
    updateWorkspace.mutate(
      { workspaceId, request: { slug: slug.trim() } },
      {
        onSuccess: () => {
          setSlugSaved(true);
          setSlugConfirming(false);
          // The slug can be part of the current URL in a future route; there is
          // none today, but refreshing keeps this page consistent either way.
          router.refresh();
        },
      },
    );
    setNameSaved(false);
  };

  return (
    <AppPage maxWidth="max-w-2xl">
      <h1 className="text-lg font-semibold">Arbeitsbereich-Einstellungen</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        {original.name} · {original.memberCount} {original.memberCount === 1 ? 'Mitglied' : 'Mitglieder'}
      </p>

      {!canEdit ? (
        <Alert className="mt-6" data-testid="workspace-settings-readonly">
          <AlertDescription>
            Nur Besitzer und Administratoren dieses Arbeitsbereichs können ihn umbenennen oder den
            Slug ändern.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="mt-6 flex flex-col gap-8">
          {updateWorkspace.isError ? (
            <Alert variant="destructive" data-testid="workspace-settings-error">
              <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
            </Alert>
          ) : null}

          <section className="flex flex-col gap-2">
            <Label htmlFor="workspace-name">Name</Label>
            <div className="flex max-w-md gap-2">
              <Input
                id="workspace-name"
                data-testid="workspace-name-input"
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setNameSaved(false);
                }}
              />
              <Button
                onClick={saveName}
                disabled={!nameDirty || updateWorkspace.isPending}
                data-testid="save-workspace-name"
              >
                Speichern
              </Button>
            </div>
            {nameSaved ? (
              <p className="text-xs text-success" data-testid="workspace-name-saved">
                Name gespeichert.
              </p>
            ) : null}
          </section>

          <section className="flex flex-col gap-2 border-t border-border pt-6">
            <Label htmlFor="workspace-slug">Slug</Label>
            <p className="text-xs text-muted-foreground">
              Der Slug steckt in Links, die bereits verschickt oder gespeichert wurden. Anders als der
              Name wandert er nicht automatisch mit &ndash; und eine Änderung bricht diese Links.
            </p>
            <div className="flex max-w-md gap-2">
              <Input
                id="workspace-slug"
                data-testid="workspace-slug-input"
                value={slug}
                onChange={(event) => {
                  setSlug(event.target.value);
                  setSlugSaved(false);
                  setSlugConfirming(false);
                }}
              />
              {slugDirty && !slugConfirming ? (
                <Button
                  variant="outline"
                  onClick={() => setSlugConfirming(true)}
                  data-testid="confirm-workspace-slug-change"
                >
                  Trotzdem ändern
                </Button>
              ) : (
                <Button
                  onClick={saveSlug}
                  disabled={!slugDirty || !slugConfirming || updateWorkspace.isPending}
                  data-testid="save-workspace-slug"
                >
                  Speichern
                </Button>
              )}
            </div>
            {slugSaved ? (
              <p className="text-xs text-success" data-testid="workspace-slug-saved">
                Slug gespeichert.
              </p>
            ) : null}
          </section>
        </div>
      )}
    </AppPage>
  );
}
