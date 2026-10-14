'use client';

import {
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  LoaderCircleIcon,
  PlugIcon,
} from 'lucide-react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import * as React from 'react';

import { type ExternalMcpServer } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  cn,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  EmptyState,
  Label,
  LoadingState,
  Readout,
  SectionRule,
  Switch,
} from '@exocortex/ui';

import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import {
  useCheckExternalMcpServer,
  useCreateExternalMcpServer,
  useExternalMcpServers,
  useRemoveExternalMcpServer,
  useSetExternalMcpToolAccess,
  useUpdateExternalMcpServer,
} from '@/lib/api/external-mcp-queries';

import { ExternalMcpServerForm } from './external-mcp-server-form';
import { ExternalMcpToolRow } from './external-mcp-tool-row';

/**
 * The external MCP servers of a workspace (issue #196, ADR-086).
 *
 * The screen has one job a person can only do here: look at what a foreign
 * server offers and decide, tool by tool, what the assistant may use. So the
 * tools are the body of each server and everything else (address, secret,
 * status) is the frame around them. Owner only, like the API.
 */
export function ExternalMcpPanel({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('settings.externalMcp');
  const query = useExternalMcpServers(workspaceId, true);
  const create = useCreateExternalMcpServer(workspaceId);
  const [adding, setAdding] = React.useState(false);

  if (query.isPending) return <LoadingState label={t('loading')} variant="skeleton" rows={3} />;
  if (query.data === undefined) {
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {messageForCode(query.error instanceof ApiError ? query.error.code : undefined)}
        </AlertDescription>
      </Alert>
    );
  }

  const { servers, enabled, credentialsAvailable } = query.data;
  const createError = create.error instanceof ApiError ? create.error.code : undefined;

  return (
    <div className="flex flex-col gap-8" data-testid="external-mcp-panel">
      {enabled ? null : (
        <Alert data-testid="external-mcp-disabled">
          <AlertDescription>
            {t.rich('disabled', {
              link: (chunks) => (
                <Link href="/admin/einstellungen?gruppe=ai" className="underline">
                  {chunks}
                </Link>
              ),
            })}
          </AlertDescription>
        </Alert>
      )}

      {servers.length === 0 && !adding ? (
        <EmptyState icon={PlugIcon} title={t('empty.title')} description={t('empty.description')} />
      ) : null}

      {servers.map((server) => (
        <ServerSection
          key={server.id}
          workspaceId={workspaceId}
          server={server}
          deploymentEnabled={enabled}
          credentialsAvailable={credentialsAvailable}
        />
      ))}

      {adding ? (
        <section className="flex flex-col gap-4 border-t border-border pt-6">
          <h3 className="text-base font-semibold">{t('addTitle')}</h3>
          {createError === undefined ? null : (
            <Alert variant="destructive" data-testid="external-mcp-create-error">
              <AlertDescription>{messageForCode(createError)}</AlertDescription>
            </Alert>
          )}
          <ExternalMcpServerForm
            server={null}
            credentialsAvailable={credentialsAvailable}
            pending={create.isPending}
            onCreate={(request) =>
              create.mutate(request, {
                onSuccess: () => setAdding(false),
              })
            }
            onUpdate={() => undefined}
            onCancel={() => {
              create.reset();
              setAdding(false);
            }}
          />
        </section>
      ) : (
        <div>
          <Button
            onClick={() => setAdding(true)}
            disabled={!enabled}
            data-testid="external-mcp-add"
          >
            {t('add')}
          </Button>
        </div>
      )}
    </div>
  );
}

