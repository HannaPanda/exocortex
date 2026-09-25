'use client';

import { useTranslations } from 'next-intl';
import * as React from 'react';
import { flushSync } from 'react-dom';

import {
  SETTING_KEYS,
  type SettingKey,
  type Settings,
  updateSettingsRequestSchema,
} from '@exocortex/contracts';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Button,
  LoadingState,
  Tabs,
  TabsContent,
} from '@exocortex/ui';

import { useSettingCopy } from '@/components/settings/setting-copy';
import { SettingGroupNav } from '@/components/settings/setting-group-nav';
import {
  fieldErrorsFromDetails,
  groupOf,
  inputId,
  sameSettingValue,
  SETTING_LIST_CLASS,
  SettingRow,
  useSettingMessages,
} from '@/components/settings/setting-row';
import {
  SettingsActionBar,
  UnsavedChangesNotice,
  useUnsavedChangesGuard,
} from '@/components/settings/unsaved-changes-guard';
import {
  useAdminAiModels,
  useAdminSettings,
  useUpdateAdminSettings,
} from '@/lib/api/admin-queries';
import { ApiError } from '@/lib/api/client';
import { messageForCode } from '@/lib/api/error-messages';
import { useRequestedState } from '@/lib/use-requested-state';

/**
 * What the alert beside the save button says.
 *
 * A refusal at a field outranks the API's own message: the fields are named in
 * the form and marked in the group list, so "invalid input" alone would be the
 * less specific of the two.
 */
function refusalSummary(
  refusedCount: number,
  errorCode: string | undefined,
  refused: (count: number) => string,
): string {
  return refusedCount === 0 ? messageForCode(errorCode) : refused(refusedCount);
}

/** The settings whose draft value differs from the one on the server. */
function changedSettingKeys(draft: Settings | null, stored: Settings | undefined): SettingKey[] {
  if (draft === null || stored === undefined) return [];
  return SETTING_KEYS.filter((key) => !sameSettingValue(draft[key], stored[key]));
}

