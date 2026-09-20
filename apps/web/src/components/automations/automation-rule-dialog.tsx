'use client';

import * as React from 'react';

import {
  AUTOMATION_MIN_DEBOUNCE_SECONDS,
  type AutomationAction,
  type AutomationOutput,
  type AutomationRule,
  type AutomationScope,
  type AutomationTrigger,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Button,
  Checkbox,
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
} from '@exocortex/ui';

import { CopyBlock } from '@/components/settings/copy-block';
import { useCreateAutomationRule, useUpdateAutomationRule } from '@/lib/api/automation-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';

import {
  ACTION_LABELS,
  OUTPUT_LABELS,
  SCOPE_LABELS,
  TRIGGER_LABELS,
  TRIGGER_ORDER,
} from './automation-labels';
import {
  AutomationScheduleFields,
  browserTimeZone,
  fromLocalInput,
  type ScheduleDraft,
  toLocalInput,
} from './automation-schedule-fields';

interface Draft extends ScheduleDraft {
  name: string;
  scope: AutomationScope;
  scopeDocumentId: string;
  triggers: AutomationTrigger[];
  debounceSeconds: number;
  action: AutomationAction;
  webhookUrl: string;
  prompt: string;
  modelSlug: string;
  mailSubject: string;
  output: AutomationOutput;
}

/** What a new rule starts as: the cheapest useful rule somebody could mean. */
const EMPTY_DRAFT: Draft = {
  name: '',
  scope: 'WORKSPACE',
  scopeDocumentId: '',
  triggers: ['DOCUMENT_CONTENT_CHANGED'],
  // Carried even while the rule watches changes, so switching to the clock and
  // back does not lose what was typed. Only a scheduled rule sends them.
  scheduleKind: 'DAILY',
  scheduleAt: '',
  scheduleTime: '07:00',
  scheduleWeekday: 1,
  scheduleDayOfMonth: 1,
  scheduleCron: '0 7 * * 1',
  scheduleTimeZone: browserTimeZone(),
  debounceSeconds: 60,
  action: 'WEBHOOK',
  webhookUrl: '',
  prompt: '',
  modelSlug: '',
  mailSubject: '',
  output: 'COMMENT',
};

/**
 * A stored rule as form state.
 *
 * Spread over the defaults rather than written field by field with `??`: the
 * only difference between the two shapes is that the API's nullable fields are
 * empty strings in a form, and saying that once is shorter than saying it ten
 * times.
 */
function draftFrom(rule: AutomationRule | null): Draft {
  if (rule === null) return EMPTY_DRAFT;
  return {
    ...EMPTY_DRAFT,
    ...rule,
    scopeDocumentId: rule.scopeDocumentId ?? '',
    webhookUrl: rule.webhookUrl ?? '',
    prompt: rule.prompt ?? '',
    modelSlug: rule.modelSlug ?? '',
    mailSubject: rule.mailSubject ?? '',
    scheduleKind: rule.scheduleKind ?? EMPTY_DRAFT.scheduleKind,
    scheduleAt: toLocalInput(rule.scheduleAt),
    scheduleTime: rule.scheduleTime ?? EMPTY_DRAFT.scheduleTime,
    scheduleWeekday: rule.scheduleWeekday ?? EMPTY_DRAFT.scheduleWeekday,
    scheduleDayOfMonth: rule.scheduleDayOfMonth ?? EMPTY_DRAFT.scheduleDayOfMonth,
    scheduleCron: rule.scheduleCron ?? EMPTY_DRAFT.scheduleCron,
    scheduleTimeZone: rule.scheduleTimeZone ?? EMPTY_DRAFT.scheduleTimeZone,
  };
}

/**
 * The draft as the API wants it: empty strings become nulls again.
 *
 * Each action sends only its own fields and nulls the rest. The contract
 * refuses a rule carrying a field its action does not use, which is what keeps
 * a rule somebody switched from a webhook to a mail from still holding a URL
 * nothing reads.
 */
