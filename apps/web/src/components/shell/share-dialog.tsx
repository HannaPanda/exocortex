'use client';

import { CopyIcon, GlobeIcon, LinkIcon, MailIcon, TriangleAlertIcon } from 'lucide-react';
import * as React from 'react';

import { type DocumentShare, type ShareScope } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  ErrorState,
  Input,
  Label,
  LoadingState,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useCreateShare,
  useDocumentShares,
  useRevokeShare,
  useUpdateShare,
} from '@/lib/api/share-queries';

/**
 * Handing a page to somebody who is not in this workspace (issue #83, ADR-044).
 *
 * The copy in here does a job the controls cannot: everything on this dialog
 * reaches outside, and the two mistakes it has to prevent are believing a
 * public link is somehow private, and not noticing that a page is already
 * readable because a section above it was shared. So the inherited grants sit
 * at the top, before anything can be clicked, and the link section says in
 * plain words what an address on the internet means.
 */

const SCOPE_LABELS: Record<ShareScope, string> = {
  PAGE_ONLY: 'Nur diese Seite',
  SUBTREE: 'Diese Seite und alles darunter',
};

const EXPIRY_OPTIONS = [
  { value: 'never', label: 'Unbefristet' },
  { value: '7', label: '7 Tage' },
  { value: '30', label: '30 Tage' },
  { value: '90', label: '90 Tage' },
] as const;

type ExpiryOption = (typeof EXPIRY_OPTIONS)[number]['value'];

function expiresInDays(value: ExpiryOption): number | null {
  return value === 'never' ? null : Number(value);
}

