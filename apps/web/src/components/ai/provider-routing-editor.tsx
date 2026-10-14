'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';

import {
  mergeProviderRouting,
  PROVIDER_SORTS,
  type ProviderRouting,
  type ProviderRoutingOverride,
} from '@exocortex/contracts';
import {
  Combobox,
  ComboboxChip,
  ComboboxChips,
  ComboboxChipsInput,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Textarea,
  useComboboxAnchor,
} from '@exocortex/ui';

import {
  addProviderName,
  DATA_COLLECTION_VALUES,
  formFromRouting,
  ROUTING_FLAG_KEYS,
  ROUTING_LIST_KEYS,
  type RoutingField,
  type RoutingForm,
  routingFromForm,
  type RoutingListKey,
  type RoutingMode,
  type RoutingResult,
  sameRouting,
} from '@/lib/provider-routing-form';

/**
 * OpenRouter's provider preferences as a form (issue #201, ADR-063).
 *
 * One component for the three places that hold them: the deployment setting
 * (`mode="setting"`) and the overrides on a model and on an agent profile
 * (`mode="override"`). An override's field has three states (inherit, remove,
 * own value), the setting's two (OpenRouter's default, own value). Keys the
 * form has no field for stay as JSON in a folded section, so nothing stored
 * is lost by opening and saving.
 *
 * The form is the component's own state, seeded from `value`. Every change
 * reports the stored object, or `undefined` while the form does not describe
 * one; the parent keeps passing the last valid object, and only a different
 * one resets the form.
 */
export interface ProviderRoutingEditorProps<TMode extends RoutingMode> {
  id: string;
  mode: TMode;
  value: ProviderRouting | ProviderRoutingOverride | null;
  onChange: (
    value: (TMode extends 'setting' ? ProviderRouting : ProviderRoutingOverride) | undefined,
  ) => void;
  /** Provider names to offer in the lists, from the model's endpoint snapshot. */
  suggestions?: readonly string[];
  /** The deployment's preferences, for the "applies to this model" preview. */
  inherited?: ProviderRouting;
  /** The description the first control carries, from the surrounding row. */
  describedBy?: string;
  invalid?: boolean;
}

type ChoiceToken = 'unset' | 'remove' | `set:${string}`;

function tokenOf<TValue>(field: RoutingField<TValue>): ChoiceToken {
  if (field.state === 'set') return `set:${String(field.value)}`;
  return field.state;
}

function fieldOfToken<TValue>(
  token: string,
  parse: (raw: string) => TValue | undefined,
): RoutingField<TValue> {
  if (token === 'remove') return { state: 'remove' };
  if (token.startsWith('set:')) {
    const value = parse(token.slice(4));
    if (value !== undefined) return { state: 'set', value };
  }
  return { state: 'unset' };
}