function ServerSection({
  workspaceId,
  server,
  deploymentEnabled,
  credentialsAvailable,
}: {
  workspaceId: string;
  server: ExternalMcpServer;
  deploymentEnabled: boolean;
  credentialsAvailable: boolean;
}) {
  const t = useTranslations('settings.externalMcp');
  const update = useUpdateExternalMcpServer(workspaceId);
  const check = useCheckExternalMcpServer(workspaceId);
  const setAccess = useSetExternalMcpToolAccess(workspaceId);
  const [editing, setEditing] = React.useState(false);
  const failed = update.error ?? check.error ?? setAccess.error;
  const errorCode = failed instanceof ApiError ? failed.code : undefined;
  const approved = server.tools.filter((tool) => tool.access !== 'blocked').length;

  return (
    <section
      className="flex flex-col gap-5 border-t border-border pt-6"
      data-testid="external-mcp-server"
      aria-labelledby={`mcp-server-${server.id}`}
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <h3 id={`mcp-server-${server.id}`} className="text-base font-semibold break-words">
            {server.name}
          </h3>
          <code className="font-mono text-xs break-all text-muted-foreground">{server.url}</code>
        </div>
        <ServerStatus server={server} checking={check.isPending} />
      </div>

      {failed === null ? null : (
        <Alert variant="destructive" data-testid="external-mcp-server-error">
          <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
        </Alert>
      )}

      {editing ? (
        <ExternalMcpServerForm
          server={server}
          credentialsAvailable={credentialsAvailable}
          pending={update.isPending}
          onCreate={() => undefined}
          onUpdate={(request) =>
            update.mutate({ serverId: server.id, request }, { onSuccess: () => setEditing(false) })
          }
          onCancel={() => {
            update.reset();
            setEditing(false);
          }}
        />
      ) : (
        <ServerFacts server={server} />
      )}

      {editing ? null : (
        <ServerActions
          workspaceId={workspaceId}
          server={server}
          deploymentEnabled={deploymentEnabled}
          checking={check.isPending}
          onCheck={() => check.mutate(server.id)}
          onEdit={() => setEditing(true)}
          onToggle={(next) => update.mutate({ serverId: server.id, request: { enabled: next } })}
          togglePending={update.isPending}
        />
      )}

      <div className="flex flex-col gap-1">
        <SectionRule
          as="h4"
          trailing={
            server.tools.length === 0
              ? undefined
              : t('toolCount', { approved, total: server.tools.length })
          }
        >
          {t('tools')}
        </SectionRule>
        {server.tools.length === 0 ? (
          <p className="pt-2 text-sm text-muted-foreground">
            {server.status === 'unchecked' ? t('noToolsYet') : t('noTools')}
          </p>
        ) : (
          <>
            <p className="max-w-measure pt-2 pb-1 text-xs text-muted-foreground">
              {t('toolsHint')}
            </p>
            <ul className="flex flex-col">
              {server.tools.map((tool) => (
                <ExternalMcpToolRow
                  key={tool.id}
                  tool={tool}
                  disabled={setAccess.isPending}
                  onAccess={(access) =>
                    setAccess.mutate({ serverId: server.id, toolId: tool.id, access })
                  }
                />
              ))}
            </ul>
            {server.toolsTruncated ? (
              <p className="text-xs text-muted-foreground">{t('truncated')}</p>
            ) : null}
          </>
        )}
      </div>

      {server.instructions === null ? null : (
        <details className="text-sm">
          <summary className="w-fit cursor-pointer text-xs text-muted-foreground hover:text-foreground">
            {t('instructions')}
          </summary>
          <p className="mt-2 max-w-measure text-xs whitespace-pre-wrap text-muted-foreground">
            {server.instructions}
          </p>
        </details>
      )}
    </section>
  );
}

/** Status as an icon and a word, never colour alone. */
function ServerStatus({ server, checking }: { server: ExternalMcpServer; checking: boolean }) {
  const t = useTranslations('settings.externalMcp.status');
  const [Icon, tone, label] = checking
    ? [LoaderCircleIcon, 'text-muted-foreground', t('checking')]
    : server.status === 'ok'
      ? [CircleCheckIcon, 'text-success', t('ok')]
      : server.status === 'error'
        ? [CircleAlertIcon, 'text-destructive-text', t('error')]
        : [CircleDashedIcon, 'text-muted-foreground', t('unchecked')];
  return (
    <span
      className="flex shrink-0 items-center gap-1.5 text-sm"
      role="status"
      data-testid="external-mcp-status"
      data-status={checking ? 'checking' : server.status}
    >
      <Icon className={cn('size-4', tone, checking && 'motion-safe:animate-spin')} aria-hidden />
      {label}
    </span>
  );
}

