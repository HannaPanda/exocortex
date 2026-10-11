'use client';

import { XIcon } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  EVAL_REPLAY_MODES,
  type EvalCase,
  type EvalReplayMode,
  TOOL_DOMAINS,
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
  Textarea,
} from '@exocortex/ui';

import { useAgentProfiles } from '@/lib/api/agent-profile-queries';
import { useCreateEvalCase, useUpdateEvalCase } from '@/lib/api/eval-queries';
import { useSearch } from '@/lib/api/search-queries';

import { useAgentProfileWording } from '../agent-profiles/agent-profile-labels';

import { EvalCaseChecks } from './eval-case-checks';
import { type CaseDraft, caseDraftOf, caseRequestOf } from './eval-case-draft';
import { EvalCaseFixture } from './eval-case-fixture';
import { useEvalWording } from './eval-labels';

const NONE = '__none__';
const CHOOSABLE_DOMAINS = TOOL_DOMAINS.filter((domain) => domain !== 'core');

type Set = <TKey extends keyof CaseDraft>(field: TKey, value: CaseDraft[TKey]) => void;

/**
 * Writing an eval case (issue #146, ADR-074).
 *
 * In the order a person thinks the task through: what is asked, where it
 * happens and how it stays harmless, what holds it, and what has to be true
 * afterwards. Every limit is optional, because an empty field means "as the
 * workspace and the profile say", which a case can only narrow.
 */