export function ProviderRoutingEditor<TMode extends RoutingMode>({
  id,
  mode,
  value,
  onChange,
  suggestions = [],
  inherited,
  describedBy,
  invalid = false,
}: ProviderRoutingEditorProps<TMode>) {
  const t = useTranslations('settings.providerRouting');
  const [form, setForm] = React.useState<RoutingForm>(() => formFromRouting(value));
  // The value this form last stood for. A `value` that differs from it came
  // from outside (a discarded draft, a reloaded row), so the form starts over
  // from it; adjusted while rendering, so no frame shows the old fields.
  const [reported, setReported] = React.useState(value);
  if (!sameRouting(value ?? {}, reported ?? {})) {
    setReported(value);
    setForm(formFromRouting(value));
  }
  const result = routingFromForm(form, mode);

  const update = (next: RoutingForm): void => {
    setForm(next);
    const outcome = routingFromForm(next, mode);
    if (outcome.ok) setReported(outcome.value);
    onChange(outcome.ok ? outcome.value : undefined);
  };

  const inheritedText = (key: string): string | null => {
    if (mode !== 'override' || inherited === undefined) return null;
    const entry = (inherited as Record<string, unknown>)[key];
    if (entry === undefined) return null;
    return describeValue(entry, t);
  };

  const sortOptions = PROVIDER_SORTS.map((sort) => ({
    token: `set:${sort}` as const,
    label: t(`sort.${sort}.label`),
  }));
  const sortHint =
    form.sort.state === 'set' ? t(`sort.${form.sort.value}.help`) : t('sort.unsetHelp');

  return (
    <div
      role="group"
      className="flex flex-col gap-4"
      aria-describedby={describedBy}
      data-testid={`${id}-editor`}
    >
      <ChoiceField
        id={id}
        label={t('sort.label')}
        hint={sortHint}
        mode={mode}
        token={tokenOf(form.sort)}
        options={sortOptions}
        inheritedText={inheritedText('sort')}
        describedBy={describedBy}
        invalid={invalid}
        onToken={(token) =>
          update({
            ...form,
            sort: fieldOfToken(token, (raw) =>
              (PROVIDER_SORTS as readonly string[]).includes(raw)
                ? (raw as (typeof PROVIDER_SORTS)[number])
                : undefined,
            ),
          })
        }
      />
      {ROUTING_LIST_KEYS.map((key) => (
        <ListField
          key={key}
          id={`${id}-${key}`}
          listKey={key}
          mode={mode}
          field={form.lists[key]}
          suggestions={suggestions}
          inheritedText={inheritedText(key)}
          onField={(field) => update({ ...form, lists: { ...form.lists, [key]: field } })}
        />
      ))}
      {ROUTING_FLAG_KEYS.map((key) => (
        <ChoiceField
          key={key}
          id={`${id}-${key}`}
          label={t(`flags.${key}.label`)}
          hint={t(`flags.${key}.help`)}
          mode={mode}
          token={tokenOf(form.flags[key])}
          options={[
            { token: 'set:true', label: t('yes') },
            { token: 'set:false', label: t('no') },
          ]}
          unsetLabel={t(`flags.${key}.default`)}
          inheritedText={inheritedText(key)}
          onToken={(token) =>
            update({
              ...form,
              flags: { ...form.flags, [key]: fieldOfToken(token, parseFlag) },
            })
          }
        />
      ))}
      <ChoiceField
        id={`${id}-data_collection`}
        label={t('dataCollection.label')}
        hint={t('dataCollection.help')}
        mode={mode}
        token={tokenOf(form.dataCollection)}
        options={DATA_COLLECTION_VALUES.map((entry) => ({
          token: `set:${entry}` as const,
          label: t(`dataCollection.${entry}`),
        }))}
        inheritedText={inheritedText('data_collection')}
        onToken={(token) =>
          update({
            ...form,
            dataCollection: fieldOfToken(token, (raw) =>
              (DATA_COLLECTION_VALUES as readonly string[]).includes(raw)
                ? (raw as (typeof DATA_COLLECTION_VALUES)[number])
                : undefined,
            ),
          })
        }
      />
      <ExtraField
        id={`${id}-extra`}
        value={form.extra}
        reason={result.ok ? null : result.reason}
        onChange={(extra) => update({ ...form, extra })}
      />
      {mode === 'override' && inherited !== undefined ? (
        <Preview id={`${id}-preview`} inherited={inherited} result={result} />
      ) : null}
    </div>
  );
}

function parseFlag(raw: string): boolean | undefined {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return undefined;
}

type Translate = ReturnType<typeof useTranslations<'settings.providerRouting'>>;