function ServerFacts({ server }: { server: ExternalMcpServer }) {
  const t = useTranslations('settings.externalMcp.facts');
  const tAuth = useTranslations('settings.externalMcp.auth');
  const tCode = useTranslations('settings.externalMcp.errorCodes');
  const format = useFormatter();
  const when = (iso: string | null) =>
    iso === null
      ? t('never')
      : format.dateTime(new Date(iso), { dateStyle: 'short', timeStyle: 'short' });
  const auth =
    server.authKind === 'none'
      ? tAuth('none')
      : `${server.authKind === 'header' ? (server.authHeaderName ?? '') : tAuth('bearer')}${
          server.secretConfigured && server.secretHint !== ''
            ? ` · ${t('endsWith', { hint: server.secretHint })}`
            : ''
        }`;
  const reported =
    server.serverName === null
      ? null
      : [server.serverName, server.serverVersion].filter(Boolean).join(' ');

  return (
    <div className="flex max-w-xl flex-col gap-2">
      <Readout label={t('key')} value={<code className="font-mono">{server.key}</code>} />
      <Readout label={t('auth')} value={auth} />
      <Readout label={t('lastChecked')} value={when(server.lastCheckedAt)} />
      {reported === null ? null : <Readout label={t('reported')} value={reported} />}
      {server.status === 'error' && server.lastErrorCode !== null ? (
        <p className="text-sm text-destructive-text" data-testid="external-mcp-last-error">
          {tCode(server.lastErrorCode)}
          {server.lastErrorDetail === null ? null : (
            <span className="block text-xs text-muted-foreground">{server.lastErrorDetail}</span>
          )}
        </p>
      ) : null}
    </div>
  );
}

function ServerActions({
  workspaceId,
  server,
  deploymentEnabled,
  checking,
  onCheck,
  onEdit,
  onToggle,
  togglePending,
}: {
  workspaceId: string;
  server: ExternalMcpServer;
  deploymentEnabled: boolean;
  checking: boolean;
  onCheck: () => void;
  onEdit: () => void;
  onToggle: (next: boolean) => void;
  togglePending: boolean;
}) {
  const t = useTranslations('settings.externalMcp');
  const remove = useRemoveExternalMcpServer(workspaceId);
  const [confirming, setConfirming] = React.useState(false);
  const switchId = `mcp-enabled-${server.id}`;

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant={server.status === 'unchecked' ? 'default' : 'outline'}
          onClick={onCheck}
          disabled={checking || !deploymentEnabled}
          data-testid="external-mcp-check"
        >
          {server.status === 'unchecked' ? t('checkFirst') : t('check')}
        </Button>
        <Button variant="outline" onClick={onEdit} data-testid="external-mcp-edit">
          {t('edit')}
        </Button>
        <Button
          variant="ghost"
          onClick={() => setConfirming(true)}
          data-testid="external-mcp-remove"
        >
          {t('remove')}
        </Button>
      </div>
      <div className="flex items-start gap-3">
        <Switch
          id={switchId}
          checked={server.enabled}
          disabled={togglePending || (!server.enabled && !deploymentEnabled)}
          onCheckedChange={onToggle}
          data-testid="external-mcp-enabled"
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor={switchId}>{t('enabled')}</Label>
          <p className="max-w-measure text-xs text-muted-foreground">{t('enabledHint')}</p>
        </div>
      </div>

      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('removeTitle', { name: server.name })}</DialogTitle>
            <DialogDescription>{t('removeDescription')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              {t('form.cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate(server.id, { onSuccess: () => setConfirming(false) })}
              data-testid="external-mcp-confirm-remove"
            >
              {t('remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
