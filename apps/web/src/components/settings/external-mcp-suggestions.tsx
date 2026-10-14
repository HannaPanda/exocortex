'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type ExternalMcpServer, type ExternalMcpTool } from '@exocortex/contracts';
import {
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@exocortex/ui';

import { useSetExternalMcpToolsAccess } from '@/lib/api/external-mcp-queries';

/**
 * Applying the suggested classification in one go (issue #196).
 *
 * Sixty tools judged one by one is an afternoon nobody gets back, so the
 * screen proposes read or write from each name and the person confirms the
 * list. A tool that changed since it was approved is left out: that one is
 * the warning the fingerprint exists for, and it stays something to look at.
 */
export function ExternalMcpSuggestions({
  workspaceId,
  server,
}: {
  workspaceId: string;
  server: ExternalMcpServer;
}) {
  const t = useTranslations('settings.externalMcp.suggest');
  const tForm = useTranslations('settings.externalMcp.form');
  const apply = useSetExternalMcpToolsAccess(workspaceId);
  const [open, setOpen] = React.useState(false);

  const usable = server.tools.filter((tool) => tool.problem === null && tool.available);
  const changedLeftOut = usable.filter((tool) => tool.changedSinceApproval).length;
  const pending = usable.filter(
    (tool) => !tool.changedSinceApproval && tool.access !== tool.suggestedAccess,
  );
  const toRead = pending.filter((tool) => tool.suggestedAccess === 'read');
  const toWrite = pending.filter((tool) => tool.suggestedAccess === 'write');
  if (usable.length === 0) return null;

  return (
    <div
      className="flex flex-col gap-2 pt-2 sm:flex-row sm:items-center sm:justify-between"
      data-testid="external-mcp-suggestions"
    >
      <p className="max-w-measure text-xs text-muted-foreground">
        {t('summary', {
          read: usable.filter((tool) => tool.suggestedAccess === 'read').length,
          write: usable.filter((tool) => tool.suggestedAccess === 'write').length,
          differ: pending.length,
        })}
      </p>
      {pending.length === 0 ? null : (
        <Button
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => setOpen(true)}
          data-testid="external-mcp-suggestions-review"
        >
          {t('review')}
        </Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="flex max-h-[50vh] flex-col gap-4 overflow-y-auto">
            <ToolList label={t('toRead', { count: toRead.length })} tools={toRead} />
            <ToolList label={t('toWrite', { count: toWrite.length })} tools={toWrite} />
            {changedLeftOut === 0 ? null : (
              <p className="text-xs text-muted-foreground">
                {t('changedLeftOut', { count: changedLeftOut })}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {tForm('cancel')}
            </Button>
            <Button
              disabled={apply.isPending}
              onClick={() =>
                apply.mutate(
                  {
                    serverId: server.id,
                    request: {
                      changes: pending.map((tool) => ({
                        toolId: tool.id,
                        access: tool.suggestedAccess,
                      })),
                    },
                  },
                  { onSuccess: () => setOpen(false) },
                )
              }
              data-testid="external-mcp-suggestions-apply"
            >
              {t('confirm', { count: pending.length })}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ToolList({ label, tools }: { label: string; tools: readonly ExternalMcpTool[] }) {
  if (tools.length === 0) return null;
  return (
    <section className="flex flex-col gap-1">
      <h4 className="text-sm font-medium">{label}</h4>
      <ul className="flex flex-col gap-0.5">
        {tools.map((tool) => (
          <li key={tool.id} className="font-mono text-xs break-all text-muted-foreground">
            {tool.name}
          </li>
        ))}
      </ul>
    </section>
  );
}
