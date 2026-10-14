'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  type CreateExternalMcpServerRequest,
  createExternalMcpServerRequestSchema,
  type ExternalMcpAuthKind,
  type ExternalMcpServer,
  type UpdateExternalMcpServerRequest,
  updateExternalMcpServerRequestSchema,
} from '@exocortex/contracts';
import {
  Button,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@exocortex/ui';

const AUTH_KINDS: readonly ExternalMcpAuthKind[] = ['none', 'bearer', 'header'];

interface Draft {
  key: string;
  name: string;
  url: string;
  authKind: ExternalMcpAuthKind;
  authHeaderName: string;
  secret: string;
}

function draftOf(server: ExternalMcpServer | null): Draft {
  return {
    key: server?.key ?? '',
    name: server?.name ?? '',
    url: server?.url ?? 'https://',
    authKind: server?.authKind ?? 'none',
    authHeaderName: server?.authHeaderName ?? '',
    secret: '',
  };
}

/** What a new server is created from, or the field the contract refuses first. */
function createRequestOf(
  draft: Draft,
): { request: CreateExternalMcpServerRequest } | { field: string } {
  const parsed = createExternalMcpServerRequestSchema.safeParse({
    key: draft.key.trim(),
    name: draft.name,
    url: draft.url,
    authKind: draft.authKind,
    authHeaderName: draft.authKind === 'header' ? draft.authHeaderName : null,
    secret: draft.authKind === 'none' || draft.secret.trim() === '' ? undefined : draft.secret,
  });
  if (parsed.success) return { request: parsed.data };
  return { field: String(parsed.error.issues[0]?.path[0] ?? 'url') };
}

/**
 * Only what changed. An empty secret field keeps the stored secret; choosing
 * no authentication removes it, and a kind that needs one while none is
 * stored refuses to save without it.
 */
function updateRequestOf(
  draft: Draft,
  server: ExternalMcpServer,
): { request: UpdateExternalMcpServerRequest | null } | { field: string } {
  const request: UpdateExternalMcpServerRequest = {};
  if (draft.name.trim() !== server.name) request.name = draft.name;
  if (draft.url.trim() !== server.url) request.url = draft.url;
  if (draft.authKind !== server.authKind) request.authKind = draft.authKind;
  const headerName = draft.authKind === 'header' ? draft.authHeaderName.trim() : null;
  if (headerName !== server.authHeaderName) request.authHeaderName = headerName;
  if (draft.authKind === 'none') {
    if (server.secretConfigured) request.secret = null;
  } else if (draft.secret.trim() !== '') {
    request.secret = draft.secret;
  } else if (!server.secretConfigured) {
    return { field: 'secret' };
  }
  if (Object.keys(request).length === 0) return { request: null };
  const parsed = updateExternalMcpServerRequestSchema.safeParse(request);
  if (parsed.success) return { request: parsed.data };
  return { field: String(parsed.error.issues[0]?.path[0] ?? 'url') };
}

/**
 * Connecting a server, or changing one, in place rather than in a dialog
 * (DESIGN.md: inline before modal). The key is asked for once and then shown
 * as fixed, because every tool name the model sees is built from it.
 *
 * The secret field never shows the stored value; on a change it says that
 * leaving it empty keeps what is there.
 */
export function ExternalMcpServerForm({
  server,
  credentialsAvailable,
  pending,
  onCreate,
  onUpdate,
  onCancel,
}: {
  /** `null` connects a new server. */
  server: ExternalMcpServer | null;
  credentialsAvailable: boolean;
  pending: boolean;
  onCreate: (request: CreateExternalMcpServerRequest) => void;
  onUpdate: (request: UpdateExternalMcpServerRequest) => void;
  onCancel: () => void;
}) {
  const t = useTranslations('settings.externalMcp.form');
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(server));
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const idPrefix = `mcp-form-${server?.id ?? 'new'}`;

  const set = <K extends keyof Draft>(field: K, value: Draft[K]): void => {
    setDraft((previous) => ({ ...previous, [field]: value }));
    setInvalid(null);
  };

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    if (server === null) {
      const result = createRequestOf(draft);
      if ('field' in result) setInvalid(result.field);
      else onCreate(result.request);
      return;
    }
    const result = updateRequestOf(draft, server);
    if ('field' in result) setInvalid(result.field);
    else if (result.request === null) onCancel();
    else onUpdate(result.request);
  };

  const fieldError = (field: string) =>
    invalid === field ? (
      <p
        id={`${idPrefix}-${field}-error`}
        className="text-xs text-destructive-text"
        data-testid="mcp-form-error"
      >
        {t(`invalid.${field as 'key'}`)}
      </p>
    ) : null;
  const describedBy = (field: string) =>
    invalid === field ? `${idPrefix}-${field}-error` : undefined;

  return (
    <form
      onSubmit={submit}
      className="flex max-w-xl flex-col gap-4"
      data-testid="mcp-server-form"
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-[1fr_10rem]">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-name`}>{t('name')}</Label>
          <Input
            id={`${idPrefix}-name`}
            data-testid="mcp-form-name"
            value={draft.name}
            placeholder={t('namePlaceholder')}
            aria-invalid={invalid === 'name'}
            aria-describedby={describedBy('name')}
            onChange={(event) => set('name', event.target.value)}
          />
          {fieldError('name')}
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-key`}>{t('key')}</Label>
          <Input
            id={`${idPrefix}-key`}
            data-testid="mcp-form-key"
            className="font-mono"
            value={draft.key}
            placeholder="health"
            disabled={server !== null}
            autoCapitalize="off"
            spellCheck={false}
            aria-invalid={invalid === 'key'}
            aria-describedby={describedBy('key') ?? `${idPrefix}-key-hint`}
            onChange={(event) => set('key', event.target.value.toLowerCase())}
          />
          {fieldError('key')}
        </div>
      </div>
      <p id={`${idPrefix}-key-hint`} className="-mt-2 text-xs text-muted-foreground">
        {server === null
          ? t('keyHint', {
              name: `mcp_${draft.key.trim() === '' ? 'kuerzel' : draft.key.trim()}__…`,
            })
          : t('keyFixed')}
      </p>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-url`}>{t('url')}</Label>
        <Input
          id={`${idPrefix}-url`}
          data-testid="mcp-form-url"
          type="url"
          className="font-mono"
          value={draft.url}
          spellCheck={false}
          aria-invalid={invalid === 'url'}
          aria-describedby={describedBy('url') ?? `${idPrefix}-url-hint`}
          onChange={(event) => set('url', event.target.value)}
        />
        {fieldError('url')}
        <p id={`${idPrefix}-url-hint`} className="text-xs text-muted-foreground">
          {server !== null && server.tools.some((tool) => tool.access !== 'blocked')
            ? t('urlHintBlocks')
            : t('urlHint')}
        </p>
      </div>

      <AuthFields
        idPrefix={idPrefix}
        draft={draft}
        server={server}
        credentialsAvailable={credentialsAvailable}
        invalid={invalid}
        fieldError={fieldError}
        describedBy={describedBy}
        set={set}
      />

      <div className="flex gap-2">
        <Button type="submit" disabled={pending} data-testid="mcp-form-submit">
          {server === null ? t('create') : t('save')}
        </Button>
        <Button type="button" variant="ghost" onClick={onCancel}>
          {t('cancel')}
        </Button>
      </div>
    </form>
  );
}

