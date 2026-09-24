'use client';

import { CopyIcon } from 'lucide-react';
import * as React from 'react';

import {
  type ApiToken,
  type ApiTokenPageScopeInput,
  type CreateApiTokenResponse,
  type DocumentTreeNode,
} from '@exocortex/contracts';
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
import { useDocumentTree } from '@/lib/api/document-queries';
import { messageForCode } from '@/lib/api/error-messages';
import { useWorkspaces } from '@/lib/api/workspace-queries';
import { connectionSnippets } from '@/lib/connection-snippets';

import { CopyBlock } from './copy-block';

const dateTimeFormat = new Intl.DateTimeFormat('de-DE', {
  dateStyle: 'medium',
  timeStyle: 'short',
});

const EXPIRY_OPTIONS = [
  { value: '30', label: '30 Tage' },
  { value: '90', label: '90 Tage' },
  { value: '365', label: '1 Jahr' },
  { value: 'never', label: 'Unbegrenzt' },
] as const;

type ExpiryOption = (typeof EXPIRY_OPTIONS)[number]['value'];

/**
 * Scopes are cumulative, so one choice is enough: sending the highest scope also
 * grants everything below it. Offering three checkboxes would only let someone
 * tick "admin" without "read" and wonder why nothing works.
 */
const SCOPE_OPTIONS = [
  { value: 'read', label: 'Nur lesen', hint: 'Seiten und Datenbanken lesen, nichts ändern.' },
  {
    value: 'write',
    label: 'Lesen und schreiben',
    hint: 'Zusätzlich Inhalte anlegen, ändern und löschen.',
  },
  {
    value: 'admin',
    label: 'Voller Zugriff',
    hint: 'Zusätzlich Administration und Token-Verwaltung.',
  },
] as const;

type ScopeOption = (typeof SCOPE_OPTIONS)[number]['value'];

const SCOPE_LABELS: Record<string, string> = {
  read: 'Lesen',
  write: 'Schreiben',
  admin: 'Administration',
};

/** The "no page limit" choice, which is what a token has had until issue #83. */
const NO_SCOPE = '__all__';

/** The tree as a flat list with its nesting kept as an indent. */
function flattenTree(
  nodes: readonly DocumentTreeNode[],
  depth = 0,
): { id: string; title: string; depth: number }[] {
  const result: { id: string; title: string; depth: number }[] = [];
  for (const node of nodes) {
    result.push({ id: node.id, title: node.title, depth });
    result.push(...flattenTree(node.children, depth + 1));
  }
  return result;
}

interface ApiTokenPanelProps {
  /**
   * Called with the raw secret the moment a token is created, so the setup
   * section below can put it into its commands. The page drops it again on
   * reload; nothing here stores it.
   */
  onTokenCreated?: (secret: string) => void;
}

/**
 * Personal API tokens. Not admin-gated: every signed-in user manages their own
 * (the API only ever returns the caller's own tokens, one per row).
 */