function requestFrom(draft: Draft) {
  const forWebhook = draft.action === 'WEBHOOK';
  const forAi = draft.action === 'AI_RUN';
  const forMail = draft.action === 'EMAIL_SELF';
  return {
    name: draft.name.trim(),
    scope: draft.scope,
    scopeDocumentId: draft.scope === 'WORKSPACE' ? null : emptyToNull(draft.scopeDocumentId),
    triggers: draft.triggers,
    ...scheduleFrom(draft),
    debounceSeconds: draft.debounceSeconds,
    action: draft.action,
    webhookUrl: forWebhook ? emptyToNull(draft.webhookUrl) : null,
    prompt: forAi ? emptyToNull(draft.prompt) : null,
    modelSlug: forAi ? emptyToNull(draft.modelSlug) : null,
    mailSubject: forMail ? emptyToNull(draft.mailSubject) : null,
    output: draft.output,
  };
}

/**
 * The schedule fields the API wants: only the ones this kind uses, and nothing
 * at all while the rule watches changes. The contract refuses a rule that
 * carries a half-filled schedule it would never read.
 */
function scheduleFrom(draft: Draft) {
  const empty = {
    scheduleKind: null,
    scheduleAt: null,
    scheduleTime: null,
    scheduleWeekday: null,
    scheduleDayOfMonth: null,
    scheduleCron: null,
    scheduleTimeZone: null,
  };
  if (!draft.triggers.includes('SCHEDULE')) return empty;
  const kind = draft.scheduleKind;
  const timed = kind === 'DAILY' || kind === 'WEEKLY' || kind === 'MONTHLY';
  return {
    ...empty,
    scheduleKind: kind,
    scheduleAt: kind === 'ONCE' ? fromLocalInput(draft.scheduleAt) : null,
    scheduleTime: timed ? draft.scheduleTime : null,
    scheduleWeekday: kind === 'WEEKLY' ? draft.scheduleWeekday : null,
    scheduleDayOfMonth: kind === 'MONTHLY' ? draft.scheduleDayOfMonth : null,
    scheduleCron: kind === 'CRON' ? emptyToNull(draft.scheduleCron) : null,
    scheduleTimeZone: emptyToNull(draft.scheduleTimeZone),
  };
}

function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export interface AutomationRuleDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The rule being changed, or null when a new one is being written. */
  rule: AutomationRule | null;
  /** Hosts a webhook may point at, so the form can say so before the API does. */
  allowedHosts: readonly string[];
}

/**
 * Writing a rule (issue #50, ADR-024).
 *
 * One dialog for both creating and changing, because it is the same three
 * decisions either way: where it watches, what it watches for, what it then
 * does. What differs is the ending. A new webhook rule finishes by showing its
 * signing secret and staying open, the same bargain an API token makes: this is
 * the only moment the value exists outside the database, and a dialog that
 * closed over it would have thrown it away on the user's behalf.
 */