function AuthFields({
  idPrefix,
  draft,
  server,
  credentialsAvailable,
  invalid,
  fieldError,
  describedBy,
  set,
}: {
  idPrefix: string;
  draft: Draft;
  server: ExternalMcpServer | null;
  credentialsAvailable: boolean;
  invalid: string | null;
  fieldError: (field: string) => React.ReactNode;
  describedBy: (field: string) => string | undefined;
  set: <K extends keyof Draft>(field: K, value: Draft[K]) => void;
}) {
  const t = useTranslations('settings.externalMcp.form');
  const tAuth = useTranslations('settings.externalMcp.auth');
  // Without the encryption key nothing secret can be stored, so the only
  // honest choice left is a server that needs none.
  const kinds = credentialsAvailable ? AUTH_KINDS : (['none'] as const);
  const keepsSecret = server?.secretConfigured === true && server.authKind !== 'none';

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <Label id={`${idPrefix}-auth-label`}>{t('auth')}</Label>
        <Select
          value={draft.authKind}
          onValueChange={(next) => set('authKind', next as ExternalMcpAuthKind)}
        >
          <SelectTrigger
            aria-labelledby={`${idPrefix}-auth-label`}
            className="w-full sm:w-64"
            data-testid="mcp-form-auth"
          >
            <SelectValue>{() => tAuth(draft.authKind)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {kinds.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {tAuth(kind)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {credentialsAvailable ? null : (
          <p className="text-xs text-muted-foreground">{t('noCredentials')}</p>
        )}
      </div>

      {draft.authKind === 'header' ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-header`}>{t('headerName')}</Label>
          <Input
            id={`${idPrefix}-header`}
            data-testid="mcp-form-header"
            className="font-mono sm:w-64"
            value={draft.authHeaderName}
            placeholder="X-API-Key"
            spellCheck={false}
            aria-invalid={invalid === 'authHeaderName'}
            aria-describedby={describedBy('authHeaderName')}
            onChange={(event) => set('authHeaderName', event.target.value)}
          />
          {fieldError('authHeaderName')}
        </div>
      ) : null}

      {draft.authKind === 'none' ? null : (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-secret`}>
            {draft.authKind === 'bearer' ? t('token') : t('headerValue')}
          </Label>
          <Input
            id={`${idPrefix}-secret`}
            data-testid="mcp-form-secret"
            type="password"
            autoComplete="off"
            value={draft.secret}
            placeholder={
              keepsSecret ? t('secretKeep', { hint: (server?.secretHint ?? '') || '…' }) : ''
            }
            aria-invalid={invalid === 'secret'}
            aria-describedby={describedBy('secret') ?? `${idPrefix}-secret-hint`}
            onChange={(event) => set('secret', event.target.value)}
          />
          {fieldError('secret')}
          <p id={`${idPrefix}-secret-hint`} className="text-xs text-muted-foreground">
            {t('secretHint')}
          </p>
        </div>
      )}
    </div>
  );
}