export function EvalCaseDialog({
  open,
  onOpenChange,
  workspaceId,
  evalCase,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The case being edited; null creates one. */
  evalCase: EvalCase | null;
}) {
  const t = useTranslations('evals.dialog');
  const router = useRouter();
  const create = useCreateEvalCase(workspaceId);
  const update = useUpdateEvalCase(workspaceId);
  const [draft, setDraft] = React.useState<CaseDraft>(() => caseDraftOf(evalCase));

  // Reopened for another case, or a new one, the form starts from that one.
  const [openedFor, setOpenedFor] = React.useState<string | null>(null);
  const key = open ? (evalCase?.id ?? 'new') : null;
  if (key !== openedFor) {
    setOpenedFor(key);
    if (key !== null) setDraft(caseDraftOf(evalCase));
  }

  const set: Set = (field, value) => setDraft((current) => ({ ...current, [field]: value }));
  const built = caseRequestOf(draft);
  const pending = create.isPending || update.isPending;
  const error = create.error ?? update.error;

  const submit = async (): Promise<void> => {
    if (!('request' in built)) return;
    if (evalCase === null) {
      const created = await create.mutateAsync(built.request);
      onOpenChange(false);
      router.push(`/arbeitsbereich/${workspaceId}/evals/faelle/${created.evalCase.id}`);
      return;
    }
    await update.mutateAsync({ caseId: evalCase.id, request: built.request });
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{evalCase === null ? t('newTitle') : t('editTitle')}</DialogTitle>
          <DialogDescription>{t('description')}</DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="flex flex-col gap-5" data-testid="eval-case-form">
            {error === null ? null : (
              <Alert variant="destructive">
                <AlertDescription>{error.message}</AlertDescription>
              </Alert>
            )}
            <TaskFields draft={draft} set={set} />
            <ModeFields draft={draft} set={set} workspaceId={workspaceId} />
            <HoldFields draft={draft} set={set} workspaceId={workspaceId} />
            <EvalCaseChecks
              checks={draft.checks}
              replayMode={draft.replayMode}
              pageKeys={draft.pages.map((page) => page.key)}
              onChange={(checks) => set('checks', checks)}
            />
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="eval-case-expected">{t('expectedLabel')}</Label>
              <Textarea
                id="eval-case-expected"
                value={draft.expectedOutcome}
                rows={3}
                maxLength={4_000}
                placeholder={t('expectedPlaceholder')}
                onChange={(event) => set('expectedOutcome', event.target.value)}
              />
            </div>
          </div>
        </DialogBody>

        <DialogFooter className="items-center">
          {'problem' in built ? (
            <p className="mr-auto text-xs text-muted-foreground" data-testid="eval-case-problem">
              {t(`problems.${built.problem}`)}
            </p>
          ) : null}
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            {t('cancel')}
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={pending || !('request' in built)}
            data-testid="eval-case-save"
          >
            {evalCase === null ? t('create') : t('save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** What the assistant is asked, and which set the case belongs to. */
function TaskFields({ draft, set }: { draft: CaseDraft; set: Set }) {
  const t = useTranslations('evals.dialog');
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eval-case-name">{t('nameLabel')}</Label>
          <Input
            id="eval-case-name"
            value={draft.name}
            maxLength={120}
            placeholder={t('namePlaceholder')}
            onChange={(event) => set('name', event.target.value)}
            data-testid="eval-case-name"
          />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eval-case-suite">{t('suiteLabel')}</Label>
          <Input
            id="eval-case-suite"
            value={draft.suite}
            maxLength={60}
            placeholder={t('suitePlaceholder')}
            onChange={(event) => set('suite', event.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="eval-case-description">{t('descriptionLabel')}</Label>
        <Input
          id="eval-case-description"
          value={draft.description}
          maxLength={2_000}
          onChange={(event) => set('description', event.target.value)}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="eval-case-prompt">{t('promptLabel')}</Label>
        <Textarea
          id="eval-case-prompt"
          value={draft.prompt}
          rows={4}
          maxLength={20_000}
          placeholder={t('promptPlaceholder')}
          onChange={(event) => set('prompt', event.target.value)}
          data-testid="eval-case-prompt"
        />
      </div>
    </>
  );
}

/** Where the attempt happens, and how it stays away from what people use. */
function ModeFields({
  draft,
  set,
  workspaceId,
}: {
  draft: CaseDraft;
  set: Set;
  workspaceId: string;
}) {
  const t = useTranslations('evals.dialog');
  const wording = useEvalWording();
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1.5">
        <Label htmlFor="eval-case-mode">{t('modeLabel')}</Label>
        <Select
          value={draft.replayMode}
          onValueChange={(next) => set('replayMode', next as EvalReplayMode)}
        >
          <SelectTrigger id="eval-case-mode" data-testid="eval-case-mode">
            <SelectValue>{() => wording.mode(draft.replayMode)}</SelectValue>
          </SelectTrigger>
          <SelectContent>
            {EVAL_REPLAY_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>
                {wording.mode(mode)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{wording.modeHint(draft.replayMode)}</p>
      </div>
      {draft.replayMode === 'fixture' ? (
        <EvalCaseFixture
          pages={draft.pages}
          startKey={draft.startKey}
          onChange={(pages) => set('pages', pages)}
          onStartChange={(startKey) => set('startKey', startKey)}
        />
      ) : (
        <StartPagePicker
          workspaceId={workspaceId}
          chosen={
            draft.documentId === null
              ? null
              : { id: draft.documentId, title: draft.documentTitle ?? draft.documentId }
          }
          onChange={(page) => {
            set('documentId', page?.id ?? null);
            set('documentTitle', page?.title ?? null);
          }}
        />
      )}
    </div>
  );
}

/** The real page an attempt stands on, chosen by searching for it. */
function StartPagePicker({
  workspaceId,
  chosen,
  onChange,
}: {
  workspaceId: string;
  chosen: { id: string; title: string } | null;
  onChange: (page: { id: string; title: string } | null) => void;
}) {
  const t = useTranslations('evals.dialog');
  const [query, setQuery] = React.useState('');
  const search = useSearch(workspaceId, query);
  const hits = (search.data?.results ?? []).slice(0, 5);
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor="eval-case-page-search">{t('startPageLabel')}</Label>
      {chosen === null ? (
        <p className="text-xs text-muted-foreground">{t('startPageNone')}</p>
      ) : (
        <Badge variant="secondary" className="gap-1 self-start">
          {chosen.title}
          <button
            type="button"
            aria-label={t('startPageRemove', { title: chosen.title })}
            className="rounded-sm hover:text-foreground"
            onClick={() => onChange(null)}
          >
            <XIcon className="size-3" />
          </button>
        </Badge>
      )}
      <Input
        id="eval-case-page-search"
        value={query}
        placeholder={t('startPageSearch')}
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
                onClick={() => {
                  onChange({ id: hit.documentId, title: hit.title });
                  setQuery('');
                }}
              >
                {hit.title}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The profile, the tools and the limits; each only ever narrows. */
function HoldFields({
  draft,
  set,
  workspaceId,
}: {
  draft: CaseDraft;
  set: Set;
  workspaceId: string;
}) {
  const t = useTranslations('evals.dialog');
  const profileWording = useAgentProfileWording();
  const profiles = useAgentProfiles(workspaceId);
  const chosen = profiles.data?.profiles.find((profile) => profile.id === draft.agentProfileId);
  const toggle = (domain: (typeof CHOOSABLE_DOMAINS)[number], on: boolean): void =>
    set(
      'toolDomains',
      on ? [...draft.toolDomains, domain] : draft.toolDomains.filter((entry) => entry !== domain),
    );
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="eval-case-profile">{t('profileLabel')}</Label>
          <Select
            value={draft.agentProfileId ?? NONE}
            onValueChange={(next) =>
              set('agentProfileId', next === NONE || next === null ? null : next)
            }
          >
            <SelectTrigger id="eval-case-profile">
              <SelectValue>{() => chosen?.name ?? t('profileNone')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>{t('profileNone')}</SelectItem>
              {(profiles.data?.profiles ?? []).map((profile) => (
                <SelectItem key={profile.id} value={profile.id}>
                  {profile.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <LimitField
          id="eval-case-budget"
          label={t('budgetLabel')}
          value={draft.budgetUsd}
          placeholder={t('limitPlaceholder')}
          onChange={(value) => set('budgetUsd', value)}
        />
        <LimitField
          id="eval-case-iterations"
          label={t('iterationsLabel')}
          value={draft.maxToolIterations}
          placeholder={t('limitPlaceholder')}
          onChange={(value) => set('maxToolIterations', value)}
        />
        <LimitField
          id="eval-case-seconds"
          label={t('secondsLabel')}
          value={draft.maxRunSeconds}
          placeholder={t('limitPlaceholder')}
          onChange={(value) => set('maxRunSeconds', value)}
        />
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 text-sm font-medium">{t('toolsLabel')}</legend>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox
            checked={draft.allTools}
            onCheckedChange={(checked) => set('allTools', checked === true)}
          />
          {t('toolsAll')}
        </label>
        {draft.allTools ? null : (
          <div className="grid gap-1.5 sm:grid-cols-3">
            {CHOOSABLE_DOMAINS.map((domain) => (
              <label key={domain} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={draft.toolDomains.includes(domain)}
                  onCheckedChange={(checked) => toggle(domain, checked === true)}
                />
                {profileWording.domain(domain)}
              </label>
            ))}
          </div>
        )}
      </fieldset>
    </div>
  );
}

function LimitField({
  id,
  label,
  value,
  placeholder,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        inputMode="decimal"
        value={value}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