export function AutomationRuleDialog({
  open,
  onOpenChange,
  workspaceId,
  rule,
  allowedHosts,
}: AutomationRuleDialogProps) {
  const create = useCreateAutomationRule(workspaceId);
  const update = useUpdateAutomationRule(workspaceId);

  const [draft, setDraft] = React.useState<Draft>(() => draftFrom(rule));
  const [secret, setSecret] = React.useState<string | null>(null);
  const [key, setKey] = React.useState(rule?.id ?? 'new');

  // Reset when the dialog is pointed at a different rule. Done during render
  // rather than in an effect, the same way the settings forms here do it.
  const wantedKey = rule?.id ?? 'new';
  if (key !== wantedKey) {
    setKey(wantedKey);
    setDraft(draftFrom(rule));
    setSecret(null);
  }

  const isNew = rule === null;
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const errorCode = error instanceof ApiError ? error.code : undefined;

  const set = <TKey extends keyof Draft>(field: TKey, value: Draft[TKey]): void => {
    setDraft((current) => ({ ...current, [field]: value }));
  };

  // The clock is exclusive: picking it drops the change triggers, and picking a
  // change drops the clock. The contract refuses the mixture, and a form that
  // let somebody build it would only be handing them an error afterwards.
  const toggleTrigger = (trigger: AutomationTrigger, on: boolean): void => {
    setDraft((current) => {
      if (trigger === 'SCHEDULE') {
        return { ...current, triggers: on ? ['SCHEDULE'] : ['DOCUMENT_CONTENT_CHANGED'] };
      }
      const others = current.triggers.filter((entry) => entry !== trigger && entry !== 'SCHEDULE');
      return { ...current, triggers: on ? [...others, trigger] : others };
    });
  };

  const scheduled = draft.triggers.includes('SCHEDULE');
  const body = requestFrom(draft);

  const submit = (): void => {
    if (body.name.length === 0 || body.triggers.length === 0) return;
    if (isNew) {
      create.mutate(
        { ...body, enabled: true },
        {
          onSuccess: (response) => {
            if (response.webhookSecret === null) onOpenChange(false);
            else setSecret(response.webhookSecret);
          },
        },
      );
      return;
    }
    update.mutate({ ruleId: rule.id, request: body }, { onSuccess: () => onOpenChange(false) });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{isNew ? 'Neue Automation' : 'Automation ändern'}</DialogTitle>
          <DialogDescription>
            Wenn sich unter dem gewählten Bereich etwas ändert oder der Zeitplan fällig wird, läuft
            die Aktion. Eine Automation überschreibt nie den Inhalt einer Seite.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {secret !== null ? (
            <SecretHandover secret={secret} onDone={() => onOpenChange(false)} />
          ) : (
            <div className="flex flex-col gap-5" data-testid="automation-form">
              {error !== null ? (
                <Alert variant="destructive" data-testid="automation-form-error">
                  <AlertDescription>{messageForCode(errorCode)}</AlertDescription>
                </Alert>
              ) : null}

              <div className="flex flex-col gap-2">
                <Label htmlFor="automation-name">Name</Label>
                <Input
                  id="automation-name"
                  data-testid="automation-name-input"
                  value={draft.name}
                  onChange={(event) => set('name', event.target.value)}
                  placeholder="Hermes über neue Sitzungsnotizen informieren"
                />
              </div>

              <ScopeFields draft={draft} set={set} />
              <TriggerFields draft={draft} onToggle={toggleTrigger} />

              {scheduled ? (
                <AutomationScheduleFields
                  draft={draft}
                  onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
                />
              ) : null}

              <div className={scheduled ? 'hidden' : 'flex flex-col gap-2'}>
                <Label htmlFor="automation-debounce">Entprellung (Sekunden)</Label>
                <Input
                  id="automation-debounce"
                  type="number"
                  min={AUTOMATION_MIN_DEBOUNCE_SECONDS}
                  value={draft.debounceSeconds}
                  onChange={(event) => set('debounceSeconds', Number(event.target.value))}
                  className="max-w-32"
                />
                <p className="text-xs text-muted-foreground">
                  So lange muss eine Seite ruhig sein, bevor die Regel läuft. Ohne das löst jeder
                  Tastendruck einen Lauf aus, und bei einem KI-Lauf kostet jeder davon Geld.
                </p>
              </div>

              <ActionFields draft={draft} set={set} allowedHosts={allowedHosts} isNew={isNew} />
            </div>
          )}
        </DialogBody>

        {secret === null ? (
          <DialogFooter>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Abbrechen
            </Button>
            <Button onClick={submit} disabled={pending} data-testid="automation-save">
              {isNew ? 'Anlegen' : 'Speichern'}
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The one moment the signing secret exists outside the database. */
function SecretHandover({ secret, onDone }: { secret: string; onDone: () => void }) {
  return (
    <div className="flex flex-col gap-4" data-testid="automation-secret">
      <Alert>
        <AlertDescription>
          Die Regel ist angelegt. Das Signiergeheimnis siehst du jetzt und nie wieder: eXocortex
          kann es nicht zurückgeben. Der empfangende Dienst braucht es, um die Signatur zu prüfen.
        </AlertDescription>
      </Alert>
      <CopyBlock label="Signiergeheimnis" value={secret} />
      <p className="text-xs text-muted-foreground">
        Jeder POST trägt die Kopfzeilen <code>x-exocortex-timestamp</code> und{' '}
        <code>x-exocortex-signature</code>. Signiert wird{' '}
        <code>&lt;timestamp&gt;.&lt;body&gt;</code> per HMAC-SHA256 mit diesem Geheimnis.
      </p>
      <DialogFooter>
        <Button onClick={onDone}>Habe ich kopiert</Button>
      </DialogFooter>
    </div>
  );
}

interface FieldProps {
  draft: Draft;
  set: <TKey extends keyof Draft>(field: TKey, value: Draft[TKey]) => void;
}

function ScopeFields({ draft, set }: FieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Geltungsbereich</Label>
      <Select value={draft.scope} onValueChange={(value) => set('scope', value as AutomationScope)}>
        <SelectTrigger data-testid="automation-scope">
          <SelectValue>{() => SCOPE_LABELS[draft.scope]}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {(Object.keys(SCOPE_LABELS) as AutomationScope[]).map((scope) => (
            <SelectItem key={scope} value={scope}>
              {SCOPE_LABELS[scope]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {draft.scope === 'WORKSPACE' ? null : (
        <div className="flex flex-col gap-2">
          <Label htmlFor="automation-scope-document">
            {draft.scope === 'SUBTREE' ? 'Seiten-Id' : 'Datenbank-Id'}
          </Label>
          <Input
            id="automation-scope-document"
            data-testid="automation-scope-document"
            value={draft.scopeDocumentId}
            onChange={(event) => set('scopeDocumentId', event.target.value)}
            placeholder="z. B. z29zpmvlgk3wk86anm1axa2h"
          />
          <p className="text-xs text-muted-foreground">
            Die Id steht in der Adresszeile der Seite.
          </p>
        </div>
      )}
    </div>
  );
}

function TriggerFields({
  draft,
  onToggle,
}: {
  draft: Draft;
  onToggle: (trigger: AutomationTrigger, on: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>Auslöser</Label>
      <div className="flex flex-col gap-2">
        {TRIGGER_ORDER.map((trigger) => {
          const onlyInDatabase = trigger === 'DATABASE_ROW_CHANGED';
          // The clock fits every scope but the workspace-wide one, where it
          // would have no page to act on.
          const disabled =
            trigger === 'SCHEDULE' ? false : onlyInDatabase !== (draft.scope === 'DATABASE');
          return (
            <label
              key={trigger}
              className="flex items-center gap-2 text-sm data-[disabled]:opacity-50"
              data-disabled={disabled ? '' : undefined}
            >
              <Checkbox
                checked={draft.triggers.includes(trigger)}
                disabled={disabled}
                onCheckedChange={(checked) => onToggle(trigger, checked === true)}
              />
              {TRIGGER_LABELS[trigger]}
            </label>
          );
        })}
      </div>
      <p className="text-xs text-muted-foreground">
        Zeilenwerte gibt es nur im Geltungsbereich einer Datenbank, alles andere nur außerhalb. Ein
        Zeitplan steht allein und braucht eine Seite als Geltungsbereich: die Uhr nennt keine.
      </p>
    </div>
  );
}

function ActionFields({
  draft,
  set,
  allowedHosts,
  isNew,
}: FieldProps & { allowedHosts: readonly string[]; isNew: boolean }) {
  return (
    <div className="flex flex-col gap-4 border-t border-border pt-4">
      <div className="flex flex-col gap-2">
        <Label>Aktion</Label>
        <Select
          value={draft.action}
          onValueChange={(value) => set('action', value as AutomationAction)}
          // A stored rule cannot become a webhook rule: the signing secret can
          // only be handed over once, at creation.
          disabled={!isNew && draft.action !== 'WEBHOOK'}
        >
          <SelectTrigger data-testid="automation-action">
            <SelectValue>{() => ACTION_LABELS[draft.action]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(ACTION_LABELS) as AutomationAction[]).map((action) => (
              <SelectItem key={action} value={action}>
                {ACTION_LABELS[action]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {draft.action === 'EMAIL_SELF' ? <MailFields draft={draft} set={set} /> : null}
      {draft.action === 'WEBHOOK' ? (
        <WebhookFields draft={draft} set={set} allowedHosts={allowedHosts} />
      ) : null}
      {draft.action === 'AI_RUN' ? <AiFields draft={draft} set={set} /> : null}
    </div>
  );
}

/** The mail action: a subject, and the promise about where it goes. */
function MailFields({ draft, set }: FieldProps) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="automation-mail-subject">Betreff (optional)</Label>
      <Input
        id="automation-mail-subject"
        data-testid="automation-mail-subject"
        value={draft.mailSubject}
        onChange={(event) => set('mailSubject', event.target.value)}
        placeholder="Leer lassen für den Namen der Regel"
      />
      <p className="text-xs text-muted-foreground">
        Die Mail geht an die bestätigte Adresse deines eigenen Kontos, an keine andere. Im Text
        steht die Seite selbst, bei langen Seiten gekürzt und mit einem Link darunter.
      </p>
    </div>
  );
}

function WebhookFields({
  draft,
  set,
  allowedHosts,
}: FieldProps & { allowedHosts: readonly string[] }) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="automation-url">Ziel-URL</Label>
      <Input
        id="automation-url"
        data-testid="automation-url"
        value={draft.webhookUrl}
        onChange={(event) => set('webhookUrl', event.target.value)}
        placeholder="https://hooks.example.org/exocortex"
      />
      <p className="text-xs text-muted-foreground">
        {allowedHosts.length === 0
          ? 'Diese Installation erlaubt derzeit keine Webhook-Ziele. Ein globaler Administrator muss automations.webhookAllowedHosts füllen.'
          : `Erlaubte Hosts: ${allowedHosts.join(', ')}. Verschickt werden nur Metadaten der Seite, nie ihr Inhalt.`}
      </p>
    </div>
  );
}

function AiFields({ draft, set }: FieldProps) {
  return (
    <>
      <div className="flex flex-col gap-2">
        <Label htmlFor="automation-prompt">Prompt</Label>
        <Textarea
          id="automation-prompt"
          data-testid="automation-prompt"
          rows={4}
          value={draft.prompt}
          onChange={(event) => set('prompt', event.target.value)}
          placeholder="Prüfe, ob diese Seite durch die Änderung veraltete Angaben enthält."
        />
        <p className="text-xs text-muted-foreground">
          Die geänderte Seite ist das Material des Modells. Die Antwort landet daneben, nicht darin.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label>Ergebnis</Label>
        <Select
          value={draft.output}
          onValueChange={(value) => set('output', value as AutomationOutput)}
        >
          <SelectTrigger data-testid="automation-output">
            <SelectValue>{() => OUTPUT_LABELS[draft.output]}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(OUTPUT_LABELS) as AutomationOutput[]).map((output) => (
              <SelectItem key={output} value={output}>
                {OUTPUT_LABELS[output]}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="automation-model">Modell (optional)</Label>
        <Input
          id="automation-model"
          value={draft.modelSlug}
          onChange={(event) => set('modelSlug', event.target.value)}
          placeholder="Leer lassen für das Standardmodell"
        />
      </div>
    </>
  );
}
