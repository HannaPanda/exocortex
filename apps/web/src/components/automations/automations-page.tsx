'use client';

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

import {
  ACTION_LABELS,
  describeSchedule,
  formatDuration,
  formatMoment,
  RUN_ORIGIN_LABELS,
  RUN_STATUS_LABELS,
  runStatusVariant,
  SCOPE_LABELS,
  TRIGGER_LABELS,
} from './automation-labels';
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
  const detail = useWorkspaceDetail(workspaceId);
  const rules = useAutomationRules(workspaceId);
  const update = useUpdateAutomationRule(workspaceId);

  const [editing, setEditing] = React.useState<AutomationRule | null>(null);
  const [dialogOpen, setDialogOpen] = React.useState(false);

  if (detail.isPending || rules.isPending || rules.data === undefined) {
    return <LoadingState label="Automationen werden geladen …" />;
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
          <h1 className="text-lg font-semibold">Automationen</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Regeln, die auf Änderungen an Seiten oder auf die Uhr reagieren: ein signierter Webhook
            oder ein KI-Lauf gegen die betroffene Seite.
          </p>
        </div>
        {isOwner ? (
          <Button onClick={openNew} data-testid="automation-new">
            Neue Regel
          </Button>
        ) : null}
      </div>

      {!enabledForWorkspace ? (
        <Alert className="mt-6" data-testid="automations-disabled">
          <AlertDescription>
            Automationen sind für diesen Arbeitsbereich abgeschaltet. Keine der Regeln unten läuft,
            egal wie sie eingestellt ist. Umschalten lässt sich das über die Einstellung
            <code className="mx-1">automations.enabled</code>; wenn die Installation sie global
            abgeschaltet hat, kann ein Arbeitsbereich sie nicht selbst wieder einschalten.
          </AlertDescription>
        </Alert>
      ) : null}

      {!isOwner ? (
        <Alert className="mt-6" data-testid="automations-readonly">
          <AlertDescription>
            Regeln anlegen und ändern kann die Besitzerin oder der Besitzer dieses Arbeitsbereichs.
            Eine Regel schickt Daten nach außen oder gibt Geld für ein Modell aus, und sie tut das
            weiter, wenn niemand mehr hinschaut.
          </AlertDescription>
        </Alert>
      ) : null}

      <section className="mt-8 flex flex-col gap-3">
        <h2 className="text-sm font-medium">Regeln</h2>
        {rules.data.rules.length === 0 ? (
          <EmptyState
            title="Noch keine Automation"
            description="Eine Regel besteht aus drei Antworten: wo sie hinsieht, worauf sie reagiert und was sie dann tut."
          />
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
  return (
    <Table data-testid="automation-rules">
      <TableHeader>
        <TableRow>
          <TableHead>Name</TableHead>
          <TableHead>Bereich</TableHead>
          <TableHead>Auslöser</TableHead>
          <TableHead>Aktion</TableHead>
          <TableHead className="text-right">An</TableHead>
          {isOwner ? <TableHead className="w-px" /> : null}
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={rule.id} data-testid="automation-rule">
            <TableCell>
              <div className="font-medium">{rule.name}</div>
              {rule.disabledReason === null ? null : (
                <div className="text-xs text-destructive">
                  Selbst abgeschaltet: {rule.disabledReason}
                </div>
              )}
              {rule.lastTriggeredAt === null ? null : (
                <div className="text-xs text-muted-foreground">
                  Zuletzt {formatMoment(rule.lastTriggeredAt)}
                </div>
              )}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {rule.scope === 'WORKSPACE'
                ? SCOPE_LABELS.WORKSPACE
                : (rule.scopeDocumentTitle ?? rule.scopeDocumentId ?? '')}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {rule.triggers.includes('SCHEDULE') ? (
                <>
                  <div>{describeSchedule(rule)}</div>
                  <div className="text-xs">
                    {rule.nextRunAt === null
                      ? 'Kein weiterer Lauf'
                      : `Nächster Lauf ${formatMoment(rule.nextRunAt)}`}
                  </div>
                </>
              ) : (
                rule.triggers.map((trigger) => TRIGGER_LABELS[trigger]).join(', ')
              )}
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {ACTION_LABELS[rule.action]}
              <div className="text-xs">{rule.webhookUrl ?? ''}</div>
            </TableCell>
            <TableCell className="text-right">
              <Switch
                checked={rule.enabled}
                disabled={!isOwner}
                onCheckedChange={(checked) => onToggle(rule, checked)}
                aria-label={`${rule.name} ${rule.enabled ? 'abschalten' : 'einschalten'}`}
              />
            </TableCell>
            {isOwner ? (
              <TableCell>
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
          placeholder="Seiten-Id"
          className="h-8 w-36"
          aria-label={`Seite, gegen die ${rule.name} laufen soll`}
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
        Jetzt ausführen
      </Button>
      <Button size="sm" variant="ghost" onClick={() => onEdit(rule)}>
        Ändern
      </Button>
      {confirming ? (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => remove.mutate(rule.id)}
          data-testid="automation-delete-confirm"
        >
          Wirklich löschen
        </Button>
      ) : (
        <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
          Löschen
        </Button>
      )}
    </div>
  );
}

function RunLog({ workspaceId }: { workspaceId: string }) {
  const runs = useAutomationRuns(workspaceId);

  return (
    <section className="mt-10 flex flex-col gap-3">
      <h2 className="text-sm font-medium">Lauf-Protokoll</h2>
      {runs.data === undefined || runs.data.runs.length === 0 ? (
        <p className="text-sm text-muted-foreground">Noch nichts gelaufen.</p>
      ) : (
        <Table data-testid="automation-runs">
          <TableHeader>
            <TableRow>
              <TableHead>Zeitpunkt</TableHead>
              <TableHead>Regel</TableHead>
              <TableHead>Seite</TableHead>
              <TableHead>Start</TableHead>
              <TableHead>Ergebnis</TableHead>
              <TableHead>Dauer</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.data.runs.map((run) => (
              <TableRow key={run.id} data-testid="automation-run">
                <TableCell className="text-sm text-muted-foreground">
                  {formatMoment(run.createdAt)}
                </TableCell>
                <TableCell className="text-sm">{run.ruleName}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {run.documentTitle ?? '(gelöscht)'}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {RUN_ORIGIN_LABELS[run.origin]}
                </TableCell>
                <TableCell>
                  <Badge variant={runStatusVariant(run.status)}>
                    {RUN_STATUS_LABELS[run.status]}
                  </Badge>
                  {run.error === null ? null : (
                    <div className="mt-1 text-xs text-muted-foreground">{run.error}</div>
                  )}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {formatDuration(run.durationMs)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </section>
  );
}
