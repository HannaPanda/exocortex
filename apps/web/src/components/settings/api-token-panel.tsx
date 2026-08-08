'use client';

import { CopyIcon } from 'lucide-react';
import * as React from 'react';

import { type ApiToken, type CreateApiTokenResponse } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
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
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import { useApiTokens, useCreateApiToken, useRevokeApiToken } from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', { dateStyle: 'medium', timeStyle: 'short' });

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 Tage' },
  { value: '90', label: '90 Tage' },
  { value: '365', label: '1 Jahr' },
  { value: 'never', label: 'Unbegrenzt' },
] as const;

type ExpiryOption = (typeof EXPIRY_OPTIONS)[number]['value'];

/**
 * Personal API tokens. Not admin-gated: every signed-in user manages their own
 * (the API only ever returns the caller's own tokens, one per row).
 */
export function ApiTokenPanel() {
  const tokensQuery = useApiTokens();
  const createToken = useCreateApiToken();
  const revokeToken = useRevokeApiToken();

  const [name, setName] = React.useState('');
  const [expiry, setExpiry] = React.useState<ExpiryOption>('90');
  const [revealedToken, setRevealedToken] = React.useState<CreateApiTokenResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiToken | null>(null);
  const [copied, setCopied] = React.useState(false);

  const createErrorCode = createToken.error instanceof ApiError ? createToken.error.code : undefined;
  const revokeErrorCode = revokeToken.error instanceof ApiError ? revokeToken.error.code : undefined;

  function handleCreate(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    createToken.mutate(
      { name: trimmed, expiresInDays: expiry === 'never' ? null : Number(expiry) },
      {
        onSuccess: (response) => {
          setRevealedToken(response);
          setCopied(false);
          setName('');
          setExpiry('90');
        },
      },
    );
  }

  function closeRevealDialog(): void {
    setRevealedToken(null);
    setCopied(false);
  }

  async function handleCopy(secret: string): Promise<void> {
    await navigator.clipboard.writeText(secret);
    setCopied(true);
  }

  return (
    <AppPage maxWidth="max-w-3xl" className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">API-Token</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          API-Token erlauben externen Programmen wie dem MCP-Server, in deinem Namen auf
          Exocortex zuzugreifen. Ein Token hat genau deine Rechte.
        </p>
      </div>

      {revokeToken.isError ? (
        <Alert variant="destructive">
          <AlertDescription>{messageForCode(revokeErrorCode)}</AlertDescription>
        </Alert>
      ) : null}

      {tokensQuery.isPending ? (
        <LoadingState label="Token werden geladen …" variant="skeleton" rows={3} />
      ) : tokensQuery.isError ? (
        <ErrorState
          title="Token konnten nicht geladen werden"
          onRetry={() => void tokensQuery.refetch()}
        />
      ) : (
        <Table>
          <TableCaption className="sr-only">Liste deiner API-Token</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Präfix</TableHead>
              <TableHead>Zuletzt benutzt</TableHead>
              <TableHead>Läuft ab</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Aktionen</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {tokensQuery.data.map((token) => {
              const revoked = token.revokedAt !== null;
              return (
                <TableRow key={token.id}>
                  <TableCell>{token.name}</TableCell>
                  <TableCell className="font-mono text-xs">{token.prefix}</TableCell>
                  <TableCell>
                    {token.lastUsedAt !== null
                      ? dateTimeFormat.format(new Date(token.lastUsedAt))
                      : '–'}
                  </TableCell>
                  <TableCell>
                    {token.expiresAt !== null
                      ? dateTimeFormat.format(new Date(token.expiresAt))
                      : '–'}
                  </TableCell>
                  <TableCell>
                    <Badge variant={revoked ? 'muted' : 'default'}>
                      {revoked ? 'Widerrufen' : 'Aktiv'}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoked}
                      onClick={() => setRevokeTarget(token)}
                    >
                      Widerrufen
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <div className="flex flex-col gap-3 rounded-lg border border-border p-4">
        <h2 className="text-sm font-semibold">Neues Token</h2>
        {createToken.isError ? (
          <Alert variant="destructive">
            <AlertDescription>{messageForCode(createErrorCode)}</AlertDescription>
          </Alert>
        ) : null}
        <form className="flex flex-wrap items-end gap-3" onSubmit={handleCreate}>
          <div className="flex min-w-48 flex-1 flex-col gap-1.5">
            <Label htmlFor="token-name">Name</Label>
            <Input
              id="token-name"
              value={name}
              placeholder="z. B. MCP-Server"
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="token-expiry">Gültigkeit</Label>
            <Select value={expiry} onValueChange={(next) => setExpiry(next as ExpiryOption)}>
              <SelectTrigger id="token-expiry" className="w-40">
                {/* Base UI shows the raw value without a render function. */}
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
          <Button type="submit" disabled={name.trim().length === 0 || createToken.isPending}>
            Erstellen
          </Button>
        </form>
      </div>

      {/*
        Secret reveal: `onOpenChange` deliberately ignores Escape/backdrop-close
        signals from the primitive, so the only way out is the explicit button
        below. The secret is never shown again after this dialog closes.
      */}
      <Dialog open={revealedToken !== null} onOpenChange={() => {}}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>Token erstellt</DialogTitle>
            <DialogDescription>
              Kopiere das Token jetzt. Aus Sicherheitsgründen wird es danach nicht mehr angezeigt.
            </DialogDescription>
          </DialogHeader>
          {revealedToken !== null ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-md border border-border bg-muted p-3 font-mono text-sm select-all">
                {revealedToken.secret}
              </div>
              <Button variant="outline" onClick={() => void handleCopy(revealedToken.secret)}>
                <CopyIcon /> {copied ? 'Kopiert' : 'Kopieren'}
              </Button>
              <p className="text-sm text-destructive-text">
                Dieses Token wird nie wieder angezeigt. Bewahre es an einem sicheren Ort auf.
              </p>
            </div>
          ) : null}
          <DialogFooter>
            <Button onClick={closeRevealDialog}>Verstanden, schließen</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Token widerrufen?</DialogTitle>
            <DialogDescription>
              {revokeTarget !== null
                ? `„${revokeTarget.name}“ kann danach nicht mehr verwendet werden. Das lässt sich nicht rückgängig machen.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              Abbrechen
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (revokeTarget === null) return;
                revokeToken.mutate(revokeTarget.id, { onSuccess: () => setRevokeTarget(null) });
              }}
            >
              Widerrufen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppPage>
  );
}