export function SettingsForm({ requestedGroup = null }: { requestedGroup?: string | null }) {
  const settingsQuery = useAdminSettings();
  const modelsQuery = useAdminAiModels();
  const updateSettings = useUpdateAdminSettings();
  const t = useTranslations('settings.adminForm');
  const tForm = useTranslations('settings.form');
  const settingCopy = useSettingCopy();
  const { invalidMessage } = useSettingMessages();

  const [draft, setDraft] = React.useState<Settings | null>(null);
  const [saved, setSaved] = React.useState(false);
  const [fieldErrors, setFieldErrors] = React.useState<Partial<Record<SettingKey, string>>>({});
  // Set when the save was refused before it left the browser; the API's own
  // rejection is reported through `updateSettings.error` instead.
  const [localError, setLocalError] = React.useState(false);
  // Which group of rows is on screen. Over a hundred rows in one column is a
  // scroll nobody reads to the end of; the draft lives above this, so switching
  // groups never loses an edit and one save covers all of them.
  // `?gruppe=` opens a group and moves it on when the address changes.
  const [group, setGroup] = useRequestedState<string | null>(requestedGroup, null);

  // Initialise the draft once the query resolves. Setting state directly
  // during render (guarded so it only fires once) is the pattern React
  // recommends for this instead of an effect (react.dev: "Adjusting state
  // when a prop changes") and avoids the cascading-render lint warning an
  // effect-based version would trigger.
  if (draft === null && settingsQuery.data !== undefined) {
    setDraft(settingsQuery.data.settings);
  }

  // Which rows differ from what is stored. Read before the loading branch
  // below, because the guard is a hook and a hook cannot sit after a return --
  // and while the query is still open there is nothing to lose anyway.
  const changedKeys = changedSettingKeys(draft, settingsQuery.data?.settings);
  const guardDialog = useUnsavedChangesGuard(changedKeys.length);

  if (settingsQuery.isPending || settingsQuery.data === undefined || draft === null) {
    return <LoadingState label={tForm('loading')} variant="skeleton" rows={6} />;
  }

  // Reassigning into fresh `const`s (rather than referencing `draft` /
  // `settingsQuery.data` directly) keeps the non-null narrowing above valid
  // inside the nested handlers below, which TypeScript otherwise widens back
  // to the declared (nullable) type at a function boundary.
  const original: Settings = settingsQuery.data.settings;
  const currentDraft: Settings = draft;
  // Rows the deployment refused to load. Not an error of this form: the value
  // shown is the default that stepped in, and saving the field replaces the bad
  // row. Named per setting, because "some row is broken" is what the log
  // already said.
  const ignoredKeys = settingsQuery.data.invalidKeys;
  const dirty = changedKeys.length > 0;

  const groups = new Map<string, SettingKey[]>();
  for (const key of SETTING_KEYS) {
    const list = groups.get(groupOf(key)) ?? [];
    list.push(key);
    groups.set(groupOf(key), list);
  }

  const groupNames = [...groups.keys()];
  const activeGroup = group !== null && groups.has(group) ? group : (groupNames[0] ?? '');
  const pendingGroups = new Set(changedKeys.map(groupOf));
  const invalidGroups = new Set(
    SETTING_KEYS.filter((key) => fieldErrors[key] !== undefined).map(groupOf),
  );

  function updateField(key: SettingKey, value: Settings[SettingKey]): void {
    setDraft((current) => {
      if (current === null) return current;
      // `key` and `value` are always a matching runtime pair from the same
      // control, but TypeScript cannot correlate them across the union here.
      // This assertion is the documented exception (CLAUDE.md rule 7), not a
      // loosening to `any`.
      return { ...current, [key]: value } as Settings;
    });
    setSaved(false);
    // Editing the offending field retracts its complaint; leaving it standing
    // would make a corrected value still look rejected.
    setFieldErrors((current) => {
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function handleDiscard(): void {
    setDraft(original);
    setSaved(false);
    setFieldErrors({});
    setLocalError(false);
    updateSettings.reset();
  }

  /**
   * Puts the first refused setting on screen; a message out of sight is none.
   *
   * Since the rows arrived in groups, "out of sight" can also mean "in a group
   * that is not rendered", and `getElementById` would find nothing at all. So
   * the group switch is flushed first, synchronously, and only then is the
   * field there to scroll to.
   */
  function revealFirstError(errors: Partial<Record<SettingKey, string>>): void {
    const first = SETTING_KEYS.find((key) => errors[key] !== undefined);
    if (first === undefined) return;
    flushSync(() => setGroup(groupOf(first)));
    const element = document.getElementById(inputId(first));
    element?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    element?.focus({ preventScroll: true });
  }

  function handleSave(): void {
    const changed: Partial<Settings> = {};
    for (const key of SETTING_KEYS) {
      if (!sameSettingValue(currentDraft[key], original[key])) {
        (changed as Record<SettingKey, unknown>)[key] = currentDraft[key];
      }
    }
    if (Object.keys(changed).length === 0) return;

    // The same schema the API validates against, run here first: an
    // out-of-range value is named at its own field straight away instead of
    // coming back as a bare "Die Eingaben sind nicht gültig." (issue #27).
    const parsed = updateSettingsRequestSchema.safeParse(changed);
    if (!parsed.success) {
      const errors: Partial<Record<SettingKey, string>> = {};
      for (const issue of parsed.error.issues) {
        const key = issue.path[0];
        if (typeof key !== 'string' || !(SETTING_KEYS as readonly string[]).includes(key)) continue;
        errors[key as SettingKey] = invalidMessage(key as SettingKey);
      }
      setFieldErrors(errors);
      setLocalError(true);
      setSaved(false);
      updateSettings.reset();
      revealFirstError(errors);
      return;
    }

    setFieldErrors({});
    setLocalError(false);
    updateSettings.mutate(changed, {
      onSuccess: () => setSaved(true),
      onError: (caught) => {
        // A rejection the local check did not anticipate still has to land at
        // the field it belongs to rather than only in the summary.
        const errors =
          caught instanceof ApiError ? fieldErrorsFromDetails(caught.details, invalidMessage) : {};
        setFieldErrors(errors);
        revealFirstError(errors);
      },
    });
  }

  const errorCode =
    updateSettings.error instanceof ApiError ? updateSettings.error.code : undefined;
  const summaryMessage = refusalSummary(Object.keys(fieldErrors).length, errorCode, (count) =>
    t('refused', { count }),
  );
  const showError = localError || updateSettings.isError;

  return (
    <div className="flex flex-col gap-8">
      {/* Unlike the two messages further down, this one belongs at the top: it is
          not the answer to a click but a condition that was already true when the
          page opened. */}
      {ignoredKeys.length > 0 ? (
        <Alert variant="destructive" data-testid="settings-invalid-rows">
          <AlertTitle>{t('ignoredTitle')}</AlertTitle>
          <AlertDescription>
            {t('ignoredDescription', {
              count: ignoredKeys.length,
              labels: ignoredKeys.map((key) => settingCopy(key).label).join(', '),
            })}
          </AlertDescription>
        </Alert>
      ) : null}

      <Tabs
        value={activeGroup}
        onValueChange={(next) => setGroup(typeof next === 'string' ? next : null)}
        orientation="vertical"
        className="flex flex-col gap-6 md:flex-row md:gap-8"
      >
        <SettingGroupNav
          groups={groupNames}
          pending={pendingGroups}
          invalid={invalidGroups}
          testIdPrefix="setting-group"
        />

        <fieldset disabled={updateSettings.isPending} className="min-w-0 flex-1 border-0 p-0">
          {[...groups.entries()].map(([name, keys]) => (
            <TabsContent key={name} value={name} className={SETTING_LIST_CLASS}>
              {keys.map((key) => (
                <div key={key} className="max-sm:py-4">
                  <SettingRow
                    settingKey={key}
                    value={currentDraft[key]}
                    onChange={(value) => updateField(key, value)}
                    models={modelsQuery.data?.models ?? []}
                    error={fieldErrors[key]}
                  />
                </div>
              ))}
            </TabsContent>
          ))}
        </fieldset>
      </Tabs>

      {/* Both messages sit next to the button that triggers them. Above the
          form they would appear several screen heights away from the click,
          which is where the rejection in issue #27 went unnoticed. */}
      {saved ? (
        <Alert data-testid="settings-saved">
          <AlertDescription>{tForm('saved')}</AlertDescription>
        </Alert>
      ) : null}
      {showError ? (
        <Alert variant="destructive" data-testid="settings-error">
          <AlertDescription>{summaryMessage}</AlertDescription>
        </Alert>
      ) : null}

      <SettingsActionBar dirty={dirty}>
        <div className="flex gap-2">
          <Button onClick={handleSave} disabled={!dirty || updateSettings.isPending}>
            {tForm('save')}
          </Button>
          <Button
            variant="outline"
            onClick={handleDiscard}
            disabled={!dirty || updateSettings.isPending}
          >
            {tForm('discard')}
          </Button>
        </div>
        <UnsavedChangesNotice changedCount={changedKeys.length} testId="settings-dirty" />
      </SettingsActionBar>

      {guardDialog}
    </div>
  );
}
