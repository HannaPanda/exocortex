'use client';

import { useFormatter, useTranslations } from 'next-intl';

import {
  type ExternalMcpTool,
  type ExternalMcpToolAccess,
  type ExternalMcpToolHints,
} from '@exocortex/contracts';
import { Badge, Toggle, ToggleGroup } from '@exocortex/ui';

const ACCESS_ORDER: readonly ExternalMcpToolAccess[] = ['blocked', 'read', 'write'];

/** The hints in the order a person weighs them, and only those the server stated. */
function statedHints(hints: ExternalMcpToolHints): string[] {
  const stated: string[] = [];
  if (hints.readOnlyHint === true) stated.push('readOnly');
  if (hints.readOnlyHint === false) stated.push('writes');
  if (hints.destructiveHint === true) stated.push('destructive');
  if (hints.idempotentHint === true) stated.push('idempotent');
  if (hints.openWorldHint === true) stated.push('openWorld');
  return stated;
}

/**
 * One tool and the decision about it.
 *
 * Everything the approval is bound to is on screen before the choice: the
 * name the model will call, the server's own description in full (never cut,
 * because a cut description is not what was approved) and the parameters
 * behind a disclosure. The server's hints are quoted as the server's words,
 * beside the choice and not inside it, because they are a claim (ADR-086).
 */
export function ExternalMcpToolRow({
  tool,
  disabled,
  onAccess,
}: {
  tool: ExternalMcpTool;
  disabled: boolean;
  onAccess: (access: ExternalMcpToolAccess) => void;
}) {
  const t = useTranslations('settings.externalMcp.tool');
  const format = useFormatter();
  const hints = statedHints(tool.hints);
  const approvable = tool.problem === null && tool.available;
  const labelId = `mcp-tool-${tool.id}`;

  return (
    <li className="flex flex-col gap-2 border-t border-border py-4" data-testid="mcp-tool-row">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <span id={labelId} className="font-medium break-words">
            {tool.title ?? tool.name}
          </span>
          <code className="font-mono text-xs break-all text-muted-foreground">
            {tool.functionName}
          </code>
        </div>
        <ToggleGroup
          aria-labelledby={labelId}
          value={[tool.access]}
          disabled={disabled}
          onValueChange={(next) => {
            const chosen = next.at(-1) as ExternalMcpToolAccess | undefined;
            if (chosen !== undefined && chosen !== tool.access) onAccess(chosen);
          }}
          data-testid="mcp-tool-access"
        >
          {ACCESS_ORDER.map((access) => (
            <Toggle
              key={access}
              value={access}
              variant="outline"
              size="sm"
              disabled={access !== 'blocked' && !approvable}
              data-testid={`mcp-tool-access-${access}`}
            >
              {t(`access.${access}`)}
            </Toggle>
          ))}
        </ToggleGroup>
      </div>

      <ToolNotices tool={tool} />

      {tool.description === '' ? (
        <p className="text-sm text-muted-foreground italic">{t('noDescription')}</p>
      ) : (
        <p className="max-w-measure text-sm whitespace-pre-wrap text-muted-foreground">
          {tool.description}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {hints.length > 0 ? (
          <span>
            {t('serverSays', {
              hints: format.list(hints.map((hint) => t(`hints.${hint as 'readOnly'}`))),
            })}
          </span>
        ) : (
          <span>{t('noHints')}</span>
        )}
        {tool.approvedAt !== null && tool.access !== 'blocked' ? (
          <span>
            {t('approvedAt', {
              date: format.dateTime(new Date(tool.approvedAt), {
                day: 'numeric',
                month: 'numeric',
                year: 'numeric',
              }),
            })}
          </span>
        ) : null}
      </div>

      <details className="text-xs">
        <summary className="w-fit cursor-pointer text-muted-foreground hover:text-foreground">
          {t('parameters')}
        </summary>
        <pre className="mt-2 max-h-64 overflow-auto rounded-md bg-sunken p-3 font-mono text-xs">
          {JSON.stringify(tool.inputSchema, null, 2)}
        </pre>
      </details>
    </li>
  );
}

/** Why a tool cannot be approved, or why it is blocked again. Text, never colour alone. */
function ToolNotices({ tool }: { tool: ExternalMcpTool }) {
  const t = useTranslations('settings.externalMcp.tool');
  if (tool.problem !== null) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="mcp-tool-problem">
        <Badge variant="destructive">{t('unusable')}</Badge>
        <span>{t(`problems.${tool.problem}`)}</span>
      </p>
    );
  }
  if (!tool.available) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="mcp-tool-gone">
        <Badge variant="muted">{t('gone')}</Badge>
        <span>{t('goneHint')}</span>
      </p>
    );
  }
  if (tool.changedSinceApproval) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="mcp-tool-changed">
        <Badge variant="outline">{t('changed')}</Badge>
        <span>{t('changedHint')}</span>
      </p>
    );
  }
  return null;
}