function shareUrlFor(token: string): string {
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/freigabe/${token}`;
}

export function ShareDialog({
  documentId,
  documentTitle,
  open,
  onOpenChange,
}: {
  documentId: string;
  documentTitle: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const shares = useDocumentShares(documentId, { enabled: open });
  const createShare = useCreateShare(documentId);
  const updateShare = useUpdateShare(documentId);
  const revokeShare = useRevokeShare(documentId);

  const [email, setEmail] = React.useState('');
  const [permission, setPermission] = React.useState<'READ' | 'WRITE'>('READ');
  const [scope, setScope] = React.useState<ShareScope>('PAGE_ONLY');
  const [expiry, setExpiry] = React.useState<ExpiryOption>('never');
  /** The one moment the raw address exists in the browser. Dropped on close. */
  const [freshLink, setFreshLink] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState(false);

  /*
   * Closing the dialog forgets the raw address. Done in the handler rather
   * than in an effect on `open`: the secret leaving the browser is a
   * consequence of the click, not a state two renders have to agree on.
   */
  const close = (next: boolean): void => {
    if (!next) {
      setFreshLink(null);
      setCopied(false);
      setEmail('');
    }
    onOpenChange(next);
  };

  const errorCode =
    createShare.error instanceof ApiError
      ? createShare.error.code
      : revokeShare.error instanceof ApiError
        ? revokeShare.error.code
        : undefined;

  const active = (shares.data?.shares ?? []).filter((share) => share.revokedAt === null);
  const inherited = shares.data?.inherited ?? [];

  function handleInvite(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = email.trim();
    if (trimmed.length === 0) return;
    createShare.mutate(
      {
        kind: 'USER',
        email: trimmed,
        permission,
        scope,
        expiresInDays: expiresInDays(expiry),
      },
      { onSuccess: () => setEmail('') },
    );
  }

  function handleCreateLink(): void {
    createShare.mutate(
      { kind: 'PUBLIC_LINK', permission: 'READ', scope, expiresInDays: expiresInDays(expiry) },
      {
        onSuccess: (response) => {
          if (response.share.token !== null) setFreshLink(shareUrlFor(response.share.token));
          setCopied(false);
        },
      },
    );
  }

  async function handleCopy(value: string): Promise<void> {
    await navigator.clipboard.writeText(value);
    setCopied(true);
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-xl" data-testid="share-dialog">
        <DialogHeader>
          <DialogTitle>„{documentTitle}“ teilen</DialogTitle>
          <DialogDescription>
            Teilen heißt: jemand außerhalb dieses Arbeitsbereichs kommt an diese Seite. Wer hier
            schon Mitglied ist, braucht keine Freigabe.
          </DialogDescription>
        </DialogHeader>

        {inherited.length > 0 ? (
          <Alert data-testid="share-inherited">
            <TriangleAlertIcon />
            <AlertDescription>
              Diese Seite ist bereits von weiter oben freigegeben: jemand hat einen Bereich darüber
              mitsamt allem darunter geteilt. Sie ist also schon von außen erreichbar, ohne dass
              hier etwas steht.
              <ul className="mt-2 list-disc pl-4">
                {inherited.map((share) => (
                  <li key={share.id}>{describe(share)}</li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {errorCode === undefined ? null : (
          <Alert variant="destructive">
            <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
          </Alert>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="share-scope">Umfang</Label>
          <div className="flex flex-wrap gap-2">
            <Select value={scope} onValueChange={(next) => setScope(next as ShareScope)}>
              <SelectTrigger id="share-scope" className="w-64">
                <SelectValue>{() => SCOPE_LABELS[scope]}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="PAGE_ONLY">{SCOPE_LABELS.PAGE_ONLY}</SelectItem>
                <SelectItem value="SUBTREE">{SCOPE_LABELS.SUBTREE}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={expiry} onValueChange={(next) => setExpiry(next as ExpiryOption)}>
              <SelectTrigger aria-label="Gültigkeit" className="w-40">
                <SelectValue>
                  {() => EXPIRY_OPTIONS.find((option) => option.value === expiry)?.label ?? expiry}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <form className="flex flex-wrap items-end gap-2" onSubmit={handleInvite}>
          <div className="flex min-w-56 flex-1 flex-col gap-1.5">
            <Label htmlFor="share-email">An ein Konto</Label>
            <Input
              id="share-email"
              type="email"
              value={email}
              placeholder="adresse@beispiel.de"
              data-testid="share-email"
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>
          <Select
            value={permission}
            onValueChange={(next) => setPermission(next as 'READ' | 'WRITE')}
          >
            <SelectTrigger aria-label="Recht" className="w-40">
              <SelectValue>{() => (permission === 'WRITE' ? 'Bearbeiten' : 'Lesen')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="READ">Lesen</SelectItem>
              <SelectItem value="WRITE">Bearbeiten</SelectItem>
            </SelectContent>
          </Select>
          <Button type="submit" disabled={email.trim().length === 0 || createShare.isPending}>
            <MailIcon /> Teilen
          </Button>
        </form>

        <div className="flex flex-col gap-2 rounded-lg border border-border p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-sm font-medium">Öffentlicher Link</p>
              <p className="text-xs text-muted-foreground">
                Wer die Adresse hat, liest die Seite: ohne Konto, ohne Anmeldung, auch wenn er sie
                weitergereicht bekommen hat. Schreiben kann über einen Link niemand.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              data-testid="share-create-link"
              disabled={createShare.isPending}
              onClick={handleCreateLink}
            >
              <LinkIcon /> Link erzeugen
            </Button>
          </div>
          {freshLink === null ? null : (
            <div className="flex flex-col gap-1.5" data-testid="share-fresh-link">
              <div className="rounded-md border border-border bg-muted p-2 font-mono text-xs select-all break-all">
                {freshLink}
              </div>
              <Button variant="outline" size="sm" onClick={() => void handleCopy(freshLink)}>
                <CopyIcon /> {copied ? 'Kopiert' : 'Adresse kopieren'}
              </Button>
              <p className="text-xs text-muted-foreground">
                Die Adresse steht nur jetzt hier. Danach zeigt die Liste unten nur noch ihre ersten
                Zeichen; brauchst du sie wieder, erzeuge einen neuen Link und zieh den alten zurück.
              </p>
            </div>
          )}
        </div>

        <section className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold">Aktuell freigegeben</h3>
          {shares.isPending ? (
            <LoadingState label="Freigaben werden geladen …" variant="skeleton" rows={2} />
          ) : shares.isError ? (
            <ErrorState
              title="Freigaben konnten nicht geladen werden"
              onRetry={() => void shares.refetch()}
            />
          ) : active.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Niemand außerhalb dieses Arbeitsbereichs kann diese Seite erreichen.
            </p>
          ) : (
            <ul className="flex flex-col gap-2" data-testid="share-list">
              {active.map((share) => (
                <li
                  key={share.id}
                  className="flex flex-wrap items-center gap-2 rounded-md border border-border px-3 py-2"
                  data-testid="share-row"
                >
                  {share.kind === 'PUBLIC_LINK' ? <GlobeIcon className="size-4" /> : null}
                  <span className="min-w-0 flex-1 truncate text-sm">{describe(share)}</span>
                  {share.kind === 'USER' ? (
                    <Select
                      value={share.permission}
                      onValueChange={(next) =>
                        updateShare.mutate({
                          shareId: share.id,
                          request: { permission: next as 'READ' | 'WRITE' },
                        })
                      }
                    >
                      <SelectTrigger aria-label="Recht ändern" className="w-32">
                        <SelectValue>
                          {() => (share.permission === 'WRITE' ? 'Bearbeiten' : 'Lesen')}
                        </SelectValue>
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="READ">Lesen</SelectItem>
                        <SelectItem value="WRITE">Bearbeiten</SelectItem>
                      </SelectContent>
                    </Select>
                  ) : (
                    <Badge variant="muted">Nur lesen</Badge>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    data-testid="share-revoke"
                    onClick={() => revokeShare.mutate(share.id)}
                  >
                    Zurückziehen
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <DialogFooter>
          <Button variant="outline" onClick={() => close(false)}>
            Schließen
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** One sentence per grant, in the words somebody would use about it. */
function describe(share: DocumentShare): string {
  const who =
    share.kind === 'PUBLIC_LINK'
      ? `Öffentlicher Link (…${share.tokenPrefix ?? ''})`
      : (share.grantee?.email ?? 'Unbekanntes Konto');
  const reach = share.scope === 'SUBTREE' ? ', mit allem darunter' : '';
  const right = share.permission === 'WRITE' ? 'darf bearbeiten' : 'darf lesen';
  const until =
    share.expiresAt === null
      ? ''
      : `, bis ${new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium' }).format(new Date(share.expiresAt))}`;
  return `${who} — ${right}${reach}${until}`;
}
