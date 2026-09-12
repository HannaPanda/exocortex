'use client';

import * as React from 'react';

import { type WorkspaceCredential } from '@exocortex/contracts';
import { Alert, AlertDescription, Badge, Button, Input, Label, LoadingState } from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useRemoveWorkspaceCredential,
  useSetWorkspaceCredential,
  useWorkspaceCredentials,
} from '@/lib/api/queries';

/**
 * This workspace's own provider key (issue #52, AP7, ADR-023).
 *
 * A form that can only ever write. The stored value never comes back, so there
 * is no field to prefill and no "show" button to offer: what the page can say
 * about a stored key is that it exists, what it ends in, and whether a run has
 * paid with it yet. Replacing means typing the new one; the old one is gone
 * either way.
 */
export function WorkspaceCredentialsForm({ workspaceId, isOwner }: WorkspaceCredentialsFormProps) {
  const query = useWorkspaceCredentials(workspaceId, isOwner);
  const store = useSetWorkspaceCredential(workspaceId);
  const remove = useRemoveWorkspaceCredential(workspaceId);

  const [secret, setSecret] = React.useState('');
  const [saved, setSaved] = React.useState(false);

  if (!isOwner) {
    return (
      <Alert data-testid="workspace-credentials-readonly">
        <AlertDescription>
          Einen eigenen Schlüssel hinterlegt die Besitzerin oder der Besitzer dieses
          Arbeitsbereichs. Wer hier arbeitet, merkt davon nichts außer der Rechnung.
        </AlertDescription>
      </Alert>
    );
  }

  if (query.isPending || query.data === undefined) {
    return <LoadingState label="Schlüssel wird geladen …" variant="skeleton" rows={2} />;
  }

  const openRouter: WorkspaceCredential | undefined = query.data.credentials.find(
    (entry) => entry.purpose === 'AI_OPENROUTER',
  );
  const errorCode =
    store.error instanceof ApiError
      ? store.error.code
      : remove.error instanceof ApiError
        ? remove.error.code
        : undefined;

  if (!query.data.available) {
    return (
      <Alert data-testid="workspace-credentials-unavailable">
        <AlertDescription>
          Diese Installation kann keine eigenen Schlüssel speichern: ihr fehlt der Schlüssel zum
          Verschlüsseln. Solange das so ist, laufen alle Anfragen über den Schlüssel der
          Installation.
        </AlertDescription>
      </Alert>
    );
  }

  const save = (): void => {
    const value = secret.trim();
    if (value.length < 20) return;
    store.mutate(
      { purpose: 'AI_OPENROUTER', request: { secret: value } },
      {
        onSuccess: () => {
          setSecret('');
          setSaved(true);
        },
      },
    );
  };

  return (
    <div className="flex flex-col gap-4" data-testid="workspace-credentials">
      {errorCode !== undefined ? (
        <Alert variant="destructive" data-testid="workspace-credentials-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      ) : null}

      <div className="flex items-center gap-2">
        {openRouter?.configured === true ? (
          <>
            <Badge variant="secondary" data-testid="workspace-credential-state">
              Eigener Schlüssel
            </Badge>
            <span className="text-xs text-muted-foreground">
              endet auf {openRouter.hint === '' ? 'unbekannt' : openRouter.hint}
              {openRouter.lastUsedAt === null
                ? ' · noch nicht benutzt'
                : ` · zuletzt benutzt am ${new Date(openRouter.lastUsedAt).toLocaleDateString('de-DE')}`}
            </span>
          </>
        ) : (
          <>
            <Badge variant="outline" data-testid="workspace-credential-state">
              Schlüssel der Installation
            </Badge>
            <span className="text-xs text-muted-foreground">
              KI-Läufe hier gehen auf die Rechnung der Installation.
            </span>
          </>
        )}
      </div>

      <div className="flex max-w-md gap-2">
        <div className="flex-1">
          <Label htmlFor="workspace-openrouter-key" className="sr-only">
            OpenRouter-Schlüssel
          </Label>
          <Input
            id="workspace-openrouter-key"
            data-testid="workspace-credential-input"
            type="password"
            autoComplete="off"
            placeholder={
              openRouter?.configured === true ? 'Neuen Schlüssel eingeben' : 'sk-or-v1-…'
            }
            value={secret}
            onChange={(event) => {
              setSecret(event.target.value);
              setSaved(false);
            }}
          />
        </div>
        <Button
          onClick={save}
          disabled={secret.trim().length < 20 || store.isPending}
          data-testid="save-workspace-credential"
        >
          {openRouter?.configured === true ? 'Ersetzen' : 'Speichern'}
        </Button>
      </div>

      {openRouter?.configured === true ? (
        <div>
          <Button
            variant="ghost"
            onClick={() => {
              setSaved(false);
              remove.mutate('AI_OPENROUTER');
            }}
            disabled={remove.isPending}
            data-testid="remove-workspace-credential"
          >
            Schlüssel entfernen
          </Button>
        </div>
      ) : null}

      {saved ? (
        <p className="text-xs text-success" data-testid="workspace-credential-saved">
          Gespeichert. Ab dem nächsten Lauf geht es über diesen Schlüssel.
        </p>
      ) : null}

      <p className="text-xs text-muted-foreground">
        Der Schlüssel wird verschlüsselt abgelegt und nie wieder angezeigt. Er bezahlt die KI-Läufe
        dieses Arbeitsbereichs. Die Suche bleibt beim Schlüssel der Installation, weil alle
        Einbettungen im selben Vektorraum liegen müssen.
      </p>
    </div>
  );
}

interface WorkspaceCredentialsFormProps {
  workspaceId: string;
  /** Reading and writing are the same bar here, so the caller passes one flag. */
  isOwner: boolean;
}