function describeValue(value: unknown, t: Translate): string {
  if (typeof value === 'boolean') return value ? t('yes') : t('no');
  if (Array.isArray(value)) return value.length === 0 ? t('emptyList') : value.join(', ');
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

/** A field with a closed set of values: sort, the two flags, data collection. */
function ChoiceField({
  id,
  label,
  hint,
  mode,
  token,
  options,
  unsetLabel,
  inheritedText,
  describedBy,
  invalid = false,
  onToken,
}: {
  id: string;
  label: string;
  hint: string;
  mode: RoutingMode;
  token: ChoiceToken;
  options: readonly { token: ChoiceToken; label: string }[];
  unsetLabel?: string;
  inheritedText: string | null;
  describedBy?: string;
  invalid?: boolean;
  onToken: (token: string) => void;
}) {
  const t = useTranslations('settings.providerRouting');
  const all = [
    { token: 'unset' as const, label: unsetText(t, mode, inheritedText, unsetLabel) },
    ...(mode === 'override' ? [{ token: 'remove' as const, label: t('state.remove') }] : []),
    ...options,
  ];
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Select value={token} onValueChange={(next) => onToken(String(next))}>
        <SelectTrigger
          id={id}
          className="w-full"
          aria-describedby={describedBy === undefined ? hintId : `${hintId} ${describedBy}`}
          aria-invalid={invalid}
        >
          <SelectValue>{() => all.find((entry) => entry.token === token)?.label ?? ''}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {all.map((entry) => (
            <SelectItem key={entry.token} value={entry.token}>
              {entry.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p id={hintId} className="text-xs text-muted-foreground">
        {hint}
      </p>
    </div>
  );
}

function unsetText(
  t: Translate,
  mode: RoutingMode,
  inheritedText: string | null,
  settingDefault: string | undefined,
): string {
  if (mode === 'setting') return settingDefault ?? t('state.default');
  return inheritedText === null
    ? t('state.inherit')
    : t('state.inheritWith', { value: inheritedText });
}

const LIST_STATE_TOKENS = ['unset', 'remove', 'set'] as const;

/** `only`, `ignore`, `order`: provider names as chips, typed freely or picked. */
function ListField({
  id,
  listKey,
  mode,
  field,
  suggestions,
  inheritedText,
  onField,
}: {
  id: string;
  listKey: RoutingListKey;
  mode: RoutingMode;
  field: RoutingField<string[]>;
  suggestions: readonly string[];
  inheritedText: string | null;
  onField: (field: RoutingField<string[]>) => void;
}) {
  const t = useTranslations('settings.providerRouting');
  const names = field.state === 'set' ? field.value : [];
  const hintId = `${id}-hint`;
  const stateId = `${id}-state`;

  // The setting has no "remove", and an empty list is no preference at all:
  // removing the last chip goes back to OpenRouter's default.
  const setNames = (next: string[]): void => {
    if (mode === 'setting' && next.length === 0) onField({ state: 'unset' });
    else onField({ state: 'set', value: next });
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={mode === 'override' ? stateId : id}>{t(`lists.${listKey}.label`)}</Label>
      {mode === 'override' ? (
        <Select
          value={field.state}
          onValueChange={(next) => {
            if (next === 'set') onField({ state: 'set', value: names });
            else if (next === 'remove') onField({ state: 'remove' });
            else onField({ state: 'unset' });
          }}
        >
          <SelectTrigger id={stateId} className="w-full" aria-describedby={hintId}>
            <SelectValue>
              {() =>
                field.state === 'set'
                  ? t('state.custom')
                  : field.state === 'remove'
                    ? t('state.remove')
                    : unsetText(t, mode, inheritedText, undefined)
              }
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {LIST_STATE_TOKENS.map((state) => (
              <SelectItem key={state} value={state}>
                {state === 'set'
                  ? t('state.custom')
                  : state === 'remove'
                    ? t('state.remove')
                    : unsetText(t, mode, inheritedText, undefined)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
      {mode === 'setting' || field.state === 'set' ? (
        <ProviderNameInput
          id={id}
          names={names}
          suggestions={suggestions}
          describedBy={hintId}
          label={mode === 'override' ? t(`lists.${listKey}.label`) : undefined}
          onNames={setNames}
        />
      ) : null}
      <p id={hintId} className="text-xs text-muted-foreground">
        {t(`lists.${listKey}.help`)}
      </p>
    </div>
  );
}

/**
 * The chip row. A name that is not among the suggestions is offered as an
 * entry of its own while it is being typed, so a provider the snapshot does
 * not know yet can still be named.
 */
function ProviderNameInput({
  id,
  names,
  suggestions,
  describedBy,
  label,
  onNames,
}: {
  id: string;
  names: readonly string[];
  suggestions: readonly string[];
  describedBy: string;
  /** The input's name when no visible label points at it. */
  label?: string;
  onNames: (names: string[]) => void;
}) {
  const t = useTranslations('settings.providerRouting');
  const anchor = useComboboxAnchor();
  const [query, setQuery] = React.useState('');
  const typed = query.trim();
  const known = [...new Set([...suggestions, ...names])];
  const isNew =
    typed.length > 0 && !known.some((entry) => entry.toLowerCase() === typed.toLowerCase());
  const items = isNew ? [...known, typed] : known;

  return (
    <Combobox
      multiple
      items={items}
      value={[...names]}
      inputValue={query}
      onInputValueChange={setQuery}
      onValueChange={(next: string[]) => {
        onNames(next.reduce<string[]>((list, entry) => addProviderName(list, entry), []));
        setQuery('');
      }}
    >
      <ComboboxChips ref={anchor}>
        {names.map((name) => (
          <ComboboxChip key={name} removeLabel={t('chips.remove', { name })}>
            {name}
          </ComboboxChip>
        ))}
        <ComboboxChipsInput
          id={id}
          placeholder={names.length === 0 ? t('chips.placeholder') : undefined}
          aria-describedby={describedBy}
          aria-label={label}
          data-testid={`${id}-input`}
        />
      </ComboboxChips>
      <ComboboxContent anchor={anchor}>
        <ComboboxEmpty>{t('chips.empty')}</ComboboxEmpty>
        <ComboboxList>
          {(entry: string) => (
            <ComboboxItem key={entry} value={entry}>
              {isNew && entry === typed ? t('chips.add', { name: entry }) : entry}
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

/** Keys the form has no field for, kept as JSON and folded away while empty. */
function ExtraField({
  id,
  value,
  reason,
  onChange,
}: {
  id: string;
  value: string;
  reason: Extract<RoutingResult<RoutingMode>, { ok: false }>['reason'] | null;
  onChange: (value: string) => void;
}) {
  const t = useTranslations('settings.providerRouting');
  const extraInvalid = reason === 'extraInvalid' || reason === 'extraKnownKey';
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <details className="group rounded-md border border-border" open={value.length > 0}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
        {t('extra.summary')}
      </summary>
      <div className="flex flex-col gap-1.5 px-3 pb-3">
        <Label htmlFor={id} className="sr-only">
          {t('extra.summary')}
        </Label>
        <Textarea
          id={id}
          rows={3}
          spellCheck={false}
          className="font-mono text-xs"
          placeholder='{ "max_price": { "prompt": 1 } }'
          value={value}
          aria-invalid={extraInvalid}
          aria-describedby={extraInvalid ? `${hintId} ${errorId}` : hintId}
          onChange={(event) => onChange(event.target.value)}
        />
        <p id={hintId} className="text-xs text-muted-foreground">
          {t('extra.help')}
        </p>
        {extraInvalid ? (
          <p id={errorId} className="text-xs text-destructive-text" data-testid={`${id}-error`}>
            {reason === 'extraKnownKey' ? t('extra.knownKey') : t('extra.invalid')}
          </p>
        ) : null}
      </div>
    </details>
  );
}

/** What a model or profile will send once the override is laid over the setting. */
function Preview({
  id,
  inherited,
  result,
}: {
  id: string;
  inherited: ProviderRouting;
  result: RoutingResult<RoutingMode>;
}) {
  const t = useTranslations('settings.providerRouting');
  const merged = result.ok ? mergeProviderRouting(inherited, result.value) : null;
  const entries = merged === null ? [] : Object.entries(merged);
  return (
    <div className="rounded-md bg-muted/50 px-3 py-2" data-testid={id} aria-live="polite">
      <p className="text-xs font-medium">{t('preview.title')}</p>
      {merged === null ? (
        <p className="text-xs text-muted-foreground">{t('preview.invalid')}</p>
      ) : entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{t('preview.empty')}</p>
      ) : (
        <dl className="mt-1 grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-0.5 text-xs">
          {entries.map(([key, entry]) => (
            <React.Fragment key={key}>
              <dt className="font-mono text-muted-foreground">{key}</dt>
              <dd className="break-words">{describeValue(entry, t)}</dd>
            </React.Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}
