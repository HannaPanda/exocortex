'use client';

import { XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  AGENT_APPROVAL_POLICIES,
  type AgentApprovalPolicy,
  type AgentProfile,
  AI_WRITE_MODES,
  type AiReasoningLevel,
  type AiWriteMode,
  type CreateAgentProfileRequest,
  providerRoutingOverrideSchema,
  TOOL_DOMAINS,
  type ToolDomain,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  Badge,
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
  Switch,
  Textarea,
} from '@exocortex/ui';

import { useCreateAgentProfile, useUpdateAgentProfile } from '@/lib/api/agent-profile-queries';
import { useAiModels } from '@/lib/api/ai-queries';
import { useSearch } from '@/lib/api/search-queries';

import { microUsdOf, useAgentProfileWording, wholeNumberOf } from './agent-profile-labels';

/**
 * Writing an agent profile (issue #143, ADR-071).
 *
 * Grouped the way the detail reads: the role, then model and provider, then
 * tools, then how it may write, then what it may spend. Every number is
 * optional, because an empty field means "as the workspace says", which is
 * the honest default for a limit that can only ever narrow.
 */

const DEFAULT = '__default__';
/** `core` is always allowed; offering it as a choice would suggest otherwise. */
const CHOOSABLE_DOMAINS = TOOL_DOMAINS.filter((domain) => domain !== 'core');

interface Draft {
  name: string;
  description: string;
  instructions: string;
  rules: { documentId: string; title: string }[];
  modelSlug: string | null;
  reasoningLevel: AiReasoningLevel | null;
  routing: string;
  allTools: boolean;
  toolDomains: ToolDomain[];
  writeMode: AiWriteMode;
  approvalPolicy: AgentApprovalPolicy;
  budgetRunUsd: string;
  budgetTaskUsd: string;
  maxToolIterations: string;
  maxRunSeconds: string;
  confineToWorkspace: boolean;
  isDefault: boolean;
}

function usd(microUsd: number | null): string {
  return microUsd === null ? '' : String(microUsd / 1_000_000);
}

/** What a new profile starts as: careful, and with no limits of its own yet. */
const NEW_DRAFT: Draft = {
  name: '',
  description: '',
  instructions: '',
  rules: [],
  modelSlug: null,
  reasoningLevel: null,
  routing: '',
  allTools: true,
  toolDomains: ['pages'],
  writeMode: 'propose',
  approvalPolicy: 'none',
  budgetRunUsd: '',
  budgetTaskUsd: '',
  maxToolIterations: '',
  maxRunSeconds: '',
  confineToWorkspace: true,
  isDefault: false,
};

function draftOf(profile: AgentProfile | null): Draft {
  if (profile === null) return NEW_DRAFT;
  return {
    ...profile,
    description: profile.description ?? '',
    instructions: profile.instructions ?? '',
    rules: profile.ruleDocuments.flatMap((rule) =>
      rule.title === null ? [] : [{ documentId: rule.documentId, title: rule.title }],
    ),
    routing:
      profile.providerRouting === null ? '' : JSON.stringify(profile.providerRouting, null, 2),
    allTools: profile.toolDomains === null,
    toolDomains: profile.toolDomains ?? NEW_DRAFT.toolDomains,
    budgetRunUsd: usd(profile.budgetMicroUsdPerRun),
    budgetTaskUsd: usd(profile.budgetMicroUsdPerTask),
    maxToolIterations: profile.maxToolIterations?.toString() ?? '',
    maxRunSeconds: profile.maxRunSeconds?.toString() ?? '',
  };
}