export function ApiTokenPanel({ onTokenCreated }: ApiTokenPanelProps = {}) {
  const tokensQuery = useApiTokens();
  const createToken = useCreateApiToken();
  const revokeToken = useRevokeApiToken();

  const [name, setName] = React.useState('');
  const [expiry, setExpiry] = React.useState<ExpiryOption>('90');
  const [scope, setScope] = React.useState<ScopeOption>('read');
  /*
   * Page scopes (issue #83, ADR-044). Empty means the token is as broad as the
   * account, which is what every token was before this existed; naming one
   * page makes everything else unreachable, including search, references and
   * every workspace-wide listing.
   */
  const [scopeWorkspaceId, setScopeWorkspaceId] = React.useState<string>(NO_SCOPE);
  const [pageScopes, setPageScopes] = React.useState<ApiTokenPageScopeInput[]>([]);
  const workspaces = useWorkspaces();
  const scopeTree = useDocumentTree(scopeWorkspaceId === NO_SCOPE ? undefined : scopeWorkspaceId);
  const scopeCandidates = React.useMemo(
    () => flattenTree(scopeTree.data?.nodes ?? []),
    [scopeTree.data],
  );
  const [revealedToken, setRevealedToken] = React.useState<CreateApiTokenResponse | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ApiToken | null>(null);
  const [copied, setCopied] = React.useState(false);

  const createErrorCode =
    createToken.error instanceof ApiError ? createToken.error.code : undefined;
  const revokeErrorCode =
    revokeToken.error instanceof ApiError ? revokeToken.error.code : undefined;

  function handleCreate(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed.length === 0) return;
    createToken.mutate(
      {
        name: trimmed,
        scopes: [scope],
        pageScopes,
        expiresInDays: expiry === 'never' ? null : Number(expiry),
      },
      {
        onSuccess: (response) => {
          setRevealedToken(response);
          setCopied(false);
          setName('');
          setExpiry('90');
          setScope('read');
          setPageScopes([]);
          setScopeWorkspaceId(NO_SCOPE);
          onTokenCreated?.(response.secret);
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
    <section className="flex flex-col gap-3" aria-labelledby="api-tokens-heading">
      <div>
        <h2 id="api-tokens-heading" className="text-sm font-semibold">
          Token
        </h2>
        <p className="mt-1 max-w-measure text-sm text-muted-foreground">
          API-Token erlauben externen Programmen wie dem MCP-Server, in deinem Namen auf eXocortex
          zuzugreifen. Gib jedem Token nur die Rechte, die es wirklich braucht: Wenn es
          abhandenkommt, kann jemand genau das damit tun.
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
        <Table narrow="list">
          <TableCaption className="sr-only">Liste deiner API-Token</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Präfix</TableHead>
              <TableHead>Rechte</TableHead>
              <TableHead>Seiten</TableHead>
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
                  <TableCell cell="title">{token.name}</TableCell>
                  <TableCell label="Präfix" className="font-mono text-xs">
                    {token.prefix}
                  </TableCell>
                  <TableCell label="Rechte">
                    {token.scopes.length > 0 ? (
                      <span className="flex flex-wrap gap-1">
                        {token.scopes.map((granted) => (
                          <Badge key={granted} variant="muted">
                            {SCOPE_LABELS[granted] ?? granted}
                          </Badge>
                        ))}
                      </span>
                    ) : (
                      // Issued before scopes existed. The API refuses it, so say so
                      // instead of showing an empty cell that looks like a glitch.
                      <Badge variant="destructive">Keine</Badge>
                    )}
                  </TableCell>
                  <TableCell label="Seiten" className="text-xs">
                    {token.pageScopes.length === 0 ? (
                      <span className="text-muted-foreground">alle</span>
                    ) : (
                      <span className="flex flex-col gap-0.5">
                        {token.pageScopes.map((entry) => (
                          <span key={entry.documentId}>
                            {entry.documentTitle}
                            {entry.scope === 'SUBTREE' ? ' + Unterseiten' : ''}
                          </span>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell label="Zuletzt benutzt">
                    {token.lastUsedAt !== null
                      ? dateTimeFormat.format(new Date(token.lastUsedAt))
                      : '–'}
                  </TableCell>
                  <TableCell label="Läuft ab">
                    {token.expiresAt !== null
                      ? dateTimeFormat.format(new Date(token.expiresAt))
                      : '–'}
                  </TableCell>
                  <TableCell label="Status">
                    <Badge variant={revoked ? 'muted' : 'default'}>
                      {revoked ? 'Zurückgezogen' : 'Aktiv'}
                    </Badge>
                  </TableCell>
                  <TableCell cell="actions" className="text-right">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={revoked}
                      onClick={() => setRevokeTarget(token)}
                    >
                      Zurückziehen
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
            <Label htmlFor="token-scope">Rechte</Label>
            <Select value={scope} onValueChange={(next) => setScope(next as ScopeOption)}>
              <SelectTrigger id="token-scope" className="w-56">
                <SelectValue>
                  {() => SCOPE_OPTIONS.find((option) => option.value === scope)?.label ?? scope}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {SCOPE_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
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
            Anlegen
          </Button>
        </form>
        <p className="text-xs text-muted-foreground">
          {SCOPE_OPTIONS.find((option) => option.value === scope)?.hint}
        </p>

        <TokenPageScopePicker
          workspaceId={scopeWorkspaceId}
          onWorkspaceChange={setScopeWorkspaceId}
          workspaces={workspaces.data ?? []}
          candidates={scopeCandidates}
          value={pageScopes}
          onChange={setPageScopes}
        />
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
              {/*
                The finished command, not just the secret: this dialog is the
                one moment the token exists in the browser, so what a person
                actually needs has to be copyable right here. The other clients
                stay available in the setup section for as long as the page
                lives.
              */}
              <div className="flex flex-col gap-1.5">
                <p className="text-sm font-medium">Direkt in Claude Code einrichten</p>
                <CopyBlock
                  value={claudeCodeCommand(revealedToken.secret)}
                  label="Befehl für Claude Code kopieren"
                />
                <p className="text-xs text-muted-foreground">
                  Befehle für ChatGPT und Hermes stehen unter „Einrichten“, mit diesem Token bereits
                  eingesetzt.
                </p>
              </div>
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
            <DialogTitle>Token zurückziehen?</DialogTitle>
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
              Zurückziehen
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

/**
 * The one-liner for the client most people arrive from. Built from the same
 * catalogue the setup cards use, so the two can never drift apart, and from
 * `window.location.origin` so a self-hosted deployment names itself.
 */
function claudeCodeCommand(secret: string): string {
  const origin = typeof window === 'undefined' ? 'https://exocortex.app' : window.location.origin;
  const snippet = connectionSnippets(origin, secret).find((entry) => entry.id === 'claude-code');
  return snippet?.code ?? '';
}

/**
 * Confining a token to pages (issue #83, ADR-044).
 *
 * Its own component because the panel it came out of had grown past what the
 * size rule allows, and because this is a self-contained decision: a workspace,
 * a handful of pages, and how far each one reaches. It holds no state of its
 * own -- the token form owns the draft, so cancelling the form cancels this.
 */
function TokenPageScopePicker({
  workspaceId,
  onWorkspaceChange,
  workspaces,
  candidates,
  value,
  onChange,
}: {
  workspaceId: string;
  onWorkspaceChange: (next: string) => void;
  workspaces: readonly { id: string; name: string }[];
  candidates: readonly { id: string; title: string; depth: number }[];
  value: readonly ApiTokenPageScopeInput[];
  onChange: (next: ApiTokenPageScopeInput[]) => void;
}) {
  return (
    <div className="flex flex-col gap-2 border-t border-border pt-3">
      <Label htmlFor="token-scope-workspace">Auf Seiten beschränken (optional)</Label>
      <p className="text-xs text-muted-foreground">
        Ohne Angabe kommt das Token überall hin, wo du hinkommst. Nennst du eine Seite, erreicht es
        nur noch sie: nicht über die Suche, nicht über Verweise, nicht über Listen, und der ganze
        Rest ist für dieses Token nicht einmal vorhanden.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Select value={workspaceId} onValueChange={(next) => onWorkspaceChange(next ?? NO_SCOPE)}>
          <SelectTrigger id="token-scope-workspace" className="w-56">
            <SelectValue>
              {() =>
                workspaceId === NO_SCOPE
                  ? 'Keine Beschränkung'
                  : (workspaces.find((entry) => entry.id === workspaceId)?.name ?? workspaceId)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_SCOPE}>Keine Beschränkung</SelectItem>
            {workspaces.map((workspace) => (
              <SelectItem key={workspace.id} value={workspace.id}>
                {workspace.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        {workspaceId === NO_SCOPE ? null : (
          <Select
            value=""
            onValueChange={(documentId) => {
              if (documentId === null || documentId.length === 0) return;
              if (value.some((entry) => entry.documentId === documentId)) return;
              onChange([...value, { documentId, scope: 'SUBTREE' }]);
            }}
          >
            <SelectTrigger aria-label="Seite hinzufügen" className="w-72">
              <SelectValue>{() => 'Seite hinzufügen …'}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {candidates.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {`${'\u00a0\u00a0'.repeat(entry.depth)}${entry.title}`}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      {value.length === 0 ? null : (
        <ul className="flex flex-col gap-1" data-testid="token-page-scopes">
          {value.map((entry) => (
            <li
              key={entry.documentId}
              className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1 text-sm"
            >
              <span className="min-w-0 flex-1 truncate">
                {candidates.find((candidate) => candidate.id === entry.documentId)?.title ??
                  entry.documentId}
              </span>
              <Select
                value={entry.scope}
                onValueChange={(next) =>
                  onChange(
                    value.map((item) =>
                      item.documentId === entry.documentId
                        ? { ...item, scope: (next ?? 'SUBTREE') as 'PAGE_ONLY' | 'SUBTREE' }
                        : item,
                    ),
                  )
                }
              >
                <SelectTrigger aria-label="Umfang" className="w-48">
                  <SelectValue>
                    {() => (entry.scope === 'SUBTREE' ? 'mit Unterseiten' : 'nur diese Seite')}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SUBTREE">mit Unterseiten</SelectItem>
                  <SelectItem value="PAGE_ONLY">nur diese Seite</SelectItem>
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() =>
                  onChange(value.filter((item) => item.documentId !== entry.documentId))
                }
              >
                Entfernen
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
