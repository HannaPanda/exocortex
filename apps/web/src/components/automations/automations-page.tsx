'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import { type AutomationRule } from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AppPage,
  Badge,
  Button,
  EmptyState,
  Input,
  LoadingState,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@exocortex/ui';

import {
  useAutomationRules,
  useAutomationRuns,
  useDeleteAutomationRule,
  useTriggerAutomationRule,
  useUpdateAutomationRule,
} from '@/lib/api/automation-queries';
import { useWorkspaceDetail } from '@/lib/api/workspace-queries';

import { runStatusVariant, useAutomationWording } from './automation-labels';
import { AutomationRuleDialog } from './automation-rule-dialog';

/**
 * The automations of one workspace, and what they have been doing (issue #50,
 * ADR-024).
 *
 * Two halves, and the lower one is the point. A rule that runs invisibly cannot
 * be told apart from a rule that does not run, so the run log is on the same
 * page as the rules rather than behind a link: the first question anybody asks
 * about an automation is what it did last night.
 *
 * Writing needs the OWNER role. Everybody else sees the same page read-only,
 * because what an automation has been doing to the pages people work on is not
 * a secret from those people.
 */
export function AutomationsPage({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('automations.page');
  const detail = useWorkspaceDetail(workspaceId);
  const rules = useAutomationRules(workspaceId);
  const update = useUpdateAutomationRule(workspaceId);

  const [editing, setEditing] = React.useState<AutomationRule | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  if (detail.isPending || rules.isPending || rules.data === undefined) {
    return <LoadingState label={t('loading')} />;
  }

  const isOwner = detail.data?.role === 'OWNER';
  const { enabledForWorkspace, allowedWebhookHosts } = rules.data;

  const openNew = (): void => {
    setEditing(null);
    setDialogOpen(true);
  };

  return (
    <AppPage maxWidth="max-w-4xl">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="exocortex-page-title">{t('title')}</h1>
          <p className="mt-1 max-w-measure text-sm text-muted-foreground">{t('intro')}</p>
        </div>
        {isOwner ? (
          <Button onClick={openNew} data-testid="automation-new">
            {t('newRule')}
          </Button>
        ) : null}
      </div>

      {!enabledForWorkspace ? (
        <Alert className="mt-6" data-testid="automations-disabled">
          <AlertDescription>
            {t.rich('disabled', {
              setting: 'automations.enabled',
              code: (chunks) => <code>{chunks}</code>,
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      {!isOwner ? (
        <Alert className="mt-6" data-testid="automations-readonly">
          <AlertDescription>{t('readOnly')}</AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-sm font-medium">{t('rulesHeading')}</h2>
        {rules.data.rules.length === 0 ? (
          <EmptyState title={t('emptyTitle')} description={t('emptyDescription')} />
        ) : (
          <RuleTable
            rules={rules.data.rules}
            isOwner={isOwner}
            workspaceId={workspaceId}
            onEdit={(rule) => {
              setEditing(rule);
              setDialogOpen(true);
            }}
            onToggle={(rule, enabled) => {
              update.mutate({ ruleId: rule.id, request: { enabled } });
            }}
          />
        )}
      </section>

      <RunLog workspaceId={workspaceId} />

      {isOwner ? (
        <AutomationRuleDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          workspaceId={workspaceId}
          rule={editing}
          allowedHosts={allowedWebhookHosts}
        />
      ) : null}
    </AppPage>
  );
}

function RuleTable({
  rules,
  isOwner,
  workspaceId,
  onEdit,
  onToggle,
}: {
  rules: readonly AutomationRule[];
  isOwner: boolean;
  workspaceId: string;
  onEdit: (rule: AutomationRule) => void;
  onToggle: (rule: AutomationRule, enabled: boolean) => void;
}) {
  const t = useTranslations('automations.page');
  const wording = useAutomationWording();
  return (
    <Table narrow="list" data-testid="automation-rules">
      <TableHeader>
        <TableRow>
          <TableHead>{t('columns.name')}</TableHead>
          <TableHead>{t('columns.scope')}</TableHead>
          <TableHead>{t('columns.triggers')}</TableHead>
          <TableHead>{t('columns.action')}</TableHead>
          <TableHead className="text-right">{t('columns.enabled')}</TableHead>
          {isOwner ? <TableHead className="w-px" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id} data-testid="automation-rule">
            <TableCell cell="title">
              <div className="font-medium">{rule.name}</div>
              {rule.disabledReason === null ? null : (
                <div className="text-xs text-destructive">
                  {t('selfDisabled', { reason: rule.disabledReason })}
                </div>
              )}
              {rule.lastTriggeredAt === null ? null : (
                <div className="text-xs text-muted-foreground">
                  {t('lastTriggered', { moment: wording.moment(rule.lastTriggeredAt) })}
                </div>
              )}
            </TableCell>
            <TableCell label={t('columns.scope')} className="text-sm text-muted-foreground">
              {rule.scope === 'WORKSPACE'
                ? wording.scope('WORKSPACE')
                : (rule.scopeDocumentTitle ?? rule.scopeDocumentId ?? '')}
            </TableCell>
            <TableCell label={t('columns.triggers')} className="text-sm text-muted-foreground">
              {rule.triggers.includes('SCHEDULE') ? (
                <>
                  <div>{wording.schedule(rule)}</div>
                  <div className="text-xs">
                    {rule.nextRunAt === null
                      ? t('noNextRun')
                      : t('nextRun', { moment: wording.moment(rule.nextRunAt) })}
                  </div>
                </>
              ) : (
                rule.triggers.map((trigger) => wording.trigger(trigger)).join(', ')
              )}
            </TableCell>
            <TableCell label={t('columns.action')} className="text-sm text-muted-foreground">
              {wording.action(rule.action)}
              <div className="text-xs">{rule.webhookUrl ?? ''}</div>
            </TableCell>
            <TableCell label={t('columns.enabled')} className="text-right">
              <Switch
                checked={rule.enabled}
                disabled={!isOwner}
                onCheckedChange={(checked) => onToggle(rule, checked)}
                aria-label={
                  rule.enabled
                    ? t('disableRule', { name: rule.name })
                    : t('enableRule', { name: rule.name })
                }
              />
            </TableCell>
            {isOwner ? (
              <TableCell cell="actions">
                <RuleActions rule={rule} workspaceId={workspaceId} onEdit={onEdit} />
              </TableCell>
            ) : null}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/**
 * Change, try, delete.
 *
 * "Jetzt ausführen" asks for a page id rather than opening a picker: it is a
 * debugging affordance for the person who just wrote the rule and has the page
 * in front of them, and a tree picker here would be a second page-selection
 * widget to keep correct for a field used once per rule.
 */
function RuleActions({
  rule,
  workspaceId,
  onEdit,
}: {
  rule: AutomationRule;
  workspaceId: string;
  onEdit: (rule: AutomationRule) => void;
}) {
  const t = useTranslations('automations.page');
  const trigger = useTriggerAutomationRule(workspaceId);
  const remove = useDeleteAutomationRule(workspaceId);
  const [documentId, setDocumentId] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);

  // A scheduled rule already names its page, so trying it out is one press.
  const scheduled = rule.triggers.includes('SCHEDULE');

  return (
    <div className="flex items-center justify-end gap-2">
      {scheduled ? null : (
        <Input
          value={documentId}
          onChange={(event) => setDocumentId(event.target.value)}
          placeholder={t('documentIdPlaceholder')}
          className="h-8 w-36"
          aria-label={t('runAgainst', { name: rule.name })}
        />
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={(!scheduled && documentId.trim().length === 0) || trigger.isPending}
        onClick={() =>
          trigger.mutate({
            ruleId: rule.id,
            request: {
              documentId: scheduled ? null : documentId.trim(),
              trigger: scheduled ? 'SCHEDULE' : 'DOCUMENT_UPDATED',
            },
          })
        }
      >
        {t('runNow')}
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onEdit(rule)}>
        {t('edit')}
      </Button>
      {confirming ? (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => remove.mutate(rule.id)}
          data-testid="automation-delete-confirm"
        >
          {t('confirmDelete')}
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          {t('delete')}
        </Button>
      )}
    </div>
  );
}

function RunLog({ workspaceId }: { workspaceId: string }) {
  const t = useTranslations('automations.runLog');
  const wording = useAutomationWording();
  const runs = useAutomationRuns(workspaceId);

  return (
    <section className="mt-10 flex flex-col gap-3">
      <h2 className="text-sm font-medium">{t('heading')}</h2>
      {runs.data === undefined || runs.data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('empty')}</p>
      ) : (
        <Table narrow="list" data-testid="automation-runs">
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.moment')}</TableHead>
              <TableHead>{t('columns.rule')}</TableHead>
              <TableHead>{t('columns.page')}</TableHead>
              <TableHead>{t('columns.origin')}</TableHead>
              <TableHead>{t('columns.status')}</TableHead>
              <TableHead>{t('columns.duration')}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.data.runs.map((run) => (
              <TableRow key={run.id} data-testid="automation-run">
                <TableCell label={t('columns.moment')} className="text-sm text-muted-foreground">
                  {wording.moment(run.createdAt)}
                </TableCell>
                <TableCell cell="title" className="text-sm">
                  {run.ruleName}
                </TableCell>
                <TableCell label={t('columns.page')} className="text-sm text-muted-foreground">
                  {run.documentTitle ?? t('deletedPage')}
                </TableCell>
                <TableCell label={t('columns.origin')} className="text-sm text-muted-foreground">
                  {wording.runOrigin(run.origin)}
                </TableCell>
                <TableCell label={t('columns.status')}>
                  <Badge variant={runStatusVariant(run.status)}>
                    {wording.runStatus(run.status)}
                  </Badge>
                  {run.error === null ? null : (
                    <div className="mt-1 text-xs text-muted-foreground">{run.error}</div>
                  )}
                </TableCell>
                <TableCell label={t('columns.duration')} className="text-sm text-muted-foreground">
                  {wording.duration(run.durationMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