/** The routing text as an override, `null` for none, `undefined` when it does not parse. */
function routingOf(text: string): CreateAgentProfileRequest['providerRouting'] | undefined {
  if (text.trim().length === 0) return null;
  try {
    const parsed = providerRoutingOverrideSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export function AgentProfileDialog({
  open,
  onOpenChange,
  workspaceId,
  profile,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The profile being edited; null creates one. */
  profile: AgentProfile | null;
}) {
  const t = useTranslations('agentProfiles.dialog');
  const router = useRouter();
  const create = useCreateAgentProfile(workspaceId);
  const update = useUpdateAgentProfile(workspaceId);
  const [draft, setDraft] = React.useState<Draft>(() => draftOf(profile));

  // Reopened for another profile, or a new one, the form starts from that
  // one; adjusted while rendering so no frame shows the previous text.
  const [openedFor, setOpenedFor] = React.useState<string | null>(null);
  const key = open ? (profile?.id ?? 'new') : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (key !== null) setDraft(draftOf(profile));
  }

  const set = <TKey extends keyof Draft>(field: TKey, value: Draft[TKey]): void =>
    setDraft((current) => ({ ...current, [field]: value }));

  const routing = routingOf(draft.routing);
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;
  const valid = draft.name.trim().length > 0 && routing !== undefined;

  const submit = async (): Promise<void> => {
    if (routing === undefined) return;
    const request: CreateAgentProfileRequest = {
      name: draft.name.trim(),
      description: draft.description.trim() || null,
      instructions: draft.instructions.trim() || null,
      ruleDocumentIds: draft.rules.map((rule) => rule.documentId),
      modelSlug: draft.modelSlug,
      reasoningLevel: draft.reasoningLevel,
      providerRouting: routing,
      toolDomains: draft.allTools ? null : draft.toolDomains,
      writeMode: draft.writeMode,
      approvalPolicy: draft.approvalPolicy,
      budgetMicroUsdPerRun: microUsdOf(draft.budgetRunUsd),
      budgetMicroUsdPerTask: microUsdOf(draft.budgetTaskUsd),
      maxToolIterations: wholeNumberOf(draft.maxToolIterations),
      maxRunSeconds: wholeNumberOf(draft.maxRunSeconds),
      confineToWorkspace: draft.confineToWorkspace,
      isDefault: draft.isDefault,
    };
    if (profile === null) {
      const created = await create.mutateAsync(request);
      onOpenChange(false);
      router.push(`/arbeitsbereich/${workspaceId}/agentenprofile/${created.profile.id}`);
      return;
    }
    await update.mutateAsync({ profileId: profile.id, request });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{profile === null ? t('newTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-4" data-testid="agent-profile-form">
            {error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-profile-name">{t('nameLabel')}</Label>
                <Input
                  id="agent-profile-name"
                  value={draft.name}
                  maxLength={80}
                  placeholder={t('namePlaceholder')}
                  onChange={(event) => set('name', event.target.value)}
                  data-testid="agent-profile-name"
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="agent-profile-description">{t('descriptionLabel')}</Label>
                <Input
                  id="agent-profile-description"
                  value={draft.description}
                  maxLength={500}
                  onChange={(event) => set('description', event.target.value)}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label htmlFor="agent-profile-instructions">{t('instructionsLabel')}</Label>
              <Textarea
                id="agent-profile-instructions"
                value={draft.instructions}
                rows={4}
                maxLength={8_000}
                placeholder={t('instructionsPlaceholder')}
                onChange={(event) => set('instructions', event.target.value)}
                data-testid="agent-profile-instructions"
              />
            </div>

            <RulePagePicker
              workspaceId={workspaceId}
              rules={draft.rules}
              onChange={(rules) => set('rules', rules)}
            />

            <ModelFields draft={draft} set={set} routingValid={routing !== undefined} />
            <ToolFields draft={draft} set={set} />

            <PolicyFields draft={draft} set={set} />
          </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !valid}
            data-testid="agent-profile-save"
          >
            {profile === null ? t('create') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Model, reasoning and routing: the profile's preferences, never a binding. */
function ModelFields({ draft, set, routingValid }: FieldProps & { routingValid: boolean }) {
  const t = useTranslations('agentProfiles.dialog');
  const wording = useAgentProfileWording();
  const models = useAiModels();
  const usable = (models.data?.models ?? []).filter((model) => model.supportsTools);
  const chosenModel = usable.find((model) => model.slug === draft.modelSlug) ?? null;
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-profile-model">{t('modelLabel')}</Label>
          <Select
            value={draft.modelSlug ?? DEFAULT}
            onValueChange={(next) =>
              set('modelSlug', next === DEFAULT || next === null ? null : next)
            }
          >
            <SelectTrigger id="agent-profile-model">
              <SelectValue>
                {() =>
                  draft.modelSlug === null
                    ? t('modelDefault')
                    : (chosenModel?.displayName ?? draft.modelSlug)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('modelDefault')}</SelectItem>
              {usable.map((model) => (
                <SelectItem key={model.slug} value={model.slug}>
                  {model.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-profile-reasoning">{t('reasoningLabel')}</Label>
          <Select
            value={draft.reasoningLevel ?? DEFAULT}
            onValueChange={(next) =>
              set(
                'reasoningLevel',
                next === DEFAULT || next === null ? null : (next as AiReasoningLevel),
              )
            }
          >
            <SelectTrigger id="agent-profile-reasoning">
              <SelectValue>
                {() =>
                  draft.reasoningLevel === null
                    ? t('reasoningDefault')
                    : wording.reasoning(draft.reasoningLevel)
                }
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={DEFAULT}>{t('reasoningDefault')}</SelectItem>
              {(chosenModel?.reasoningLevels ?? []).map((level) => (
                <SelectItem key={level} value={level}>
                  {wording.reasoning(level)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="agent-profile-routing">{t('routingLabel')}</Label>
        <Textarea
          id="agent-profile-routing"
          value={draft.routing}
          rows={2}
          className="font-mono text-xs"
          onChange={(event) => set('routing', event.target.value)}
          aria-invalid={!routingValid}
        />
        <p className="text-xs text-muted-foreground">
          {!routingValid ? t('routingInvalid') : t('routingHint', { example: '{"sort": "price"}' })}
        </p>
      </div>
    </>
  );
}

/** The tool domains the profile allows; `core` is always kept. */
function ToolFields({ draft, set }: FieldProps) {
  const t = useTranslations('agentProfiles.dialog');
  const wording = useAgentProfileWording();
  const toggleDomain = (domain: ToolDomain, on: boolean): void =>
    set(
      'toolDomains',
      on ? [...draft.toolDomains, domain] : draft.toolDomains.filter((entry) => entry !== domain),
    );
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1.5 text-sm font-medium">{t('toolsLabel')}</legend>
      <label className="flex items-center gap-2 text-sm">
        <Checkbox
          checked={draft.allTools}
          onCheckedChange={(checked) => set('allTools', checked === true)}
          data-testid="agent-profile-all-tools"
        />
        {t('toolsAll')}
      </label>
      {draft.allTools ? null : (
        <div className="grid gap-1.5 sm:grid-cols-2" data-testid="agent-profile-domains">
          {CHOOSABLE_DOMAINS.map((domain) => (
            <label key={domain} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={draft.toolDomains.includes(domain)}
                onCheckedChange={(checked) => toggleDomain(domain, checked === true)}
              />
              {wording.domain(domain)}
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

/** How the profile may write and close, and what it may spend. */
function PolicyFields({ draft, set }: FieldProps) {
  const t = useTranslations('agentProfiles.dialog');
  const wording = useAgentProfileWording();
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-profile-write-mode">{t('writeModeLabel')}</Label>
          <Select
            value={draft.writeMode}
            onValueChange={(next) => set('writeMode', next as AiWriteMode)}
          >
            <SelectTrigger id="agent-profile-write-mode" data-testid="agent-profile-write-mode">
              <SelectValue>{() => wording.writeMode(draft.writeMode)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AI_WRITE_MODES.map((mode) => (
                <SelectItem key={mode} value={mode}>
                  {wording.writeMode(mode)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="agent-profile-approval">{t('approvalLabel')}</Label>
          <Select
            value={draft.approvalPolicy}
            onValueChange={(next) => set('approvalPolicy', next as AgentApprovalPolicy)}
          >
            <SelectTrigger id="agent-profile-approval">
              <SelectValue>{() => wording.approval(draft.approvalPolicy)}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {AGENT_APPROVAL_POLICIES.map((policy) => (
                <SelectItem key={policy} value={policy}>
                  {wording.approval(policy)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <NumberField
          id="agent-profile-budget-run"
          label={t('budgetRunLabel')}
          value={draft.budgetRunUsd}
          placeholder={t('budgetPlaceholder')}
          onChange={(value) => set('budgetRunUsd', value)}
        />
        <NumberField
          id="agent-profile-budget-task"
          label={t('budgetTaskLabel')}
          value={draft.budgetTaskUsd}
          placeholder={t('budgetPlaceholder')}
          onChange={(value) => set('budgetTaskUsd', value)}
        />
        <NumberField
          id="agent-profile-iterations"
          label={t('iterationsLabel')}
          value={draft.maxToolIterations}
          placeholder={t('limitPlaceholder')}
          numeric
          onChange={(value) => set('maxToolIterations', value)}
        />
        <NumberField
          id="agent-profile-run-seconds"
          label={t('runSecondsLabel')}
          value={draft.maxRunSeconds}
          placeholder={t('limitPlaceholder')}
          numeric
          onChange={(value) => set('maxRunSeconds', value)}
        />
      </div>

      <label className="flex items-center justify-between gap-3 text-sm">
        {t('confineLabel')}
        <Switch
          checked={draft.confineToWorkspace}
          onCheckedChange={(checked) => set('confineToWorkspace', checked)}
        />
      </label>
      <label className="flex items-center justify-between gap-3 text-sm">
        {t('defaultLabel')}
        <Switch
          checked={draft.isDefault}
          onCheckedChange={(checked) => set('isDefault', checked)}
          data-testid="agent-profile-default"
        />
      </label>
    </>
  );
}

interface FieldProps {
  draft: Draft;
  set: <TKey extends keyof Draft>(field: TKey, value: Draft[TKey]) => void;
}

function NumberField({
  id,
  label,
  value,
  placeholder,
  numeric = false,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  numeric?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode={numeric ? 'numeric' : 'decimal'}
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

/**
 * The rule pages, chosen by searching for them: an id is not something a
 * person should have to know.
 */
function RulePagePicker({
  workspaceId,
  rules,
  onChange,
}: {
  workspaceId: string;
  rules: Draft['rules'];
  onChange: (rules: Draft['rules']) => void;
}) {
  const t = useTranslations('agentProfiles.dialog');
  const [query, setQuery] = React.useState('');
  const search = useSearch(workspaceId, query);
  const chosen = new Set(rules.map((rule) => rule.documentId));
  const hits = (search.data?.results ?? [])
    .filter((hit) => !chosen.has(hit.documentId))
    .slice(0, 5);

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="agent-profile-rule-search">{t('rulesLabel')}</Label>
      {rules.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('rulesNone')}</p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {rules.map((rule) => (
            <li key={rule.documentId}>
              <Badge variant="secondary" className="gap-1">
                {rule.title}
                <button
                  type="button"
                  aria-label={t('rulesRemove', { title: rule.title })}
                  className="rounded-sm hover:text-foreground"
                  onClick={() =>
                    onChange(rules.filter((entry) => entry.documentId !== rule.documentId))
                  }
                >
                  <XIcon className="size-3" />
                </button>
              </Badge>
            </li>
          ))}
        </ul>
      )}
      <Input
        id="agent-profile-rule-search"
        value={query}
        placeholder={t('rulesSearch')}
        onChange={(event) => setQuery(event.target.value)}
      />
      {hits.length === 0 ? null : (
        <ul className="flex flex-col gap-0.5">
          {hits.map((hit) => (
            <li key={hit.documentId}>
              <Button
                variant="ghost"
                size="sm"
                className="h-auto w-full justify-start py-1 text-left"
                aria-label={t('rulesAdd', { title: hit.title })}
                onClick={() => {
                  onChange([...rules, { documentId: hit.documentId, title: hit.title }]);
                  setQuery('');
                }}
              >
                {hit.title}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">{t('rulesHint')}</p>
    </div>
  );
}
